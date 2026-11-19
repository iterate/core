// person-context.ts — A SIGNED-IN PERSON'S LIVE VIEW OF ONE CONTEXT (iterate/sdk `auth.personItx`):
// the socket a page of the mind's own host opens for someone who need not be a member, rooted at
// the one context the app's answer named. The root is a fixed set of calls, each spelled at the
// platform's fixed point (`itx.builtins`), so no rewrite rule of the context changes what it
// reaches, and it never hands out the context's own `itx`. It is exactly what @iterate-com/ui's
// live chat asks of a context (core/lib/src/client/react.tsx `IterateContextHandle`).
//
// WHO CALLS. The person is no member, so the calls carry no principal: the caller is the kernel's
// own unnamed one, which the platform vouches for here because this class spells every call
// itself. Reads go as that caller. A subscription goes as that caller with the person beside it
// (`onBehalfOf`, no `call` and no `run`): the context stamps the row's event with it, so the
// subscription names who holds the callback (`heldBy`). Its lease is the session's, and ends with
// it. The calls that speak to the context carry the person beside them, as a member's page does:
// a token on the call's cause that names them (on-behalf-of.ts), which every append it makes
// verifies and stamps as `source.onBehalfOf`. Each says who asked or holds, never what they may do.
//
// A PERSON METHOD. A facet's class may name methods that a person may call (iterate/sdk
// `FacetDurableObject.personMethods`). The view takes one such call as an expression and sends it
// as the person, who is then named twice: on the kernel's own record of the call (`Caller.
// onBehalfOf`), which holds the call to the class's person methods, counts it, and is what the
// facet's `onBehalfOf()` answers (./context/facet-host.ts `handle`); and on the token, for the
// stamp of what the facet appends. A person who is no member is named there by what another
// person's view reads of them (`asAFacetIsTold`), so no address of theirs reaches a facet's code.
// The arguments and the answer are JSON within one bound (`PERSON_METHOD_MAX_CHARS`), so no stub
// crosses either way. The view decides nothing else of such a call: the facet does.
//
// WHAT THE VIEW APPENDS. Two events alone, each rebuilt from the fields it parsed, so nothing else
// the page wrote (a key, a `source`, another field) lands: the stop of an answer, in the
// platform's words, and the page's presence status (@iterate-com/ui `lib/presence.ts`), one
// ephemeral `presence/status`, which no log stores. The status names nobody and decides nothing:
// the stamp says whose it is (no `call`, no `run`, `via.appPage`), and a reader counts it only for
// the row its stamp's person holds, so a status that names another row is nobody's.
//
// WHAT THE PERSON READS OF OTHER PEOPLE. A person who is no member (a guest among them) reads
// other people by what a page draws them with, and by nothing that is theirs alone
// (`asAPersonReads`): an id to group by, a name, whether they are a guest. Every answer of the
// view and every batch its live callback gets is read that way. A member who opens the view reads
// what a member reads anywhere. It covers what the platform stamps and the states made from it,
// not words: an address that somebody wrote into a message stays in the message.
import { RpcTarget } from "capnweb";
import { type ItxExpression } from "iterate/expression";
import { codedError, releaseRpcSessions, resolveContextPath } from "iterate/lib";
import {
  nameInEmail,
  stampedCallerOf,
  stampedExpiryOf,
  stampedPersonOf,
  type Person,
  type Principal,
} from "iterate/principal";
import { z } from "zod";
import type { Caller } from "./caller.ts";
import { newChain } from "./cause.ts";
import { PERSON_METHOD_MAX_CHARS, PersonCallCount } from "./context/facet-public-methods.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import { contexts, itxHost } from "./host.ts";
import { IterateContextRpcTarget } from "./iterate-context.ts";
import { mintOnBehalfOf } from "./on-behalf-of.ts";
import { SessionTeardown, serveSession } from "./session.ts";

/** What the view reaches of its context: reads as the session's caller, which names nobody, and a
 *  subscription as that caller with the person beside it (WHO CALLS, above). */
type ContextReach = Pick<IterateContextRpcTarget, "invoke" | "subscribe">;
/** One call at the context that names the person as who asked; `call` names a facet call.
 *  `personMethod`: the call is one of a facet's person methods (A PERSON METHOD, above). */
type CallAsPerson = (
  expression: ItxExpression,
  call?: string,
  personMethod?: true,
) => Promise<unknown>;

/** How often a person's socket asks the named facet whether the person still reaches the
 *  context, at most (`admissionOf`). */
export const ADMITS_EVERY_MS = 5_000;
const ACCESS_ENDED = "your access to this context ended";
const FACET_NAME = /^[A-Za-z0-9_.-]+$/;
// The only `invoke` texts: the seed of a live state, and a facet's state, for the chat's views.
const SNAPSHOT_TEXT = /^itx\.facets\.get\('([A-Za-z0-9_.-]+)'\)\.(liveSnapshot|snapshot)\(\)$/;
// The only `invoke` expression: one call of one method of a facet of this context. Whether the
// facet offers the method to a person is the kernel's to say.
const PersonMethodCall = z.tuple([
  z.literal("itx"),
  z.literal("facets"),
  z.tuple([z.literal("get"), z.string().regex(/^[A-Za-z0-9_.-]+$/)]),
  z.tuple([z.string().min(1).max(100)], z.unknown()),
]);

const ReadEventsArgs = z.tuple([
  z.number().optional(),
  z.number().int().nonnegative().optional(),
  z.object({ includeEphemeral: z.boolean().optional() }).strict().optional(),
]);
// The page's own `name` is not taken: a name the context's processors hold would be replaced.
const SubscribeInput = z
  .object({
    name: z.string().optional(),
    consumes: z.array(z.string()).optional(),
    target: z.unknown(),
  })
  .strict();
const StopOfAnAnswer = z.tuple([
  z.object({
    type: z.literal("events.iterate.com/agent/context-added"),
    payload: z.looseObject({
      llmRequestPolicy: z.looseObject({ behaviour: z.literal("interrupt-current-request") }),
    }),
  }),
]);
const PresenceStatus = z.tuple([
  z.strictObject({
    type: z.literal("presence/status"),
    ephemeral: z.literal(true),
    payload: z.strictObject({
      subscription: z.string().min(1).max(200),
      away: z.boolean(),
      typing: z.boolean(),
      marks: z.array(z.string().min(1).max(32)).max(8).optional(),
    }),
  }),
]);
// A message's options on a person's view: its idempotency key alone (iterate/agents `AgentMessageOptions`).
const MessageOptions = z
  .object({ key: z.string().min(1).max(200).optional() })
  .strict()
  .optional();
const MessageInput = z.union([
  z.string(),
  z
    .object({
      message: z.string(),
      files: z
        .array(
          z.object({ contentType: z.string(), filename: z.string(), data: z.unknown() }).strict(),
        )
        .optional(),
    })
    .strict(),
]);

/** The chat's stop of an answer, in the platform's own words (WHAT THE VIEW APPENDS, above). */
const STOP_OF_AN_ANSWER = {
  type: "events.iterate.com/agent/context-added",
  payload: {
    role: "developer",
    content: "The user interrupted the in-progress response from the web chat.",
    actor: { type: "user" },
    llmRequestPolicy: { behaviour: "interrupt-current-request" },
  },
};

/** A value as the view's person reads it: `asAPersonReads` for them, or as it is for a member. */
type Reads = (value: unknown) => unknown;

/** Before the view's own writes (a message to the agent, the stop of an answer): throws when the
 *  person no longer reaches the context (`admissionOf`). A facet's person method
 *  is the facet's own to refuse, and a presence status writes nothing to the log. */
type Admitted = () => Promise<void>;

/** A page's live callback as capnweb hands it over: a callable stub (context/rpc-stub-relay.ts
 *  `ClientRpcStub`). */
type LiveCallback = ((events: unknown, range: unknown) => unknown) & {
  dup(): LiveCallback;
  itxLivenessProbe(): unknown;
  onRpcBroken?(broken: () => void): void;
  [Symbol.dispose]?(): void;
};

export class PersonContextRpcTarget extends RpcTarget {
  readonly #path: string;
  readonly #context: ContextReach;
  readonly #asPerson: CallAsPerson;
  // this socket's calls of a person method, counted before their arguments are read
  readonly #personCalls = new PersonCallCount();
  readonly #admitted: Admitted;

  /** `reads`: how the person reads each answer and each batch of events (WHAT THE PERSON READS
   *  OF OTHER PEOPLE, above). It wraps each call into the context here, so no method below
   *  can leave it out. */
  constructor(
    path: string,
    context: ContextReach,
    asPerson: CallAsPerson,
    reads: Reads,
    admitted: Admitted = async () => {},
  ) {
    super();
    this.#path = path;
    this.#admitted = admitted;
    this.#context = {
      invoke: async (call, ...args) => reads(await context.invoke(call, ...args)),
      subscribe: (input) =>
        context.subscribe({
          ...input,
          // the view's own `subscribe` lets a live callback alone through
          target: readingCallback(input.target as LiveCallback, reads),
        }),
    };
    // A person method's answer is made JSON first (`jsonAnswerOf`), so the reading walks plain data.
    this.#asPerson = async (...call) => {
      const [, name, personMethod] = call;
      const answer = await asPerson(...call);
      return reads(personMethod ? jsonAnswerOf(answer, name || "a person method") : answer);
    };
  }

  /** Itself, for its own path; any other path is refused. */
  cd(path: unknown): PersonContextRpcTarget {
    this.#ownPath(path, "cd");
    return this;
  }

  readEvents(...args: unknown[]): Promise<unknown> {
    const parsed = wireInput(ReadEventsArgs, args, "readEvents(afterOffset?, limit?, options?)");
    while (parsed.length > 0 && parsed.at(-1) === undefined) parsed.pop();
    return this.#context.invoke(["itx", "builtins", ["readEvents", ...parsed]]);
  }

  /** A live callback alone, under a name the kernel mints. */
  subscribe(input: unknown) {
    const { consumes, target } = wireInput(
      SubscribeInput,
      input,
      "subscribe({ consumes?, target })",
    );
    // as the kernel's own `subscribe` tells a live callback: reading `path` on a stub gives a stub
    const isLiveCallback =
      !!target &&
      typeof target !== "string" &&
      !Array.isArray(target) &&
      typeof (target as { path?: unknown }).path !== "string";
    if (!isLiveCallback)
      throw codedError("FORBIDDEN", "subscribe on a person's view takes a live callback alone");
    // The cast: the check above left an object or a function, which is what capnweb hands over for
    // a stub, and the kernel's lend refuses anything else.
    return this.#context.subscribe({
      consumes,
      target: target as (events: unknown[], range: unknown) => void,
    });
  }

  get subscriptions(): ListRpcTarget {
    return new ListRpcTarget(() =>
      this.#context.invoke(["itx", "builtins", "subscriptions", ["list"]]),
    );
  }

  get rpcStubs(): ListRpcTarget {
    return new ListRpcTarget(() => this.#context.invoke(["itx", "builtins", "rpcStubs", ["list"]]));
  }

  /** `itx.facets.get('<name>').liveSnapshot()` or `….snapshot()`, as that exact text; or one
   *  person method of a facet, as `["itx", "facets", ["get", name], [method, ...args]]`
   *  (A PERSON METHOD, above). */
  invoke(call: unknown, ...args: unknown[]): Promise<unknown> {
    const match = typeof call === "string" && args.length === 0 && SNAPSHOT_TEXT.exec(call);
    if (match) {
      const [, facet, method] = match;
      return this.#context.invoke(["itx", "builtins", "facets", ["get", facet], [method]]);
    }
    this.#personCalls.count("this socket", this.#path);
    const personMethod = args.length === 0 ? PersonMethodCall.safeParse(call) : undefined;
    if (!personMethod?.success)
      throw codedError(
        "FORBIDDEN",
        'invoke on a person\'s view takes `itx.facets.get(\'<name>\').liveSnapshot()` or `….snapshot()` as text, or one method that a facet offers a person, as ["itx", "facets", ["get", name], [method, ...args]]',
      );
    const [, , [, facet], [method, ...methodArgs]] = personMethod.data;
    const json = jsonOf(methodArgs);
    if (!json || json.length > PERSON_METHOD_MAX_CHARS)
      throw codedError(
        "INVALID_INPUT",
        json
          ? `the arguments of ${facet}.${method} are ${json.length} characters of JSON, over the ${PERSON_METHOD_MAX_CHARS} that a person's call may carry`
          : `the arguments of ${facet}.${method} are not JSON: a person's call carries plain data, never a callback or a stub`,
      );
    return this.#asPerson(
      // the arguments as their JSON says them: what was measured is what the facet gets
      ["itx", "builtins", "facets", ["get", facet], [method, ...JSON.parse(json)]],
      `${this.#path}#${facet}.${method}`,
      true,
    );
  }

  /** The chat's stop of an answer, which the platform appends in its own words, or the page's
   *  presence status, rebuilt from its parsed fields (WHAT THE VIEW APPENDS, above). */
  append(...events: unknown[]): Promise<unknown> {
    const status = PresenceStatus.safeParse(events);
    if (status.success) {
      const [{ type, ephemeral, payload }] = status.data;
      return this.#asPerson(["itx", "builtins", ["append", { type, ephemeral, payload }]]);
    }
    if (!StopOfAnAnswer.safeParse(events).success)
      throw codedError(
        "FORBIDDEN",
        "append on a person's view takes one event alone: the chat's stop of an answer (an events.iterate.com/agent/context-added with llmRequestPolicy.behaviour interrupt-current-request), or the page's presence status (an ephemeral presence/status with { subscription, away, typing, marks? } and no other field)",
      );
    return this.#admitted().then(() =>
      this.#asPerson(["itx", "builtins", ["append", STOP_OF_AN_ANSWER]]),
    );
  }

  get files(): FilesRpcTarget {
    return new FilesRpcTarget((file) => {
      if (
        typeof file !== "string" ||
        !file.startsWith(this.#path === "/" ? "/" : `${this.#path}/`) ||
        resolveContextPath("/", file) !== file
      )
        throw codedError(
          "FORBIDDEN",
          `files on a person's view reach a file under ${JSON.stringify(this.#path)} alone, by its plain path`,
        );
      return new FileUrlRpcTarget(() =>
        this.#context.invoke(["itx", "builtins", "files", ["get", file], ["url"]]),
      );
    });
  }

  get agents(): AgentsRpcTarget {
    return new AgentsRpcTarget((path, input, options) => {
      this.#ownPath(path, "agents.get");
      const words = wireInput(MessageInput, input, "agents.get(path).message(input, { key? })");
      const { key } =
        wireInput(MessageOptions, options, "agents.get(path).message(input, { key? })") ?? {};
      // the sender is a person, as on a member's page: `/` (core/lib/src/agents/collection.ts); a
      // key makes a retry land once
      const message: [string, ...unknown[]] = key
        ? ["message", words, "/", { key }]
        : ["message", words, "/"];
      // the checks above throw at once; the question to the facet comes after them
      return this.#admitted().then(() =>
        this.#asPerson(
          ["itx", "builtins", "facets", ["get", "agent"], message],
          `${this.#path}#agent.message`,
        ),
      );
    });
  }

  #ownPath(path: unknown, verb: string): void {
    if (typeof path !== "string" || resolveContextPath(this.#path, path) !== this.#path)
      throw codedError(
        "FORBIDDEN",
        `${verb} on a person's view reaches ${JSON.stringify(this.#path)} alone, not ${JSON.stringify(path)}`,
      );
  }
}

// capnweb exposes prototype members only, so each nested name is a class of its own.
class ListRpcTarget extends RpcTarget {
  readonly #list: () => Promise<unknown>;
  constructor(list: () => Promise<unknown>) {
    super();
    this.#list = list;
  }
  list(): Promise<unknown> {
    return this.#list();
  }
}

class FilesRpcTarget extends RpcTarget {
  readonly #get: (file: unknown) => FileUrlRpcTarget;
  constructor(get: (file: unknown) => FileUrlRpcTarget) {
    super();
    this.#get = get;
  }
  /** Refused here, for a file outside the view. */
  get(file: unknown): FileUrlRpcTarget {
    return this.#get(file);
  }
}

class FileUrlRpcTarget extends RpcTarget {
  readonly #url: () => Promise<unknown>;
  constructor(url: () => Promise<unknown>) {
    super();
    this.#url = url;
  }
  /** A signed download URL, with its default lifetime. */
  url(): Promise<unknown> {
    return this.#url();
  }
}

class AgentsRpcTarget extends RpcTarget {
  readonly #message: (path: unknown, input: unknown, options: unknown) => Promise<unknown>;
  constructor(message: (path: unknown, input: unknown, options: unknown) => Promise<unknown>) {
    super();
    this.#message = message;
  }
  get(path: unknown): AgentRpcTarget {
    return new AgentRpcTarget((input, options) => this.#message(path, input, options));
  }
}

class AgentRpcTarget extends RpcTarget {
  readonly #message: (input: unknown, options: unknown) => Promise<unknown>;
  constructor(message: (input: unknown, options: unknown) => Promise<unknown>) {
    super();
    this.#message = message;
  }
  /** `options`: `{ key }` alone, which makes a retry land once (iterate/agents `AgentMessageOptions`). */
  message(input: unknown, options?: unknown): Promise<unknown> {
    return this.#message(input, options);
  }
}

/** A PERSON'S SOCKET (iterate/sdk `auth.personItx`). The config worker's answer asked for it and
 *  named the context; it named no caller and handed over no Request. The person is the one the
 *  boundary stamped on the Request this invocation was given, so nothing user code built or
 *  altered is read. As a member's socket (serve-host.ts `itxSession`): a WebSocket upgrade from
 *  this origin alone, ended when the person's sign-in ends. */
export async function personItxSession(args: {
  ctx: ExecutionContext;
  request: Request;
  path: string | null;
  /** The facet the answer named to ask `admits()` (`admissionOf`), or none. */
  admits?: string | null;
}): Promise<Response> {
  const { ctx, request } = args;
  const url = new URL(request.url);
  const person = stampedPersonOf(request);
  const endsAt = stampedExpiryOf(request);
  if (!person || !endsAt)
    return new Response("Sign in\n", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Bearer realm="iterate", scope="identity"',
        "Cache-Control": "no-store",
      },
    });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return new Response("Open this path as a WebSocket: it is the page's view of one context.\n", {
      status: 426,
      headers: { upgrade: "websocket" },
    });
  if (request.headers.get("origin") !== url.origin)
    return new Response("This socket opens from a page of this host alone\n", { status: 403 });
  const path = canonicalPathOf(args.path);
  if (!path)
    return new Response(
      `The app's answer named no context, or no canonical path: ${JSON.stringify(args.path)}\n`,
      { status: 500 },
    );
  const onBehalfOf = { principal: principalOf(person), via: { appPage: url.hostname } };
  const { member, ...toAFacet } = { ...onBehalfOf, ...asAFacetIsTold(request, person) };
  const asThePersonReads = readsOf(request, person);
  const asPerson: CallAsPerson = async (expression, call, personMethod) => {
    const { signingSecret } = itxHost();
    if (!signingSecret)
      throw new Error("this host signs no token that names a person: it sends nothing as one");
    const asked = { ...(personMethod ? toAFacet : onBehalfOf), call };
    const token = await mintOnBehalfOf(asked, await signingSecret(), Date.now());
    const caller: Caller = {
      principal: null,
      cause: { ...newChain("a person's page"), onBehalfOf: token },
      // The kernel's own record that a person asks, and whether they are a member: it holds the
      // call to person methods. The mark is here alone, never on the token.
      ...(personMethod && { onBehalfOf: { ...asked, member } }),
    };
    return new IterateContextRpcTarget(
      contexts(),
      DurableObjectNameCodec.address(path),
      new SessionTeardown(),
      (promise) => ctx.waitUntil(promise),
      caller,
    ).invoke(expression);
  };
  const admission = admissionOf({
    facet: args.admits,
    member: !!member,
    ask: (facet) =>
      asPerson(
        ["itx", "builtins", "facets", ["get", facet], ["admits"]],
        `${path}#${facet}.admits`,
        true,
      ),
  });
  return serveSession(ctx, {
    caller: { principal: null },
    endsAt,
    endReason: "the sign-in for this session ended: sign in again",
    onFrame: admission.onFrame,
    root: (context, teardown) => {
      const reads = context.cd(path);
      // The kernel's own code names the person here, so no signed token is needed, and a redial
      // hours later stamps the same holder.
      const holder = new IterateContextRpcTarget(
        contexts(),
        DurableObjectNameCodec.address(path),
        teardown,
        (promise) => ctx.waitUntil(promise),
        { principal: null, onBehalfOf },
      );
      return new PersonContextRpcTarget(
        path,
        {
          invoke: (call, ...callArgs) => reads.invoke(call, ...callArgs),
          subscribe: (input) => holder.subscribe(input),
        },
        asPerson,
        asThePersonReads,
        admission.gate,
      );
    },
  });
}

/** ADMITS: whether a person who is no member still reaches the context, by the facet the app's
 *  answer named (iterate/sdk `auth.personItx`, `admits`). `ask` calls that facet's person method
 *  `admits()` as the person. `gate` asks before each of the view's own writes and refuses on a no;
 *  `onFrame` asks on the socket's traffic at most every `ADMITS_EVERY_MS` and ends the session on a
 *  no. A throw is a no, and a no is final, and so is a name that is no facet's name. A member, or an
 *  answer that named no facet, is never asked: then there is no `onFrame`, and the gate lets every
 *  write through. */
export function admissionOf(args: {
  facet: string | null | undefined;
  member: boolean;
  ask: (facet: string) => Promise<unknown>;
  now?: () => number;
}) {
  const now = args.now || Date.now;
  const named = !args.member && !!args.facet;
  const facet = named && FACET_NAME.test(args.facet!) ? args.facet! : null;
  // a name that is no facet's name is a no: a typo in an app never leaves the socket open
  let refused = named && !facet;
  let askedAt = now();
  const admitted = async () => {
    if (refused) return false;
    if (!facet) return true;
    // a no only ever sets it: an answer that comes later, from a check that started earlier,
    // never clears it
    if ((await args.ask(facet).catch(() => false)) !== true) refused = true;
    return !refused;
  };
  return {
    gate: async () => {
      if (!(await admitted())) throw codedError("FORBIDDEN", ACCESS_ENDED);
    },
    onFrame: named
      ? async () => {
          if (!refused && now() - askedAt < ADMITS_EVERY_MS) return;
          askedAt = now();
          if (!(await admitted())) return ACCESS_ENDED;
        }
      : undefined,
  };
}

/** HOW THE VIEW'S PERSON READS. The boundary stamps a principal beside the person for a member
 *  alone (core/boundary-worker/src/stamp.ts): a member reads here what they read in their own
 *  session. Anyone else, a guest among them, reads as `asAPersonReads` says. */
export function readsOf(request: Request, person: Person): Reads {
  return stampedCallerOf(request).principal
    ? (value) => value
    : (value) => asAPersonReads(value, person.userId);
}

/** WHO A FACET IS TOLD ASKED, for a person method. A member is told whole, as in their own
 *  session, and marked a member: the boundary stamps a principal beside the person for a member
 *  alone (`readsOf`). Anyone else is told as another person's view reads them (`asAPersonReads`):
 *  their id, their name, and whether they are a guest. The token of such a call holds the same
 *  principal, because loaded code can read the token on its cause, and never the mark. */
export function asAFacetIsTold(
  request: Request,
  person: Person,
): { principal: Principal; member?: true } {
  const principal = principalOf(person);
  if (stampedCallerOf(request).principal) return { principal, member: true };
  // No viewer is "": the person is read as someone else reads them. The cast: `asAPersonReads`
  // answers `unknown`, and of a principal it keeps `actor` and drops or adds only optional fields.
  return { principal: asAPersonReads(principal, "") as Principal };
}

/** WHAT A PERSON WHO IS NO MEMBER READS OF OTHER PEOPLE, in any value the view hands them: an
 *  event, a subscription's row, a facet's state, a live state's delta. It goes by shape, because
 *  the platform's stamp sits in many places (`source.principal`, `source.onBehalfOf`, a
 *  schedule's `definedBy`, a row's `heldBy`, an agent's `saidBy`), and a place that is added
 *  later is covered too.
 *  - WHO SOMEONE IS (an object with a string `actor`) keeps the `actor`, to group by, and what a
 *    page draws them with (`name`, `kind`). It loses `email` and `impersonatedBy`. A person with
 *    an address and no name gets the name every person has: the part before the "@"
 *    (iterate/principal `nameInEmail`).
 *  - WHAT IS OF A SESSION goes: every `grant` (an OAuth grant's id, or a key's) but the one
 *    beside the viewer's own `principal`, also where no principal stands beside it; and a rule's
 *    `lentBy`, which is a grant too.
 *  - THE VIEWER'S OWN (`actor` is `viewer`) stays whole, with the grant beside it.
 *  - A LIVE STATE'S DELTA (`{ from, to, patch }`) whose patch names any of this is sent with no
 *    patch, which tells the page to read the state again (core/lib `LiveStateDelta`): the state
 *    it reads is one read this way, and a patch made against the whole state may not fit it.
 *  Nothing else changes, and a value with none of this comes back as the same object. */
export function asAPersonReads(value: unknown, viewer: string): unknown {
  if (Array.isArray(value)) {
    const read = value.map((item) => asAPersonReads(item, viewer));
    if (read.every((item, index) => item === value[index])) return value;
    return read;
  }
  if (!isJsonObject(value) || value.actor === viewer) return value;
  const someone = namesSomeone(value);
  const ofTheViewer = isJsonObject(value.principal) && value.principal.actor === viewer;
  const read: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const theirsAlone =
      key === "lentBy" ||
      (someone && (key === "email" || key === "impersonatedBy")) ||
      (key === "grant" && !ofTheViewer);
    if (!theirsAlone) read[key] = asAPersonReads(field, viewer);
  }
  if (someone && typeof value.email === "string" && typeof value.name !== "string") {
    const name = nameInEmail(value.email);
    if (name) read.name = name;
  }
  if (
    isLiveStateDelta(value) &&
    (read.patch !== value.patch || value.patch.some(patchesWhatAPersonDoesNotRead))
  )
    read.patch = null;
  const same =
    Object.keys(read).length === Object.keys(value).length &&
    Object.entries(read).every(([key, field]) => field === value[key]);
  if (same) return value;
  return read;
}

/** A JSON object, as an event, a row and a Workers RPC answer hold one: no array, and no
 *  instance of a class. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  // oxlint-disable-next-line iterate/simple-truthiness-check -- a guard over `unknown`: the value has no declared type to trust
  if (!value || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** ONE VALUE OF A JSON WALK: a leaf that JSON holds (text, a finite number, a boolean, null), an
 *  absent value, which JSON leaves out, or an array or a plain object, whose members the walk
 *  visits next. A guard and no schema: it runs for every value of up to 8 MiB that a person sent. */
function isJsonNode(value: unknown): boolean {
  switch (typeof value) {
    case "string":
    case "boolean":
    case "undefined":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      // null, an array, or a plain object; never an instance of a class (bytes, a stream, a date
      // that has no text)
      return !value || Array.isArray(value) || isJsonObject(value);
    default:
      return false;
  }
}

/** A value's JSON text, or "" when it is not what JSON holds: text, finite numbers, booleans,
 *  null, and arrays and plain objects of these, with no cycle and no depth that the runtime cannot
 *  walk. As JSON has it, an absent value is left out of an object and is null in an array, and a
 *  date is its text. */
function jsonOf(value: unknown): string {
  try {
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (!isJsonNode(item)) throw new TypeError("not JSON");
      return item;
    });
    return json || "";
  } catch {
    // the replacer's refusal, or the runtime's own of a cycle or of too deep a value
    return "";
  }
}

/** A PERSON METHOD'S ANSWER, AS THE PAGE GETS IT: the JSON it is, within the bound of the
 *  arguments. Anything else (a stub, a stream, a function, a cycle) is refused in words and logged
 *  for the facet's author, who alone can change it: a stub would be a reach into the facet that
 *  its class did not list. `call` is `<path>#<facet>.<method>`. */
function jsonAnswerOf(answer: unknown, call: string): unknown {
  if (answer === undefined) return undefined;
  const json = jsonOf(answer);
  if (json && json.length <= PERSON_METHOD_MAX_CHARS) return JSON.parse(json);
  releaseRpcSessions([answer]);
  const refusal = json
    ? `the answer of ${call} is ${json.length} characters of JSON, over the ${PERSON_METHOD_MAX_CHARS} that a person's call may answer`
    : `the answer of ${call} is not JSON: a person method answers plain data, never a stub, a stream or a function`;
  console.warn({
    event: "person-method.answer-refused",
    namespace: "person-context",
    message: refusal,
    call,
  });
  // a plain error: the fault is the facet's, not the page's input
  throw new Error(refusal);
}

/** Who someone is, as the platform stamps them: an object with their id in `actor`. */
const namesSomeone = (value: Record<string, unknown>) => typeof value.actor === "string";

/** A live state's delta that carries its patch (core/lib `LiveStateDelta`). */
const isLiveStateDelta = (
  value: Record<string, unknown>,
): value is Record<string, unknown> & { patch: unknown[] } =>
  Array.isArray(value.patch) && typeof value.from === "number" && typeof value.to === "number";

const PatchOperation = z.object({ path: z.string() });

/** Whether one operation of a patch writes at, or inside, a field that `asAPersonReads` drops.
 *  One that has no path is no operation the page could apply: it counts too. */
function patchesWhatAPersonDoesNotRead(operation: unknown): boolean {
  const parsed = PatchOperation.safeParse(operation);
  if (!parsed.success) return true;
  return parsed.data.path
    .split("/")
    .some((key) => ["email", "impersonatedBy", "grant", "lentBy"].includes(key));
}

/** THE PAGE'S LIVE CALLBACK, which gets each batch of events as the person reads it. The kernel's
 *  lend dups the stub, probes it, hears it break and disposes of it
 *  (context/rpc-stub-relay.ts): each of these goes to the page's own stub. */
function readingCallback(callback: LiveCallback, reads: Reads): LiveCallback {
  return Object.assign((events: unknown, range: unknown) => callback(reads(events), range), {
    dup: () => readingCallback(callback.dup(), reads),
    itxLivenessProbe: () => callback.itxLivenessProbe(),
    onRpcBroken: (broken: () => void) => callback.onRpcBroken?.(broken),
    [Symbol.dispose]: () => callback[Symbol.dispose]?.(),
  });
}

function canonicalPathOf(path: string | null): string | null {
  if (!path) return null;
  try {
    return DurableObjectNameCodec.parse(path).path;
  } catch {
    return null;
  }
}

/** The person as `onBehalfOf` names who asked: the auth Worker's user id is a principal's actor.
 *  Their name goes with them, as text to show beside what they did. A guest has no address, and
 *  is marked as one: the name is all that says who they are, and it is their own claim. */
export function principalOf(person: Person): Principal {
  if (person.method === "guest") return { actor: person.userId, name: person.name, kind: "guest" };
  // a member of another mind has no address here: their name is that mind's hostname
  if (person.method === "mind") return { actor: person.userId, name: person.name };
  return {
    actor: person.userId,
    email: person.email,
    name: person.name,
    impersonatedBy: person.impersonatedBy,
  };
}

function wireInput<T>(schema: z.ZodType<T>, value: unknown, shape: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw codedError("INVALID_INPUT", `${shape}: ${z.prettifyError(parsed.error)}`);
}
