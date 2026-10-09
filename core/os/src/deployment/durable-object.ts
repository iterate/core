// src/deployment/durable-object.ts — THE DEPLOYMENT'S FACET: turns a verb into
// `deployment/run-requested` and hosts the processor that drives the run (processor.ts).
// `DeploymentHandle` in core/lib api.ts documents each verb. ONE ATTEMPT is run.ts, imported as it
// starts (its header says why, and what is masked). THE CONFIG a run deploys, the whole iterate
// config with its secrets and the account's API token inline, is the verb's input, kept in this
// facet's own storage under an id of the request's own: no fact carries it, a request that opens
// no run touches no other request's, and a destroy or the deletion's teardown runs with the last
// opened run's. The project's secrets play no part: this is first-party code, and the platform
// could read the values in any case.
import { z } from "zod";
import { codedError } from "iterate/lib";
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import { DurableObjectNameCodec } from "../context/paths.ts";
import type { ItxEntrypointScope, IterateContextNamespace } from "../iterate-context.ts";
import { deploymentOf, resourceNamesOf } from "../iterate-config.ts";
import { assertCreated } from "../project/entity-lifecycle.ts";
import { DeploymentContract, DeploymentRunRequested, type DeploymentState } from "./contract.ts";
import { DeploymentProcessor, type AttemptOutcome, type DeploymentRunDeps } from "./processor.ts";

/** The deployment's own verbs, beyond the processor's reads (library.ts names the handle's). */
export const deploymentVerbs = ["plan", "deploy", "destroy"] as const;

/** The storage keys of the configs that requests brought, `<prefix><configId>`. */
const CONFIG_PREFIX = "deployment:config:";
const configKeyOf = (configId: string) => `${CONFIG_PREFIX}${configId}`;

/** A run's config as the verb takes it: one JSON object. */
const ConfigObject = z.record(z.string(), z.unknown());

/** The config as a run uses it (run.ts): the Worker's variables (core/os `deploymentOf`), and the
 *  account's API token, which the deploy runs with. */
export type DeploymentConfig = {
  ITERATE: string;
  secrets: Record<string, string>;
  apiToken: string;
};

/** What `plan` and `deploy` take (`DeploymentRunInput`, core/lib api.ts): the request's own fields
 *  with the contract's rules, the config as one JSON string, and nothing else (strict: an unknown
 *  key is refused, not ignored). */
const RunInput = DeploymentRunRequested.options[0]
  .pick({ release: true, images: true, version: true })
  .extend({
    images: DeploymentRunRequested.options[0].shape.images.default({}),
    config: z.string(),
  })
  .strict();

export class DeploymentFacet extends StreamProcessorDurableObject<
  DeploymentState,
  { ITX?: ItxEntrypointService; ITERATE_CONTEXT: IterateContextNamespace },
  ItxEntrypointScope
> {
  static override publicMethods = [...super.publicMethods, ...deploymentVerbs];

  /** The entity lifecycle and the run. Nothing to provision; the deletion destroys what runs made. */
  processor = new DeploymentProcessor(
    DeploymentContract,
    () => this.getItx(),
    () => this.#path,
    { teardown: () => this.#teardown() },
    { attempt: (run, report) => this.#attempt(run, report) },
  );

  /** The deployment's path: the context's name in this facet's props, so no call reads it. */
  get #path(): string {
    return DurableObjectNameCodec.parse(this.ctx.props.iterateContextName).path;
  }

  /** The path's last segment: the Worker's name and Alchemy's stage. */
  get #name(): string {
    return this.#path.slice(this.#path.lastIndexOf("/") + 1);
  }

  /** Where the deployment stands, read through the head of the log: a run that settled a moment
   *  ago must not refuse the next request. */
  async #state(): Promise<DeploymentState> {
    await this.catchUpFromLog();
    return (await this.snapshot()).state;
  }

  /** The config kept under `configId`, or undefined. */
  #config(configId: string): Promise<DeploymentConfig | undefined> {
    return this.ctx.storage.get<DeploymentConfig>(configKeyOf(configId));
  }

  // ── the verbs (core/lib api.ts `DeploymentHandle`) ──

  plan(input: z.input<typeof RunInput>): Promise<{ requestOffset: number }> {
    return this.#run("plan", input);
  }

  deploy(input: z.input<typeof RunInput>): Promise<{ requestOffset: number }> {
    return this.#run("deploy", input);
  }

  destroy(): Promise<{ requestOffset: number }> {
    return this.#request(async ({ target }) => {
      if (!target || !(await this.#config(target.configId)))
        throw codedError(
          "INVALID_INPUT",
          `deployment ${this.#path}: nothing to destroy, since no plan or deploy ran here`,
        );
      return { kind: "destroy", ...target };
    });
  }

  /** A plan or a deploy: the input on its schema, its config parsed as the Worker parses it (a
   *  malformed field is refused by name), and the config's Worker the one that the path names. The
   *  config is kept under an id of this request's own before the request lands, so the attempt
   *  finds it; a request that is refused takes its config away again, and once one lands, the
   *  configs no run needs any more go. */
  async #run(kind: "plan" | "deploy", input: unknown): Promise<{ requestOffset: number }> {
    const fields = RunInput.safeParse(input);
    if (!fields.success)
      throw codedError(
        "INVALID_INPUT",
        `deployment ${this.#path}: ${z.prettifyError(fields.error)}`,
      );
    const { config, vars } = this.#parse(fields.data.config);
    const { worker } = resourceNamesOf(config.cloudflare);
    if (worker !== this.#name)
      throw codedError(
        "INVALID_INPUT",
        `deployment ${this.#path}: its config deploys the Worker ${worker}, but a deployment's path ends in the name of its Worker`,
      );
    const { accountId, apiToken } = config.cloudflare;
    const { release, images, version } = fields.data;
    const configId = crypto.randomUUID();
    await this.ctx.storage.put<DeploymentConfig>(configKeyOf(configId), {
      ITERATE: vars.ITERATE,
      secrets: vars.secrets,
      apiToken: apiToken.exposeSecret(),
    });
    let requested: { requestOffset: number };
    try {
      requested = await this.#request(() => ({
        kind,
        release,
        images,
        version,
        accountId,
        configId,
      }));
    } catch (error) {
      await this.ctx.storage.delete(configKeyOf(configId));
      throw error;
    }
    await this.#prune(configId);
    return requested;
  }

  /** The configs no run needs: every one but the request's just landed, the open run's and the
   *  last run's (the reduce has read the log through that request). */
  async #prune(configId: string): Promise<void> {
    const { run, target } = await this.#state();
    const needed = new Set([configId, run?.request.configId, target?.configId]);
    const kept = await this.ctx.storage.list({ prefix: CONFIG_PREFIX });
    const stale = [...kept.keys()].filter((key) => !needed.has(key.slice(CONFIG_PREFIX.length)));
    if (stale.length > 0) await this.ctx.storage.delete(stale);
  }

  /** The config as the Worker parses it, with its `cloudflare` section, since a deployment deploys
   *  somewhere. What is wrong with it is the refusal's text. */
  #parse(config: string) {
    let json: unknown;
    try {
      json = JSON.parse(config);
    } catch {
      throw codedError("INVALID_INPUT", `deployment ${this.#path}: its config is not JSON`);
    }
    const object = ConfigObject.safeParse(json);
    if (!object.success)
      throw codedError("INVALID_INPUT", `deployment ${this.#path}: its config is not an object`);
    let deployment: ReturnType<typeof deploymentOf>;
    try {
      deployment = deploymentOf(object.data);
    } catch (error) {
      throw codedError(
        "INVALID_INPUT",
        `deployment ${this.#path}: its config: ${messageOf(error)}`,
      );
    }
    const { cloudflare } = deployment.config;
    if (!cloudflare)
      throw codedError(
        "INVALID_INPUT",
        `deployment ${this.#path}: its config has no cloudflare section, so it does not say where it deploys`,
      );
    return { config: { ...deployment.config, cloudflare }, vars: deployment.vars };
  }

  /** THE REQUEST, after the guards every verb reads. The reduce is the one guard of one run at a
   *  time; this check answers the caller at once. A request off the contract's schema is refused
   *  here: the processor would skip it, and nothing would settle it. */
  async #request(
    requestOf: (state: DeploymentState) => DeploymentRunRequested | Promise<DeploymentRunRequested>,
  ): Promise<{ requestOffset: number }> {
    const state = await this.#state();
    assertCreated("deployment", this.#path, state);
    if (state.run)
      throw codedError(
        "RUN_IN_PROGRESS",
        `deployment ${this.#path}: a ${state.run.request.kind} run is open since offset ${state.run.requestOffset}: follow it to its settlement, then ask again`,
      );
    const request = DeploymentRunRequested.safeParse(await requestOf(state));
    if (!request.success)
      throw codedError(
        "INVALID_INPUT",
        `deployment ${this.#path}: ${z.prettifyError(request.error)}`,
      );
    using itx = this.getItx();
    // the RPC type of an append's answer is `never` (its events hold `unknown`); each one has its `offset`
    const [requested] = (await itx.append({
      type: "events.iterate.com/deployment/run-requested",
      payload: request.data,
    })) as { offset: number }[];
    return { requestOffset: requested!.offset };
  }

  // ── the run ──

  /** ONE ATTEMPT: run.ts, imported as it starts, under one scope for the whole attempt, which
   *  Alchemy needs: it reads each answer's body after its fetch returned. The config is the
   *  request's own; without it (a request whose config was never kept, which no verb makes) the
   *  attempt refuses. */
  async #attempt(
    ...[run, report]: Parameters<DeploymentRunDeps["attempt"]>
  ): Promise<AttemptOutcome> {
    const config = await this.#config(run.request.configId);
    if (!config)
      return {
        status: "refused",
        error: `no config is kept under ${run.request.configId}: a plan or a deploy brings one`,
      };
    // oxlint-disable-next-line no-restricted-imports -- the lazy chunk's one import: Alchemy and Effect load only when an attempt starts
    const { attemptRun } = await import("./run.ts");
    using itx = this.getItx();
    return await attemptRun({
      ...run,
      stage: this.#name,
      path: this.#path,
      sql: this.ctx.storage.sql,
      files: itx.files,
      config,
      report,
    });
  }

  /** THE DELETION'S TEARDOWN: the driver in flight ends, then a destroy with the last target and
   *  its config, its steps on the log under the deletion's request. A destroy that fails logs one
   *  warn line and throws: the lifecycle's next at-head pass tries again (entity-lifecycle.ts).
   *  One that succeeds drops every config kept. */
  async #teardown(): Promise<void> {
    await this.processor.driven();
    const { target, deletion } = await this.#state();
    if (!target || !deletion || !(await this.#config(target.configId))) return;
    const step = { requestOffset: deletion.offset, attempt: 1 };
    const outcome = await this.#attempt(
      { ...step, request: { kind: "destroy", ...target } },
      // unkeyed: each try reports its own steps, and a later try can plan another deletion
      async (fact) => {
        using itx = this.getItx();
        await itx.append({ ...fact, payload: { ...fact.payload, ...step } });
      },
    );
    if (outcome.status === "succeeded") {
      const kept = await this.ctx.storage.list({ prefix: CONFIG_PREFIX });
      if (kept.size > 0) await this.ctx.storage.delete([...kept.keys()]);
      return;
    }
    console.warn({ event: "deployment.teardown-failed", path: this.#path, ...outcome });
    throw new Error(`deployment ${this.#path}: the teardown's destroy ended ${outcome.status}`);
  }
}

/** What an error says. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
