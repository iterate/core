// sdk/index.ts — THE SDK's HOSTS, the workerd classes a loaded worker extends (this file imports
// cloudflare:workers; the Node unit tests never import it):
//   FacetDurableObject           — the `DurableObject` shell a context hosts as a facet: its class lists
//                                  the methods a caller reaches by itx expression (`publicMethods`)
//   StreamProcessorDurableObject — the facet shell that hosts ONE `StreamProcessor`
//   IterateConfigEntrypoint      — the stateless `WorkerEntrypoint` a mind's config repo exports
// and capnweb's constructors (below), which loaded code has no other platform path to.
//
// Everything else has one path of its own: a processor's surface (`StreamProcessor`,
// `defineProcessorContract`, `LiveState`, the event and contract types) is `iterate/stream/processor`,
// which runs in Node too; zod is `zod`. A loaded worker imports each by name and the loader links
// this deployment's own build of it (core/mind-worker/scripts/build.ts):
//
//   import { StreamProcessorDurableObject } from "iterate/sdk";
//   import { StreamProcessor, defineProcessorContract } from "iterate/stream/processor";
//   import { z } from "zod";

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  InstalledAppRoots,
  IterateContextApi,
  IterateContextApiWith,
  StreamPage,
} from "../api.ts";
import {
  ProcessorEngine,
  type ScannedRange,
  type StreamProcessor,
  ReduceCheckpointTable,
  type StreamEvent,
  type StreamEventInput,
} from "../stream/processor.ts";
// The hosts' `callWithCause` and `fetch` run what they call under the cause the platform hands them
// (../cause.ts).
import { causeOfRequest, currentCause, runCausedBy } from "../cause.ts";
import { errorCode, reportIssue } from "../lib.ts";
import { auth } from "./auth.ts";
import { codeFailedFact, type CodeFailedWhere, scrubbedError } from "./code-failed.ts";
import {
  currentCallerPath,
  currentOnBehalfOf,
  walkUnderCause,
  type OnBehalfOf,
  type RpcSteps,
} from "./call-with-cause.ts";
// The hosts' `this.getItx()` is this (itx-scope.ts says why a scope is never kept).
import { itxScope } from "./itx-scope.ts";
import { DirectAppendHolder, type DirectAppend } from "./direct-append.ts";
// capnweb's CLIENT constructors, so userspace can dial a remote capnweb API from inside its isolate
// through the context's own egress, and `newWorkersRpcResponse`, the SERVER half, so a loaded worker
// can serve a capnweb API over its `fetch`. The HTTP batch is exported ON PURPOSE beside the
// WebSocket session: a stateless entrypoint answering one method with one remote call has no session
// to hold across calls, and a one-shot POST is the honest shape (the lint rule targets long-lived workers).
// oxlint-disable-next-line iterate/no-capnweb-http-batch -- userspace one-shot remote calls; see above
export { newHttpBatchRpcSession, newWebSocketRpcSession, newWorkersRpcResponse } from "capnweb";
export { serveFiles, type FileContent } from "./files.ts";
export type { OnBehalfOf };
// What an app says of itself to the mind's issuer: the typed object, and the answer that serves it.
export { serveAppDescription, type AppDescription } from "../app-description.ts";
// ── StreamProcessorDurableObject ── THE SDK HOST: the `DurableObject` shell that hosts ONE
// `StreamProcessor` as a facet of its context. An author writes the pure processor and its host,
// one line long:
//
//   export class PresenceDurableObject extends StreamProcessorDurableObject {
//     processor = new PresenceProcessor();
//   }
//
// hosted through the ordinary `itx.facets.get('presence', { source, className: 'PresenceDurableObject' })`
// — a processor is a named facet that additionally gets pushed every commit. `processor` is a FIELD
// so it can take what its effects need from this object — reach as an accessor, never a scope:
// `new Notifier(() => this.getItx())` — and so the same class is constructed bare in a test. A
// method of the host's own that callers reach by itx expression goes on its list:
// `static override publicMethods = [...super.publicMethods, "message"]`.
//
// IDENTITY is `ctx.props` — `{ iterateContextName, name }`, minted by the parent, the only party
// that knows it, plus `fedByPushes` when a row pushes it (FacetProps). THE STREAM is the itx scope
// `this.getItx()` hands out (core/itx/src/iterate-context.ts `ItxEntrypoint`); the engine's
// `append`/`read` ride it like any other dotted call.
//
// NEVER define alarm(): facets have none (workerd#6810 — the runtime answers "Facets currently
// cannot set alarms."); a timer, when one is needed, is a scheduled append on the context. The
// engine's own recovery is a CLAIM on the context's alarm (processor.ts, rule 3): while a
// `runInBackground` attempt is in flight the context owes this facet a `revive()`, so a host that
// dies mid-attempt is re-materialized and runs its at-head pass again
// (test/vitest/os-workers/agent-revive.test.ts: an LLM call survives its context's death).
//
// THE CLAIM IS ALSO WHAT KEEPS A FACET RUNNING: a loaded facet that holds none when its context
// starts a new incarnation is reset then (os FacetHost `resetUnclaimedLoadedFacets`). So work that
// must outlive the call that started it — a model request, a retry's backoff sleep, an open
// provider socket — runs through `runInBackground` (ProcessEventArgs), never as a bare floating
// promise, a `ctx.waitUntil` or a timer the facet keeps on its own.

/** What the parent mints a facet's class with — the whole identity, and one fact about its feed. */
export type FacetProps = {
  iterateContextName: string;
  name: string;
  /** Set when, as this facet started, a subscription row of its context pushed it every commit it
   *  consumes (`processEventBatch`, the delivery loop's push): a processor's engine then trusts the
   *  head a catch-up read until the next push (stream/processor.ts, the read verbs). Absent, only a
   *  push is proof, so a processor no row pushes reads its log on every read. */
  fedByPushes?: true;
  /** The code it was started on, as the parent names it (the deploy, and a loaded facet's identity):
   *  work in flight that died with a restart onto other code is no death of that work
   *  (stream/processor.ts). */
  codeId?: string;
};

/** THE FACET SHELL: a `DurableObject` a context hosts as a facet — `itx.facets.get(name, { source,
 *  className })`, a rule naming it, or a processor's row. A caller reaches a facet by itx expression
 *  (`itx.facets.get(name).<method>(…)`) only through what its class lists in `publicMethods`: the
 *  context refuses any other first step FORBIDDEN before the call reaches the facet
 *  (core/itx/src/context/facet-public-methods.ts). A person who is no member (a guest among them)
 *  reaches, through their one-context view, only what it also lists in `personMethods`. The
 *  platform's own calls — the delivery loop's push
 *  and catch-up, the alarm's revive — never go through the list. A loaded class that does not
 *  extend this shell lists nothing, so no caller reaches it by expression. */
export abstract class FacetDurableObject<
  Env extends { ITX?: ItxEntrypointService } = { ITX: ItxEntrypointService },
  Scope = IterateContextApi,
> extends DurableObject<Env, FacetProps> {
  /** What a caller may reach by itx expression: the FIRST step of `itx.facets.get(name).<step>…`, a
   *  method or a property of this class. A subclass lists its own on top of its parent's:
   *  `static override publicMethods = [...super.publicMethods, "send"]`. */
  static publicMethods: readonly string[] = ["fetch"];

  /** What a PERSON may call through their one-context view of this facet's context
   *  (`auth.personItx`): a signed-in person who need not be a member, a guest among them. Each is
   *  one of `publicMethods`, and never `fetch`: `static override personMethods = ["join", "leave"]`.
   *  With none, as here, no person reaches the facet's methods. A person's page calls one as
   *  `invoke(["itx", "facets", ["get", name], [method, ...args]])`. What to know of such a call:
   *  - WHO ASKED is `this.onBehalfOf()`. Decide by it and by this facet's own records: the list
   *    lets every person with a view of the context in, and a guest is one. A member has
   *    `member: true`; test that, never the absence of `kind`.
   *  - THE ARGUMENTS are JSON, of any shape: check them. The answer must be JSON too: a stub, a
   *    stream or a function in it is refused, and the Worker's log says so.
   *  - THE ANSWER is yours to keep free of other people's addresses. The view reads events, rows
   *    and states as a person reads them, and in an answer only what has the platform's shape of
   *    a person (an object with `actor`): an address in a string stays in it.
   *  - THE COUNT: a person's calls are counted by the minute on one context, for all its facets
   *    together, and arguments and answer have one size bound
   *    (core/itx/src/context/facet-public-methods.ts has both numbers). */
  static personMethods: readonly string[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // `this.constructor` is the concrete facet class (as in `listPublicMethods`, below).
    const { name, publicMethods, personMethods } = this.constructor as typeof FacetDurableObject;
    const notPublic = personMethods.filter((method) => !publicMethods.includes(method));
    if (notPublic.length > 0)
      throw new Error(
        `${name}: static personMethods lists ${notPublic.join(", ")}, which static publicMethods does not list. A person may call only what a member's session may call: list it in both`,
      );
    if (personMethods.includes("fetch"))
      throw new Error(
        `${name}: static personMethods lists fetch. A person's view calls a method, never fetch: a Request names nobody`,
      );
    // A Request the facet serves runs under the cause it carries (../cause.ts).
    const serve = (this as { fetch?: (request: Request) => unknown }).fetch;
    if (serve)
      // the cast: `serve` is typed to answer `unknown` only so it can be read off `this`; it is the
      // subclass's own `fetch`, which answers a Response as every Durable Object's fetch must
      this.fetch = (request: Request) =>
        runCausedBy(
          causeOfRequest(request),
          () => serve.call(this, request),
          "clear",
        ) as Promise<Response>;
  }

  /** THE CALL UNDER A CAUSE (`walkUnderCause`): a caller's `itx.facets.get(name).<steps>`, the
   *  alarm's revive. On no list: only the platform calls it (core/itx/src/context/facet-host.ts). */
  callWithCause(cause: unknown, steps: RpcSteps, onBehalfOf?: OnBehalfOf): Promise<unknown> {
    return walkUnderCause(this, cause, steps, undefined, onBehalfOf);
  }

  /** This class's `publicMethods`, for the context that loaded it — a static does not cross the
   *  isolate. On no list: only the context asks it. */
  listPublicMethods(): readonly string[] {
    // `this.constructor` is the concrete facet class, a subclass of this one; TypeScript types it as
    // `Function`, which has no `publicMethods`.
    return (this.constructor as typeof FacetDurableObject).publicMethods;
  }

  /** This class's `personMethods`, for the context, which asks when a person's view calls. On no
   *  list, as `listPublicMethods`. */
  listPersonMethods(): readonly string[] {
    return (this.constructor as typeof FacetDurableObject).personMethods;
  }

  /** WHO ASKED, never what they may do: the person whose own call is running this method. A
   *  member who called through their session (`principal`, with `grant` and `via`), or a person
   *  who called a person method through their one-context view. Of a person who is no member it
   *  holds what another person's view reads of them: `principal.actor` (a stable id),
   *  `principal.name`, and `principal.kind: "guest"` for a guest; no address and no grant.
   *  `call` is `<path>#<facet>.<method>`.
   *
   *  `member: true` says that a member of the mind asked, in their session or through a view.
   *  It is the only mark of a member: a person who proved an address and is no member has no
   *  `kind` either, and their `name` can be the start of that address. A key's session names the
   *  service that the key speaks for, with no mark.
   *
   *  Read it at the start of the method. It belongs to the call's async context: work that the
   *  call started and nobody awaited (a timer, a floating promise, `runInBackground`) still reads
   *  that call's asker after the call ended.
   *
   *  The context answers it from its own record of the call, never from anything the calling
   *  code wrote (core/itx/src/on-behalf-of.ts `askerOf`). So it is undefined for every call that
   *  code made: a member's script, an agent's tool, another worker or facet, a delivery. It is
   *  undefined in `fetch` and outside a call too. It grants nothing: decide from this facet's own
   *  records. A field, as `getItx` is: Workers RPC reaches a class's methods. */
  protected readonly onBehalfOf = (): OnBehalfOf | undefined => currentOnBehalfOf();

  /** `using itx = this.getItx()`: this facet's context's scope, released with every call made
   *  through it when the block ends (itx-scope.ts). Keep no RPC values past the block; see
   *  test/vitest/os/context-residency.e2e.test.ts, "A FACET DOES NOT OUTLIVE ITS CONTEXT", for why.
   *  A field, not a method: Workers RPC reaches a class's methods, and no caller may get the scope. */
  protected readonly getItx = (): Scope & Disposable => itxScope(this.#itxEntrypoint());

  /** The loopback to this facet's context: a LOADED class gets it as `env.ITX` (the loader bakes the
   *  stub in, worker-loader.ts); a class of THIS worker hosted through `ctx.exports` has the
   *  worker's real env and mints the same stub itself from its props — `ctx.exports` is populated
   *  inside a facet (test/vitest/os-workers/facets.test.ts). The casts name what workers-types cannot:
   *  this worker's own `ItxEntrypoint` export, and the scope its `get` answers, which `Scope` is. */
  #itxEntrypoint(): { get(): Scope; fetch(request: Request): Promise<Response> } {
    return (this.env.ITX ??
      (
        this.ctx.exports as unknown as {
          ItxEntrypoint: (options: { props: object }) => ItxEntrypointService;
        }
      ).ItxEntrypoint({
        // PLATFORM: this worker's own class, minted from its own exports — the full handle, the fixed
        // point spellable, `cd` free to go up. A LOADED class never reaches this branch (it has
        // `env.ITX`, baked in by the loader, and its own module's exports).
        props: { iterateContextName: this.ctx.props.iterateContextName, platform: true },
      })) as unknown as {
      get(): Scope;
      fetch(request: Request): Promise<Response>;
    };
  }
}

/** What hands the itx scope over — a loaded worker's `env.ITX`, or the loopback a class of the
 *  platform's own worker mints from `ctx.exports`: `get()` its scope (a context's declared API,
 *  api.ts, which a capnweb stub of core/itx's `IterateContextRpcTarget` satisfies), or `fetch` a
 *  request through the context's dispatch (a fetch route's target, the `x-itx-expression` header). */
export type ItxEntrypointService = {
  get(): IterateContextApi;
  fetch(request: Request): Promise<Response>;
};
/** The least a host needs of its scope: the fixed-point log calls the engine makes. The platform's own
 *  facets pass the Workers-RPC STUB of a context (every dotted step pipelined; a property there is a
 *  promise), which no plain-promise interface can name — so the constraint is this, not
 *  `IterateContextApi`. */
export type ProcessorScope = {
  append(...events: StreamEventInput[]): Promise<unknown>;
  readEvents(afterOffset?: number, limit?: number): Promise<unknown>;
  /** The engine's claim on the context's alarm (processor.ts rule 3): "come back by `at`", or null. */
  processors: { claim(name: string, at: number | null): Promise<unknown> };
  /** Another context of the mind by its dotted surface (`.append`), which the platform's handle
   *  and a loaded worker's alike answer — how an entity's processor cross-posts its certificate to
   *  `/` (`itx.cd("/").append(certificate)`). Through the table like every other
   *  word here: anyone's `cd(path).append` reaches any context of the mind, stamped with where
   *  it came from; a jail's bare null refuses it. */
  cd(path: string): { append(...events: StreamEventInput[]): Promise<unknown> };
};

export abstract class StreamProcessorDurableObject<
  State = unknown,
  Env extends { ITX?: ItxEntrypointService } = { ITX: ItxEntrypointService },
  Scope extends ProcessorScope = IterateContextApi,
> extends FacetDurableObject<Env, Scope> {
  /** The reads a caller reaches on every processor: `fetch`, and the state caught up through the log
   *  (`snapshot`, `liveSnapshot`) or awaited (`waitUntilProcessed`). What feeds the processor —
   *  `processEventBatch`, `catchUpFromLog`, `revive` — is the platform's, never a caller's. */
  static override publicMethods = [
    ...super.publicMethods,
    "snapshot",
    "liveSnapshot",
    "waitUntilProcessed",
  ];

  /** The processor this object hosts — `processor = new PresenceProcessor()` at the top of the subclass. */
  abstract readonly processor: StreamProcessor<State>;

  // ── what an author reaches (the itx scope: `this.getItx()`; identity: `this.ctx.props`) ──

  /** After a runtime field on the processor moved OUTSIDE a batch (an RPC method on this object);
   *  inside `processEvent` the engine re-projects on its own. */
  protected publishLiveState(): void {
    this.#engine.publishLiveState();
  }

  // ── what the platform calls: the delivery loop's push and catch-up, the alarm's revive ──

  /** THE push: the context hands over each committed batch with its scanned-range proof, and its
   *  own `append` for this facet's engine (direct-append.ts). */
  processEventBatch(
    events: StreamEvent[],
    range: ScannedRange,
    directAppend?: DirectAppend,
  ): Promise<void> {
    if (directAppend) this.#directAppend.hold(directAppend);
    return this.#engine.processEventBatch(events, range);
  }

  readonly #directAppend = new DirectAppendHolder();

  /** Catch up from the log (the delivery loop's, when a row is configured or resumed). */
  catchUpFromLog(): Promise<void> {
    return this.#engine.catchUpFromLog();
  }
  /** THE REVIVE: the context's alarm pass calls it for a due claim — catch up, then run the
   *  at-head pass, so an attempt the last incarnation was running is started again from state. */
  revive(): Promise<void> {
    return this.#engine.revive();
  }

  // ── what a caller reaches by itx expression (`publicMethods`) ──

  /** Caught up through the log, then `{ offset, state }`. */
  snapshot(): Promise<{ offset: number; state: State }> {
    return this.#engine.snapshot();
  }
  /** The live-state seed read: `{ rev, state: projectLiveState(reduced) }`. */
  liveSnapshot(): Promise<{ rev: number; state: unknown }> {
    return this.#engine.liveSnapshot();
  }
  /** The barrier: resolves once processed at least through `offset` (default timeout 10s). */
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void> {
    return this.#engine.waitUntilProcessed(input);
  }

  // ── the engine: one ProcessorEngine over `processor` and this object's storage, built on first use —
  // `processor` is a subclass field, which does not exist yet while this base class constructs. ──
  #engineBuiltOnFirstUse?: ProcessorEngine<State>;
  get #engine(): ProcessorEngine<State> {
    return (this.#engineBuiltOnFirstUse ??= new ProcessorEngine(this.processor, {
      // The engine's own emits, catch-up and gap repair are the CONTEXT ROOTS `append`, `readEvents`,
      // `processors.claim` — implicit in every context (itx-expression-rewriting.ts rule 3), so they
      // resolve to this log with no row and no hop; a row at `itx.append` is the OWNER's deliberate
      // wall (a jailed processor halts visibly), never a loaded worker's — the fixed point is not a
      // loaded worker's word.
      stream: {
        // A stub scope's answers are pipelined shapes by type and plain data on the wire (the
        // engine awaits them): the engine's own types, asserted.
        append: async (...events) => {
          const appended = await this.#directAppend.append(currentCause(), events);
          if (appended) return appended;
          using itx = this.getItx();
          return (await itx.append(...events)) as StreamEvent[];
        },
        read: async (after, limit) => {
          using itx = this.getItx();
          return (await itx.readEvents(after, limit)) as StreamPage;
        },
        claim: async (at) => {
          using itx = this.getItx();
          return await itx.processors.claim(this.ctx.props.name, at);
        },
      },
      storage: new ReduceCheckpointTable(this.ctx.storage.sql),
      fedByPushes: this.ctx.props.fedByPushes === true,
      kv: this.ctx.storage.kv,
      codeId: this.ctx.props.codeId,
    }));
  }
}

/** What `processEvent` is handed: one event, and the mind's root, typed with the installed apps
 *  the config repo's init case gives it (`IterateConfigProcessEventArgs<"agents">`). */
export type IterateConfigProcessEventArgs<App extends keyof InstalledAppRoots = never> = {
  event: StreamEvent;
  itx: IterateContextApiWith<App>;
};

/** WHAT A MIND HOSTS BESIDE ITS OWN CODE — an integration package (iterate-telegram,
 *  iterate-github, …: github.com/jonastemplestein/iterategrations), two hooks the config repo
 *  lists in `const integrations: Integration[]` and its worker dispatches to
 *  (core/configs/default/integrations.ts, every-event.ts). A package's install hook is its `mind/worker-updated` case:
 *  there it registers its card on the mind's `/integrations` context (iterate/integrations),
 *  keyed by that event's path and offset, so the Dash lists it after every publish and a retry
 *  appends nothing new. A package keeps nothing across calls: not the host, not a scope, not a
 *  handle. */
export type Integration = {
  /** A request on the package's own hostname, handed over by the worker in a case of its `fetch`
   *  (`case "telegram": return telegram.fetch(request, this)`), so a package never sees another's
   *  requests, and an error in one page breaks no other host. `host` is the worker:
   *  `using itx = host.getItx()` for the mind's scope, and for a members-only page the gate every
   *  private page needs:
   *  `const denied = host.auth.require(request); if (denied) return denied;`. A webhook needs no
   *  gate: it proves itself with a signature (`itx.secrets.verifyHmac`). A sender that can only
   *  present a secret as it is (`itx.secrets.verifyEquals`) can be shut out by anyone for a minute
   *  with twenty wrong guesses: use it only where the sender cannot sign. */
  fetch?(
    request: Request,
    host: Pick<IterateConfigEntrypoint, "getItx" | "auth">,
  ): Promise<Response>;
  /** Every durable event of the mind, as `processEvent` is handed it: unordered, at least once,
   *  so each reaction is an append keyed by the event's path and offset. Return for an event the
   *  package does not handle: a hook that throws fails the whole worker's handling of that event,
   *  which the platform retries, and one that throws on every event slows the mind's own cases
   *  to a trickle. */
  processEvent?(args: IterateConfigProcessEventArgs): Promise<void>;
};

/** Stateless config entrypoint, the default export of a mind's config repo; its init handles
 *  `events.iterate.com/mind/worker-updated` (core/configs/default/worker.ts, init.ts). */
export abstract class IterateConfigEntrypoint<
  Env extends { ITX: ItxEntrypointService } = { ITX: ItxEntrypointService },
> extends WorkerEntrypoint<Env> {
  /** At fetch entry: `const denied = this.auth.require(request); if (denied) return denied;`
   *  It lets in a mind member (or the operator) alone. `this.auth.principal(request)` names who
   *  is stamped as a principal: a member, or another mind that signed its request, which is no
   *  member (`kind: "mind"`). Read both through `this.auth`, never by hand. A page for people who are not members asks
   *  with `this.auth.requirePerson(request)` and reads who they are with
   *  `this.auth.person(request)` (`x-itx-person`). A private route answers the platform's sign-in
   *  challenge, which the edge turns into the sign-in for a page load:
   *
   *  ```js
   *  const refused = this.auth.require(request);
   *  if (refused) return refused;
   *  ```
   *  Public, so a package the worker hosts (`Integration`) reaches it through the worker. */
  readonly auth = auth;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    // WHAT THE CONFIG'S OWN CODE THREW, which nothing else sees (./code-failed.ts): a throw of
    // its `fetch`, and a rejection of a promise it hands `this.ctx.waitUntil`, are each one
    // `mind/code-failed` fact on `/`, appended after the answer through the runtime's own
    // `waitUntil`. Recording never throws: the author's error is what the caller gets.
    const keepAlive = ctx.waitUntil;
    const hold = (promise: Promise<unknown>) => keepAlive.call(ctx, promise);
    const record = (where: CodeFailedWhere, caught: unknown, request?: Request) => {
      try {
        const fact = codeFailedFact(where, caught, request);
        if (fact) hold(this.#appendCodeFailed(fact));
      } catch (error) {
        reportIssue("config.code-failed", error);
      }
    };
    // The author's `fetch` runs under the cause its Request carries (../cause.ts), and its throw
    // or rejection reaches the caller unchanged. The loader never type-checks a config, so a
    // class may lack the abstract `fetch`: each request then gets a page that says so, never a
    // TypeError (the publication records the lack once: `mind/worker-updated`'s `missing`).
    const serve = implemented(this, "fetch");
    this.fetch = (request: Request) =>
      serve
        ? runCausedBy(
            causeOfRequest(request),
            async () => {
              try {
                return await serve.call(this, request);
              } catch (error) {
                record("fetch", error, request);
                throw error;
              }
            },
            "clear",
          )
        : new Response("This mind's config has no fetch method, so it serves no page.\n", {
            status: 501,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
    // workerd lets a loaded class give its own `ctx` an own `waitUntil`, and the author's
    // `this.ctx.waitUntil` then calls it (core/mind-worker/src/context/config-code-failed.test.ts).
    // A rejection is caught there, logged (scrubbed, as its fact is) and recorded; `waitUntil`
    // from `cloudflare:workers` is not caught.
    ctx.waitUntil = (promise: Promise<unknown>) =>
      hold(
        promise.catch((error: unknown) => {
          reportIssue("config.wait-until", scrubbedError(error));
          record("waitUntil", error);
        }),
      );
  }

  /** One `mind/code-failed` on `/`, through the config's own scope. A failed append is reported
   *  once and dropped; a key that another isolate wrote first is the same fact. */
  async #appendCodeFailed(fact: StreamEventInput): Promise<void> {
    try {
      using itx = this.getItx();
      await itx.append(fact);
    } catch (error) {
      if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") reportIssue("config.code-failed", error);
    }
  }

  /** The platform's delivery of one event (the dispatch boundary refuses any other caller),
   *  through `callWithCause`: `processEvent` under ONE scope, released when it settles. A class
   *  that lacks the abstract `processEvent` takes each event as handled: the publication records
   *  the lack once for its commit (`mind/worker-updated`'s `missing`), and no event fails for it. */
  async deliverEvent(event: StreamEvent): Promise<void> {
    using itx = this.getItx();
    // Another mind's event never reaches `processEvent`, so no case there can take it for the
    // mind's own: it goes to `processMindEvent` alone, which reads it as data.
    const signer = event.source.signer?.principal;
    if (signer?.kind === "mind")
      await this.processMindEvent({ event, mind: signer.actor, hostname: signer.hostname, itx });
    else await implemented(this, "processEvent")?.call(this, { event, itx });
  }

  /** THE CALL UNDER A CAUSE (`walkUnderCause`) every method but `fetch` is called through, with the
   *  context it came from (`callerPath`). On no list: only the platform calls it
   *  (core/itx/src/context/built-ins.ts `workers`). */
  callWithCause(cause: unknown, steps: RpcSteps, callerPath?: string): Promise<unknown> {
    return walkUnderCause(this, cause, steps, callerPath);
  }

  /** `using itx = this.getItx()`: the mind root's scope, released with every call made through
   *  it when the block ends (`FacetDurableObject.getItx` says why nothing is kept past it). A field,
   *  not a method: Workers RPC reaches an entrypoint's methods, and a caller must never get the
   *  scope (sdk/index.test.ts). Public, so a package the worker hosts (`Integration`) reaches it
   *  through the worker. */
  readonly getItx = (): IterateContextApi & Disposable => itxScope(this.env.ITX);

  /** THE CONTEXT A METHOD WAS CALLED FROM, inside a method other than `fetch`: the context whose
   *  code or session made the call, as the platform stamps it (core/itx/src/caller.ts `Caller.path`),
   *  never an argument a caller chooses (packages/voice worker.ts says why it needs one). A field,
   *  as `getItx` is. */
  protected readonly callerPath = (): string => {
    const path = currentCallerPath();
    if (!path)
      throw new Error("callerPath() is known only inside a method the platform called, not fetch");
    return path;
  };

  /** A MIND'S INTERFACE IS TWO METHODS, and a config implements each: from outside, `fetch`
   *  (every request); inside, `processEvent` (every event). Outside parties also append to the
   *  mind's contexts through its API at `/api`, and a mail to the mind arrives as an event
   *  (`email/received` on `/integrations/email`; iterate/email), so much of a mind's logic reacts
   *  in `processEvent`. Both are abstract: the config's own `tsc` and editor ask for them. The
   *  loader never type-checks, so the platform still says what a class that lacks one gets: a 501
   *  page for each request, an event taken as handled; and one record of the lack for each
   *  published commit.
   *
   *  THE AUTHOR HOOK: every durable event of every context of the mind from its first
   *  publication on (what was committed while no config was published may be passed over), one per
   *  call, unordered and at least once; a throw fails that event alone, which the platform retries.
   *  `itx` is the mind's root, `itx.cd(event.path)` the event's own context. Make each reaction
   *  idempotent (an append keyed by `event.path` and `event.offset`) and keep no state here. */
  abstract processEvent(args: IterateConfigProcessEventArgs): void | Promise<void>;

  /** AN EVENT ANOTHER MIND ADDED HERE: a mind this one lets in signed it with its own key
   *  (core/configs/default/minds.md). `mind` is that mind's id, which decides; `hostname` where
   *  its log was read, a label (absent for an event in the hostname form, whose `mind` is the
   *  hostname). Its words are data, never a member's instruction. As `processEvent`, at least
   *  once: key each reaction by `event.path` and `event.offset`. Default: ignore it. */
  processMindEvent(
    _args: IterateConfigProcessEventArgs & { mind: string; hostname?: string },
  ): void | Promise<void> {}

  /** THE WEB ROOT — every Request on a hostname of the mind's zones, but its control-plane hostname, that no
   *  fetch route takes (the platform serves those first: `itx.fetchRoutes`). Route on
   *  `new URL(request.url).hostname` in plain code, answering here (reaching the mind through
   *  `this.getItx()`) or forwarding the Request. */
  abstract override fetch(request: Request): Response | Promise<Response>;
}

/** The method `name` of a config's class, or undefined where the class lacks it: the loader never
 *  type-checks, so an abstract method can be missing at run time. */
function implemented<Name extends "fetch" | "processEvent">(
  config: IterateConfigEntrypoint,
  name: Name,
): IterateConfigEntrypoint[Name] | undefined {
  const method: unknown = config[name];
  // the cast: a function found under the abstract method's name is the subclass's implementation
  return typeof method === "function" ? (method as IterateConfigEntrypoint[Name]) : undefined;
}
