// app-session.ts — WHAT AN APP'S GATE KEEPS for one browser (app-server.ts): one object per browser
// and mind, `<app origin>:<cookie id>:<address>`, holding that mind's discovered issuer and the
// browser's tokens there, and one small record per browser, `<app origin>:<cookie id>`, of the
// minds it is connected to. Both are this one class, because each app's Worker binds one namespace
// (`BROWSER_SESSION`); an object only ever plays one of the two parts.
import { DurableObject } from "cloudflare:workers";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import {
  authorizationCodeRequest,
  authorizationServerOf,
  type DiscoveredMind,
} from "./client/oauth.ts";
import { isLocalOrigin } from "./lib.ts";
import { fetchResendingNotRoutedYet } from "./platform-retry.ts";

/** What a sign-in to one mind starts from: the app's origin and branding, and the mind as
 *  discovery found it. The scope is `iterate`, the one a mind's issuer grants for its API. */
export type MindSignIn = {
  origin: string;
  mind: DiscoveredMind;
  client?: { name: string; logoUri: string };
};
type Base = {
  origin: string;
  mind: DiscoveredMind;
  clientId: string;
  next: string;
  until: number;
};
type Pending = Base & { phase: "pending"; state: string; verifier: string };
type Active = Base & {
  phase: "active";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};
type StoredSession = Pending | Active;

/** A mind the browser is connected to, as `/.auth/minds.json` answers it. */
export type ConnectedMind = { address: string; lastUsedAt: number };
/** The record: the connected minds, and the sign-ins still waiting at an issuer, by `state`. */
type StoredRecord = {
  minds: ConnectedMind[];
  pending: { state: string; address: string; until: number }[];
  until: number;
};

const PENDING_MS = 10 * 60_000;
const SESSION_MS = 30 * 24 * 3600_000;

/** Each app binds this same class. Token exchange, refresh and revocation use the discovered
 *  issuer's public endpoints, so separately deployed apps need no platform bindings. One queue
 *  serializes sign-in, refresh, sign-out and expiry across tabs (`#serial`). */
export class BrowserSession extends DurableObject {
  /** The operation that runs last, settled either way: the next one starts after it. */
  #last: Promise<unknown> = Promise.resolve();

  // ── the record: which minds this browser is connected to ──

  /** The connected minds, the last used first. */
  async minds(): Promise<{ minds: ConnectedMind[]; lastUsed: string | null }> {
    const minds = [...(await this.#record()).minds].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return { minds, lastUsed: minds[0]?.address ?? null };
  }

  /** A sign-in to `address` left for its issuer with `state`: the callback finds it by that. */
  async expect(state: string, address: string) {
    const record = await this.#record();
    const now = Date.now();
    record.pending = [
      ...record.pending.filter((flow) => flow.until > now),
      { state, address, until: now + PENDING_MS },
    ];
    await this.#saveRecord(record);
  }

  /** The mind a pending sign-in is for, or null. */
  async addressOf(state: string): Promise<string | null> {
    const record = await this.#record();
    return (
      record.pending.find((flow) => flow.state === state && flow.until > Date.now())?.address ??
      null
    );
  }

  /** A sign-in to `address` completed: it is connected and the last used, and its pending flows
   *  are done. */
  async connected(address: string) {
    const record = await this.#record();
    record.pending = record.pending.filter((flow) => flow.address !== address);
    record.minds = [
      ...record.minds.filter((mind) => mind.address !== address),
      { address, lastUsedAt: Date.now() },
    ];
    await this.#saveRecord(record);
  }

  /** `address` was used just now. A write at most once a minute per mind, and none for a mind
   *  the browser is not connected to. */
  async touch(address: string) {
    const record = await this.#record();
    const mind = record.minds.find((item) => item.address === address);
    if (!mind || mind.lastUsedAt > Date.now() - 60_000) return;
    mind.lastUsedAt = Date.now();
    await this.#saveRecord(record);
  }

  /** The browser signed out of `address`: it is no longer connected. */
  async forget(address: string) {
    const record = await this.#record();
    record.minds = record.minds.filter((mind) => mind.address !== address);
    record.pending = record.pending.filter((flow) => flow.address !== address);
    await this.#saveRecord(record);
  }

  async #record(): Promise<StoredRecord> {
    return (
      (await this.ctx.storage.get<StoredRecord>("record")) || {
        minds: [],
        pending: [],
        until: 0,
      }
    );
  }

  /** The record lives as long as a session may: thirty days from its last change. */
  async #saveRecord(record: StoredRecord) {
    record.until = Date.now() + SESSION_MS;
    await this.ctx.storage.put("record", record);
    await this.ctx.storage.setAlarm(record.until);
  }

  // ── a session: one mind's sign-in ──

  /** Start the OAuth code flow with PKCE at the mind's issuer, for the mind's API as the
   *  resource (RFC 8707). Whatever this object held for the mind before is replaced. Answers the
   *  authorization URL and the flow's `state`. */
  begin(signIn: MindSignIn, next: string) {
    return this.#serial(async () => {
      const { origin, mind, client } = signIn;
      const local = isLocalOrigin(origin);
      if (new URL(origin).protocol !== "https:" && !local)
        throw new Error("Browser login requires HTTPS");
      let clientId = `${origin}/.auth/client.json`;
      // An issuer cannot fetch a local app's client metadata document: the local app registers
      // (RFC 7591) where the issuer allows it.
      if (local && mind.endpoints.registration) {
        const response = await fetch(mind.endpoints.registration, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: client?.name || new URL(origin).host,
            client_uri: origin,
            logo_uri: client?.logoUri,
            redirect_uris: [`${origin}/.auth/callback`],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Local client registration failed (${response.status})`);
        clientId = z
          .object({ client_id: z.string().min(1) })
          .parse(await response.json()).client_id;
      }
      const { url, state, verifier } = await authorizationCodeRequest({
        issuer: mind.issuer,
        authorizationEndpoint: mind.endpoints.authorization,
        clientId,
        redirectUri: `${origin}/.auth/callback`,
        resources: [mind.resource],
      });
      const data: Pending = {
        origin,
        mind,
        next,
        clientId,
        phase: "pending",
        state,
        verifier,
        until: Date.now() + PENDING_MS,
      };
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put("session", data);
      await this.ctx.storage.setAlarm(data.until);
      return { url: url.href, state };
    });
  }

  /** The issuer's redirect back to `/.auth/callback`, its query string. oauth4webapi validates it
   *  (the state matches this browser's pending flow, the `iss` matches the issuer, no `error`), then
   *  exchanges the code for tokens. */
  complete(callbackQuery: string) {
    return this.#serial(async (): Promise<{ next: string } | { error: string }> => {
      const data = await this.ctx.storage.get<StoredSession>("session");
      if (!data || data.phase !== "pending" || data.until <= Date.now())
        return {
          error: "This sign-in expired or does not match this browser. Connect the mind again.",
        };
      const as = authorizationServerOf(data.mind);
      const client: oauth.Client = { client_id: data.clientId };
      let callback: URLSearchParams;
      try {
        callback = oauth.validateAuthResponse(
          as,
          client,
          new URLSearchParams(callbackQuery),
          data.state,
        );
      } catch (error) {
        // A provider `error=` (the person declined) ends the flow; a state/iss mismatch leaves the
        // pending flow to be retried from a genuine browser.
        if (error instanceof oauth.AuthorizationResponseError) {
          await this.#clear();
          return { error: "Authorization was declined." };
        }
        return {
          error: "This sign-in expired or does not match this browser. Connect the mind again.",
        };
      }
      const started = Date.now();
      let tokens: oauth.TokenEndpointResponse;
      try {
        const response = await oauth.authorizationCodeGrantRequest(
          as,
          client,
          oauth.None(),
          callback,
          `${data.origin}/.auth/callback`,
          data.verifier,
          this.#tokenOptions(data),
        );
        tokens = await oauth.processAuthorizationCodeResponse(as, client, response);
      } catch (error) {
        await this.#endOnDeadGrant(error);
        return { error: "Sign-in could not complete. Connect the mind again." };
      }
      await this.#activate(data, tokens, started);
      return { next: data.next };
    });
  }

  /** A live access token for the mind's API, refreshed when it is about to expire; null when
   *  there is no live session. */
  bearer() {
    return this.#serial(() => this.#bearer());
  }

  /** A verified 401 means this local credential no longer grants access. */
  discard() {
    return this.#serial(() => this.#clear());
  }

  /** Sign out: revoke the refresh token at the issuer's revocation endpoint (RFC 7009) when it has
   *  one, then forget the session. A failure to reach the issuer keeps the session and throws, so
   *  the person can try again. */
  end() {
    return this.#serial(async () => {
      const data = await this.ctx.storage.get<StoredSession>("session");
      if (data?.phase === "active" && data.mind.endpoints.revocation) {
        const as = authorizationServerOf(data.mind);
        const client: oauth.Client = { client_id: data.clientId };
        const response = await oauth.revocationRequest(
          as,
          client,
          oauth.None(),
          data.refreshToken,
          {
            additionalParameters: { token_type_hint: "refresh_token" },
            signal: AbortSignal.timeout(10_000),
            [oauth.allowInsecureRequests]: isLocalOrigin(data.origin),
          },
        );
        await oauth.processRevocationResponse(response);
      }
      await this.#clear();
    });
  }

  async alarm() {
    // A record ends thirty days after its last change. A pending flow expires in ten minutes; an
    // active grant has an absolute thirty-day lifetime here, whatever the issuer allows. An expiry
    // that waited in the queue behind a sign-in or a refresh reads the bound that one set: a
    // session it renewed is kept, and the alarm moves to its new bound.
    await this.#serial(async () => {
      const held =
        (await this.ctx.storage.get<StoredSession>("session")) ||
        (await this.ctx.storage.get<StoredRecord>("record"));
      if (held && held.until > Date.now()) await this.ctx.storage.setAlarm(held.until);
      else await this.#clear();
    });
  }

  async #bearer() {
    const data = await this.ctx.storage.get<StoredSession>("session");
    if (!data || data.phase !== "active") return null;
    if (data.until <= Date.now()) {
      await this.#clear();
      return null;
    }
    if (data.expiresAt > Date.now() + 30_000) return data.accessToken;
    const as = authorizationServerOf(data.mind);
    const client: oauth.Client = { client_id: data.clientId };
    const started = Date.now();
    let tokens: oauth.TokenEndpointResponse;
    try {
      const response = await oauth.refreshTokenGrantRequest(
        as,
        client,
        oauth.None(),
        data.refreshToken,
        this.#tokenOptions(data),
      );
      tokens = await oauth.processRefreshTokenResponse(as, client, response);
    } catch (error) {
      await this.#endOnDeadGrant(error);
      return null;
    }
    return (await this.#activate(data, tokens, started)).accessToken;
  }

  /** The token request's shared options: the audience (RFC 8707 resource), a bounded timeout, a
   *  request Cloudflare answered itself sent again (an issuer's brand-new workers.dev hostname that
   *  the server reached does not route yet), and — only for a LOCAL APP (`begin` already admits
   *  http there) — oauth4webapi's opt-out of its HTTPS-only default. Keyed on the app's origin,
   *  never the issuer's: a mind a person typed can not talk a deployed app into sending its
   *  codes in the clear. */
  #tokenOptions(data: StoredSession): oauth.TokenEndpointRequestOptions {
    const options: oauth.TokenEndpointRequestOptions = {
      additionalParameters: { resource: data.mind.resource },
      signal: AbortSignal.timeout(10_000),
      [oauth.customFetch]: fetchResendingNotRoutedYet({
        area: "app-session",
        name: "token-request",
      }),
    };
    if (isLocalOrigin(data.origin)) options[oauth.allowInsecureRequests] = true;
    return options;
  }

  /** Write the active session from a token response. A refresh reuses the prior refresh token when
   *  the issuer does not rotate it. */
  async #activate(
    data: StoredSession,
    tokens: oauth.TokenEndpointResponse,
    started: number,
  ): Promise<Active> {
    const refreshToken =
      tokens.refresh_token || (data.phase === "active" ? data.refreshToken : undefined);
    if (!refreshToken) throw new Error("The sign-in provider returned no refresh token.");
    const { origin, mind, clientId, next } = data;
    const stored: Active = {
      origin,
      mind,
      clientId,
      next,
      phase: "active",
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt: started + (tokens.expires_in ?? 0) * 1000,
      until: data.phase === "pending" ? started + SESSION_MS : data.until,
    };
    await this.ctx.storage.put("session", stored);
    await this.ctx.storage.setAlarm(stored.until);
    return stored;
  }

  /** A dead code or refresh token (`invalid_grant`) ends the session; other failures are transient.
   *  A token endpoint that answered anything but its token — an OAuth error body, or a response
   *  oauth4webapi could not read as one (an uncaught 500) — throws one message naming its status,
   *  which reads the same on the far side of the Durable Object's RPC. */
  async #endOnDeadGrant(error: unknown): Promise<void> {
    if (error instanceof oauth.ResponseBodyError && error.error === "invalid_grant") {
      await this.#clear();
      return;
    }
    const status =
      error instanceof oauth.ResponseBodyError
        ? error.status
        : error instanceof oauth.OperationProcessingError && error.cause instanceof Response
          ? error.cause.status
          : null;
    throw status === null ? error : new Error(`Token exchange failed (${status}). Try again.`);
  }

  /** `work`, once every operation before it settled, so two tabs never spend one refresh token.
   *  Its failure is its caller's alone. A queue in memory, because the object is one instance and a
   *  reset ends the queue with it. Not `blockConcurrencyWhile`, so the object serves other requests
   *  while a refresh waits on the network. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#last.then(work);
    this.#last = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async #clear() {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
}
