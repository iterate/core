// attempt.ts — ONE RUN OF THE STACK AS A PROMISE, for a host that composes nothing of Effect
// itself: a project's own deployment facet, a config repo's class over the package's workerd build
// (dist/workerd/attempt.mjs). core/os's facet composes the same engine itself
// (core/os/src/deployment/run.ts) and reports each step as a fact; this reports through callbacks
// and answers how the run ended.
import { Stack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Formatter from "effect/Formatter";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { cloudflareProviders, hostLayer, type RunEvent, runStack, stageRelease } from "./engine.ts";
import { iterateStack, type StackInput } from "./stack.ts";
import { sqlState, type StateSql } from "./state-sql.ts";

/** The stack's name in Alchemy's state: what core/os's facet and Alchemy's CLI call it too. */
const STACK = "iterate";
/** Where a release unzips: workerd gives each request its own /tmp. */
const RELEASES = "/tmp/release";

export type AttemptInput = {
  kind: "plan" | "deploy" | "destroy";
  /** Alchemy's stage: the Worker's name */
  stage: string;
  /** the account the token reaches */
  accountId: string;
  /** the Cloudflare API token as the request carries it: the token, or a placeholder the host's
   *  egress fills (`getSecret("/secrets/…", { field: "accessToken" })`) */
  apiToken: string;
  /** the facet's SQLite, which holds Alchemy's state */
  sql: StateSql;
  /** a plan or a deploy: the deployment (the `cloudflare` section and the Worker's variables) */
  deployment?: StackInput["deployment"];
  /** a plan or a deploy: the release zip, checked against its digest */
  release?: { archive: Uint8Array; sha256: string; version?: string };
  /** image name ⇒ its reference in the account's registry; none ⇒ Cloudflare's managed image */
  images?: Record<string, string>;
  /** each engine event: the plan, each resource applied, the stack's output */
  onEvent?: (event: RunEvent) => void;
  /** each line Alchemy and Effect log */
  onLog?: (line: string) => void;
  /** the run's deadline; default 10 minutes */
  timeout?: `${number} minutes` | `${number} seconds`;
  /** what the engine's requests go through; default the global fetch */
  fetch?: typeof globalThis.fetch;
};

export type AttemptOutcome =
  | { status: "succeeded"; url?: string }
  | { status: "failed"; error: string };

/** One attempt of a plan, a deploy or a destroy of `stage`, settled as a value: a thrown error is
 *  the host's own fault (a release that is no zip is a `failed` outcome, not a throw). */
export async function attempt(input: AttemptInput): Promise<AttemptOutcome> {
  const { kind, stage, accountId, apiToken, onEvent, onLog } = input;
  const state = sqlState(input.sql);
  const vars =
    kind === "destroy" || !input.deployment
      ? {}
      : { ...input.deployment.vars.secrets, ITERATE: input.deployment.vars.ITERATE };
  const run = Effect.gen(function* () {
    // Nothing in the state, nothing to delete: a destroy then needs no Cloudflare.
    if (kind === "destroy" && (yield* nothingDeployed(state, stage))) return undefined;
    // THE STACK'S INPUT, staged before the stack runs (its body fails on config alone): the release
    // from the request, checked and unzipped.
    const staged = Effect.gen(function* () {
      if (!input.deployment || !input.release)
        return yield* Effect.fail(new Error(`a ${kind} needs a deployment and a release`));
      const unzipped = yield* stageRelease(
        input.release.archive,
        input.release.sha256,
        `${RELEASES}/${stage}`,
      );
      onEvent?.({
        _tag: "Output",
        output: { staged: { files: unzipped.files, bytes: unzipped.bytes } },
      });
      return {
        deployment: input.deployment,
        release: { dir: unzipped.directory, version: input.release.version },
        images: input.images || {},
      } satisfies StackInput;
    });
    // one output type for both verbs: the stack's object, or a destroy's nothing
    const body =
      kind === "destroy"
        ? Effect.succeed<unknown>(undefined)
        : iterateStack(yield* staged).pipe(Effect.map((output): unknown => output));
    let url: string | undefined;
    const stack = Stack(
      STACK,
      { providers: cloudflareProviders(apiToken, accountId), state },
      body,
    );
    yield* runStack(kind, stack).pipe(
      Stream.runForEach((event) => {
        onEvent?.(event);
        // the stack's output: a deploy's is the Worker's URL (./stack.ts)
        if (event._tag === "Output") {
          const { output } = event;
          if (Predicate.hasProperty(output, "url") && typeof output.url === "string")
            url = output.url;
        }
        return Effect.void;
      }),
    );
    return url;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        hostLayer(stage, vars, input.fetch || globalThis.fetch),
        Logger.layer([
          Logger.make(({ logLevel, message, cause }) => {
            const parts: unknown[] = Array.isArray(message) ? message : [message];
            const text = parts
              .map((part) => (typeof part === "string" ? part : Formatter.format(part)))
              .join(" ");
            const why = cause.reasons.length > 0 ? `\n${Cause.pretty(cause)}` : "";
            onLog?.(`${logLevel} ${text}${why}`);
          }),
        ]),
      ),
    ),
    Effect.scoped,
    Effect.timeout(input.timeout || "10 minutes"),
  );
  const exit = await Effect.runPromiseExit(run);
  if (Exit.isSuccess(exit))
    return exit.value ? { status: "succeeded", url: exit.value } : { status: "succeeded" };
  return { status: "failed", error: Cause.pretty(exit.cause).slice(0, 4000) };
}

/** Whether Alchemy's state holds no resource of `stage`. */
const nothingDeployed = (state: Layer.Layer<State>, stage: string) =>
  Effect.gen(function* () {
    const store = yield* yield* State;
    return (yield* store.list({ stack: STACK, stage })).length === 0;
  }).pipe(Effect.provide(state));
