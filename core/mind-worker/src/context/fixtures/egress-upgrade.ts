// egress-upgrade.ts — the path of an outbound WebSocket upgrade (`itx.fetch` with `Upgrade:
// websocket`), run in workerd by ../egress-upgrade.test.ts. Two Workers of one bundle, as a stack
// has them: "boundary" ends a client's capnweb session and holds the mind's part of it through
// core/boundary-worker's own `SessionMind`; "mind" runs the kernel (core-itx), whose egress is an
// upstream that greets at once and echoes, as OpenAI's realtime API does. `/loaded` is the mind's
// own code: a loaded worker that calls `this.getItx().fetch` with the upgrade.
import { DurableObject, env, WorkerEntrypoint } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import {
  defineItxHost,
  DurableObjectNameCodec,
  fetchUpgradeLegResponse,
  sessionContext,
} from "core-itx";
import { SessionMind, type MindApiStub } from "../../../../boundary-worker/src/session-mind.ts";

export { IterateContextDurableObject, ItxEntrypoint } from "core-itx";

type Env = {
  MIND: Service<Mind>;
  UPSTREAM: DurableObjectNamespace<Upstream>;
  LOADER: WorkerLoader;
  /** The loaded code's one module, bundled by the test. */
  LOADED_CODE: string;
  COMPATIBILITY_DATE: string;
};

defineItxHost({
  firstPartyFacets: {},
  egress: (request) => upstreamOf().fetch(request),
});

const upstreamOf = () => (env as unknown as Env).UPSTREAM.getByName("upstream");

/** The upstream: one socket at a time. It greets, echoes each frame, and says how the last socket
 *  closed at `/closed`. A Durable Object, so the test can read what it saw. */
export class Upstream extends DurableObject {
  #closed: { code: number; reason: string } | null = null;
  #socket: WebSocket | null = null;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/closed") return Response.json(this.#closed);
    if (url.pathname === "/close") {
      this.#socket?.close(4001, "the upstream ends it");
      return new Response("closing");
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response(`plain ${request.method} ${url.pathname}`);
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    this.#closed = null;
    this.#socket = server;
    server.addEventListener("message", (event) => server.send(`echo ${String(event.data)}`));
    server.addEventListener("close", (event) => {
      this.#closed = { code: event.code, reason: event.reason };
      try {
        server.close(event.code, event.reason);
      } catch {
        // already closing
      }
    });
    server.send(`hello ${url.pathname}`);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}

export class Mind extends WorkerEntrypoint<Env> {
  override fetch(request: Request) {
    const leg = fetchUpgradeLegResponse(request);
    if (leg) return leg;
    if (new URL(request.url).pathname !== "/loaded")
      return new Response("Not found\n", { status: 404 });
    // the mind's own code at its root, with the loopback the kernel mints for it
    const exports = this.ctx.exports as unknown as {
      ItxEntrypoint(options: { props: { iterateContextName: string } }): Fetcher;
    };
    const ITX = exports.ItxEntrypoint({
      props: { iterateContextName: DurableObjectNameCodec.address("/").name },
    });
    const worker = this.env.LOADER.get("loaded", () => ({
      compatibilityDate: this.env.COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_als", "allow_irrevocable_stub_storage"],
      mainModule: "loaded.js",
      modules: { "loaded.js": this.env.LOADED_CODE },
      env: { ITX },
    }));
    return worker.getEntrypoint().fetch(request);
  }

  api() {
    return sessionContext((promise) => this.ctx.waitUntil(promise), {
      principal: { actor: "usr_aaaaabbbbbccccc", email: "member@mind.example" },
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/upstream/closed") return upstreamOf().fetch("https://upstream/closed");
    if (url.pathname === "/upstream/close") return upstreamOf().fetch("https://upstream/close");
    if (url.pathname === "/loaded") return env.MIND.fetch(request);
    if (url.pathname === "/over-rpc") {
      // the mind's part of a session, asked for the upgrade over Workers RPC itself
      using stub = (await env.MIND.api()) as unknown as MindApiStub & Disposable;
      const upgrade = new Request("https://upstream.example/over-rpc", {
        headers: { Upgrade: "websocket" },
      });
      return stub.fetch(upgrade).then(
        (answer) => new Response(`answered ${(answer as Response).status}`),
        (error: unknown) => new Response(String(error)),
      );
    }
    // the boundary: the client's session, whose `mind` is the mind's own part of it
    // (core/boundary-worker/src/control-plane-api.ts `#watchedMind`)
    const stub = (await env.MIND.api()) as unknown as MindApiStub;
    const pair = new WebSocketPair();
    pair[1].accept();
    newWebSocketRpcSession(
      pair[1] as unknown as WebSocket,
      new SessionMind(stub, (dial) => env.MIND.fetch(dial), false),
    );
    return new Response(null, { status: 101, webSocket: pair[0] });
  },
} satisfies ExportedHandler<Env>;
