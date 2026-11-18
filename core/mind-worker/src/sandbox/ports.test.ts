// A sandbox's port at a host: which steps are a port call, which names a port may take, what a
// process in the sandbox sees of a request, and the order of `exposePort`'s writes. The facet, the
// routes of `/` and the container's object are the injected calls of `runSandboxPortCall`; what
// they do on a deployed stack is out of scope.
import type { ItxExpression } from "iterate/expression";
import { expect, test } from "vitest";
import {
  heldPortFailure,
  portNameRefusal,
  portRoutesOf,
  requestToThePort,
  runSandboxPortCall,
  sandboxPortCallOf,
  sandboxPortTarget,
  type SandboxPortDeps,
} from "./ports.ts";

const BOX = "/sandboxes/web";
const DOMAIN = "mind.example";
const request = new Request("https://web.mind.example/socket?room=1");

const portCallRows: { name: string; steps: ItxExpression; expected: object | null }[] = [
  {
    name: "a Request to a port is a port fetch",
    steps: ["container", ["getTcpPort", 8080], ["fetch", request]],
    expected: { verb: "fetch", port: 8080, request },
  },
  {
    name: "the same chain as one call is a port fetch too",
    steps: [
      "container",
      [
        "invoke",
        [
          ["getTcpPort", 8080],
          ["fetch", request],
        ],
      ],
    ],
    expected: { verb: "fetch", port: 8080, request },
  },
  {
    name: "a fetch of a URL stays the raw container call",
    steps: ["container", ["getTcpPort", 8080], ["fetch", "http://container/"]],
    expected: null,
  },
  {
    name: "a step after the fetch stays the raw container call",
    steps: ["container", ["getTcpPort", 8080], ["fetch", request], "status"],
    expected: null,
  },
  {
    name: "exposePort takes a port and its options",
    steps: [["exposePort", 8080, { name: "web", command: ["node", "/root/server.mjs"] }]],
    expected: {
      verb: "exposePort",
      port: 8080,
      options: { name: "web", command: ["node", "/root/server.mjs"] },
    },
  },
  {
    name: "unexposePort takes a port",
    steps: [["unexposePort", 8080]],
    expected: { verb: "unexposePort", port: 8080 },
  },
  { name: "any other verb is the facet's", steps: [["exec", ["true"]]], expected: null },
];

test.for(portCallRows)("$name", ({ steps, expected }) => {
  // exact: a call that is half a port call must not be taken for one
  expect(sandboxPortCallOf(steps)).toEqual(expected);
});

test("a port verb with arguments it does not take is refused, never sent to the facet", () => {
  expect(() => sandboxPortCallOf([["exposePort", 8080, { name: "web", token: "x" }]])).toThrow(
    /exposePort\(port, \{ name, command\?, public\? \}\)/,
  );
});

const own = sandboxPortTarget(BOX, 8080);
const routes = [
  route("sandbox-web", { url: { hostname: "web.mind.example" } }, own),
  route("tunnel-demo", { url: { hostname: "demo.mind.example" } }, ["itx", "tunnels", "demo"]),
  route("tunnel-host", { url: { hostname: "shop.mind.example" } }, ["itx", "tunnels", "host"]),
];

test.for([
  { name: "a free name", port: "notes", refused: false },
  {
    name: "this port's own route, which a second exposePort replaces",
    port: "web",
    refused: false,
  },
  { name: "the platform's hostname", port: "iterate", refused: true },
  { name: "a host of the template's apps", port: "dash", refused: true },
  { name: "a tunnel's hostname", port: "demo", refused: true },
  { name: "a hostname that a route matches by its URL", port: "shop", refused: true },
  { name: "no DNS label", port: "Web_1", refused: true },
  { name: "longer than a route's name allows", port: "a".repeat(56), refused: true },
])("a port's name: $name", ({ port, refused }) => {
  expect({ refused: portNameRefusal(port, routes, own, DOMAIN) !== null }).toEqual({ refused });
});

test("another sandbox's port of the same name is refused", () => {
  expect(portNameRefusal("web", routes, sandboxPortTarget("/sandboxes/other", 8080), DOMAIN)).toBe(
    "the fetch route sandbox-web already takes web.mind.example: pick another name",
  );
});

test("a deleted sandbox's routes are its ports' own, each only while it still names the port", () => {
  expect(
    portRoutesOf(routes, BOX, {
      8080: { name: "web" },
      9090: { name: "demo" },
      7070: { name: "x" },
    }),
  ).toEqual(["sandbox-web"]);
});

test("a process in the sandbox sees nothing of the platform's in a request", () => {
  const forwarded = requestToThePort(
    new Request("https://web.mind.example/socket?room=1", {
      headers: {
        cookie: "__Host-iterate-session=secret; theme=dark; __Host-iterate-sign-in=flow",
        "x-itx-principal": '{"actor":"member"}',
        "x-iterate-sandbox-port": "8080",
        "x-iterate-routing-slug": "web",
        upgrade: "websocket",
        authorization: "Bearer the-apps-own",
      },
    }),
  );
  // exact: a header that is not listed here must not reach the port
  expect({ url: forwarded.url, headers: Object.fromEntries(forwarded.headers) }).toEqual({
    url: "http://web.mind.example/socket?room=1",
    headers: {
      authorization: "Bearer the-apps-own",
      cookie: "theme=dark",
      upgrade: "websocket",
      "x-forwarded-host": "web.mind.example",
      "x-forwarded-proto": "https",
    },
  });
});

test.for([
  { name: "no failure: the command may run", failure: undefined, now: 100_000, held: null },
  {
    name: "a failure 29 s ago is answered again from memory, and the command does not run",
    failure: { at: 71_000, error: "port 8080 did not open" },
    now: 100_000,
    held: "port 8080 did not open",
  },
  {
    name: "a failure 30 s ago: the command may run again",
    failure: { at: 70_000, error: "port 8080 did not open" },
    now: 100_000,
    held: null,
  },
])("a port's failed command: $name", ({ failure, now, held }) => {
  expect({ held: heldPortFailure(failure, now) }).toEqual({ held });
});

test("exposePort writes the route first, so a caller that may not set a route writes no fact", async () => {
  const refused = portCalls({ setRoute: "refused" });
  const allowed = portCalls({});
  const expose = { verb: "exposePort", port: 8080, options: { name: "notes" } } as const;
  await expect(runSandboxPortCall(expose, refused.deps)).rejects.toThrow("no itx.cd in a jail");
  expect({
    refused: refused.writes,
    answer: await runSandboxPortCall(expose, allowed.deps),
    allowed: allowed.writes,
  }).toEqual({
    refused: [],
    answer: { port: 8080, name: "notes", url: "https://notes.mind.example/", public: false },
    allowed: [
      {
        route: "sandbox-notes",
        requestMatcher: { url: { hostname: "notes.mind.example" } },
        target: own,
        authRequirement: { visitors: "mind-members" },
      },
      { type: "events.iterate.com/sandbox/port-exposed", payload: { port: 8080, name: "notes" } },
    ],
  });
});

test("a request to a sandbox that does not exist is answered 404 and reaches no container", async () => {
  const calls = portCalls({ readiness: { ready: false, status: 404, reason: "no sandbox" } });
  const answer = await runSandboxPortCall({ verb: "fetch", port: 8080, request }, calls.deps);
  expect({ status: (answer as Response).status, fetched: calls.fetched }).toEqual({
    status: 404,
    fetched: [],
  });
});

test("a request to a ready port goes to the container's object with the port named", async () => {
  const calls = portCalls({});
  await runSandboxPortCall({ verb: "fetch", port: 8080, request }, calls.deps);
  expect(calls).toMatchObject({ fetched: [{ url: request.url, port: "8080" }] });
});

function route(
  fetchRouteName: string,
  requestMatcher: { url?: { hostname: string } },
  target: unknown,
) {
  return { fetchRouteName, requestMatcher, target, authRequirement: null };
}

/** The calls `runSandboxPortCall` makes, with what it wrote and what it sent to the container. */
function portCalls(options: {
  setRoute?: "refused";
  readiness?: { ready: false; status: 404; reason: string };
}) {
  const writes: object[] = [];
  const fetched: object[] = [];
  const deps: SandboxPortDeps = {
    sandboxPath: BOX,
    domain: DOMAIN,
    assertBeneathCaller: () => {},
    facet: async (steps) =>
      JSON.stringify(steps[0]).includes("readyPort")
        ? options.readiness || { ready: true }
        : { state: { creation: { status: "created", offset: 1 }, deletion: null, ports: {} } },
    routes: async () => routes,
    setRoute: async (fetchRouteName, written) => {
      if (options.setRoute === "refused") throw new Error("no itx.cd in a jail");
      writes.push({ route: fetchRouteName, ...written });
    },
    append: async (event) => void writes.push(event),
    container: () => ({
      fetch: async (sent) => {
        fetched.push({ url: sent.url, port: sent.headers.get("x-iterate-sandbox-port") });
        return new Response("ok");
      },
    }),
  };
  return { deps, writes, fetched };
}
