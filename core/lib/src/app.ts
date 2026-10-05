import { newHttpBatchRpcSession, newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { IterateApi, IterateSessionApi } from "./api.ts";
import { openSocketWithRetry, socketOnceOpen } from "./client/socket.ts";
import { OAuthScopes } from "./oauth-scopes.ts";

/** What `authenticate` resolves to: the session as a capnweb stub (pipelined; disposable) and the
 *  bootstrap info it answered with. Declared, so the package's declarations stay serializable. */
export type AuthenticatedApp = {
  api: RpcStub<IterateSessionApi>;
  info: ReturnType<IterateSessionApi["info"]>;
  /** The page names a project this sign-in does not include — its `/projects/<ref>` is absent from
   *  `api.projects.list()`: leave for `/.auth/login`, whose page offers to sign in again (the
   *  project ticked at consent, or another account) and returns to this very URL. Never settles,
   *  like `authenticate`'s own leave for login. */
  signInFor(project: string): Promise<never>;
  /** Plain data, read the fastest way there is: over the socket once it is open, before that as one
   *  capnweb HTTP batch on `POST /api` (a few hundred milliseconds sooner on a first load). `fn`
   *  makes its calls at once, pipelined, and returns data: a stub it returns ends with the batch,
   *  so anything held — a context to subscribe to — comes from `api`. A context it addresses on the
   *  way is held with `using` (`using project = api.projects.get(id)`): over the open socket a call's
   *  result stays held until disposed. */
  read<T>(fn: (session: RpcStub<IterateSessionApi>) => PromiseLike<T>): Promise<T>;
};
export type IterateClient = { authenticate(next?: string): Promise<AuthenticatedApp> };

/** The browser leaves for the issuer's login (a document navigation) and this never settles — no
 *  framework in the loop: a TanStack `beforeLoad` awaiting it ends the way a thrown
 *  `redirect({ reloadDocument: true })` did, a plain page simply navigates. */
function leaveForLogin(login: string): Promise<never> {
  window.location.assign(login);
  return new Promise<never>(() => {});
}

/** One socket to `/api` with the session the OAuth gate resolved from the cookie. The `api` is
 *  capnweb's pipelined `authenticate(...)` answer: usable before the socket has even opened, calls
 *  queue until it has. */
type Connection = { api: RpcStub<IterateSessionApi>; socket: WebSocket; dispose(): void };
function connectionOn(socket: WebSocket): Connection {
  const iterate = newWebSocketRpcSession<IterateApi>(socket);
  const api = iterate.authenticate({
    type: "from-server-cookie",
  }) as unknown as RpcStub<IterateSessionApi>;
  return { api, socket, dispose: () => iterate[Symbol.dispose]() };
}

/** Create once per app — a TanStack route's client-only `beforeLoad`, or a plain page's entry.
 *  Every loader and action of the page shares the returned public RPC session.
 *
 *  Signing in waits for HTTP only: the probe and the session's info. The socket's upgrade runs
 *  beside them and nothing waits for it — the connection is adopted on a socket that becomes the
 *  upgraded one (client/socket.ts `socketOnceOpen`), its calls queue until then, and a page reads
 *  its first data with `read` meanwhile. The upgrade tries for a while (≈16 s of attempts) before
 *  its calls fail — a phone waking up or a flapping tunnel is not a reason to show "connection
 *  failed". And the `api` the page holds is a proxy to the CURRENT connection: when the socket
 *  closes, the next call opens a fresh one and pipelines onto it, so a dropped connection costs a
 *  reconnect, not the page. A reconnect the platform refuses (the session ended elsewhere) rejects that call; the
 *  page's retry runs `authenticate` again — a fresh one, the socket's close forgot the last — whose
 *  probe sends the browser to log in. */
export function createIterateClient(options: { scopes?: string[] } = {}): IterateClient {
  const scopes = OAuthScopes.parse(options.scopes || []);
  let live: Connection | null = null;
  let connecting: Promise<AuthenticatedApp> | undefined;
  const socketUrl = () => {
    const url = new URL("/api", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  };
  /** Adopt a connection as the live one until its socket closes. A close also forgets the settled
   *  `authenticate` — the next one probes `/api` again, so a session that ended elsewhere sends the
   *  browser to log in instead of a retry that can only fail. */
  function adopt(socket: WebSocket): Connection {
    const connection = connectionOn(socket);
    live = connection;
    const forget = () => {
      if (live !== connection) return;
      live = null;
      connecting = undefined;
    };
    const dispose = () => {
      forget();
      connection.dispose();
    };
    socket.addEventListener(
      "close",
      () => {
        forget();
        window.removeEventListener("pagehide", dispose);
      },
      { once: true },
    );
    window.addEventListener("pagehide", dispose, { once: true });
    return connection;
  }
  // Every property read goes to the live connection — or to a fresh one when the last socket
  // closed (a new WebSocket, no wait: capnweb queues the call until it opens). What comes back is
  // capnweb's own stub for that property — a method stub carries its path, so it is returned as
  // is, never bound or otherwise touched (a capnweb stub answers `.bind` with another stub).
  const api = new Proxy({} as RpcStub<IterateSessionApi>, {
    get(_target, property) {
      const connection = live || adopt(new WebSocket(socketUrl()));
      return Reflect.get(connection.api as object, property);
    },
  });
  const loginUrl = (params: Record<string, string>) =>
    `/.auth/login?${new URLSearchParams({ scope: scopes.join(" "), ...params })}`;
  async function read<T>(fn: (session: RpcStub<IterateSessionApi>) => PromiseLike<T>) {
    if (live?.socket.readyState === WebSocket.OPEN) return await fn(live.api);
    // oxlint-disable-next-line iterate/no-capnweb-http-batch -- One bounded read of plain data while the socket's upgrade is still running, no live capabilities.
    using batch = newHttpBatchRpcSession<IterateApi>(new URL("/api", window.location.href).href);
    // the session `authenticate` answers, pipelined — the same cast as `connectionOn`'s
    return await fn(
      batch.authenticate({ type: "from-server-cookie" }) as unknown as RpcStub<IterateSessionApi>,
    );
  }
  async function connect(next: string): Promise<AuthenticatedApp> {
    const login = loginUrl({ next });
    // Three requests at once: the probe, the session's info, and the socket's upgrade, which nothing
    // here waits for (client/socket.ts `socketOnceOpen`). A socket the probe does not lead to is
    // closed unused.
    const opening = live ? undefined : openSocketWithRetry(socketUrl());
    const discard = () =>
      void opening?.then(
        (socket) => socket.close(),
        () => {},
      );
    // Consent is task-based: the person may have granted fewer scopes than the app asked for
    // (every scope but `iterate` is optional on the consent page). The granted set is
    // `info.scopes` — an app reads it and offers a step-up link (`/.auth/login?scope=…`) for what
    // it lacks; it is never bounced back to consent for a permission the person declined.
    const reading = read((session) => session.info());
    reading.catch(() => {}); // unread when the probe sends the browser away
    // HTTP distinguishes 401 from outages; a failed WebSocket is not evidence
    // that the visitor needs to log in. Errors reach the route's error boundary.
    const probe = await fetch("/api", {
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
    if (!probe.ok) throw new Error(`iterate is unavailable (${probe.status}). Please retry.`);
    // another read may have opened the live connection meanwhile (`api`): then this one goes
    if (opening && !live) adopt(socketOnceOpen(opening));
    else discard();
    return {
      api,
      info: await reading,
      read,
      signInFor: (project) => leaveForLogin(loginUrl({ next: window.location.href, project })),
    };
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
