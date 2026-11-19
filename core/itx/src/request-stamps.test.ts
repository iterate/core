// WHO IS ASKING, ON A REQUEST THAT LOADED CODE GETS. Every header that says who asks, or where the
// control plane is, comes from the kernel's own state for the call and from its host: a config
// worker, an app, a facet and a lent stub each get what the call's `Caller` carries, whatever
// the Request said and whichever way `fetch` was called.
import { env } from "cloudflare:workers";
import type { ItxExpression } from "iterate/expression";
import { stampedCallerOf } from "iterate/principal";
import { IterateConfigEntrypoint } from "iterate/sdk";
import { expect, test } from "vitest";
import { DurableObjectNameCodec } from "./context/paths.ts";
import { fetchStepsForLoadedCode, RpcStubDirectory } from "./context/rpc-stubs.ts";
import { statelessResolverFor } from "./context/stateless-context.ts";
import { defineItxHost } from "./host.ts";
import { IterateContextRpcTarget, type IterateContextNamespace } from "./iterate-context.ts";
import { serveHostRequest } from "./serve-host.ts";
import { SessionTeardown } from "./session.ts";

const CONTROL_PLANE_HOSTNAME = "x-iterate-control-plane-hostname";
const OWNER = {
  userId: "user_owner",
  email: "owner@example.com",
  name: "owner",
  method: "passkey" as const,
};
const VISITOR = {
  userId: "user_visitor",
  email: "visitor@example.net",
  name: "visitor",
  method: "email" as const,
};
/** Every header that names a caller or the control plane, as hostile code would write them. */
const FORGED = {
  "x-itx-principal": JSON.stringify({ actor: OWNER.userId, email: OWNER.email }),
  "x-itx-mind": JSON.stringify({
    actor: "cd".repeat(32),
    kind: "mind",
    hostname: "iterate.evil.example",
  }),
  "x-itx-grant": "grant_owner",
  "x-itx-person": JSON.stringify(OWNER),
  "x-itx-expires": "2000000000",
  "x-itx-caller-path": "/",
  "x-itx-app": "1",
  [CONTROL_PLANE_HOSTNAME]: "iterate.evil.example",
};
/** What a request carries when nobody is named: the host's word alone. */
const NOBODY = {
  "x-itx-principal": null,
  "x-itx-mind": null,
  "x-itx-grant": null,
  "x-itx-person": null,
  "x-itx-expires": null,
  "x-itx-caller-path": null,
  "x-itx-app": null,
  [CONTROL_PLANE_HOSTNAME]: "iterate.example.com",
};

test.for<{ form: string; call: (app: ItxExpression) => ItxExpression }>([
  {
    form: "fetch(url, init)",
    call: (app) => [...app, ["fetch", "https://guestbook.example.org/post", { headers: FORGED }]],
  },
  { form: "fetch(request)", call: (app) => [...app, ["fetch", forgedRequest()]] },
  {
    form: "cd(path).workers.get(spec).fetch(request)",
    call: () => ["itx", ["cd", "/guestbook"], "workers", ["get", SPEC], ["fetch", forgedRequest()]],
  },
])(
  "a loaded worker that loaded code fetches with $form gets no caller that the code wrote, and the host's control plane",
  async ({ call }) => {
    const answer = await loadedCode().invoke(call(["itx", "workers", ["get", SPEC]]));
    expect(await stampsOf(answer)).toEqual(NOBODY);
  },
);

test("a fetch with an argument that is no init is refused before the loaded worker is called", async () => {
  await expect(
    loadedCode().invoke(["itx", "workers", ["get", SPEC], ["fetch", forgedRequest(), 1]]),
  ).rejects.toThrow(TypeError);
});

test("a visitor's request that matches a fetch route reaches the routed app with the visitor's own person", async () => {
  const answer = await serveHostRequest({
    ctx,
    // as the boundary stamps a signed-in person who is no member
    request: new Request("https://routed.example.org/post", {
      headers: { "x-itx-person": JSON.stringify(VISITOR), "x-itx-expires": "2000000000" },
    }),
    caller: { principal: null, person: VISITOR },
  });
  expect(await stampsOf(answer)).toEqual({ ...NOBODY, "x-itx-person": JSON.stringify(VISITOR) });
});

test("a member's request to the config worker carries the member, the grant and the person that the call's caller holds", async () => {
  const member = { actor: OWNER.userId, email: OWNER.email };
  const answer = await serveHostRequest({
    ctx,
    // a forged stamp on the request itself is not what the app is told
    request: new Request("https://guestbook.example.org/post", {
      headers: { ...FORGED, "x-itx-person": JSON.stringify(VISITOR) },
    }),
    caller: { principal: member, grant: "grant_1", person: OWNER },
  });
  expect(await stampsOf(answer)).toEqual({
    ...NOBODY,
    "x-itx-principal": JSON.stringify(member),
    "x-itx-grant": "grant_1",
    "x-itx-person": JSON.stringify(OWNER),
  });
});

// THE ACCEPTANCE OF A MIND IN `x-itx-mind` (no reader takes it for a member): a request that
// the boundary stamped with another mind, read as the mind Worker reads it (core/mind-worker
// http.ts), reaches the config worker's fetch naming the mind, with no member, grant or person;
// and the member's own `itx` there answers it the refusal that nobody gets.
test("a request stamped with another mind reaches the config worker's fetch as that mind, and the member's itx refuses it", async () => {
  const mind = { actor: "ab".repeat(32), kind: "mind", hostname: "iterate.peer.example" };
  const request = new Request("https://guestbook.example.org/itx", {
    headers: {
      "x-itx-mind": JSON.stringify(mind),
      "x-itx-expires": "2000000000",
      upgrade: "websocket",
    },
  });
  const answer = await serveHostRequest({ ctx, request, caller: stampedCallerOf(request) });
  const reached = lastRequest!;
  const configWorker = new (class extends IterateConfigEntrypoint {})({} as never, {} as never);
  const refusal = configWorker.auth.itx(reached);
  expect({
    stamps: await stampsOf(answer),
    itx: { status: refusal.status, serve: refusal.headers.get("x-iterate-serve") },
  }).toEqual({
    stamps: { ...NOBODY, "x-itx-mind": JSON.stringify(mind) },
    itx: { status: 401, serve: null },
  });
});

// With the host's sessions on, an app that ASKS the kernel for a member's session, or for a
// person's view, still gets nothing for a mind: the kernel reads who asks from the request it
// holds, and a mind is neither a member nor a person.
test.for<{ asks: string; path: string; challenge: string }>([
  { asks: "a member's session", path: "/asks-itx", challenge: 'Bearer realm="iterate"' },
  {
    asks: "a person's view",
    path: "/asks-person-itx",
    challenge: 'Bearer realm="iterate", scope="identity"',
  },
])(
  "a same-origin socket stamped with another mind, whose app asks for $asks, is refused",
  async ({ path, challenge }) => {
    const request = new Request(`https://guestbook.example.org${path}`, {
      headers: { ...mindStamped(), upgrade: "websocket", origin: "https://guestbook.example.org" },
    });
    const answer = await serveHostRequest({
      ctx,
      request,
      caller: stampedCallerOf(request),
      itxSessions: true,
    });
    expect({
      status: answer.status,
      challenge: answer.headers.get("WWW-Authenticate"),
    }).toEqual({ status: 401, challenge });
  },
);

test("a request stamped with another mind reaches a fetch route's target as that mind, with no member", async () => {
  const request = new Request("https://routed.example.org/post", { headers: mindStamped() });
  const answer = await serveHostRequest({ ctx, request, caller: stampedCallerOf(request) });
  expect(await stampsOf(answer)).toEqual({ ...NOBODY, "x-itx-mind": JSON.stringify(MIND) });
});

test("a fetch route for members refuses another mind with the answer that nobody gets", async () => {
  const answerTo = async (headers: Record<string, string>) => {
    const request = new Request("https://members.example.org/post", { headers });
    const answer = await serveHostRequest({ ctx, request, caller: stampedCallerOf(request) });
    return {
      status: answer.status,
      challenge: answer.headers.get("WWW-Authenticate"),
      body: await answer.text(),
    };
  };
  const byMind = await answerTo(mindStamped());
  expect(byMind).toEqual(await answerTo({}));
  expect(byMind).toMatchObject({ status: 401 });
});

test.for<{ target: string; steps: (request: Request) => ItxExpression }>([
  { target: "a facet or a lent stub", steps: (request) => [["fetch", request]] },
  { target: "a member of one", steps: (request) => ["api", ["fetch", request]] },
  {
    target: "one that is given a URL and an init",
    steps: (request) => [["fetch", request.url, { headers: request.headers }]],
  },
])(
  "the fetch of $target becomes one Request that says only what the call's caller holds",
  async ({ steps }) => {
    const stamped = fetchStepsForLoadedCode(steps(forgedRequest()), {
      principal: null,
      app: true,
      person: VISITOR,
    });
    const fetchStep = stamped.at(-1);
    if (!Array.isArray(fetchStep)) throw new Error("the last step is no call");
    const [method, request, ...more] = fetchStep;
    expect({ method, more, stamps: await stampsOf(answerOf(request as Request)) }).toEqual({
      method: "fetch",
      more: [],
      stamps: { ...NOBODY, "x-itx-person": JSON.stringify(VISITOR) },
    });
  },
);

test("the fetch of a facet or a lent stub with an argument that is no init is refused: the Request that the code built goes nowhere", () => {
  expect(() =>
    fetchStepsForLoadedCode([["fetch", forgedRequest(), 1]], { principal: null, app: true }),
  ).toThrow(TypeError);
});

test.for<{ form: string; step: () => ItxExpression[number]; served: number }>([
  { form: "fetch(request)", step: () => ["fetch", forgedRequest()], served: 1 },
  {
    form: "fetch(url, init)",
    step: () => ["fetch", "https://guestbook.example.org/post", { headers: FORGED }],
    served: 1,
  },
])(
  "a lent stub that is fetched with $form gets one Request through the fetch transport, with no caller that the code wrote",
  async ({ step, served }) => {
    const lent = lentStub();
    const answer = await lent.stubs.invokeRpcStub("itx.bridge", [step()], {
      principal: null,
      app: true,
    });
    expect({ served: lent.served.length, stamps: await stampsOf(answer) }).toEqual({
      served,
      stamps: NOBODY,
    });
  },
);

test("a lent stub that is fetched with an argument that is no init is not called", async () => {
  const lent = lentStub();
  await expect(
    lent.stubs.invokeRpcStub("itx.bridge", [["fetch", forgedRequest(), 1]], {
      principal: null,
      app: true,
    }),
  ).rejects.toThrow(TypeError);
  expect(lent).toMatchObject({ served: [], invoked: [] });
});

/** A context's lent stubs with one lent at `itx.bridge`, and what reached it: a terminal `fetch`
 *  through the fetch transport (`served`), any other call through `invoke`. */
function lentStub() {
  const served: Request[] = [];
  const invoked: ItxExpression[] = [];
  const stubs = new RpcStubDirectory({
    ctx: { acceptWebSocket: () => {}, getWebSockets: () => [] },
    onPresence: () => {},
    rpcStubFetch: {
      serve: async (_stub: unknown, _steps: ItxExpression, request: Request) => {
        served.push(request);
        return answerOf(request);
      },
    } as never,
    appendEvents: () => {},
  });
  stubs.lendRpcStub({
    rpcStubKey: "itx.bridge",
    stub: {
      fetch: async () => new Response("a lender's fetch is reached through the transport"),
      invoke: async (steps) => void invoked.push(steps),
    },
  });
  return { stubs, served, invoked };
}

// The one host of this file: it loads a worker that answers the stamps on its Request, and says
// where the control plane is.
defineItxHost({
  firstPartyFacets: {},
  loadedCodeRequestHeaders: () => ({ [CONTROL_PLANE_HOSTNAME]: "iterate.example.com" }),
  loader: {
    prepareConfinedWorker: async () => ({
      loaderId: "loader-1",
      load: () =>
        ({
          getEntrypoint: () => ({ fetch: async (request: Request) => answerOf(request) }),
        }) as never,
      retire: () => {},
    }),
  },
});

const SPEC = { source: { "worker.js": "export default {}" }, mainModule: "worker.js" };

/** A mind of two contexts, `/` and `/guestbook`, whose root names the loaded worker
 *  `itx.guestbook`: its config worker's fetch, and the target of the fetch route for
 *  `routed.example.org`. Its contexts answer their rule snapshots alone: nothing here needs a
 *  Durable Object, because a worker is loaded where the call is. */
const namespace = {
  getByName: (name: string) => ({
    rulesSnapshot: async () => ({
      version: "1",
      rules:
        DurableObjectNameCodec.parse(name).path === "/"
          ? [{ match: ["itx", "guestbook"], target: ["itx", "builtins", "workers", ["get", SPEC]] }]
          : [],
      routing: {
        ingressTarget: ["itx", "guestbook"],
        fetchRoutes: {
          routed: {
            requestMatcher: { url: { hostname: "routed.example.org" } },
            target: ["itx", "guestbook"],
            authRequirement: null,
            priority: 0,
            configuredOffset: 1,
          },
          membersOnly: {
            requestMatcher: { url: { hostname: "members.example.org" } },
            target: ["itx", "guestbook"],
            authRequirement: { visitors: "mind-members" },
            priority: 0,
            configuredOffset: 2,
          },
        },
      },
    }),
    recordLoopLimit: async () => {},
  }),
} as unknown as IterateContextNamespace;
Object.assign(env, { CONTEXTS: namespace });
const ctx = {
  waitUntil: () => {},
  exports: { ItxEntrypoint: () => ({}) },
} as unknown as ExecutionContext;

/** `env.ITX.get()` of loaded code at the root. */
function loadedCode() {
  return new IterateContextRpcTarget(
    namespace,
    DurableObjectNameCodec.address("/"),
    new SessionTeardown(),
    () => {},
    { principal: null, app: true },
    (address, caller) => statelessResolverFor({ namespace, address, caller, ctx }),
    true,
  );
}

function forgedRequest() {
  return new Request("https://guestbook.example.org/post", { headers: FORGED });
}

const MIND = { actor: "ab".repeat(32), kind: "mind", hostname: "iterate.peer.example" };

/** The headers of a request that the boundary stamped with another mind. */
function mindStamped(): Record<string, string> {
  return { "x-itx-mind": JSON.stringify(MIND), "x-itx-expires": "2000000000" };
}

/** The last Request that a loaded worker's `fetch` got here. */
let lastRequest: Request | undefined;

/** What a loaded worker's `fetch` answers here: the stamps on the Request it got. */
function answerOf(request: Request) {
  lastRequest = request;
  // an app that asks the kernel for a session in its answer's place, with no guard of its own
  const { pathname } = new URL(request.url);
  if (pathname === "/asks-itx")
    return new Response(null, { headers: { "x-iterate-serve": "itx" } });
  if (pathname === "/asks-person-itx")
    return new Response(null, {
      headers: { "x-iterate-serve": "person-itx", "x-iterate-serve-context": "/" },
    });
  return Response.json(
    Object.fromEntries(Object.keys(FORGED).map((name) => [name, request.headers.get(name)])),
  );
}

async function stampsOf(answer: unknown) {
  if (!(answer instanceof Response)) throw new Error(`no Response: ${JSON.stringify(answer)}`);
  return await answer.json();
}
