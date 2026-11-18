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
// it. The two calls that speak to the context, the words to its agent and the stop of an answer,
// carry the person beside them, as a member's page does: a token on the call's cause that names
// them (on-behalf-of.ts), which every append it makes verifies and stamps as `source.onBehalfOf`.
// Each says who asked or holds, never what they may do.
import { RpcTarget } from "capnweb";
import { type ItxExpression } from "iterate/expression";
import { codedError, resolveContextPath } from "iterate/lib";
import { stampedExpiryOf, stampedPersonOf, type Person, type Principal } from "iterate/principal";
import { z } from "zod";
import type { Caller } from "./caller.ts";
import { newChain } from "./cause.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import { contexts, itxHost } from "./host.ts";
import { IterateContextRpcTarget } from "./iterate-context.ts";
import { mintOnBehalfOf } from "./on-behalf-of.ts";
import { SessionTeardown, serveSession } from "./session.ts";

/** What the view reaches of its context: reads as the session's caller, which names nobody, and a
 *  subscription as that caller with the person beside it (WHO CALLS, above). */
type ContextReach = Pick<IterateContextRpcTarget, "invoke" | "subscribe">;
/** One call at the context that names the person as who asked; `call` names a facet call. */
type CallAsPerson = (expression: ItxExpression, call?: string) => Promise<unknown>;

// The only `invoke` texts: the seed of a live state, and a facet's state, for the chat's views.
const SNAPSHOT_TEXT = /^itx\.facets\.get\('([A-Za-z0-9_.-]+)'\)\.(liveSnapshot|snapshot)\(\)$/;

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

export class PersonContextRpcTarget extends RpcTarget {
  readonly #path: string;
  readonly #context: ContextReach;
  readonly #asPerson: CallAsPerson;

  constructor(path: string, context: ContextReach, asPerson: CallAsPerson) {
    super();
    this.#path = path;
    this.#context = context;
    this.#asPerson = asPerson;
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

  /** `itx.facets.get('<name>').liveSnapshot()` or `….snapshot()`, as that exact text. */
  invoke(call: unknown, ...args: unknown[]): Promise<unknown> {
    const match = typeof call === "string" && args.length === 0 && SNAPSHOT_TEXT.exec(call);
    if (!match)
      throw codedError(
        "FORBIDDEN",
        "invoke on a person's view takes `itx.facets.get('<name>').liveSnapshot()` or `….snapshot()` alone",
      );
    const [, facet, method] = match;
    return this.#context.invoke(["itx", "builtins", "facets", ["get", facet], [method]]);
  }

  /** The chat's stop of an answer alone, which the platform appends in its own words. */
  append(...events: unknown[]): Promise<unknown> {
    if (!StopOfAnAnswer.safeParse(events).success)
      throw codedError(
        "FORBIDDEN",
        "append on a person's view takes the chat's stop of an answer alone: one events.iterate.com/agent/context-added with llmRequestPolicy.behaviour interrupt-current-request",
      );
    return this.#asPerson([
      "itx",
      "builtins",
      [
        "append",
        {
          type: "events.iterate.com/agent/context-added",
          payload: {
            role: "developer",
            content: "The user interrupted the in-progress response from the web chat.",
            actor: { type: "user" },
            llmRequestPolicy: { behaviour: "interrupt-current-request" },
          },
        },
      ],
    ]);
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
    return new AgentsRpcTarget((path, input) => {
      this.#ownPath(path, "agents.get");
      const words = wireInput(MessageInput, input, "agents.get(path).message(input)");
      // the sender is a person, as on a member's page: `/` (core/lib/src/agents/collection.ts)
      return this.#asPerson(
        ["itx", "builtins", "facets", ["get", "agent"], ["message", words, "/"]],
        `${this.#path}#agent.message`,
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
  readonly #message: (path: unknown, input: unknown) => Promise<unknown>;
  constructor(message: (path: unknown, input: unknown) => Promise<unknown>) {
    super();
    this.#message = message;
  }
  get(path: unknown): AgentRpcTarget {
    return new AgentRpcTarget((input) => this.#message(path, input));
  }
}

class AgentRpcTarget extends RpcTarget {
  readonly #message: (input: unknown) => Promise<unknown>;
  constructor(message: (input: unknown) => Promise<unknown>) {
    super();
    this.#message = message;
  }
  message(input: unknown): Promise<unknown> {
    return this.#message(input);
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
  const asPerson: CallAsPerson = async (expression, call) => {
    const { signingSecret } = itxHost();
    if (!signingSecret)
      throw new Error("this host signs no token that names a person: it sends nothing as one");
    const token = await mintOnBehalfOf({ ...onBehalfOf, call }, await signingSecret(), Date.now());
    const caller: Caller = {
      principal: null,
      cause: { ...newChain("a person's page"), onBehalfOf: token },
    };
    return new IterateContextRpcTarget(
      contexts(),
      DurableObjectNameCodec.address(path),
      new SessionTeardown(),
      (promise) => ctx.waitUntil(promise),
      caller,
    ).invoke(expression);
  };
  return serveSession(request, ctx, {
    caller: { principal: null },
    endsAt,
    endReason: "the sign-in for this session ended: sign in again",
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
      );
    },
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
