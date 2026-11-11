import { WorkerEntrypoint } from "cloudflare:workers";
import { codedError } from "iterate/lib";
import { mindMcpUrlOf } from "iterate/mind-api";
import type { AuthService, TokenIdentity } from "iterate/workers";
import {
  AUTHORIZE_ENDPOINT,
  authorizationServer,
  CLIENT_REGISTRATION_ENDPOINT,
  hostCallbackOf,
  oauthHelpers,
  mindHostResourceOf,
  tokenEndpointResponse,
  tokenIdentity,
  TOKEN_ENDPOINT,
} from "./oauth.ts";
import { authorizeResponse } from "./authorize.ts";
import { deviceCallbackResponse } from "./device/callback.ts";
import { devicePageResponse } from "./device/page.ts";
import { devicePollResponse } from "./device/poll.ts";
import {
  CALLBACK_PATH as DEVICE_CALLBACK_PATH,
  DEVICE_AUTHORIZATION_PATH,
  VERIFICATION_PATH,
} from "./device/protocol.ts";
import {
  deviceAuthorizationResponse,
  deviceRegistrationResponse,
  metadataResponse,
} from "./device/start.ts";
import { sessionOf } from "./cookies.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { DASH_PATH, dashOriginOf, dashResponse } from "./dash.ts";
import { homePage, signInPage } from "./pages.ts";
import { selfTestResponse } from "./self-test.ts";
import {
  clientMetadata,
  ITERATE_SIGN_IN_CALLBACK_PATH,
  ITERATE_SIGN_IN_CLIENT_PATH,
  ITERATE_SIGN_IN_PATH,
  iterateSignInCallbackResponse,
  iterateSignInResponse,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
  signInHref,
  signOutResponse,
} from "./sign-in.ts";
import { emailSignInResponse } from "./email-sign-in.ts";
import { FIRST_OWNER_PATH, firstOwnerResponse } from "./first-owner.ts";
import { passkeySignInResponse } from "./passkey-sign-in.ts";
import { isMember, membersResponse, standingOf } from "./members.ts";
import { verifiedStatement } from "./keys.ts";
import { keysPagesResponse } from "./keys-pages.ts";
import { signedByStack } from "./stack-key.ts";
import { STATEMENTS_PATH, statementsResponse } from "./statements.ts";

export class Auth extends WorkerEntrypoint<Env> implements AuthService {
  async fetch(request: Parameters<AuthService["fetch"]>[0]) {
    const url = new URL(request.url);
    // the cookies and the metadata name the issuer's origin alone
    if (url.origin !== issuerOf(this.env)) return new Response("Not found", { status: 404 });
    const { pathname } = url;
    const get = request.method === "GET" || request.method === "HEAD";
    if (pathname === AUTHORIZE_ENDPOINT) return authorizeResponse(this.env, request);
    if (pathname === TOKEN_ENDPOINT && request.method === "POST")
      return (
        (await devicePollResponse(this.env, request, this.ctx)) ||
        tokenEndpointResponse(this.env, request, this.ctx)
      );
    if (pathname === "/.well-known/oauth-authorization-server" && request.method === "GET")
      return metadataResponse(this.env, request, this.ctx);
    if (pathname === CLIENT_REGISTRATION_ENDPOINT && request.method === "POST") {
      const registered = await deviceRegistrationResponse(this.env, request, this.ctx);
      if (registered) return registered;
    }
    if (pathname === DEVICE_AUTHORIZATION_PATH && request.method === "POST")
      return deviceAuthorizationResponse(this.env, request);
    if (pathname === VERIFICATION_PATH && (get || request.method === "POST"))
      return devicePageResponse(this.env, request);
    if (pathname === DEVICE_CALLBACK_PATH && get) return deviceCallbackResponse(this.env, request);
    if (pathname === "/" && get) {
      const session = await sessionOf(this.env, request);
      const { domain } = iterateConfigOf(this.env);
      return homePage({
        domain,
        email: session?.email || null,
        standing: session ? await standingOf(this.env, session) : null,
        mcp: mindMcpUrlOf(domain),
        dash: Boolean(dashOriginOf(this.env)),
      });
    }
    if (pathname === DASH_PATH && get) return dashResponse(this.env);
    const selfTest = await selfTestResponse(this.env, request);
    if (selfTest) return selfTest;
    if (pathname === SIGN_IN_PATH && get) {
      const next = url.searchParams.get("next") || "/";
      const { domain, login } = iterateConfigOf(this.env);
      return login.methods.iterate
        ? signInPage(domain, next, Boolean(login.methods.email))
        : Response.redirect(`${issuerOf(this.env)}${signInHref(this.env, next)}`, 302);
    }
    const members = await membersResponse(this.env, request, (token, resource) =>
      this.whoIs(token, resource),
    );
    if (members) return members;
    const emailSignIn = await emailSignInResponse(this.env, request);
    if (emailSignIn) return emailSignIn;
    const passkeySignIn = await passkeySignInResponse(this.env, request);
    if (passkeySignIn) return passkeySignIn;
    if (pathname === ITERATE_SIGN_IN_PATH && get) return iterateSignInResponse(this.env, request);
    if (pathname === ITERATE_SIGN_IN_CALLBACK_PATH && get)
      return iterateSignInCallbackResponse(this.env, request);
    if (pathname === ITERATE_SIGN_IN_CLIENT_PATH && get) return clientMetadata(this.env);
    if (pathname === SIGN_OUT_PATH && request.method === "POST")
      return signOutResponse(this.env, request);
    if (pathname === FIRST_OWNER_PATH && (get || request.method === "POST"))
      return firstOwnerResponse(this.env, request);
    const keys = await keysPagesResponse(this.env, request);
    if (keys) return keys;
    if (pathname === STATEMENTS_PATH && request.method === "POST")
      return statementsResponse(this.env, request);
    return authorizationServer(this.env).fetch(request, this.env, this.ctx);
  }

  async whoIs(...[token, resource]: Parameters<AuthService["whoIs"]>) {
    if (!token || !resource) return null;
    return (
      (await tokenIdentity(this.env, token, resource)) ??
      (await prototypeIdentity(this.env, token, resource))
    );
  }

  // Two first sign-ins at once may each register a client; the last id kept is used from then on,
  // and the other still works for the sign-in that holds it. The library never expires these.
  async hostClient(host: Parameters<AuthService["hostClient"]>[0]) {
    const hostResource = mindHostResourceOf(this.env, `https://${host}`);
    if (!hostResource) throw codedError("INVALID_INPUT", `${host} is not a hostname of this mind`);
    const key = `iterate-host-client:${new URL(hostResource).host}`;
    const kept = await this.env.OAUTH_KV.get(key);
    if (kept) return kept;
    const { clientId } = await oauthHelpers(this.env, hostResource).createClient({
      clientName: new URL(hostResource).host,
      clientUri: hostResource,
      redirectUris: [hostCallbackOf(hostResource)],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
    });
    await this.env.OAUTH_KV.put(key, clientId);
    return clientId;
  }

  async isMember(email: Parameters<AuthService["isMember"]>[0]) {
    return isMember(this.env, email);
  }

  async browserSession(cookie: Parameters<AuthService["browserSession"]>[0]) {
    if (!cookie) return null;
    const session = await sessionOf(
      this.env,
      new Request(issuerOf(this.env), { headers: { cookie } }),
    );
    if (!session) return null;
    return {
      userId: session.userId,
      email: session.email,
      member: (await standingOf(this.env, session)) === "member",
    };
  }

  // a key's `paths` stay here: only the intake reads them
  async verify(envelope: Parameters<AuthService["verify"]>[0]) {
    const verified = await verifiedStatement(this.env, envelope);
    return "refused" in verified
      ? verified
      : { signer: verified.signer, statement: verified.statement };
  }

  // only a Worker of the stack reaches this, over a binding
  async sign(input: Parameters<AuthService["sign"]>[0]) {
    return signedByStack(this.env, input);
  }
}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<Env>;

// A stand-in member: the deploy's ITERATE_PROTOTYPE_TOKEN, for any platform resource.
async function prototypeIdentity(
  env: Env,
  token: string,
  resource: string,
): Promise<TokenIdentity | null> {
  const prototypeToken = env.ITERATE_PROTOTYPE_TOKEN;
  if (!prototypeToken || !(await sameSecret(token, prototypeToken))) return null;
  const { domain, resources } = iterateConfigOf(env);
  if (!resources.includes(resource)) return null;
  return {
    principal: { actor: "prototype", email: `prototype@${domain}` },
    grant: "prototype",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    member: true,
  };
}

// Both hashed first: `timingSafeEqual` refuses values of unequal length
// (https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/).
async function sameSecret(given: unknown, secret: string): Promise<boolean> {
  if (typeof given !== "string") return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [given, secret].map((text) => crypto.subtle.digest("SHA-256", encoder.encode(text))),
  );
  return crypto.subtle.timingSafeEqual(a!, b!);
}
