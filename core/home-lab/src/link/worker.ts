import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { codedError, leavingTheStack } from "iterate/lib";
import { MIND_PROVIDE_EXTERNAL_MIND_HEADER, mindApiUrlOf } from "iterate/mind-api";
import { mindConfigOf, zoneOf } from "iterate/mind-config";
import { reservedPathOf } from "iterate/mind-identity-log";
import { withFacts } from "iterate/facts";
import { secretPathsReferenced } from "iterate/secret-placeholder";
import type { ControlPlaneApi } from "iterate/api";
import {
  type ControlPlaneSession,
  type Door as BoundaryDoor,
  MIND_TAKEN_OVER_CLOSE_CODE,
  type MindTarget,
} from "iterate/workers";
import { isOwnHost } from "./own-host.ts";
import { forwardEveryMethod, relayTo } from "./relay.ts";

export { HomeArtifacts } from "../repos/artifacts.ts";

type LinkEnv = {
  /** The config that every Worker of the mind gets, as JSON (iterate/mind-config). */
  ITERATE: string;
  /** The launcher's git store on this machine (../repos/server.ts), `http://127.0.0.1:<port>`. */
  REPOS_ORIGIN: string;
  /** The way out to public addresses alone (the launcher's network rule). */
  INTERNET: Fetcher;
  MIND: MindTarget;
  LINK: DurableObjectNamespace<Link>;
  /** The launcher: `GET` answers a live token for the right to hand in the mind (iterate/mind-api
   *  `mindProvideConnectResourceOf`). */
  TOKEN: Fetcher;
};

// A Worker's `env` is one object for the life of its isolate, so it keys the memo: the config is
// parsed once, and a malformed one throws at the first use, naming its field.
const parsed = new WeakMap<object, ReturnType<typeof mindConfigOf<{}>>>();
function configOf(env: LinkEnv) {
  const config = parsed.get(env) || mindConfigOf(env, {});
  parsed.set(env, config);
  return config;
}
/** The one `Link` of this launcher, named by the mind. */
const linkOf = (env: LinkEnv) => env.LINK.getByName(configOf(env).controlPlaneHostname);

export default {
  async fetch(request, env) {
    const [zone] = configOf(env).zones;
    const url = new URL(request.url);
    // the launcher's start request; nothing on the internet has this name
    if (url.hostname === "link.home-lab.invalid") return Response.json(await linkOf(env).start());
    // THE PORT ANSWERS ITS OWN NAMES ALONE. A web page that points a name of its own at this
    // machine (DNS rebinding) sends that name as the Host, and gets no page of the mind.
    if (!isOwnHost(url.hostname))
      return new Response("This port answers localhost and <label>.localhost alone.\n", {
        status: 421,
      });
    // `localhost` stands for the mind's first zone, and a label under it for that hostname of the zone
    url.hostname = url.hostname.endsWith(".localhost")
      ? `${url.hostname.slice(0, -".localhost".length)}.${zone}`
      : zone!;
    url.protocol = "https:";
    url.port = "";
    // THE MIND'S CODE NEVER ANSWERS THE TWO RESERVED PATHS (iterate/mind-identity-log
    // `reservedPathOf`), at this entrance as at the boundary's: here nothing else answers them.
    if (reservedPathOf(url.pathname)) return new Response("Not found\n", { status: 404 });
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
    if (secretPathsReferenced(request).length > 0) return linkOf(this.env).fetch(request);
    // a hostname of one of the mind's zones is the stack's boundary: any other is outside it
    const url = new URL(request.url);
    const own = zoneOf(configOf(this.env), url.hostname);
    // The boundary refuses a hostname that ends with a dot (421): the mind's own request goes in
    // as the same DNS name without it.
    url.hostname = url.hostname.replace(/\.$/, "");
    // THE MIND'S CODE REACHES PUBLIC ADDRESSES ALONE, as on Cloudflare. On a home network this
    // machine's other ports and the machines beside it (a router, a NAS) are private addresses:
    // `INTERNET` connects to none, and workerd checks the address it connects to, so a name that
    // resolves to one is refused too. The one address of this machine that the mind needs is its
    // own git store.
    const answer =
      url.origin === this.env.REPOS_ORIGIN
        ? await fetch(request)
        : await this.env.INTERNET.fetch(own ? new Request(url, request) : leavingTheStack(request));
    // only the vault writes a secret's facts: an upstream's would be forged, a WebSocket's too
    return withFacts(answer, []);
  }

  static {
    forwardEveryMethod(Door, (entrypoint, method, args) => {
      const door = linkOf(entrypoint.env).door() as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return door[method]!(...args);
    });
  }
}

/** THE MIND WORKER'S OWN FETCHES, the ones that do not go through `Door` above: its repos' git
 *  transport and its module loader. They leave as loaded code's do, to public addresses alone,
 *  and to this machine's own git store. workerd's default for a Worker reaches private addresses
 *  too, and on a home network those are the router and the machines beside this one. */
export class Outbound extends WorkerEntrypoint<LinkEnv> {
  override fetch(request: Request): Promise<Response> {
    return new URL(request.url).origin === this.env.REPOS_ORIGIN
      ? fetch(request)
      : this.env.INTERNET.fetch(request);
  }
}

/** `TELEMETRY_METRICS` at home. Like the binding, a write is never awaited and never throws. */
export class HomeMetrics extends WorkerEntrypoint<LinkEnv> {
  writeDataPoint(point: Parameters<AnalyticsEngineDataset["writeDataPoint"]>[0]) {
    // The cast: a Durable Object stub's type loses the capnweb stub that `door()` answers, and
    // of the boundary's Door this writes metrics alone.
    const door = linkOf(this.env).door() as unknown as Pick<BoundaryDoor, "writeMetrics">;
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
  /** ANOTHER MACHINE HANDED IN THIS MIND, and the boundary closed this link for it
   *  (iterate/workers `MIND_TAKEN_OVER_CLOSE_CODE`). This one stops dialling until the process
   *  starts again: two that both dialled would end each other's link about once a second, and
   *  every visitor's socket with it. */
  #takenOver = false;

  /** The launcher's start: the one place that dials after a take-over. */
  async start() {
    this.#takenOver = false;
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
    if (this.#takenOver) return;
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
    console.info({
      event: "home-lab.link-ended",
      mind: configOf(this.env).controlPlaneHostname,
      why,
    });
    return true;
  }

  async #scheduleAlarm() {
    const backoff = Math.min(60_000, 1000 * 2 ** Math.min(this.#failures, 6));
    const delay = this.#session ? 30_000 : backoff / 2 + Math.random() * (backoff / 2);
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  #dialOnce() {
    if (this.#session || this.#takenOver) return Promise.resolve();
    this.#dialing ??= this.#dial().finally(() => (this.#dialing = null));
    return this.#dialing;
  }

  /** THE DIAL: a WebSocket to the mind's API, `https://<control-plane hostname>/api`. On the root
   *  of that session this authenticates as every client does, with the token of the right to
   *  hand in the mind, and on the session that it gets (iterate/workers `ControlPlaneSession`)
   *  calls `provideExternalMind` with a function that takes the boundary's door and answers the
   *  mind. The boundary then sends the mind everything, until the socket ends. It ends when the
   *  token does and when the boundary is deployed (Cloudflare restarts the object that holds the
   *  link): the alarm then dials again. It also ends when another process hands in the same
   *  mind, and then nothing dials again (`#takenOver`).
   *
   *  The dial says that it hands in a mind (iterate/mind-api
   *  `MIND_PROVIDE_EXTERNAL_MIND_HEADER`), which is where its session ends: in the boundary's
   *  object that holds the link. What the session may do is the token's to say, not the dial's. */
  async #dial() {
    const mind = configOf(this.env).controlPlaneHostname;
    const apiUrl = mindApiUrlOf(mind);
    // the boundary lets go of a session only when its socket closes
    let opened: WebSocket | null = null;
    try {
      const token = await (await this.env.TOKEN.fetch("http://launcher/token")).text();
      // workerd names a network failure only "internal error"
      const response = await fetch(apiUrl, {
        headers: { upgrade: "websocket", [MIND_PROVIDE_EXTERNAL_MIND_HEADER]: "1" },
      }).catch((error: unknown) => {
        throw new Error(`${apiUrl} could not be reached (${String(error)})`);
      });
      const socket = response.webSocket;
      if (!socket)
        throw new Error(`${apiUrl} answered ${String(response.status)}, not a WebSocket`);
      // This listener is before capnweb's own: a close is read here first, with its code, and
      // only then as a broken session.
      const closed = new Promise<{ why: string; takenOver: boolean }>((resolve) =>
        socket.addEventListener("close", ({ code, reason }) =>
          resolve({
            why: `the boundary closed the socket (${String(code)}): ${reason}`,
            takenOver: code === MIND_TAKEN_OVER_CLOSE_CODE,
          }),
        ),
      );
      socket.accept();
      opened = socket;
      const api = newWebSocketRpcSession<ControlPlaneApi>(socket);
      const handed: { door?: RpcStub<BoundaryDoor> } = {};
      // The cast: a client's type of the session names `mind` alone (iterate/api), and this
      // token's session is the stack's whole one. Not awaited: the hand-in goes with it.
      using session = api.authenticate(token) as unknown as RpcStub<ControlPlaneSession>;
      await session.provideExternalMind((door) => {
        // The door is this function's for its call alone, and `dup()` keeps it. The casts: on the
        // wire the door is a capnweb stub, and the relay answers every method of the mind by name.
        handed.door = (door as unknown as RpcStub<BoundaryDoor>).dup();
        return relayTo(() => this.env.MIND) as unknown as MindTarget;
      });
      const { door } = handed;
      if (!door) throw new Error(`${apiUrl} took the mind and never called its connect function`);
      const broken = new Promise<{ why: string; takenOver: boolean }>((resolve) =>
        api.onRpcBroken((error) =>
          resolve({ why: `the session broke: ${String(error)}`, takenOver: false }),
        ),
      );
      const live = {
        door,
        // a member the root lacks: a live boundary answers at once, with an error
        probe: () => {
          const asked = (api as unknown as { itxLivenessProbe(): Promise<unknown> })
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
          api[Symbol.dispose]();
        },
      };
      this.#session = live;
      this.#failures = 0;
      this.#lastError = null;
      console.info({ event: "home-lab.link-connected", mind });
      void Promise.race([closed, broken]).then(async ({ why, takenOver }) => {
        if (!this.#end(live, why)) return;
        if (!takenOver) return this.#scheduleAlarm();
        this.#takenOver = true;
        await this.ctx.storage.deleteAlarm();
        console.error(
          `Another machine handed in ${mind} and took it over: this home lab stops dialling. To take the mind back, stop the home lab on that machine and start this one again.`,
        );
      });
    } catch (error) {
      opened?.close(1011, "the dial failed");
      this.#failures += 1;
      this.#lastError = error instanceof Error ? error.message : String(error);
      console.info({ event: "home-lab.link-dial-failed", mind, error: this.#lastError });
    }
  }
}
