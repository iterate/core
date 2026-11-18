// The browser client (./app.ts) against a real mind API on this machine: an HTTP server with a
// `ws` socket server, each speaking capnweb. Node's own `fetch` and `WebSocket` are the
// browser's; `window` and `document` are the few members that the client reads.
import { createServer } from "node:http";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { expect, onTestFinished, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createIterateClient } from "./app.ts";

test("disposing of the page's itx ends its session, and the next read is on a new one", async () => {
  const mind = await mindOnThisMachine();
  const { itx, read } = await createIterateClient({ mind: "example.com" }).authenticate();
  expect(await itx.whoami()).toEqual({ session: 1 });

  itx[Symbol.dispose]();
  // the session's socket closes, with all that the session held
  expect(await mind.closed(1)).toBe(true);
  // a read while no socket is open opens a new session: the API has no other transport
  expect(await read((over) => over.whoami())).toEqual({ session: 2 });
  // and a call on the same itx is on that session
  expect(await itx.whoami()).toEqual({ session: 2 });
  // the page authenticates with no token: the credential is on the socket's own request
  expect(mind).toMatchObject({ authenticatedWith: [[undefined], [undefined]] });
});

test("a bearer that the gate holds and the mind refuses sends the browser to the gate's sign-in, once: a page that is refused again within the minute stays and fails", async () => {
  const mind = await mindOnThisMachine({ refuses: true });
  const client = createIterateClient({ mind: "example.com" });
  const { itx } = await client.authenticate("/here");
  await expect(Promise.resolve(itx.whoami())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  const signIn = `/.auth/login?${new URLSearchParams({ mind: "example.com", next: mind.href })}`;
  await vi.waitFor(() => expect(mind).toMatchObject({ left: [signIn] }));

  // the page as it comes back from that sign-in, in the same tab, and is refused again
  itx[Symbol.dispose]();
  const back = await createIterateClient({ mind: "example.com" }).authenticate("/here");
  await expect(Promise.resolve(back.itx.whoami())).rejects.toMatchObject({
    code: "UNAUTHENTICATED",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mind).toMatchObject({ left: [signIn] });
});

/** A mind's `/api` on this machine, with the page's `window` and `document` pointed at it. Each
 *  socket is a session with a number, which its mind answers to `whoami`. The HTTP server is the
 *  app's gate, which answers the page's probe itself. */
async function mindOnThisMachine(options: { refuses?: true } = {}) {
  const authenticatedWith: unknown[][] = [];
  class Root extends RpcTarget {
    readonly #session: number;
    constructor(session: number) {
      super();
      this.#session = session;
    }
    authenticate(...args: unknown[]) {
      authenticatedWith.push(args);
      if (options.refuses)
        throw Object.assign(new Error("sign in again"), { code: "UNAUTHENTICATED" });
      const session = this.#session;
      class Mind extends RpcTarget {
        whoami() {
          return { session };
        }
      }
      class Session extends RpcTarget {
        get mind() {
          return new Mind();
        }
      }
      return new Session();
    }
  }
  const http = createServer((_request, response) => void response.writeHead(204).end());
  const sockets = new WebSocketServer({ server: http });
  const closed = new Map<number, Promise<boolean>>();
  sockets.on("connection", (socket) => {
    const session = closed.size + 1;
    closed.set(session, new Promise((resolve) => socket.once("close", () => resolve(true))));
    // ws implements the DOM event/send/close interface that capnweb takes
    newWebSocketRpcSession(socket as unknown as WebSocket, new Root(session));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => {
    for (const socket of sockets.clients) socket.terminate();
    http.close();
  });
  const { port } = http.address() as { port: number };
  const listens = { addEventListener() {}, removeEventListener() {} };
  const href = `http://127.0.0.1:${port}/`;
  const left: string[] = [];
  const stored = new Map<string, string>();
  vi.stubGlobal("window", {
    ...listens,
    location: { href, assign: (to: string) => void left.push(to) },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
  });
  vi.stubGlobal("document", { ...listens, visibilityState: "visible" });
  return { closed: (session: number) => closed.get(session), authenticatedWith, left, href };
}
