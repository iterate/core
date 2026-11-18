import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { ControlPlaneApi, IterateContextApi } from "./api.ts";
import { connectedMind } from "./client/connected-mind.ts";
import { errorCode } from "./lib.ts";
import { startHeartbeat, type Heartbeat } from "./client/heartbeat.ts";
import { openSocketWithRetry, socketOnceOpen } from "./client/socket.ts";

/** What `authenticate` resolves to: the mind's root context as a capnweb stub (pipelined;
 *  disposable), and a read of plain data. Declared, so the package's declarations stay
 *  serializable. */
export type AuthenticatedApp = {
  /** The mind's root context, `/`, as the person signed in: `itx.cd(path)` reaches the rest. A
   *  proxy to the current connection, so a dropped socket costs a reconnect, not the page. It is
   *  usable at once: a call made before the socket has opened goes with the first frames. */
  itx: RpcStub<IterateContextApi>;
  /** Plain data, read over the page's one socket: the mind's API has no other transport. `fn`
   *  makes its calls at once, pipelined, and returns data. A context it addresses on the way is
   *  held with `using` (`using agents = itx.cd("/agents")`): a call's result stays held until
   *  disposed. Anything the page keeps, such as a context to subscribe to, comes from `itx`. */
  read<T>(fn: (itx: RpcStub<IterateContextApi>) => PromiseLike<T>): Promise<T>;
};
export type IterateClient = { authenticate(next?: string): Promise<AuthenticatedApp> };

/** The browser leaves for the gate's sign-in (a document navigation) and this never settles — no
 *  framework in the loop: a TanStack `beforeLoad` awaiting it ends the way a thrown
 *  `redirect({ reloadDocument: true })` did, a plain page simply navigates. */
function leaveForLogin(login: string): Promise<never> {
  window.location.assign(login);
  return new Promise<never>(() => {});
}

/** Where the tab keeps when it last left for a sign-in after a refusal (`adopt`). */
const LEFT_FOR_SIGN_IN = "iterate:left-for-sign-in";

/** Read, or with `value` write, one entry of the tab's `sessionStorage`. Storage is refused in
 *  some frames and private windows: a read then answers null, and a write does nothing. */
function sessionValue(key: string, value?: string): string | null {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** One socket to `/api?mind=<address>`, the bearer attached by the app's gate. The `itx` is the
 *  `mind` of the session that the root answers to `authenticate()` (iterate/api
 *  `ControlPlaneApi`), which reads the bearer that the gate put on the socket's request: the
 *  mind's root context as the person, usable before the socket has even opened, calls queue until it has.
 *  `dispose` forgets the connection and ends its session. */
type Connection = { itx: RpcStub<IterateContextApi>; socket: WebSocket; dispose(): void };

/** Create once per mind a page shows — a TanStack route's client-only `beforeLoad`, or a plain
 *  page's entry. `mind` is the mind's address (iterate/mind-api). Every loader and action
 *  of the page shares the returned connection.
 *
 *  Signing in waits for HTTP only: the probe. The socket's upgrade runs beside it and nothing waits
 *  for it — the connection is adopted on a socket that becomes the upgraded one
 *  (client/socket.ts `socketOnceOpen`), and its calls queue until then. The upgrade tries for a
 *  while (≈16 s of attempts) before its calls fail.
 *  The `itx` the page holds is a proxy to the CURRENT connection: when the socket closes, the next
 *  call opens a fresh one and pipelines onto it. A reconnect the mind refuses (the session ended
 *  elsewhere) rejects that call; the page's retry runs `authenticate` again — a fresh one, the
 *  socket's close forgot the last — whose probe sends the browser to sign in. A bearer that the
 *  gate holds and the mind refuses sends the browser there too (`adopt`). */
export function createIterateClient(options: { mind: string }): IterateClient {
  const { mind } = options;
  let live: Connection | null = null;
  let connecting: Promise<AuthenticatedApp> | undefined;
  /** Where the browser signs in to this mind again, coming back to the page it is on. */
  const login = (next: string) => `/.auth/login?${new URLSearchParams({ mind, next })}`;
  const apiUrl = () => {
    const url = new URL("/api", window.location.href);
    url.searchParams.set("mind", mind);
    return url;
  };
  const socketUrl = () => {
    const url = apiUrl();
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  };
  /** Adopt a connection as the live one until its socket closes or its heartbeat finds it dead
   *  (client/heartbeat.ts; a browser cannot send a WebSocket ping). Either also forgets the settled
   *  `authenticate` — the next one probes `/api` again, so a session that ended elsewhere sends the
   *  browser to sign in instead of a retry that can only fail. A page back in the foreground, or a
   *  network back, beats at once. */
  function adopt(socket: WebSocket): Connection {
    const api = newWebSocketRpcSession<ControlPlaneApi>(socket);
    const connection: Connection = { itx: connectedMind(api), socket, dispose };
    live = connection;
    // THE GATE'S BEARER, REFUSED BY THE MIND (a grant that ended elsewhere): the gate's probe
    // cannot see it, since the mind checks the bearer inside the session. The session's first
    // call says so, and the browser leaves for the gate's sign-in, where the gate asks the mind
    // itself, forgets the session that the mind refuses and starts a new one (app-server.ts
    // `mindRefuses`). ONCE: a page that comes back from that sign-in and is refused again does
    // not leave again within the minute. Its calls fail, and the page says so, where a second
    // leave would be a loop that no person could read.
    Promise.resolve(connection.itx.whoami()).catch((error: unknown) => {
      if (errorCode(error) !== "UNAUTHENTICATED" || live !== connection) return;
      const leftAt = Number(sessionValue(LEFT_FOR_SIGN_IN));
      if (Date.now() - leftAt < 60_000) return;
      sessionValue(LEFT_FOR_SIGN_IN, String(Date.now()));
      void leaveForLogin(login(window.location.href));
    });
    let heartbeat: Heartbeat | undefined;
    const beatNow = () => heartbeat?.beatNow();
    const onVisible = () => document.visibilityState === "visible" && beatNow();
    const forget = () => {
      heartbeat?.stop();
      window.removeEventListener("pagehide", dispose);
      window.removeEventListener("online", beatNow);
      document.removeEventListener("visibilitychange", onVisible);
      if (live !== connection) return;
      live = null;
      connecting = undefined;
    };
    // The session's root is disposed of last: that shuts the session down and closes its socket.
    function dispose() {
      forget();
      connection.itx[Symbol.dispose]();
      api[Symbol.dispose]();
    }
    // from the open on: the upgrade's own attempts are client/socket.ts's to bound
    socket.addEventListener(
      "open",
      () => {
        heartbeat = startHeartbeat({
          beat: () => connection.itx.whoami(),
          onDead: (reason) => {
            console.warn(`The connection to ${mind} is dead (${reason}). Reconnecting.`);
            dispose();
          },
        });
      },
      { once: true },
    );
    socket.addEventListener("close", forget, { once: true });
    window.addEventListener("pagehide", dispose, { once: true });
    window.addEventListener("online", beatNow);
    document.addEventListener("visibilitychange", onVisible);
    return connection;
  }
  // Every property read goes to the live connection — or to a fresh one when the last socket
  // closed (a new WebSocket, no wait: capnweb queues the call until it opens). What comes back is
  // capnweb's own stub for that property — a method stub carries its path, so it is returned as
  // is, never bound or otherwise touched (a capnweb stub answers `.bind` with another stub).
  //
  // Disposing of this `itx` ends the session it is on: the connection is forgotten and its socket
  // closed, with every capability that the session held. The next read opens a new one.
  const itx = new Proxy({} as RpcStub<IterateContextApi>, {
    get(_target, property) {
      if (property === Symbol.dispose) return () => live?.dispose();
      const connection = live || adopt(new WebSocket(socketUrl()));
      return Reflect.get(connection.itx as object, property);
    },
  });
  async function connect(next: string): Promise<AuthenticatedApp> {
    // Two requests at once: the probe and the socket's upgrade, which nothing here waits for
    // (client/socket.ts `socketOnceOpen`). A socket the probe does not lead to is closed unused.
    const opening = live ? undefined : openSocketWithRetry(socketUrl());
    const discard = () =>
      void opening?.then(
        (socket) => socket.close(),
        () => {},
      );
    // HTTP distinguishes 401 from outages; a failed WebSocket is not evidence
    // that the visitor needs to sign in. Errors reach the route's error boundary. The gate
    // answers the probe itself (app-server.ts): whether this browser has a session for the mind.
    const probe = await fetch(apiUrl(), {
      method: "POST",
      body: "",
      signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) => {
      discard();
      throw error;
    });
    await probe.body?.cancel();
    if (!probe.ok) discard();
    if (probe.status === 401) return leaveForLogin(login(next));
    if (!probe.ok) throw new Error(`${mind} is unavailable (${probe.status}). Please retry.`);
    // another read may have opened the live connection meanwhile (`itx`): then this one goes
    if (opening && !live) adopt(socketOnceOpen(opening));
    else discard();
    return { itx, read: async (fn) => await fn(itx) };
  }
  return {
    authenticate(next = "/") {
      connecting ||= connect(next).catch((error) => {
        connecting = undefined;
        throw error;
      });
      return connecting;
    },
  };
}
