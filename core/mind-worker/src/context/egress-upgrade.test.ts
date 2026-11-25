// egress-upgrade.test.ts — `itx.fetch` with `Upgrade: websocket` out of the mind, in workerd
// (./fixtures/egress-upgrade.ts). A client's capnweb session ends in the boundary, which holds the
// mind's part of the session as a Workers RPC stub; Workers RPC cannot carry a WebSocket ("Could
// not serialize object of type "WebSocket""), so the 101 must come back another way. The mind's own
// code holds its `itx` over Workers RPC too, and gets the same 101.
import { fileURLToPath } from "node:url";
import { build, type BuildOptions } from "esbuild";
import { Miniflare } from "miniflare";
import { newWebSocketRpcSession } from "capnweb";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { expect, test } from "vitest";

test(
  "a session's itx.fetch upgrade answers 101 with a socket, and a close of either side closes the other",
  { timeout: 60_000 },
  async () => {
    await using runtime = await egressPath();
    const origin = (await runtime.ready).href.replace(/^http/, "ws");
    using itx = newWebSocketRpcSession<{ fetch(request: Request): Promise<Response> }>(origin);

    const plain = await itx.fetch(new Request("https://upstream.example/plain"));
    expect(await plain.text()).toBe("plain GET /plain");

    const first = await opened(itx, "/session");
    expect(first).toMatchObject({ status: 101 });
    expect(await first.next()).toBe("hello /session");
    first.socket.send("ping");
    expect(await first.next()).toBe("echo ping");
    first.socket.close(1000, "the client ends it");
    expect(await upstreamClosed(runtime)).toEqual({ code: 1000, reason: "the client ends it" });

    const second = await opened(itx, "/again");
    expect(await second.next()).toBe("hello /again");
    await (await runtime.dispatchFetch("http://boundary.example/upstream/close")).text();
    expect(await second.closed).toBe(4001);
  },
);

test("an upgrade through a `cd` is answered by that context, under its own rules", async () => {
  await using runtime = await egressPath();
  const origin = (await runtime.ready).href.replace(/^http/, "ws");
  type Session = { fetch(request: Request): Promise<Response>; cd(path: string): Session };
  using itx = newWebSocketRpcSession<Session>(origin);
  // this host gives `fetch` to `/` alone, so a child's table refuses it, the dial's as the RPC's
  const answers = await Promise.all(
    [new Headers(), new Headers({ Upgrade: "websocket" })].map(async (headers) => {
      const answer = await itx
        .cd("/elsewhere")
        .fetch(new Request("https://upstream.example/cd", { headers }));
      return { status: answer.status, text: await answer.text() };
    }),
  );
  expect(answers[1]).toEqual(answers[0]);
  expect(answers[1]).toMatchObject({
    status: 404,
    text: expect.stringContaining("no rewrite rule"),
  });
});

test("the end of a session closes the upstream socket it opened", { timeout: 60_000 }, async () => {
  await using runtime = await egressPath();
  const origin = (await runtime.ready).href.replace(/^http/, "ws");
  const itx = newWebSocketRpcSession<{ fetch(request: Request): Promise<Response> }>(origin);
  const socket = await opened(itx, "/ended");
  expect(await socket.next()).toBe("hello /ended");
  itx[Symbol.dispose]();
  expect(await upstreamClosed(runtime)).toMatchObject({ code: expect.any(Number) });
});

// The reason for `fetchUpgradeDial` and for the scope's own upgrade (core-itx, iterate/sdk
// itx-scope.ts): once this answers 101, Workers RPC carries a socket, and both can go.
test(
  "Workers RPC still cannot return a Response that holds a WebSocket",
  { timeout: 60_000 },
  async () => {
    await using runtime = await egressPath();
    const answer = await runtime.dispatchFetch("http://boundary.example/over-rpc");
    expect(await answer.text()).toContain('Could not serialize object of type "WebSocket"');
  },
);

test(
  "the mind's own code gets the 101 of its itx.fetch upgrade, with the socket",
  { timeout: 60_000 },
  async () => {
    await using runtime = await egressPath();
    const answer = await runtime.dispatchFetch("http://boundary.example/loaded");
    expect(await answer.json()).toEqual({ status: 101, frames: ["hello /loaded", "echo ping"] });
    expect(await upstreamClosed(runtime)).toEqual({ code: 1000, reason: "the code ends it" });
  },
);

type ClientSocket = {
  accept?(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void;
};

async function opened(itx: { fetch(request: Request): Promise<Response> }, path: string) {
  const answer = await itx.fetch(
    new Request(`https://upstream.example${path}`, {
      headers: { Upgrade: "websocket", Authorization: 'Bearer getSecret("/secrets/upstream")' },
    }),
  );
  const socket = (answer as unknown as { webSocket?: ClientSocket }).webSocket;
  if (!socket) throw new Error(`no socket: ${answer.status} ${await answer.text()}`);
  const frames: unknown[] = [];
  const waiting: ((frame: unknown) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const wait = waiting.shift();
    if (wait) wait(event.data);
    else frames.push(event.data);
  });
  const closed = new Promise<number | undefined>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code)),
  );
  socket.accept?.();
  return {
    // capnweb gives a 101 as a status-200 Response that holds the socket, outside workerd
    status: answer.status === 200 ? 101 : answer.status,
    socket,
    closed,
    next: () =>
      frames.length
        ? Promise.resolve(frames.shift())
        : new Promise<unknown>((resolve) => waiting.push(resolve)),
  };
}

/** How the upstream's socket closed, once it has. */
async function upstreamClosed(runtime: Miniflare): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const closed = await (
      await runtime.dispatchFetch("http://boundary.example/upstream/closed")
    ).json();
    if (closed || attempt === 100) return closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** One module of `input`, for workerd. */
async function bundled(input: Pick<BuildOptions, "entryPoints" | "stdin">): Promise<string> {
  const result = await build({
    ...input,
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd"],
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
  });
  return result.outputFiles[0]!.text;
}

// the code a mind loads: an SDK entrypoint whose `fetch` opens the upgrade through `getItx()`
const loadedCode = [
  'import { IterateConfigEntrypoint } from "iterate/sdk";',
  "export default class Loaded extends IterateConfigEntrypoint {",
  "  processEvent() {}",
  "  async email() {}",
  "  async fetch() {",
  "    const itx = this.getItx();",
  "    try {",
  '      const answer = await itx.fetch(new Request("https://upstream.example/loaded", { headers: { Upgrade: "websocket" } }));',
  "      const socket = answer.webSocket;",
  "      if (!socket) return Response.json({ status: answer.status, body: await answer.text() });",
  "      socket.accept();",
  "      const frames = [];",
  '      const two = new Promise((resolve) => socket.addEventListener("message", (event) => {',
  "        frames.push(event.data);",
  "        if (frames.length === 2) resolve();",
  "      }));",
  '      socket.send("ping");',
  "      await two;",
  '      socket.close(1000, "the code ends it");',
  "      return Response.json({ status: answer.status, frames });",
  "    } catch (error) {",
  "      return Response.json({ threw: String(error) });",
  "    } finally {",
  "      itx[Symbol.dispose]();",
  "    }",
  "  }",
  "}",
].join("\n");

async function egressPath() {
  const [fixture, loaded] = await Promise.all([
    bundled({
      entryPoints: [fileURLToPath(new URL("./fixtures/egress-upgrade.ts", import.meta.url).href)],
    }),
    bundled({
      stdin: {
        contents: loadedCode,
        resolveDir: fileURLToPath(new URL(".", import.meta.url).href),
        loader: "js",
      },
    }),
  ]);
  const script = {
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage"],
    manifest: {
      mainModule: "worker.js",
      modules: { "worker.js": { type: "esm" as const, contents: fixture } },
    },
  };
  const upstream = { type: "durable-object", worker: "mind", exportName: "Upstream" } as const;
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          ...script,
          name: "boundary",
          env: { MIND: { type: "worker", worker: "mind", exportName: "Mind" }, UPSTREAM: upstream },
        },
      },
      {
        config: {
          ...script,
          name: "mind",
          env: {
            UPSTREAM: upstream,
            CONTEXTS: {
              type: "durable-object",
              worker: "mind",
              exportName: "IterateContextDurableObject",
            },
            CF_VERSION_METADATA: { type: "version-metadata" },
            LOADER: { type: "worker-loader" },
            LOADED_CODE: { type: "text", value: loaded },
            COMPATIBILITY_DATE: { type: "text", value: COMPATIBILITY_DATE },
          },
          exports: {
            IterateContextDurableObject: { type: "durable-object", storage: "sqlite" },
            Upstream: { type: "durable-object", storage: "sqlite" },
            ItxEntrypoint: { type: "worker" },
          },
        },
      },
    ],
  });
  await runtime.ready;
  return Object.assign(runtime, { [Symbol.asyncDispose]: () => runtime.dispose() });
}
