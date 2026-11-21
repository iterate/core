// control-plane-api.ts — THE CONTROL PLANE'S API: `https://<controlPlaneHostname>/api`, a capnweb
// session over a WebSocket that the boundary ends (iterate/api `ControlPlaneApi`).
//
//   ControlPlaneRpcTarget           the root: what anyone may ask, and `authenticate`
//     about()                       the stack's public facts
//     authenticate(token?)       ─► ControlPlaneSessionRpcTarget
//   ControlPlaneSessionRpcTarget    what the credential is for, and nothing more
//     get mind                      the mind's own API, from `MindTransport.api(who)`
//     provideExternalMind(connect)  a mind that runs elsewhere hands itself in
//     provideEgressGateway(input?)  a computer provides the egress gateway its way out
//
// One function hosts a session from its socket to its end (`controlPlaneApiResponse`), in both
// places where a session ends: the boundary's own invocation, and the object that holds the link
// of a mind which runs elsewhere (./provided-mind.ts).
//
// The session is the right (https://blog.cloudflare.com/capnweb-javascript-rpc-library/: "you
// can't possibly forget to authenticate before calling a method requiring auth, because you
// wouldn't have an object on which to make the call"). A later step adds the auth and secrets
// Workers' own APIs as getters of the same kind as `mind`.
//
// The mind never gets the credential: it gets who the session is (iterate/workers `ApiCaller`).
import {
  newWebSocketRpcSession,
  type RpcStub,
  RpcTarget,
  upgradeWebSocketResponse,
  WebSocketPair,
} from "capnweb";
import { endWhenSilent } from "core-itx/end-when-silent";
import { codedError, withTimeout } from "iterate/lib";
import {
  EGRESS_GATEWAY_KEY_NAME,
  MIND_EGRESS_GATEWAY_PATH,
  mindApiUrlOf,
  mindProvideConnectResourceOf,
} from "iterate/mind-api";
import { controlPlaneOriginOf, type MindConfig } from "iterate/mind-config";
import { STACK_KEY_PATH } from "iterate/signed";
import {
  type ApiCaller,
  type AuthService,
  type ControlPlaneSession,
  type EgressGatewayProviders,
  MIND_TAKEN_OVER_CLOSE_CODE,
} from "iterate/workers";
import { z } from "zod";
import type { MindTransport } from "./http.ts";
import { type MindApiStub, SessionMind } from "./session-mind.ts";
import { bearerOf } from "./stamp.ts";

/** The function that a mind hands in, as it arrives: a capnweb stub of it. */
export type ConnectStub = RpcStub<Parameters<ControlPlaneSession["provideExternalMind"]>[0]>;

/** WHERE A SESSION OF THE API ENDS, and what that place can do for it. There are two, and each
 *  gives one of `mind` and `handIn`:
 *    - the boundary's own invocation (./http.ts), which reaches the mind: every session but a
 *      mind's own;
 *    - the object that holds a mind's link (./provided-mind.ts), which takes a mind that hands
 *      itself in. Its socket's request said so, and a credential that hands in no mind opens no
 *      session there. */
export type ControlPlaneApiHost = {
  auth: Pick<AuthService, "whoIs" | "browserSession" | "fetch">;
  config: Pick<MindConfig, "controlPlaneHostname" | "topology" | "mindId">;
  mind?: Pick<MindTransport, "api" | "fetch">;
  /** The egress gateway's entrypoint for its providers, when the stack's deploy names a gateway. */
  egressGatewayProviders?: Pick<EgressGatewayProviders, "lease">;
  /** This session's part of `provideExternalMind`, made once for the session. */
  handIn?: (session: ApiSession) => (connect: ConnectStub) => Promise<void>;
};

/** One session, as its host's own code sees it. */
export type ApiSession = {
  /** False from the moment the session ends, whatever ends it. */
  isOpen(): boolean;
  /** End the session now, from this side. */
  end(why: keyof typeof SESSION_ENDS, detail?: unknown): void;
  /** `ended` is called once, at the session's end and before anything of it is let go: with why
   *  this side ended it, or with nothing when the socket ended by itself. */
  onEnd(ended: (why?: keyof typeof SESSION_ENDS, detail?: unknown) => void): void;
};

/** A browser's session lasts longer than a token: a session of the API that came by a cookie ends
 *  after an hour at the latest, the life of a token. The page asks again, and the cookie is
 *  checked again. */
const COOKIE_SESSION_MS = 60 * 60 * 1000;

// The longest delay a timer takes (2^31 − 1 ms).
const MAX_TIMER_MS = 2 ** 31 - 1;

/** WHY THIS SIDE ENDS A SESSION, as the socket's close code and reason. Each reason is a fixed
 *  text: a close frame takes 123 bytes of reason at most (RFC 6455 section 5.5), and workerd
 *  throws on a longer one. What broke goes to the log.
 *    - `unauthenticated`, `credential`: 1008, policy violation (RFC 6455 section 7.4.1): the
 *      socket has no live credential.
 *    - `mind`: 1012, service restart (IANA's WebSocket close code registry): the mind that this
 *      session reached is gone, or is back. A new session reaches the mind as it is now.
 *    - `takenOver`: a code of its own, which tells a mind's process not to dial again.
 *    - `silent`: 4000, as core/itx `serveSession` ends the session of a peer that went silent:
 *      not 1008, which a page reads as the end of its sign-in. A page that is still there dials
 *      again.
 *    - `broken`: 1011, an unexpected condition. */
export const SESSION_ENDS = {
  unauthenticated: { code: 1008, reason: "no call of authenticate in ten seconds" },
  credential: { code: 1008, reason: "the sign-in for this session ended: authenticate again" },
  mind: { code: 1012, reason: "the mind behind this session restarted: connect again" },
  takenOver: { code: MIND_TAKEN_OVER_CLOSE_CODE, reason: "another session handed in this mind" },
  silent: { code: 4000, reason: "the peer went silent: dial again" },
  broken: { code: 1011, reason: "the session broke: connect again" },
} as const;

/** THE ANSWER TO A REQUEST AT `/api`: ONE SESSION, FROM ITS SOCKET TO ITS END, for both places
 *  where a session ends (`ControlPlaneApiHost`). A WebSocket alone: a request that is no upgrade
 *  is refused.
 *
 *  A SESSION'S END IS ONE MOMENT, whatever ends it: the credential's end, ten seconds with no
 *  call of `authenticate`, a mind that is gone, the host's own word, a closed socket. The session
 *  does not wait for its client: a client that never answers a close frame would keep this
 *  invocation, the mind's and what the session lent. The order is the point. The host's own
 *  state first, so that nothing below can leave a dead mind as the link. Then what the session
 *  holds of the mind: letting go of the mind's stub ends the mind's own invocation for this
 *  session, and with it what the session lent. Then the socket, with this side's code. And last
 *  capnweb's session, which stops reading: capnweb closes a socket that is still open with a code
 *  of its own. */
export function controlPlaneApiResponse(request: Request, host: ControlPlaneApiHost): Response {
  if (!isWebSocketUpgrade(request)) return webSocketOnly();
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  let over = false;
  let release: (() => void) | undefined;
  const listeners: Parameters<ApiSession["onEnd"]>[0][] = [];
  /** `why`: why this side ends the session. With none, the socket ended by itself. */
  const end = (why?: keyof typeof SESSION_ENDS, detail?: unknown) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    silence.stop();
    try {
      for (const ended of listeners) ended(why, detail);
      release?.();
      if (why) server.close(SESSION_ENDS[why].code, SESSION_ENDS[why].reason);
    } catch (error) {
      // the session is over all the same: a socket that refuses to close is no reason to keep it
      console.error({ event: "boundary.api-session-end-failed", error: String(error) });
    } finally {
      session[Symbol.dispose]();
    }
  };
  const ours: ApiSession = {
    isOpen: () => !over,
    end,
    onEnd: (ended) => void listeners.push(ended),
  };
  // a socket that never authenticates holds an invocation open for nothing
  const unauthenticated = () => setTimeout(() => end("unauthenticated"), 10_000);
  let timer = unauthenticated();
  // The cast: the socket is a half of capnweb's own pair, which is what its session takes (in
  // workerd the pair is the runtime's). Its type names the half apart from a `WebSocket`.
  // The session's own stub is kept: disposing of it is how the session is made to stop.
  const session = newWebSocketRpcSession(
    server as unknown as WebSocket,
    new ControlPlaneRpcTarget({
      headers: request.headers,
      auth: host.auth,
      config: host.config,
      mind: host.mind,
      egressGatewayProviders: host.egressGatewayProviders,
      handIn: host.handIn?.(ours),
      // The ten seconds are the client's to call in, not the auth Worker's and the mind's to
      // answer in: they stop while a call of `authenticate` runs, and start again when it is
      // refused.
      authenticating: () => clearTimeout(timer),
      refused: () => {
        if (!over) timer = unauthenticated();
      },
      authenticated: (authenticated) => {
        // the socket closed while the mind was asked: nothing is held past it
        if (over) return authenticated.release();
        release = authenticated.release;
        timer = setTimeout(
          () => end("credential"),
          Math.max(0, Math.min(authenticated.endsAt - Date.now(), MAX_TIMER_MS)),
        );
      },
      mindChanged: () => end("mind"),
      credentialEnded: () => end("credential"),
    }),
  );
  // A CLIENT THAT WENT WITH NO CLOSE (a laptop asleep, a dropped network) leaves a socket that
  // never closes until TCP gives up, and the mind's session behind it stays, with what the client
  // lent and the rows that say who has a context open: the mind's own watch (core/itx
  // `serveSession`) hears the boundary, which still answers. So the boundary watches its client
  // the same way. Any answer to the probe is a frame, an error too: the client has no main.
  const silence = endWhenSilent({
    probe: () =>
      void Promise.resolve()
        .then(() =>
          (session as unknown as RpcStub<{ itxLivenessProbe(): void }>).itxLivenessProbe(),
        )
        .catch(() => {}),
    end: (silentMs) => {
      console.info({ event: "boundary.api-session-silent", silentMs });
      end("silent");
    },
  });
  // capnweb has its own listener: this one only marks the time
  server.addEventListener("message", () => silence.heard());
  server.addEventListener("close", () => end(), { once: true });
  server.addEventListener("error", () => end(), { once: true });
  return upgradeWebSocketResponse(client);
}

export const isWebSocketUpgrade = (request: Request) =>
  request.headers.get("upgrade")?.toLowerCase() === "websocket";

/** 426, Upgrade Required (RFC 9110 section 15.5.22): the API has no other transport. */
const webSocketOnly = () =>
  new Response(
    "The control plane's API is a capnweb session over a WebSocket: open this address as one.\n",
    { status: 426, headers: { upgrade: "websocket" } },
  );

/** What a root is made with: its host's (`ControlPlaneApiHost`), the headers of the WebSocket's
 *  own request (`authenticate` with no token reads the credential that the request carried), and
 *  the session's own moments, which `controlPlaneApiResponse` acts on. */
type RootDeps = Pick<ControlPlaneApiHost, "auth" | "config" | "mind" | "egressGatewayProviders"> & {
  headers: Headers;
  handIn?: (connect: ConnectStub) => Promise<void>;
  authenticating(): void;
  refused(): void;
  /** Once, when the session is authenticated: when its credential ends, in epoch milliseconds,
   *  and how to let go of what the session holds of the mind. */
  authenticated(session: { endsAt: number; release(): void }): void;
  /** The mind that this session reached is gone, or the mind that it could not reach is back. */
  mindChanged(): void;
  /** The session's credential was refused before its own end: the session ends now. */
  credentialEnded(): void;
};

/** HOW LONG A PROVIDER HOLDS ITS LINK AFTER ONE CALL of `provideEgressGateway`. Its program calls
 *  again every ten seconds. So a key that a member removed carries no byte after this time, and
 *  after one call's wait when its program still calls. */
const EGRESS_LEASE_MS = 30_000;

/** A refusal this close to the token's end is taken as the token's end, not as a removed key:
 *  the auth Worker's clock and this one are two clocks. */
const TOKEN_END_MARGIN_MS = 5_000;

/** How often a session asks after its mind (`#watchedMind`): a session over a mind that is gone,
 *  or over a refusal of a mind that is back, ends within this time. */
const MIND_ASKED_EVERY_MS = 10_000;

/** THE ROOT OF EVERY SESSION, in the boundary's own invocation and in the object that holds a
 *  mind's link alike. */
class ControlPlaneRpcTarget extends RpcTarget {
  readonly #deps: RootDeps;
  /** One session for one socket: its end is the socket's. Set while `authenticate` runs, so that
   *  two calls sent together make one session. */
  #authenticating = false;

  constructor(deps: RootDeps) {
    super();
    this.#deps = deps;
  }

  async about() {
    const { auth, config } = this.#deps;
    const published = await auth.fetch(
      new Request(`${controlPlaneOriginOf(config)}${STACK_KEY_PATH}`),
    );
    return {
      controlPlaneHostname: config.controlPlaneHostname,
      topology: config.topology,
      // the auth Worker's own document, as it publishes it: this Worker holds no key
      stackKey: published.ok ? ((await published.json()) as unknown) : null,
    };
  }

  /** ONE WAY IN FOR EVERY KIND OF CLIENT (iterate/api `ControlPlaneApi.authenticate`). With no
   *  argument, the credential is what the socket's own request carried. Any other value is a
   *  token, and a token is a text that is not empty: a client that means to send one and sends
   *  nothing is told so, and is never taken for whoever the request's cookie names. */
  async authenticate(...given: [token?: unknown]) {
    const [token] = given;
    if (this.#authenticating)
      throw codedError(
        "INVALID_INPUT",
        "this socket has its session: open another socket for another credential",
      );
    if (token !== undefined && (typeof token !== "string" || !token))
      throw codedError(
        "INVALID_INPUT",
        "authenticate takes a token, a text that is not empty, or no argument at all",
      );
    this.#authenticating = true;
    this.#deps.authenticating();
    try {
      const credential = await credentialOf(this.#deps, token);
      if (!credential)
        throw codedError("UNAUTHENTICATED", "no live credential of this mind: sign in again");
      const { mind, handIn, authenticated } = this.#deps;
      if (!credential.who) {
        authenticated({ endsAt: credential.endsAt, release: () => {} });
        return new ControlPlaneSessionRpcTarget(handsInMind(), handIn || noHandInHere);
      }
      if (!mind)
        throw codedError(
          "FORBIDDEN",
          "this socket's request says that it hands in a mind (the header x-iterate-provide-external-mind): only the token of a mind that runs elsewhere opens a session on it",
        );
      // A PROVIDER'S KEY reaches nothing of the mind, and the mind is never asked.
      if ("providerKey" in credential.who) {
        authenticated({ endsAt: credential.endsAt, release: () => {} });
        return new ControlPlaneSessionRpcTarget(
          providesEgressGateway(),
          providerHandsInNoMind,
          this.#egressLeaseOf(credential.who.providerKey, credential.endsAt),
        );
      }
      const watched = await this.#watchedMind(mind, credential.who);
      authenticated({ endsAt: credential.endsAt, release: watched.release });
      return new ControlPlaneSessionRpcTarget(watched.mind, mindsOwnCredential);
    } catch (error) {
      // a credential that was refused may be followed by one that is not
      this.#authenticating = false;
      this.#deps.refused();
      throw error;
    }
  }

  /** ONE PROVIDER KEY'S `provideEgressGateway` (iterate/workers `ControlPlaneSession`), for its
   *  session. A refusal of the key while this session's own clock holds its token live, by a
   *  margin, means that a member removed the key: the gateway is told to end the key's links now
   *  (`until: 0`), and the session ends. At the token's own end nothing is ended here: the
   *  computer renews from a new session, and its link stays. The gateway never gets the token. */
  #egressLeaseOf(key: { id: string; token: string }, endsAt: number) {
    const { auth, config, egressGatewayProviders, credentialEnded } = this.#deps;
    return async (input: unknown) => {
      if (!egressGatewayProviders)
        throw codedError(
          "NO_SERVICE",
          "this stack has no egress gateway: its deploy names none (iterate deploy --egress-gateway <Worker name>)",
        );
      const given = EgressLeaseInput.safeParse(input);
      if (!given.success)
        throw codedError(
          "INVALID_INPUT",
          "provideEgressGateway takes nothing, or { link } with the link's id that an earlier call answered",
        );
      const link = given.data?.link;
      // ten seconds for the gateway to answer: a call of the session does not wait on it for longer
      const lease = (provider: Parameters<EgressGatewayProviders["lease"]>[0]) =>
        withTimeout(egressGatewayProviders.lease(provider), 10_000, "the egress gateway");
      const identity = await auth.whoIs(key.token, mindApiUrlOf(config.controlPlaneHostname));
      if (identity?.provide !== EGRESS_GATEWAY_KEY_NAME) {
        if (Date.now() < endsAt - TOKEN_END_MARGIN_MS)
          await lease({ mind: config.mindId, key: key.id, until: 0 }).catch((error) =>
            console.error({ event: "boundary.egress-links-not-ended", error: String(error) }),
          );
        credentialEnded();
        throw codedError("UNAUTHENTICATED", "this key no longer provides the egress gateway");
      }
      const until = Math.min(Date.now() + EGRESS_LEASE_MS, identity.expiresAt * 1000);
      const leased = await lease({ mind: config.mindId, key: key.id, link, until });
      return {
        url: `wss://${config.controlPlaneHostname}${MIND_EGRESS_GATEWAY_PATH}`,
        link: leased.link,
        ticket: leased.ticket,
        until,
      };
    };
  }

  /** THE MIND IS ASKED ONCE, AND ITS ANSWER IS KEPT: a getter that asked at each read would start
   *  a new invocation of the mind for each path that a client pipelines, and a stub that is not
   *  resolved cannot be read twice. A mind that cannot be asked now (one that runs elsewhere and
   *  is not connected) fails the read of `mind`, and not the session: its other getters do not
   *  pass the mind.
   *
   *  WHAT IS KEPT IS WATCHED, because a client keeps what it read of `mind` too: a session over a
   *  stub that broke, or over a refusal of a mind that is back, would answer every call with the
   *  same error until its credential ends. So the session ends when the mind that it reached is
   *  gone, and when the mind that it could not reach is back (`mindChanged`), and the client's
   *  next session reaches the mind as it is.
   *    - A stub: it is asked every few seconds whether its part of the session lives (core-itx
   *      `sessionLives`). A Workers RPC stub has no `onRpcBroken`; a call on a broken stub fails:
   *      the link of a mind that runs elsewhere dropped, or the mind Worker's invocation is gone.
   *      A question each time, and never one call that stays open: a call in flight keeps the
   *      mind's invocation, and what the session lent, after this side let go of the stub.
   *    - A refusal: the mind is asked again for its part of the session, as often. */
  async #watchedMind(mind: NonNullable<RootDeps["mind"]>, who: ApiCaller) {
    const { mindChanged } = this.#deps;
    try {
      // The cast: the binding's method answers `unknown`, and over Workers RPC what it answers
      // is a stub of the mind's own target, which answers every name.
      const stub = (await mind.api(who)) as MindApiStub;
      const asked = setInterval(() => {
        Promise.resolve()
          .then(() => stub.sessionLives())
          .catch(mindChanged);
      }, MIND_ASKED_EVERY_MS);
      return {
        // a key's session reaches its one lend, and nothing else that the mind's stub answers
        mind: new SessionMind(stub, (request) => mind.fetch(request), "lender" in who),
        release: () => {
          clearInterval(asked);
          stub[Symbol.dispose]?.();
        },
      };
    } catch (refusal) {
      const askedAgain = setInterval(() => {
        Promise.resolve(mind.api(who)).then(
          (stub) => {
            // the cast: as above. This stub is no session's: the next session asks for its own.
            (stub as MindApiStub)[Symbol.dispose]?.();
            mindChanged();
          },
          () => {},
        );
      }, MIND_ASKED_EVERY_MS);
      return { mind: { refusal }, release: () => clearInterval(askedAgain) };
    }
  }
}

/** WHAT ONE CREDENTIAL'S SESSION OFFERS (iterate/workers `ControlPlaneSession`). Not `implements`:
 *  on the wire the mind is a stub of the mind's own target, and the connect function a stub. */
class ControlPlaneSessionRpcTarget extends RpcTarget {
  readonly #mind: SessionMind | { refusal: unknown };
  readonly #handIn: (connect: ConnectStub) => Promise<void>;
  readonly #egressLease: (input: unknown) => Promise<unknown>;

  constructor(
    mind: SessionMind | { refusal: unknown },
    handIn: (connect: ConnectStub) => Promise<void>,
    egressLease: (input: unknown) => Promise<unknown> = noProviderKey,
  ) {
    super();
    this.#mind = mind;
    this.#handIn = handIn;
    this.#egressLease = egressLease;
  }

  /** The same target at every read. It has no disposer of its own, so a stub of it that a client
   *  lets go of ends nothing that another stub still uses: the socket's end lets go of the mind. */
  get mind() {
    if (this.#mind instanceof SessionMind) return this.#mind;
    throw this.#mind.refusal;
  }

  async provideExternalMind(connect: ConnectStub) {
    await this.#handIn(connect);
  }

  async provideEgressGateway(input?: unknown) {
    return this.#egressLease(input);
  }
}

/** What a call of `provideEgressGateway` takes: nothing, or the id of the link to keep. */
const EgressLeaseInput = z.strictObject({ link: z.string().min(1).max(128).optional() }).optional();

/** WHO A CREDENTIAL IS, AND WHEN IT ENDS, or null when it is not live. `who` is absent for the
 *  token of the right to hand in a mind, which is nobody of the mind's. A key for the egress
 *  gateway is no caller of the mind's either: it is a provider's key, with its id and its token.
 *  With `token`, that token alone is asked about. With none, the request's own credential is: its `Authorization` header,
 *  and with no such header its cookie. A request that carries an `Authorization` header of any
 *  kind never falls back to the cookie: the header and the cookie may name two people.
 *
 *  THE COOKIE COUNTS FROM THE CONTROL PLANE'S OWN ORIGIN ALONE. A hostname of the mind's zones is
 *  same-site with the control plane, so the browser sends the control plane's session cookie on a
 *  WebSocket handshake that a page of the mind's own code opens, and that code may be hostile. A
 *  browser sets `Origin` on every such handshake, and a page cannot change it (./stamp.ts holds a
 *  write of the secrets pages to the same rule). */
async function credentialOf(
  { headers, auth, config }: Pick<RootDeps, "headers" | "auth" | "config">,
  token: string | undefined,
): Promise<{
  who?: ApiCaller | { providerKey: { id: string; token: string } };
  endsAt: number;
} | null> {
  const bearer = token || bearerOf(headers);
  if (bearer) {
    const identity = await auth.whoIs(bearer, mindApiUrlOf(config.controlPlaneHostname));
    // a key for the egress gateway lends the mind nothing
    if (identity?.provide === EGRESS_GATEWAY_KEY_NAME)
      return {
        who: { providerKey: { id: identity.grant, token: bearer } },
        endsAt: identity.expiresAt * 1000,
      };
    if (identity?.provide)
      return {
        who: {
          lender: {
            actor: identity.principal.actor,
            key: identity.grant,
            provide: identity.provide,
          },
        },
        endsAt: identity.expiresAt * 1000,
      };
    if (identity)
      return {
        who: { principal: identity.principal, grant: identity.grant },
        endsAt: identity.expiresAt * 1000,
      };
    const provider = await auth.whoIs(
      bearer,
      mindProvideConnectResourceOf(config.controlPlaneHostname),
    );
    return provider && { endsAt: provider.expiresAt * 1000 };
  }
  if (headers.has("authorization")) return null;
  if (headers.get("origin") !== controlPlaneOriginOf(config)) return null;
  const session = await auth.browserSession(headers.get("cookie"));
  if (!session?.member) return null;
  return {
    who: { principal: { actor: session.userId, email: session.email } },
    endsAt: Math.min(session.expiresAt * 1000, Date.now() + COOKIE_SESSION_MS),
  };
}

const handsInMind = () => ({
  refusal: codedError(
    "FORBIDDEN",
    "this token hands in a mind that runs elsewhere, and reaches nothing of the mind: call provideExternalMind",
  ),
});

const providesEgressGateway = () => ({
  refusal: codedError(
    "FORBIDDEN",
    "this key provides the egress gateway its way out, and reaches nothing of the mind: call provideEgressGateway",
  ),
});

const providerHandsInNoMind = (): Promise<never> =>
  Promise.reject(
    codedError("FORBIDDEN", "this key provides the egress gateway, and hands in no mind"),
  );

const noProviderKey = (): Promise<never> =>
  Promise.reject(
    codedError(
      "FORBIDDEN",
      "provideEgressGateway takes the token of a key that a member allowed for the name egressGateway",
    ),
  );

const mindsOwnCredential = (): Promise<never> =>
  Promise.reject(
    codedError(
      "FORBIDDEN",
      "this credential reaches the mind and hands in none: provideExternalMind takes the token of a mind that runs elsewhere",
    ),
  );

const noHandInHere = (): Promise<never> =>
  Promise.reject(
    codedError(
      "INVALID_INPUT",
      "a mind hands itself in on a socket whose request says so, with the header x-iterate-provide-external-mind, and to a stack whose mind runs elsewhere",
    ),
  );
