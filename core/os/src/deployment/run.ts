// src/deployment/run.ts — ONE ATTEMPT OF A DEPLOYMENT'S RUN: Alchemy inside the deployment's facet.
// THE LAZY CHUNK: durable-object.ts imports it with `import()` as an attempt starts, and it is the
// one module of src/ that imports Alchemy and Effect (.oxlintrc.json), so a cold isolate and every
// other facet never evaluate either. In order: the token's reach, the release staged from the
// project's files, then the stack (@iterate-com/deployer) planned, applied or destroyed over Alchemy's
// state in the facet's SQLite, each step reported as its fact.
//
// THE CONFIG IS THE FACET'S (durable-object.ts): the Worker's variables and the account's API token,
// which Alchemy's providers run with over the Worker's own fetch. NO SECRET REACHES A FACT OR A LOG
// LINE: errors and engine log lines are masked with every value the config holds, the token among
// them, and every failure comes back as an outcome, never as a throw. ALCHEMY'S STATE IS NOT MASKED:
// it keeps each Worker secret's value in plaintext in the facet's SQLite, as the CLI keeps them in
// .alchemy/.
import { Stack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Formatter from "effect/Formatter";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import {
  failureKind,
  httpFailureKind,
  isPlatformFailureKind,
  type FailureKind,
} from "iterate/platform-retry";
import {
  cloudflareProviders,
  hostLayer,
  ReleaseRefused,
  runStack,
  stageRelease,
} from "@iterate-com/deployer/engine";
import { iterateStack } from "@iterate-com/deployer/stack";
import { sqlState, type StateSql } from "@iterate-com/deployer/state-sql";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { deploymentOf, iterateConfigFromEnv } from "../iterate-config.ts";
import type { DeploymentRunRequested } from "./contract.ts";
import type { DeploymentConfig } from "./durable-object.ts";
import type { AttemptOutcome, DeploymentStepFact } from "./processor.ts";

/** Our own deadline for one attempt, an overload that settles the run `unavailable`. A fresh deploy
 *  applied in 20.8 s (tasks/alchemy-native-deploy.md). */
const ATTEMPT_DEADLINE = "10 minutes";

/** The most of an error or an engine log line that is kept, after the mask. */
const KEPT_CHARS = 8_000;

/** Alchemy's name for the stack: its state keeps each resource under it. */
const STACK = "iterate";

/** Where an attempt stages its release, `<RELEASES>/<stage>`: the same path on every run
 *  (@iterate-com/deployer/engine `stageRelease`). workerd gives each request its own /tmp. */
const RELEASES = "/tmp/release";

/** The statuses of a resource whose apply is done (alchemy Report.ts `ApplyStatus`), each a
 *  `resource-applied` fact; the others are steps on the way. */
const APPLIED = new Set(["created", "updated", "adopted", "deleted", "replaced", "orphaned"]);

/** ONE ATTEMPT of the run that `request` asks for (processor.ts `DeploymentRunDeps`).
 *  `requestOffset` and `attempt` name the run in each engine log line. */
export async function attemptRun(input: {
  requestOffset: number;
  request: DeploymentRunRequested;
  attempt: number;
  /** Alchemy's stage: the Worker's name, the last segment of the deployment's path */
  stage: string;
  path: string;
  /** the facet's SQLite, which holds Alchemy's state */
  sql: StateSql;
  /** the project's files, where the release is */
  files: ItxEntrypointScope["files"];
  /** the config the facet kept: the Worker's variables and the account's API token */
  config: DeploymentConfig;
  report: (fact: DeploymentStepFact) => Promise<unknown>;
}): Promise<AttemptOutcome> {
  const { request, path, requestOffset, attempt, config } = input;
  // THE MASK, from the first line: every value the config holds, the token among them.
  const redact = redactorOf([...Object.values(config.secrets), config.apiToken]);
  try {
    const state = sqlState(input.sql);
    const token = config.apiToken;
    const report = (fact: DeploymentStepFact) =>
      facetCall(`the ${fact.type} fact`, () => input.report(fact));
    /** The attempt over the Worker's variables, under the host that they make. */
    const run = (vars: Record<string, string>) =>
      Effect.gen(function* () {
        // Nothing in the state, nothing to delete: a destroy then needs no Cloudflare.
        if (request.kind === "destroy" && (yield* nothingDeployed(state, input.stage)))
          return undefined;
        yield* preflight(request.accountId, token);
        const body =
          request.kind === "destroy"
            ? Effect.void
            : iterateStack(yield* stackInputOf(request, vars, input.files, input.stage, report));
        let url: string | undefined;
        const stack = Stack(
          STACK,
          { providers: cloudflareProviders(token, request.accountId), state },
          body,
        );
        yield* runStack(request.kind, stack).pipe(
          Stream.runForEach((event) => {
            if (event._tag === "Planned")
              return report({
                type: "events.iterate.com/deployment/run-planned",
                payload: { resources: [...event.resources] },
              });
            if (event._tag === "Applied")
              return APPLIED.has(event.status)
                ? report({
                    type: "events.iterate.com/deployment/resource-applied",
                    payload: { fqn: event.fqn, type: event.type, status: event.status },
                  })
                : Effect.void;
            // the stack's output: a deploy's is the Worker's URL (@iterate-com/deployer/stack)
            const { output } = event;
            if (Predicate.hasProperty(output, "url") && typeof output.url === "string")
              url = output.url;
            return Effect.void;
          }),
        );
        return url;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            hostLayer(input.stage, vars, globalThis.fetch),
            Logger.layer([engineLog(redact, { path, requestOffset, attempt })]),
          ),
        ),
      );
    const exit = await Effect.runPromiseExit(
      run(request.kind === "destroy" ? {} : { ...config.secrets, ITERATE: config.ITERATE }).pipe(
        Effect.scoped,
        Effect.timeout(ATTEMPT_DEADLINE),
      ),
    );
    return outcomeOf(exit, redact);
  } catch (error) {
    // Our own defect outside the Effect: a value the attempt built before it ran threw.
    return { status: "failed", error: kept(redact(`the attempt threw: ${messageOf(error)}`)) };
  }
}

/** A failure the attempt classified where it met it, its kind as iterate/platform-retry names it. */
class AttemptFailed extends Data.TaggedError("AttemptFailed")<{
  readonly kind: FailureKind;
  readonly message: string;
}> {}

/** A call of the facet's own (`itx.files`, a step's append) as an Effect: a failure keeps the
 *  kind its hop stamped. */
const facetCall = <A>(what: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new AttemptFailed({ kind: failureKind(cause), message: `${what}: ${messageOf(cause)}` }),
  });

/** Whether Alchemy's state holds no resource of `stage`. */
const nothingDeployed = (state: Layer.Layer<State>, stage: string) =>
  Effect.gen(function* () {
    const store = yield* yield* State;
    return (yield* store.list({ stack: STACK, stage })).length === 0;
  }).pipe(Effect.provide(state));

/** THE TOKEN'S REACH, checked before Alchemy runs, which would repeat a refused token's answer for
 *  about 20 s (@distilled.cloud/core retry.ts): a token that can deploy to the account can read its
 *  workers.dev subdomain. Cloudflare's refusal of the token (400 for one it cannot read, 401 or 403
 *  for one it does not know or that may not) is the run's refusal, which names no value. */
const preflight = Effect.fn("deployment.preflight")(function* (accountId: string, token: string) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`;
  // A request that got no answer is read as `fetch` is: a connection that failed is Cloudflare's.
  const failed = (cause: unknown) =>
    new AttemptFailed({ kind: httpFailureKind(cause), message: `GET ${url}: ${messageOf(cause)}` });
  const answer = yield* Effect.tryPromise({
    try: () => fetch(url, { headers: { authorization: `Bearer ${token}` } }),
    catch: failed,
  });
  const text = yield* Effect.tryPromise({ try: () => answer.text(), catch: failed });
  if (answer.ok) return;
  if (answer.status === 400 || answer.status === 401 || answer.status === 403)
    return yield* new AttemptFailed({
      kind: "refused",
      message: `the config's cloudflare.apiToken cannot reach account ${accountId}: Cloudflare answered ${answer.status} ${text.slice(0, 300)}`,
    });
  return yield* new AttemptFailed({
    kind: httpFailureKind(answer),
    message: `GET ${url} answered ${answer.status}: ${text.slice(0, 500)}`,
  });
});

/** THE STACK'S INPUT for a plan or a deploy: the config parsed (a malformed field is refused by
 *  name), then the release from the project's files, staged for the attempt's scope and reported. */
const stackInputOf = Effect.fn("deployment.stage")(function* (
  request: Exclude<DeploymentRunRequested, { kind: "destroy" }>,
  vars: Record<string, string>,
  files: ItxEntrypointScope["files"],
  stage: string,
  report: (fact: DeploymentStepFact) => Effect.Effect<unknown, AttemptFailed>,
) {
  const deployment = yield* Effect.try({
    try: () => deploymentOf(iterateConfigFromEnv(vars)),
    catch: (cause) =>
      new AttemptFailed({ kind: "refused", message: `the iterate config: ${messageOf(cause)}` }),
  });
  const { file, sha256 } = request.release;
  const release = files.get(file);
  if (!(yield* facetCall(`the release ${file}`, () => release.head())))
    return yield* new ReleaseRefused({
      message: `the release ${file} is not in the project's files`,
    });
  const archive = yield* facetCall(`the release ${file}`, () => release.bytes());
  const staged = yield* stageRelease(archive, sha256, `${RELEASES}/${stage}`);
  yield* report({
    type: "events.iterate.com/deployment/release-staged",
    payload: { sha256, files: staged.files, bytes: staged.bytes },
  });
  return {
    deployment,
    release: { dir: staged.directory, version: request.version },
    images: request.images,
  };
});

/** THE ENGINE'S LOG: each line Alchemy and Effect log during the attempt as one
 *  `deployment.engine-log` line that names the run, masked and cut. At info, whatever its level:
 *  how the run settles is the signal (processor.ts), and a line is its context. */
const engineLog = (
  redact: (text: string) => string,
  run: { path: string; requestOffset: number; attempt: number },
) =>
  Logger.make(({ logLevel, message, cause }) => {
    const parts: unknown[] = Array.isArray(message) ? message : [message];
    const text = parts
      .map((part) => (typeof part === "string" ? part : Formatter.format(part)))
      .join(" ");
    const why = cause.reasons.length > 0 ? `\n${Cause.pretty(cause)}` : "";
    console.info({
      event: "deployment.engine-log",
      ...run,
      level: logLevel,
      message: kept(redact(text + why)),
    });
  });

/** HOW THE ATTEMPT ENDED, by its first failure (processor.ts `AttemptOutcome`): the attempt's own
 *  refusals and the stack's ConfigError are `refused`; our deadline and the platform's failure of
 *  the attempt's own calls are `unavailable`; anything else is `failed`, its error the whole cause,
 *  which names each error by its tag. Masked, then cut, so the cut never leaves part of a secret. */
function outcomeOf(
  exit: Exit.Exit<string | undefined, unknown>,
  redact: (text: string) => string,
): AttemptOutcome {
  if (Exit.isSuccess(exit))
    return exit.value ? { status: "succeeded", url: exit.value } : { status: "succeeded" };
  const said = (text: string) => kept(redact(text));
  const [first] = exit.cause.reasons;
  const error = first && Cause.isFailReason(first) ? first.error : undefined;
  if (error instanceof AttemptFailed) return outcomeOfKind(error.kind, said(error.message));
  if (error instanceof ReleaseRefused || Predicate.isTagged(error, "ConfigError"))
    return { status: "refused", error: said(messageOf(error)) };
  if (Cause.isTimeoutError(error))
    return {
      status: "unavailable",
      kind: "overloaded",
      error: `the attempt ran past its deadline, ${ATTEMPT_DEADLINE}`,
    };
  return { status: "failed", error: said(Cause.pretty(exit.cause)) };
}

/** A failure of `kind` as an outcome: the platform's failure is `unavailable`. */
const outcomeOfKind = (kind: FailureKind, error: string): AttemptOutcome =>
  isPlatformFailureKind(kind) ? { status: "unavailable", kind, error } : { status: kind, error };

/** THE MASK of one attempt: each value it holds, as the variable holds it and as the string inside
 *  its JSON (src/iterate-config.ts `deploymentOf`), each also as it reads inside a JSON string, the
 *  longest first, so a secret that holds another is masked whole. EXACT, with no shortest length: a
 *  floor would let a short secret through. */
function redactorOf(values: readonly string[]): (text: string) => string {
  const forms = values
    .flatMap((value) => {
      try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === "string" ? [value, parsed] : [value];
      } catch {
        return [value];
      }
    })
    .flatMap((form) => [form, JSON.stringify(form).slice(1, -1)])
    .filter((form) => form.length > 0);
  const masked = [...new Set(forms)].sort((a, b) => b.length - a.length);
  return (text) => masked.reduce((redacted, form) => redacted.replaceAll(form, "<redacted>"), text);
}

/** What an error says. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `text` cut to what an error or a log line keeps. */
const kept = (text: string) => text.slice(0, KEPT_CHARS);
