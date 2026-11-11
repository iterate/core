import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { codedError, leavingTheStack } from "iterate/lib";
import { mindProvideUrlOf } from "iterate/mind-api";
import { FACTS_HEADER } from "iterate/facts";
import { secretPathsReferenced } from "iterate/secret-placeholder";
import type { Door as BoundaryDoor, MindTarget, ProvideSession } from "iterate/workers";
import { forwardEveryMethod, relayTo } from "./relay.ts";

export { HomeArtifacts } from "../repos/artifacts.ts";

type LinkEnv = {
  DOMAIN: string;
  MIND: MindTarget;
  LINK: DurableObjectNamespace<Link>;
  /** The launcher: `GET` answers a live token for `iterate.<domain>/provide`. */
  TOKEN: Fetcher;
};

export default {
  async fetch(request, env) {
    const domain = env.DOMAIN;
    const url = new URL(request.url);
    const link = env.LINK.getByName(domain);
    // the launcher's start request; nothing on the internet has this name
    if (url.hostname === "link.home-lab.invalid") return Response.json(await link.start());
    url.hostname = url.hostname.endsWith(".localhost")
      ? `${url.hostname.slice(0, -".localhost".length)}.${domain}`
      : domain;
    url.protocol = "https:";
    url.port = "";
    // only the boundary may stamp a caller
    const headers = new Headers(
      [...request.headers].filter(([name]) => !name.startsWith("x-itx-")),
    );
    return env.MIND.fetch(new Request(url, new Request(request, { headers })));
  },
} satisfies ExportedHandler<LinkEnv>;

/** Every call goes to the session's door, but a `fetch` that names no secret leaves from here:
 *  through the link a large download is several times slower. */
export class Door extends WorkerEntrypoint<LinkEnv> {
  override async fetch(request: Request): Promise<Response> {
    // The Link's `fetch`, not a stub's: workerd carries a WebSocket answer on the fetch channel only.
    if (secretPathsReferenced(request).length > 0)
      return this.env.LINK.getByName(this.env.DOMAIN).fetch(request);
    // a host of the mind's own domain is the stack's boundary: any other is outside it
    const { hostname } = new URL(request.url);
    const own = hostname === this.env.DOMAIN || hostname.endsWith(`.${this.env.DOMAIN}`);
    const answer = await fetch(own ? request : leavingTheStack(request));
    if (answer.webSocket) return answer;
    const headers = new Headers(answer.headers);
    // only the vault writes a secret's facts: an upstream's would be forged
    headers.delete(FACTS_HEADER);
    return new Response(answer.body, {
      status: answer.status,
      statusText: answer.statusText,
      headers,
    });
  }

  static {
    forwardEveryMethod(Door, (entrypoint, method, args) => {
      const link = entrypoint.env.LINK.getByName(entrypoint.env.DOMAIN);
      const door = link.door() as unknown as Record<string, (...args: unknown[]) => unknown>;
      return door[method]!(...args);
    });
  }
}

/** `TELEMETRY_METRICS` at home. Like the binding, a write is never awaited and never throws. */
export class HomeMetrics extends WorkerEntrypoint<LinkEnv> {
  writeDataPoint(point: Parameters<AnalyticsEngineDataset["writeDataPoint"]>[0]) {
    const door = this.env.LINK.getByName(this.env.DOMAIN).door() as unknown as Pick<
      BoundaryDoor,
      "writeMetrics"
    >;
    this.ctx.waitUntil(
      // the kernel writes strings alone; a byte blob has no JSON form
      Promise.resolve(
        door.writeMetrics([
          {
            indexes: point?.indexes?.map((index) => (typeof index === "string" ? index : "")),
            blobs: point?.blobs?.map((blob) => (typeof blob === "string" ? blob : "")),
            doubles: point?.doubles,
          },
        ]),
      ).catch((error: unknown) =>
        console.warn({ event: "home-lab.metrics-dropped", error: String(error) }),
      ),
    );
  }
}

export class StandIn extends WorkerEntrypoint<LinkEnv, { binding: string; why: string }> {
  static {
    forwardEveryMethod(StandIn, (standIn) => {
      const { binding, why } = standIn.ctx.props;
      throw new Error(`${binding} is not available to a mind at home: ${why}`);
    });
  }
}

type LiveSession = {
  door: RpcStub<BoundaryDoor>;
  /** True once the boundary answers, in any way. */
  probe(): Promise<boolean>;
  end(): void;
};

export class Link extends DurableObject<LinkEnv> {
  #session: LiveSession | null = null;
  #misses = 0;
  #dialing: Promise<void> | null = null;
  #failures = 0;
  #lastError: string | null = null;

  async start() {
    await this.#dialOnce();
    await this.#scheduleAlarm();
    return { connected: Boolean(this.#session), error: this.#lastError };
  }

  override async fetch(request: Request): Promise<Response> {
    using door = await this.door();
    return await door.fetch(request);
  }

  /** A dup: workerd disposes a capnweb stub when its receiver lets go of it. */
  async door() {
    if (!this.#session) await this.#dialOnce();
    if (!this.#session)
      throw codedError(
        "UNAVAILABLE",
        `This home lab is not connected to its stack right now: ${this.#lastError}`,
        { kind: "disconnected", retryAfterMs: 10_000 },
      );
    return this.#session.door.dup();
  }

  async alarm() {
    const live = this.#session;
    if (live) {
      this.#misses = (await live.probe()) ? 0 : this.#misses + 1;
      if (this.#misses >= 2) this.#end(live, "the boundary left two liveness questions unanswered");
    }
    await this.#dialOnce();
    await this.#scheduleAlarm();
  }

  #end(live: LiveSession, why: string) {
    if (this.#session !== live) return false;
    this.#session = null;
    this.#misses = 0;
    this.#lastError = why;
    live.end();
    console.info({ event: "home-lab.link-ended", domain: this.env.DOMAIN, why });
    return true;
  }

  async #scheduleAlarm() {
    const backoff = Math.min(60_000, 1000 * 2 ** Math.min(this.#failures, 6));
    const delay = this.#session ? 30_000 : backoff / 2 + Math.random() * (backoff / 2);
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  #dialOnce() {
    if (this.#session) return Promise.resolve();
    this.#dialing ??= this.#dial().finally(() => (this.#dialing = null));
    return this.#dialing;
  }

  async #dial() {
    const domain = this.env.DOMAIN;
    // the boundary lets go of a session only when its socket closes
    let opened: WebSocket | null = null;
    try {
      const token = await (await this.env.TOKEN.fetch("http://launcher/token")).text();
      // workerd names a network failure only "internal error"
      const response = await fetch(mindProvideUrlOf(domain), {
        headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
      }).catch((error: unknown) => {
        throw new Error(`${mindProvideUrlOf(domain)} could not be reached (${String(error)})`);
      });
      const socket = response.webSocket;
      if (!socket)
        throw new Error(
          `${mindProvideUrlOf(domain)} answered ${String(response.status)}, not a WebSocket`,
        );
      socket.accept();
      opened = socket;
      const session = newWebSocketRpcSession<ProvideSession>(socket);
      const mind = relayTo(() => this.env.MIND) as unknown as MindTarget;
      const handle = await session.provide(mind);
      const door = (await session.door) as unknown as RpcStub<BoundaryDoor>;
      const broken = new Promise<string>((ended) =>
        session.onRpcBroken((error) => ended(`the session broke: ${String(error)}`)),
      );
      const live = {
        door,
        // a member the session lacks: a live boundary answers at once, with an error
        probe: () => {
          const asked = (session as unknown as { itxLivenessProbe(): Promise<unknown> })
            .itxLivenessProbe()
            .then(
              () => true,
              () => true,
            );
          const silent = new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000));
          return Promise.race([asked, silent]);
        },
        end: () => {
          door[Symbol.dispose]();
          session[Symbol.dispose]();
        },
      };
      this.#session = live;
      this.#failures = 0;
      this.#lastError = null;
      console.info({ event: "home-lab.link-connected", domain });
      // the lend can end while the socket lives
      void Promise.race([broken, handle.lendEnded().then((why) => `the lend ended: ${why}`)]).then(
        async (why) => {
          if (this.#end(live, why)) await this.#scheduleAlarm();
        },
      );
    } catch (error) {
      opened?.close(1011, "the dial failed");
      this.#failures += 1;
      this.#lastError = error instanceof Error ? error.message : String(error);
      console.info({ event: "home-lab.link-dial-failed", domain, error: this.#lastError });
    }
  }
}
