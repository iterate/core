// tunnel.ts — `iterate tunnel <port>`: a local port served on one of the mind's hostnames,
// `<name>.<the mind's first zone>`, through a stub lent to the mind with the fetch route that reaches it.
import { randomBytes } from "node:crypto";
import { RpcTarget, upgradeWebSocketResponse, WebSocketPair } from "capnweb";
import WebSocket from "ws";
import type { MindConnection } from "../node.ts";

/** Headers the local dial makes itself: undici throws on the hop-by-hop ones, and `host` must be
 *  localhost's (Vite's `allowedHosts` refuses any other). */
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host",
];

/** THE TUNNEL'S LENT STUB: every request the mind's host routes here, proxied to
 *  `http://localhost:<port>` — method, headers, streamed body, redirects handed back as they are.
 *  A WebSocket upgrade dials the local server with the visitor's subprotocols and pumps frames both
 *  ways. Nothing listening is a 502 naming the port. */
export class LocalPortRpcTarget extends RpcTarget {
  readonly #port: number;
  readonly #log: (line: string) => void;

  constructor(port: number, log: (line: string) => void = () => {}) {
    super();
    this.#port = port;
    this.#log = log;
  }

  async fetch(request: Request): Promise<Response> {
    const visitorUrl = new URL(request.url);
    // Set piecewise, never joined as a string: a path of `//other-host/` must stay a path on
    // localhost, never become a destination.
    const localUrl = new URL(`http://localhost:${this.#port}`);
    localUrl.pathname = visitorUrl.pathname;
    localUrl.search = visitorUrl.search;
    const headers = new Headers(request.headers);
    for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
    if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket")
      return this.#upgradeWebSocket(request, localUrl, headers);
    let response: Response;
    try {
      response = await fetch(localUrl, {
        method: request.method,
        headers,
        body: request.body,
        // a streamed request body needs half duplex (undici), which the DOM's RequestInit type
        // does not declare — hence the cast
        duplex: "half",
        redirect: "manual",
      } as RequestInit);
    } catch (error) {
      this.#log(
        `${request.method} ${localUrl.pathname}${localUrl.search} → 502 (${causeOf(error)})`,
      );
      return new Response(`Nothing answered on localhost:${this.#port} (${causeOf(error)})\n`, {
        status: 502,
      });
    }
    this.#log(`${request.method} ${localUrl.pathname}${localUrl.search} → ${response.status}`);
    // Node's fetch always decodes a compressed body, so its encoding and length no longer hold
    const responseHeaders = new Headers(response.headers);
    if (responseHeaders.has("content-encoding")) {
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  /** The local server's WebSocket, bridged through a `WebSocketPair`: the pair buffers what the
   *  server says before the visitor's side is wired (Vite's HMR server greets at once). */
  async #upgradeWebSocket(request: Request, localUrl: URL, headers: Headers): Promise<Response> {
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((protocol) => protocol.trim())
      .filter(Boolean);
    localUrl.protocol = "ws:";
    const pair = new WebSocketPair();
    const visitorSide = pair[1];
    // accepted first: a half sends only once accepted, and the local server may speak the moment
    // it opens; the visitor's half buffers until the visitor accepts it
    visitorSide.accept();
    const localHeaders: Record<string, string> = {};
    // the handshake's own headers are the local dial's to make
    headers.forEach((value, name) => {
      if (!name.startsWith("sec-websocket-")) localHeaders[name] = value;
    });
    const local = new WebSocket(localUrl, protocols, { headers: localHeaders });
    local.on("message", (data, isBinary) => {
      // ws's default binaryType, nodebuffer, delivers every message as one Buffer
      const buffer = data as Buffer;
      try {
        visitorSide.send(isBinary ? new Uint8Array(buffer) : buffer.toString());
      } catch {
        /* the visitor's side is closing; its close tears the bridge down */
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        local.once("open", resolve);
        local.once("error", reject);
        local.once("unexpected-response", (_request, response) =>
          reject(new Error(`the local server answered ${response.statusCode}`)),
        );
      });
    } catch (error) {
      visitorSide.close(1011, "no local WebSocket");
      this.#log(`WS ${localUrl.pathname} → 502 (${causeOf(error)})`);
      return new Response(
        `No WebSocket answered on localhost:${this.#port} (${causeOf(error)})\n`,
        { status: 502 },
      );
    }
    this.#log(`WS ${localUrl.pathname} → 101${local.protocol ? ` (${local.protocol})` : ""}`);
    visitorSide.addEventListener(
      "message",
      (event: { data: string | ArrayBuffer | Uint8Array }) => {
        if (local.readyState === WebSocket.OPEN) local.send(event.data);
      },
    );
    visitorSide.addEventListener("close", (event: { code?: number; reason?: string }) => {
      local.close(relayedCloseCode(event.code), event.reason);
    });
    local.on("close", (code, reason) => {
      try {
        visitorSide.close(relayedCloseCode(code), reason.toString());
      } catch {
        /* already closing */
      }
    });
    local.on("error", () => {
      try {
        visitorSide.close(1011, "the local WebSocket failed");
      } catch {
        /* already closing */
      }
    });
    return upgradeWebSocketResponse(pair[0], {
      headers: local.protocol ? { "Sec-WebSocket-Protocol": local.protocol } : {},
    });
  }
}

/** The platform's close-code policy (core/itx/src/context/websocket-close.ts `relayedCloseCode`),
 *  copied, since this package is published on its own. */
function relayedCloseCode(code: number | undefined): number {
  if (code === undefined || code === 1005) return 1000;
  if ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014)) return code;
  return code >= 3000 && code <= 4999 ? code : 1011;
}

/** undici hides the reason a dial failed (ECONNREFUSED) in `cause`. */
function causeOf(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code || cause?.message || (error instanceof Error ? error.message : String(error));
}

/** How long the tunnel waits before each attempt to reconnect after its connection closed, about
 *  five minutes in all: long enough for Wi-Fi to come back or a laptop to wake, short enough that a
 *  tunnel whose network is gone for good says so and exits. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, ...Array(9).fill(30_000)];

/** `iterate tunnel <port>`: lend a `LocalPortRpcTarget` to the mind as `itx.tunnels.<name>` with
 *  the fetch route `tunnel-<name>` taking one hostname's requests to it (`hostname`, or
 *  `<name>.<the mind's first zone>`), print the URL on stdout, and on Ctrl-C delete the
 *  route, then end the lend. The route rides the lend (`provide`'s `fetchRoute`):
 *  the platform sets it again whenever it re-attaches the lend and removes it when the lend ends —
 *  a tunnel killed outright, or asleep, leaves no route behind. A connection that closes (its
 *  heartbeat found it dead, iterate/node) is replaced: `reconnect` opens a fresh one and the tunnel
 *  lends and routes again over it, the same name taking its own route over. Only when every attempt
 *  fails does the tunnel end, with an error. */
export async function runTunnel(input: {
  connection: MindConnection;
  reconnect: () => Promise<MindConnection>;
  port: number;
  tunnelName?: string;
  /** the one hostname the route matches (`url: { hostname }`): `<name>.<the mind's first zone>`
   *  when absent */
  hostname?: string;
  public?: boolean;
  /** the reconnect schedule — a test's, `RECONNECT_DELAYS_MS` otherwise */
  reconnectDelaysMs?: readonly number[];
}): Promise<void> {
  const tunnelName = input.tunnelName || `t${randomBytes(4).toString("hex")}`;
  const fetchRouteName = `tunnel-${tunnelName}`;
  const target = `itx.tunnels.${tunnelName}`;
  // The platform takes any URLPattern hostname (`*` included); a tunnel's is one literal host.
  if (input.hostname && !/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]+$/.test(input.hostname))
    throw new Error(
      `--hostname ${JSON.stringify(input.hostname)} is not one lowercase hostname, e.g. hello.tunnels.example.com`,
    );
  // Listening before the route is set: until a listener is installed the OS's default action ends
  // the process at once, which would leave the route standing.
  let stop = () => {};
  const stopped = new Promise<"stopped">((resolve) => (stop = () => resolve("stopped")));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  /** Serve over one connection until Ctrl-C (the route deleted), or until the connection closes or
   *  the lend ends — why, as a line. */
  const serve = async (connection: MindConnection, first: boolean): Promise<"stopped" | string> => {
    const mind = connection.itx;
    // THE MIND SAYS WHETHER THE HOSTNAME IS ONE ITS OWN CODE ANSWERS, before any route is set:
    // `itx.url` refuses a hostname outside the mind's zones, and the control-plane hostname, where no
    // route is ever asked (`--name iterate` on the first zone names it). `itx.url()` is the apex
    // of the first zone, and the tunnel's own hostname is a label under it.
    const url = await mind.url({
      hostname: input.hostname || `${tunnelName}.${new URL(await mind.url()).hostname}`,
    });
    const { hostname } = new URL(url);
    // A route of this name or on this host is someone else's unless it is this tunnel's own (a
    // restart, another terminal, this tunnel before it reconnected), which is taken over.
    const conflict = (await mind.fetchRoutes.list()).find(
      (route) =>
        (route.fetchRouteName === fetchRouteName ||
          route.requestMatcher.url?.hostname === hostname) &&
        !(route.fetchRouteName === fetchRouteName && route.target.join(".") === target),
    );
    if (conflict)
      throw new Error(
        `The fetch route ${conflict.fetchRouteName} (target ${conflict.target.join(".")}) already has this name or host. Pick another ${input.hostname ? "--name or --hostname" : "--name"}.`,
      );
    using lend = await mind.provide(
      target,
      new LocalPortRpcTarget(input.port, (line) => console.error(line)),
      {
        fetchRoute: {
          fetchRouteName,
          requestMatcher: { url: { hostname } },
          authRequirement: input.public ? null : { visitors: "mind-members" },
        },
      },
    );
    if (first) {
      console.log(url);
      console.error(
        `${url} → http://localhost:${input.port} (${input.public ? "public" : "mind members only"}). Press Ctrl-C to stop.`,
      );
    } else console.error(`Reconnected: ${url} → http://localhost:${input.port}`);
    // The lend can end while the connection lives (the platform lost its pager, and the route
    // with it): serving again over a fresh connection lends and routes again.
    const lendEnded = lend.lendEnded().then(
      (reason) => `its lend ended: the stub ${reason}`,
      (error: unknown) => `its lend ended: ${messageOf(error)}`,
    );
    const connectionClosed = connection.closed.then(
      ({ code, reason }) => `${code}: ${reason || "connection closed"}`,
    );
    const outcome = await Promise.race([stopped, connectionClosed, lendEnded]);
    // the route first: the host stops answering the moment it is gone
    if (outcome === "stopped")
      await mind.fetchRoutes.set(fetchRouteName, null).catch((error: unknown) => {
        console.error(`Could not delete the fetch route ${fetchRouteName}: ${messageOf(error)}`);
      });
    return outcome;
  };
  const delaysMs = input.reconnectDelaysMs || RECONNECT_DELAYS_MS;
  let connection: MindConnection | null = input.connection;
  let lastFailure = "";
  try {
    for (let first = true, failures = 0; ; first = false) {
      if (connection) {
        try {
          const outcome = await serve(connection, first);
          if (outcome === "stopped") return;
          lastFailure = outcome;
          console.error(`The tunnel disconnected (${lastFailure}). Reconnecting...`);
          failures = 0; // it was serving: a fresh round of attempts
        } catch (error) {
          if (first) throw error; // the first connection's refusal (a taken name) is the answer
          lastFailure = messageOf(error);
          console.error(`Could not serve the tunnel again: ${lastFailure}`);
        } finally {
          connection[Symbol.dispose]();
        }
      }
      const delayMs = delaysMs[failures++];
      if (delayMs === undefined)
        throw new Error(
          `The tunnel disconnected and could not reconnect (${lastFailure}). Run iterate tunnel again.`,
        );
      let wait: ReturnType<typeof setTimeout> | undefined;
      const waited = await Promise.race([
        stopped,
        new Promise<"waited">((resolve) => (wait = setTimeout(() => resolve("waited"), delayMs))),
      ]);
      clearTimeout(wait);
      if (waited === "stopped") return;
      connection = await input.reconnect().catch((error: unknown) => {
        lastFailure = messageOf(error);
        console.error(`Could not reconnect: ${lastFailure}`);
        return null;
      });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
