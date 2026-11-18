// The stamps that reach a target through loaded code's own `fetch` (`env.ITX.fetch`,
// `itx.<name>.fetch`), and the stamp a live callback's lend carries to the context, which names who
// holds the subscription (`heldBy`). What a hop with a caller stamps is call-context.test.ts's
// subject; the decode of the pager's header is rpc-stubs.test.ts's.
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import { expect, test, vi } from "vitest";
import { stampCaller, type Caller } from "./caller.ts";
import { defineItxHost } from "./host.ts";
import { IterateContextRpcTarget, statelessExpressionFetch } from "./iterate-context.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import type { ClientRpcStub } from "./context/rpc-stub-relay.ts";
import { isRowOfLend } from "./context/rpc-stubs.ts";
import { SessionTeardown } from "./session.ts";
import { CoreContract, reduceCoreEventBatch } from "./stream/core-processor.ts";

const member = { actor: "user_1", email: "a@example.com" };
const person = { actor: "user_2", email: "b@example.com" };
const via = { appPage: "chat.example.com" };

test("a target that loaded code fetches gets no person or principal stamp that the code wrote itself", async () => {
  const answer = await statelessExpressionFetch(
    targetThatAnswersItsStamps(),
    () => ["itx", "tunnels", "dev"],
    new Request("https://dev.example.net/", {
      headers: {
        "x-itx-person": JSON.stringify({ userId: "user_2", email: "b@example.net" }),
        "x-itx-principal": JSON.stringify({ actor: "user_2", email: "b@example.net" }),
      },
    }),
    "itx.tunnels.dev.fetch",
  );

  expect(await answer.json()).toEqual({ person: null, principal: null });
});

test("a member's live subscription, and its redial after a close, stamp the row with the member, who holds it", async () => {
  const { kernel, dials } = kernelAs({ principal: member, grant: "grant:1", via });
  using _subscription = await kernel.subscribe({ name: "sub-1", target: liveCallback() });
  dials[0]!.socket.close(1006, "the context reset");
  await vi.waitFor(() => expect(dials).toHaveLength(2));
  const lenderStamp = { principal: member, grant: "grant:1", via };
  expect(dials.map(({ request }) => request)).toMatchObject([
    { redial: false, lenderStamp },
    { redial: true, lenderStamp },
  ]);
  for (const { request } of dials)
    expect(rowAfterAttach(request)).toEqual({
      source: { origin: "/", principal: member, grant: "grant:1", via },
      heldBy: { principal: member, via },
    });
});

test("a person's live subscription stamps the row with the person beside nobody, and names them as holder", async () => {
  const { kernel, dials } = kernelAs({ principal: null, onBehalfOf: { principal: person, via } });
  using _subscription = await kernel.subscribe({ name: "sub-1", target: liveCallback() });
  expect(rowAfterAttach(dials[0]!.request)).toEqual({
    source: { origin: "/", onBehalfOf: { principal: person, via } },
    heldBy: { principal: person, via },
  });
});

test("a caller names no holder by what it writes in the subscribe input", async () => {
  const { kernel, dials } = kernelAs({ principal: null });
  const input = {
    name: "sub-1",
    target: liveCallback(),
    heldBy: { principal: member },
    source: { principal: member },
    lenderStamp: { principal: member },
  };
  using _subscription = await kernel.subscribe(input);
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exact: no field the caller wrote may reach the wire
  expect(dials[0]!.request).toEqual({
    rpcStubKey: "subscription:sub-1",
    appendEvents: [
      {
        type: "events.iterate.com/itx/subscription-configured",
        payload: {
          name: "sub-1",
          target: ["itx", "builtins", "rpcStubs", ["get", "subscription:sub-1"]],
        },
      },
    ],
    redial: false,
    lenderStamp: { principal: null },
  });
  expect(rowAfterAttach(dials[0]!.request)).toEqual({ source: { origin: "/" } });
});

// A key's token is no member's (core/boundary-worker/src/stamp.ts): its session's principal names
// the service it speaks for, and no event may carry that as a member's act.
test("a key's lend stamps its rule with nobody: the row says which key lends, and no principal", async () => {
  const { kernel, dials } = kernelAs({ principal: { actor: "bridge-1" }, grant: "key:k1" });
  using _lend = await kernel.provide("itx.bridge", liveStub(), { onlyFromItself: true });
  const { appendEvents, lenderStamp } = dials[0]!.request;
  // `toEqual`, twice: no key of the stamp or of the source may name the service
  expect(lenderStamp).toEqual({ principal: null, grant: "key:k1" });
  expect(appendEvents.map((event) => stampCaller(event, lenderStamp, "/"))).toEqual([
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: {
        match: "itx.bridge",
        target: ["itx", "builtins", "rpcStubs", ["get", "itx.bridge"]],
        lentBy: "key:k1",
      },
      source: { origin: "/" },
    },
  ]);
});

// The attach refuses an event that is no row of its lend (rpc-stubs.test.ts): what the kernel's
// own two verbs send must pass it.
test("every event that a provide and a subscribe send at their attach is a row of that lend", async () => {
  const { kernel, dials } = kernelAs({ principal: member, grant: "grant:1", via });
  using _lend = await kernel.provide("itx.bridge", liveStub(), {
    description: "a bridge",
    fetchRoute: { fetchRouteName: "bridge", requestMatcher: { routingSlug: "bridge" } },
  });
  using _subscription = await kernel.subscribe({ target: liveCallback(), consumes: ["*"] });
  expect(dials.map(({ request }) => request.appendEvents.map(({ type }) => type))).toEqual([
    [
      "events.iterate.com/itx/rewrite-rule-configured",
      "events.iterate.com/itx/fetch-route-configured",
    ],
    ["events.iterate.com/itx/subscription-configured"],
  ]);
  for (const { request } of dials)
    for (const event of request.appendEvents)
      expect({ event, own: isRowOfLend(event, request.rpcStubKey) }).toMatchObject({ own: true });
});

test("loaded code's live subscription appends its row before the lend, which stamps nobody", async () => {
  const { kernel, dials } = kernelAs({ principal: null, app: true });
  using _subscription = await kernel.subscribe({ name: "sub-1", target: liveCallback() });
  expect(dials[0]!.request).toMatchObject({ appendEvents: [], lenderStamp: { principal: null } });
});

defineItxHost({ firstPartyFacets: {} });

/** A lent target that answers with the stamps on the Request it got. */
function targetThatAnswersItsStamps() {
  return {
    invoke: async (_expression: unknown, request: Request) =>
      Response.json({
        person: request.headers.get("x-itx-person"),
        principal: request.headers.get("x-itx-principal"),
      }),
  };
}

type AttachRequest = {
  rpcStubKey: string;
  appendEvents: StreamEventInput[];
  lenderStamp: Caller;
  redial: boolean;
};

/** The kernel's session for `caller` at `/`, over a context that takes every pager dial and
 *  answers loaded code's append with a row at `/`. `dials` is each dial's header, as the wire
 *  carries it, and the socket the dial got. */
function kernelAs(caller: Caller) {
  const dials: { request: AttachRequest; socket: ReturnType<typeof pagerSocket> }[] = [];
  const context = {
    fetch: async (_url: string, init: { headers: Record<string, string> }) => {
      const socket = pagerSocket();
      dials.push({
        request: JSON.parse(decodeURIComponent(init.headers["x-itx-rpc-stub-pager"]!)),
        socket,
      });
      return { status: 101, webSocket: socket };
    },
    invokeSafe: async () => ({ ok: true, data: [{ offset: 1, path: "/" }] }),
  };
  const kernel = new IterateContextRpcTarget(
    // The one cast: the kernel reaches the context by these two calls alone.
    { getByName: () => context } as unknown as ConstructorParameters<
      typeof IterateContextRpcTarget
    >[0],
    DurableObjectNameCodec.address("/"),
    new SessionTeardown(),
    (promise) => void promise,
    caller,
  );
  return { kernel, dials };
}

/** A page's live callback, as capnweb hands it over: a callable stub that dups. */
function liveCallback() {
  return Object.assign(() => {}, {
    dup() {
      return liveCallback();
    },
  });
}

/** The same, as `provide` takes a live stub. */
const liveStub = () => liveCallback() as unknown as ClientRpcStub;

/** A pager's socket at the relay: the context answers each keepalive at once, and a close reaches
 *  the relay's listener as the runtime's close event would. */
function pagerSocket() {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const fire = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) || []) listener(event);
  };
  return {
    accept: () => {},
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      void listeners.set(type, [...(listeners.get(type) || []), listener]),
    send: () => queueMicrotask(() => fire("message", { data: "itx-pager-keepalive-ack" })),
    close: (code: number, reason: string) => fire("close", { code, reason }),
  };
}

/** The row's event as the context stamps it at the attach (iterate-context-durable-object.ts, the
 *  rpc-stub directory's `appendEvents`), and who the reduced row says holds it. */
function rowAfterAttach(request: AttachRequest) {
  const [event] = request.appendEvents.map((input, index): StreamEvent => {
    const stamped = stampCaller(input, request.lenderStamp || { principal: null }, "/");
    return {
      ...stamped,
      source: { origin: "/", ...stamped.source },
      offset: index + 1,
      path: "/",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  });
  const state = reduceCoreEventBatch([event!], CoreContract.initialState(), (error) => {
    throw error;
  });
  const { heldBy } = state.subscriptions["sub-1"]!;
  return { source: event!.source, heldBy };
}
