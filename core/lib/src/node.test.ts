// The Node client (./node.ts) against a real capnweb session over a real `ws` socket: where it
// sends its token, and what it calls on the root of the session.
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { expect, onTestFinished, test } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { addressOf, connectMind } from "./node.ts";

test("a mind whose control plane is a zone's apex: the token goes to that hostname, in `authenticate` and in no header", async () => {
  const mind = await mindOnThisMachine();
  // what a person typed, read once: a URL keeps its hostname
  const address = addressOf("https://example.com");
  using connection = await connectMind({ address, token: "a-bearer", openSocket: mind.openSocket });

  expect(connection).toMatchObject({ address: "example.com" });
  // the session's `mind` is the mind, and its stub outlives the calls that made it
  expect(await connection.itx.whoami()).toEqual({ path: "/" });
  expect(mind).toMatchObject({
    dialled: [{ url: "wss://example.com/api", headers: undefined }],
    authenticated: ["a-bearer"],
  });
});

test("a token that the mind refuses fails the connection, with the mind's own word", async () => {
  const mind = await mindOnThisMachine();
  await expect(
    connectMind({ address: "example.com", token: "refused", openSocket: mind.openSocket }),
  ).rejects.toThrow("sign in again");
});

test("the shorthand is for what a person typed: an address that a function hands on is taken as it is", async () => {
  const mind = await mindOnThisMachine();
  // read twice, the bare name's `iterate.` would be put before an address that has it already,
  // or before an apex
  for (const address of [addressOf("example.com"), "example.com"]) {
    using _connection = await connectMind({ address, token: "t", openSocket: mind.openSocket });
  }
  expect(mind.dialled.map((dial) => dial.url)).toEqual([
    "wss://iterate.example.com/api",
    "wss://example.com/api",
  ]);
});

/** A mind's `/api` on this machine: the root of each session answers a session to
 *  `authenticate`, whose `mind` is the mind. `openSocket` is `connectMind`'s way to it: it records
 *  where the client meant to go, and with what headers, and dials here. */
async function mindOnThisMachine() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  onTestFinished(() => void server.close());
  const { port } = server.address() as { port: number };
  const state = {
    authenticated: [] as unknown[],
    dialled: [] as { url: string; headers: unknown }[],
  };
  class Mind extends RpcTarget {
    whoami() {
      return { path: "/" };
    }
  }
  class Session extends RpcTarget {
    get mind() {
      return new Mind();
    }
  }
  class Root extends RpcTarget {
    authenticate(token: unknown) {
      if (token === "refused") throw new Error("no live credential of this mind: sign in again");
      state.authenticated.push(token);
      return new Session();
    }
  }
  server.on("connection", (socket) =>
    // ws implements the DOM event/send/close interface that capnweb takes
    newWebSocketRpcSession(socket as unknown as globalThis.WebSocket, new Root()),
  );
  return Object.assign(state, {
    openSocket: (url: string, options: WebSocket.ClientOptions) => {
      state.dialled.push({ url, headers: options.headers });
      return new WebSocket(`ws://127.0.0.1:${port}`, options);
    },
  });
}
