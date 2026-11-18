// ports.ts — A PORT OF A SANDBOX AT A HOST OF THE MIND. `exposePort(port, { name })` serves the port
// at `https://<name>.<domain>/`: HTTP, streamed bodies and WebSockets. Two records, each in one
// place. The fetch route `sandbox-<name>` on `/` is what is served: the name, the sandbox and the
// port (its target), and who may reach it. The sandbox's own log keeps the command that is run when
// a request finds the port closed.
//
// The route's target is `itx.sandboxes.get(path).container.getTcpPort(port).fetch`, a call anyone
// who reaches the sandbox may make. A Response that holds a WebSocket cannot cross Workers RPC, so
// that call has two parts: the sandbox's facet makes the port ready over RPC (no Request in it),
// and then the Request goes to the container's object by `fetch`, where the socket ends.
import { z } from "zod";
import type { FetchRouteInput } from "iterate/api";
import { itxExpressionStepName, type ItxExpression } from "iterate/expression";
import { codedError, jsonEqual } from "iterate/lib";
import { ROUTING_SLUG } from "iterate/mind-ingress";
import { EntityCreationAndDeletionState } from "../mind/entity-lifecycle.ts";
import { SandboxPortExposed } from "./contract.ts";

/** Which port a Request to the container's object is for. The library sets it, the object reads
 *  and removes it: a Durable Object's `fetch` takes a Request alone. */
export const SANDBOX_PORT_HEADER = "x-iterate-sandbox-port";

const Port = SandboxPortExposed.shape.port;

/** What the facet answers when it is asked to make a port ready for one request. */
export const SandboxPortReadiness = z.discriminatedUnion("ready", [
  z.object({ ready: z.literal(true) }),
  z.object({
    ready: z.literal(false),
    /** 404: no such sandbox. 502: the port is closed. 503: the sandbox is still starting. */
    status: z.union([z.literal(404), z.literal(502), z.literal(503)]),
    reason: z.string(),
  }),
]);
export type SandboxPortReadiness = z.infer<typeof SandboxPortReadiness>;

const ExposePortOptions = z.strictObject({
  name: z.string(),
  command: z.array(z.string()).min(1).optional(),
  public: z.boolean().optional(),
});

const PortStep = z.tuple([z.literal("getTcpPort"), Port]);
// `z.instanceof` would type the runtime's Request without its `cf` properties
const FetchStep = z.tuple([
  z.literal("fetch"),
  z.custom<Request>((value) => value instanceof Request),
]);
/** The two spellings of one request to a port: the dotted call, which a fetch route's target is,
 *  and the chain as one call, `container.invoke([["getTcpPort", port], ["fetch", request]])`, which
 *  is the one that loaded code can make: its dotted call fails in the runtime and never arrives
 *  here. */
const PortFetchSteps = z.union([
  z.tuple([z.literal("container"), PortStep, FetchStep]).transform(([, port, fetched]) => ({
    port: port[1],
    request: fetched[1],
  })),
  z
    .tuple([z.literal("container"), z.tuple([z.literal("invoke"), z.tuple([PortStep, FetchStep])])])
    .transform(([, [, [port, fetched]]]) => ({ port: port[1], request: fetched[1] })),
]);
/** One call each, with nothing after it. */
const PortVerbSteps = z.tuple([
  z.union([
    z.tuple([z.literal("exposePort"), Port, ExposePortOptions]),
    z.tuple([z.literal("unexposePort"), Port]),
    z.tuple([z.literal("getExposedPorts")]),
  ]),
]);

type SandboxPortCall =
  | { verb: "fetch"; port: number; request: Request }
  | { verb: "exposePort"; port: number; options: z.infer<typeof ExposePortOptions> }
  | { verb: "unexposePort"; port: number }
  | { verb: "getExposedPorts" };

/** The port call that a sandbox handle's steps spell, or null for any other call. A port verb with
 *  arguments it does not take is refused here: the facet has no such method to answer for it. */
export function sandboxPortCallOf(steps: ItxExpression): SandboxPortCall | null {
  const fetched = PortFetchSteps.safeParse(steps);
  if (fetched.success) return { verb: "fetch", ...fetched.data };
  const verb = itxExpressionStepName(steps[0]);
  if (verb !== "exposePort" && verb !== "unexposePort" && verb !== "getExposedPorts") return null;
  const parsed = PortVerbSteps.safeParse(steps);
  if (!parsed.success)
    throw codedError(
      "INVALID_INPUT",
      `sandboxes.get(path).${verb}: ${z.prettifyError(parsed.error)}. exposePort(port, { name, command?, public? }) · unexposePort(port) · getExposedPorts()`,
    );
  const [call] = parsed.data;
  if (call[0] === "exposePort") return { verb: call[0], port: call[1], options: call[2] };
  if (call[0] === "unexposePort") return { verb: call[0], port: call[1] };
  return { verb: call[0] };
}

const routeNameOf = (name: string) => `sandbox-${name}`;

/** The call that a port's route sends a request to. */
export const sandboxPortTarget = (sandboxPath: string, port: number): ItxExpression => [
  "itx",
  "sandboxes",
  ["get", sandboxPath],
  "container",
  ["getTcpPort", port],
  "fetch",
];

const PortTarget = z.tuple([
  z.literal("itx"),
  z.literal("sandboxes"),
  z.tuple([z.literal("get"), z.string()]),
  z.literal("container"),
  z.tuple([z.literal("getTcpPort"), Port]),
  z.literal("fetch"),
]);

/** The fetch routes of `/` as `fetchRoutes.list()` answers them, read across a hop. */
const FetchRoutes = z.array(
  z.looseObject({
    fetchRouteName: z.string(),
    requestMatcher: z.looseObject({
      routingSlug: z.string().optional(),
      url: z.looseObject({ hostname: z.string().optional() }).optional(),
    }),
    target: z.unknown(),
    authRequirement: z.unknown().nullable(),
  }),
);
type FetchRoutes = z.infer<typeof FetchRoutes>;

/** `iterate` is the platform's own hostname, which never reaches the mind's hosts. The others are
 *  the hosts of the template's apps and of sign-in: a route is served before the mind's own code,
 *  so a port of such a name would take the app's host. A mind's own app is not known here. */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["iterate", "auth", "dash", "docs", "voice"]);
/** With `sandbox-` before it, a route's name is a DNS label of at most 63 characters. */
const NAME_MAX_LENGTH = 55;

/** Why a port is not served under `name`, or null when it may be. A route that already takes the
 *  host is another's, unless it is this port's own route, which a second `exposePort` replaces. */
export function portNameRefusal(
  name: string,
  routes: FetchRoutes,
  target: ItxExpression,
  domain: string,
): string | null {
  if (!ROUTING_SLUG.test(name) || name.length > NAME_MAX_LENGTH)
    return `a name is a DNS label that starts with a letter: lowercase letters, digits and single hyphens, at most ${NAME_MAX_LENGTH} characters`;
  if (RESERVED_NAMES.has(name))
    return `${name}.${domain} is the platform's or an app's host: pick another name`;
  const taken = routes.find(
    (route) =>
      (route.fetchRouteName === routeNameOf(name) ||
        route.requestMatcher.routingSlug === name ||
        route.requestMatcher.url?.hostname === `${name}.${domain}`) &&
      !(route.fetchRouteName === routeNameOf(name) && jsonEqual(route.target, target)),
  );
  return taken
    ? `the fetch route ${taken.fetchRouteName} already takes ${name}.${domain}: pick another name`
    : null;
}

/** The routes on `/` that a sandbox's exposed ports still hold: what its delete removes. A route of
 *  a port's name that points elsewhere by now is another's and stays. `routes` is
 *  `fetchRoutes.list()`'s answer. */
export function portRoutesOf(
  routes: unknown,
  sandboxPath: string,
  ports: Record<string, { name: string }>,
): string[] {
  const live = FetchRoutes.parse(routes);
  return Object.entries(ports).flatMap(([port, { name }]) => {
    const route = live.find((candidate) => candidate.fetchRouteName === routeNameOf(name));
    return route && jsonEqual(route.target, sandboxPortTarget(sandboxPath, Number(port)))
      ? [route.fetchRouteName]
      : [];
  });
}

const SandboxPortsState = EntityCreationAndDeletionState.extend({
  ports: z.record(z.string(), SandboxPortExposed.omit({ port: true })).default({}),
});

export type SandboxPortDeps = {
  sandboxPath: string;
  /** The mind's domain: a port's host is `<name>.<domain>`. */
  domain: string;
  /** Throws unless the sandbox is strictly beneath the caller: who exposes is who creates. */
  assertBeneathCaller(verb: string): void;
  /** A call of the sandbox's facet, by the library's own hop. */
  facet(steps: ItxExpression): Promise<unknown>;
  /** `fetchRoutes.list()` on `/`, by the library's own hop: a read. */
  routes(): Promise<unknown>;
  /** `fetchRoutes.set` on `/` THROUGH THE CALLER'S OWN `itx.cd("/")`: a caller that may not set a
   *  fetch route (a jail masks `itx.cd`) exposes no port. */
  setRoute(fetchRouteName: string, route: FetchRouteInput | null): Promise<unknown>;
  /** An event on the sandbox's own log, as the caller's. */
  append(event: { type: string; payload: object }): Promise<unknown>;
  /** The container's object, which takes the Request by `fetch`. */
  container(): { fetch(request: Request): Promise<Response> };
};

export async function runSandboxPortCall(
  call: SandboxPortCall,
  deps: SandboxPortDeps,
): Promise<unknown> {
  const { sandboxPath, domain } = deps;
  const urlOf = (name: string) => `https://${name}.${domain}/`;
  const stateOf = async () =>
    SandboxPortsState.parse(
      z.object({ state: z.unknown() }).parse(await deps.facet([["snapshot"]])).state,
    );
  if (call.verb === "fetch") {
    const readiness = SandboxPortReadiness.parse(await deps.facet([["readyPort", call.port]]));
    if (!readiness.ready)
      return new Response(`${readiness.reason}\n`, {
        status: readiness.status,
        headers: {
          "cache-control": "no-store",
          ...(readiness.status === 503 && { "retry-after": "5" }),
        },
      });
    const headers = new Headers(call.request.headers);
    headers.set(SANDBOX_PORT_HEADER, String(call.port));
    return deps.container().fetch(new Request(call.request, { headers }));
  }
  if (call.verb === "getExposedPorts") {
    const [state, routes] = [await stateOf(), FetchRoutes.parse(await deps.routes())];
    return routes.flatMap((route) => {
      const target = PortTarget.safeParse(route.target);
      const name = route.requestMatcher.routingSlug;
      if (!target.success || target.data[2][1] !== sandboxPath || !name) return [];
      const port = target.data[4][1];
      return [
        {
          port,
          name,
          url: urlOf(name),
          public: !route.authRequirement,
          command: state.ports[port]?.command,
        },
      ];
    });
  }
  deps.assertBeneathCaller(call.verb);
  const { port } = call;
  const state = await stateOf();
  if (state.deletion || state.creation?.status !== "created")
    throw codedError("NOT_CREATED", `sandbox ${sandboxPath}: no such sandbox`, {
      path: sandboxPath,
    });
  const held = state.ports[port];
  const target = sandboxPortTarget(sandboxPath, port);
  if (call.verb === "unexposePort") {
    if (!held) return { port, name: null };
    const route = FetchRoutes.parse(await deps.routes()).find(
      (candidate) => candidate.fetchRouteName === routeNameOf(held.name),
    );
    // a route of that name with another target is another port's by now
    if (route && jsonEqual(route.target, target)) await deps.setRoute(routeNameOf(held.name), null);
    await deps.append({ type: "events.iterate.com/sandbox/port-unexposed", payload: { port } });
    return { port, name: held.name };
  }
  const { name, command } = call.options;
  if (held && held.name !== name)
    throw codedError(
      "INVALID_INPUT",
      `port ${port} of ${sandboxPath} is served as ${JSON.stringify(held.name)}: unexposePort(${port}) first`,
    );
  const refusal = portNameRefusal(name, FetchRoutes.parse(await deps.routes()), target, domain);
  if (refusal)
    throw codedError(
      "INVALID_INPUT",
      `exposePort(${port}, { name: ${JSON.stringify(name)} }): ${refusal}`,
    );
  // The route first: it is the claim of the name, and the one write that a caller may be refused.
  await deps.setRoute(routeNameOf(name), {
    requestMatcher: { routingSlug: name },
    target,
    authRequirement: call.options.public ? null : { visitors: "mind-members" },
  });
  try {
    await deps.append({
      type: "events.iterate.com/sandbox/port-exposed",
      payload: { port, name, command },
    });
  } catch (error) {
    // a new host with no fact would outlive the sandbox's delete, which removes what the log names
    if (!held) await deps.setRoute(routeNameOf(name), null).catch(() => undefined);
    throw error;
  }
  return { port, name, url: urlOf(name), public: Boolean(call.options.public) };
}

/** A command that did not open its port is not run again for this long: until then a request gets
 *  the same answer from memory. Else each request of a visitor to a public port whose command fails
 *  would run a command in the sandbox and write a fact to its log. */
const PORT_COMMAND_RETRY_AFTER_MS = 30_000;

export type SandboxPortFailure = { at: number; error: string };

/** The error of a port's last failed command, while it is too recent to run the command again. */
export const heldPortFailure = (
  failure: SandboxPortFailure | undefined,
  now: number,
): string | null =>
  failure && now - failure.at < PORT_COMMAND_RETRY_AFTER_MS ? failure.error : null;

const PLATFORM_HEADER = /^x-(itx|iterate)-/i;
const SESSION_COOKIE = /^__Host-iterate-/;

/** THE REQUEST AS A PROCESS IN THE SANDBOX SEES IT: nothing of the platform's. No `x-itx-*` or
 *  `x-iterate-*` header, and no session cookie of the mind (the boundary removed them already; a
 *  request from a script or an app did not pass it). The host stays the public one, and the scheme
 *  is `http:`, the only one a container's port takes: the visitor's is in `x-forwarded-proto`. A
 *  redirect is the visitor's to follow. */
export function requestToThePort(request: Request): Request {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (PLATFORM_HEADER.test(name)) headers.delete(name);
  const cookies = (headers.get("cookie") || "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie && !SESSION_COOKIE.test(cookie));
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  else headers.delete("cookie");
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  headers.set("x-forwarded-host", url.host);
  url.protocol = "http:";
  return new Request(url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}

/** An answer's headers without the platform's own: a server in a sandbox asks the platform for
 *  nothing (a member's `itx`, a socket's resume) by a header. */
export function headersFromThePort(answer: Headers): Headers {
  const headers = new Headers(answer);
  for (const name of [...headers.keys()]) if (PLATFORM_HEADER.test(name)) headers.delete(name);
  return headers;
}
