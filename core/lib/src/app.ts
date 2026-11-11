import { newHttpBatchRpcSession, newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { IterateContextApi } from "./api.ts";
import { startHeartbeat, type Heartbeat } from "./client/heartbeat.ts";
import { openSocketWithRetry, socketOnceOpen } from "./client/socket.ts";

/** What `authenticate` resolves to: the project's root context as a capnweb stub (pipelined;
 *  disposable), and the fast first read. Declared, so the package's declarations stay
 *  serializable. */
export type AuthenticatedApp = {
  /** The project's root context, `/`, as the person signed in: `itx.cd(path)` reaches the rest. A
   *  proxy to the current connection, so a dropped socket costs a reconnect, not the page. */
  itx: RpcStub<IterateContextApi>;
  /** Plain data, read the fastest way there is: over the socket once it is open, before that as one
   *  capnweb HTTP batch on `POST /api?project=<address>` (a few hundred milliseconds sooner on a
   *  first load). `fn` makes its calls at once, pipelined, and returns data: a stub it returns ends
   *  with the batch, so anything held — a context to subscribe to — comes from `itx`. A context it
   *  addresses on the way is held with `using` (`using agents = itx.cd("/agents")`): over the open
   *  socket a call's result stays held until disposed. */
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

/** One socket to `/api?project=<address>`, the bearer attached by the app's gate. The `itx` is
 *  the session's root, the project's root context as the person: usable before the socket has
 *  even opened, calls queue until it has. */
type Connection = { itx: RpcStub<IterateContextApi>; socket: WebSocket; dispose(): void };
function connectionOn(socket: WebSocket): Connection {
  const itx = newWebSocketRpcSession<IterateContextApi>(socket);
  return { itx, socket, dispose: () => itx[Symbol.dispose]() };
}

/** Create once per project a page shows — a TanStack route's client-only `beforeLoad`, or a plain
 *  page's entry. `project` is the project's address (iterate/project-api). Every loader and action
 *  of the page shares the returned connection.
 *
 *  Signing in waits for HTTP only: the probe. The socket's upgrade runs beside it and nothing waits
 *  for it — the connection is adopted on a socket that becomes the upgraded one
 *  (client/socket.ts `socketOnceOpen`), its calls queue until then, and a page reads its first data
 *  with `read` meanwhile. The upgrade tries for a while (≈16 s of attempts) before its calls fail.
 *  The `itx` the page holds is a proxy to the CURRENT connection: when the socket closes, the next
 *  call opens a fresh one and pipelines onto it. A reconnect the project refuses (the session ended
 *  elsewhere) rejects that call; the page's retry runs `authenticate` again — a fresh one, the
 *  socket's close forgot the last — whose probe sends the browser to sign in. */
export function createIterateClient(options: { project: string }): IterateClient {
  const { project } = options;
  let live: Connection | null = null;
  let connecting: Promise<AuthenticatedApp> | undefined;
  const apiUrl = () => {
    const url = new URL("/api", window.location.href);
    url.searchParams.set("project", project);
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
    const connection = connectionOn(socket);
    live = connection;
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
    function dispose() {
      forget();
      connection.dispose();
    }
    // from the open on: the upgrade's own attempts are client/socket.ts's to bound
    socket.addEventListener(
      "open",
      () => {
        heartbeat = startHeartbeat({
          beat: () => connection.itx.whoami(),
          onDead: (reason) => {
            console.warn(`The connection to ${project} is dead (${reason}). Reconnecting.`);
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
  const itx = new Proxy({} as RpcStub<IterateContextApi>, {
    get(_target, property) {
      const connection = live || adopt(new WebSocket(socketUrl()));
      return Reflect.get(connection.itx as object, property);
    },
  });
  async function read<T>(fn: (itx: RpcStub<IterateContextApi>) => PromiseLike<T>) {
    if (live?.socket.readyState === WebSocket.OPEN) return await fn(live.itx);
    // oxlint-disable-next-line iterate/no-capnweb-http-batch -- One bounded read of plain data while the socket's upgrade is still running, no live capabilities.
    using batch = newHttpBatchRpcSession<IterateContextApi>(apiUrl().href);
    return await fn(batch);
  }
  async function connect(next: string): Promise<AuthenticatedApp> {
    const login = `/.auth/login?${new URLSearchParams({ project, next })}`;
    // Two requests at once: the probe and the socket's upgrade, which nothing here waits for
    // (client/socket.ts `socketOnceOpen`). A socket the probe does not lead to is closed unused.
    const opening = live ? undefined : openSocketWithRetry(socketUrl());
    const discard = () =>
      void opening?.then(
        (socket) => socket.close(),
        () => {},
      );
    // HTTP distinguishes 401 from outages; a failed WebSocket is not evidence
    // that the visitor needs to sign in. Errors reach the route's error boundary.
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
    if (probe.status === 401) return leaveForLogin(login);
    if (!probe.ok) throw new Error(`${project} is unavailable (${probe.status}). Please retry.`);
    // another read may have opened the live connection meanwhile (`itx`): then this one goes
    if (opening && !live) adopt(socketOnceOpen(opening));
    else discard();
    return { itx, read };
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
