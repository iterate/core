import {
  type AuthRequest,
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import { mindMcpUrlOf, mindProvideUrlOf } from "iterate/mind-api";
import { SignInMethod } from "iterate/principal";
import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import { askingAppOf } from "./asking-app.ts";
import {
  clearCloudflareSessionCookie,
  clearSessionCookie,
  cloudflareSessionOf,
  type Session,
  sessionOf,
} from "./cookies.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import {
  type GrantProps,
  grantedScopes,
  hostCallbackOf,
  oauthHelpers,
  type SignInMetadata,
  mindHostResourceOf,
} from "./oauth.ts";
import { passkeyOwedResponse, standingOf } from "./members.ts";
import { chooserPage, consentPage, errorPage, nobodySignsInPage, notMemberPage } from "./pages.ts";
import { methodsAskedIn, signInHref } from "./sign-in.ts";
import { CALLBACK_PATH as DEVICE_CALLBACK_PATH } from "./device/protocol.ts";
import { deviceStore } from "./device/store.ts";

export async function authorizeResponse(env: Env, request: Request) {
  try {
    return request.method === "POST" ? await decide(env, request) : await describe(env, request);
  } catch (error) {
    // A redirect back to the client only once the library validated the client and its redirect.
    if (error instanceof AuthorizationError && error.redirectTo)
      return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return errorPage(error.description, 400);
    if (error instanceof CimdFetchError)
      return errorPage(
        "We could not load this app's description, so we can't tell who it is.",
        400,
      );
    throw error;
  }
}

async function describe(env: Env, request: Request) {
  const hostResource = mindHostResourceOf(env, new URL(request.url).searchParams.get("resource"));
  const helpers = oauthHelpers(env, hostResource);
  const parsed = await helpers.parseAuthRequest(request);
  // PKCE with S256 for every client: the library requires it of a public client, and a client
  // that holds a secret is held to it here too.
  if (parsed.codeChallengeMethod !== "S256" || !parsed.codeChallenge)
    return Response.redirect(
      authorizationErrorRedirect(parsed, "invalid_request", "PKCE with S256 is required."),
      302,
    );
  const scope = grantedScopes(parsed.scope, Boolean(hostResource));
  if (!scope)
    return Response.redirect(
      authorizationErrorRedirect(
        parsed,
        "invalid_scope",
        hostResource
          ? "A mind hostname grants only `identity`."
          : "The mind's API and MCP server grant only `iterate`.",
      ),
      302,
    );
  const authRequest = { ...parsed, scope };
  const { prompt, here } = promptOf(new URL(request.url));
  // The ways to sign in that the app on a mind hostname takes (./sign-in.ts `methodsAskedIn`):
  // whoever has no session made one of those ways is sent to the page of those ways.
  const methods = methodsAskedIn(env, here);
  if (methods?.length === 0) return nobodySignsInPage();
  const session = await sessionFor(env, request, methods);
  const cloudflare = session?.method === "cloudflare";
  const signIn = `${issuerOf(env)}${signInHref(env, here)}`;
  if (!session) return Response.redirect(signIn, 302);
  // OpenID Connect's `prompt`. `login`: sign in again, whoever is signed in. `select_account`: say
  // who is signed in and offer another account. Either comes back here without it. A sign-in at
  // Cloudflare ends for either, and the person starts again on the page of the app's ways:
  // Cloudflare's own page says who is signed in there, and with no page of ours between,
  // Cloudflare would sign the same person straight back in.
  if (prompt === "login" || (prompt && cloudflare))
    return new Response(null, {
      status: 302,
      headers: {
        location: signIn,
        "set-cookie": cloudflare ? clearCloudflareSessionCookie : clearSessionCookie,
        "cache-control": "no-store",
      },
    });
  if (prompt === "select_account")
    return chooserPage({
      domain: iterateConfigOf(env).domain,
      email: session.email,
      here,
      // an app's own sign-in says which app, to a person who is no member: a member's page is
      // the mind's own
      app: (await standingOf(env, session)) === "member" ? null : await askingAppOf(env, here),
    });
  const refused = await notMemberRefusal(env, session, hostResource, here);
  if (refused) return refused;
  // a hostname's own sign-in: the code goes to ingress on that host alone, and is not a consent
  if (hostResource && authRequest.redirectUri === hostCallbackOf(hostResource)) {
    const { redirectTo } = await complete(env, session, authRequest, hostResource);
    return Response.redirect(redirectTo, 302);
  }
  // A device code can be sent by someone else, so a device always gets the page; so does `/provide`:
  // a trusted app is trusted to use the mind, not to run it.
  if (
    !isDeviceRequest(env, authRequest) &&
    authRequest.resource !== mindProvideUrlOf(iterateConfigOf(env).domain) &&
    isTrustedClient(env, authRequest)
  ) {
    const client = await helpers.lookupClient(authRequest.clientId);
    return approve(env, session, authRequest, client, new Headers());
  }
  // describe first: a failed lookup leaves nothing in KV
  const details = await helpers.describeConsent(authRequest);
  // the ways ride the consent to its approval (`ConsentMethods`)
  const withMethods: AuthRequest & z.input<typeof ConsentMethods> = { ...authRequest, methods };
  const consent = await helpers.beginConsent(withMethods);
  return consentPage({
    details,
    handle: consent.handle,
    email: session.email,
    domain: iterateConfigOf(env).domain,
    resource: resourceInWords(env, authRequest.resource),
    host: hostResource ? new URL(hostResource).host : undefined,
    here,
    headers: consent.headers,
  });
}

/** THE SESSION THAT MAY GET A CODE, or null. With no `methods`, the mind's own session. With the
 *  ways an app takes, the mind's own session when it began one of those ways, else Cloudflare's
 *  when they name Cloudflare. Each is read from its own cookie, so nothing a browser sends turns
 *  one into the other, and Cloudflare's is read for an app that names it alone. */
async function sessionFor(
  env: Env,
  request: Request,
  methods: readonly SignInMethod[] | null,
): Promise<Session | null> {
  const own = await sessionOf(env, request);
  if (!methods || (own?.method && methods.includes(own.method))) return own;
  return methods.includes("cloudflare") ? cloudflareSessionOf(env, request) : null;
}

/** The ways the app took, as a consent keeps them: the OAuth library keeps the request it begins
 *  a consent with whole, and answers it at the approval. */
const ConsentMethods = z.object({ methods: z.array(SignInMethod).nullish() });

/** An authorization request's `prompt` (a space-separated list; `login` wins), and the request
 *  without it, as a path of the issuer: where a sign-in or the chooser goes on. */
export function promptOf(url: URL): { prompt: "login" | "select_account" | null; here: string } {
  const asked = (url.searchParams.get("prompt") || "").split(" ");
  const rest = new URL(url);
  rest.searchParams.delete("prompt");
  return {
    prompt: asked.includes("login")
      ? "login"
      : asked.includes("select_account")
        ? "select_account"
        : null,
    here: rest.pathname + rest.search,
  };
}

async function decide(env: Env, request: Request) {
  // the session's cookie approves a grant, so the form must come from this page
  if (request.headers.get("origin") !== issuerOf(env))
    return errorPage("Approve this from its own page.", 403);
  const form = await request.formData().catch(() => null);
  const handle = form?.get("handle");
  if (typeof handle !== "string") return errorPage("This form is incomplete. Start again.", 400);
  const signedOut = () => errorPage("You are signed out. Go back to the app and start again.", 401);
  // which session decides is known once the handle says what the consent is for
  if (!(await sessionOf(env, request)) && !(await cloudflareSessionOf(env, request)))
    return signedOut();
  const helpers = oauthHelpers(env);
  if (form?.get("decision") !== "allow") {
    const denied = await helpers.denyConsent(request, handle);
    denied.headers.set("cache-control", "no-store");
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await helpers.approveConsent(request, handle);
  // the resource and the ways are the ones the consent was begun with, kept by the library: the
  // form names neither
  const kept = ConsentMethods.safeParse(approved.request).data?.methods;
  const session = await sessionFor(env, request, kept || null);
  if (!session) return signedOut();
  const hostResource = mindHostResourceOf(env, approved.request.resource);
  const refused = await notMemberRefusal(env, session, hostResource, "/");
  if (refused) return refused;
  const client = await helpers.lookupClient(approved.request.clientId);
  return approve(env, session, approved.request, client, approved.headers);
}

// A mind hostname takes anyone's identity, and gives a member's the mind: so a member's
// session must act as a member there too.
async function notMemberRefusal(
  env: Env,
  session: Session,
  hostResource: string | null,
  here: string,
) {
  const standing = await standingOf(env, session);
  if (standing === "passkey-owed") return passkeyOwedResponse(here);
  if (standing === "member" || hostResource) return null;
  const { domain } = iterateConfigOf(env);
  return notMemberPage({ domain, email: session.email, here });
}

/** What a grant keeps of its client: the name and the logo that the client gave. */
type AskingClient = { clientName?: string; logoUri?: string } | null;

async function complete(
  env: Env,
  session: Session,
  authRequest: AuthRequest,
  hostResource: string | null,
  client?: AskingClient,
) {
  const clientName = client?.clientName;
  const letIn = isDeviceRequest(env, authRequest)
    ? (await deviceStore(env.OAUTH_KV).byKey(authRequest.state))?.letIn
    : undefined;
  // Every code is made here, so this is the last check of the rule the callers follow: a sign-in at
  // Cloudflare serves a mind hostname alone (./cloudflare-sign-in.ts).
  if (session.method === "cloudflare" && !hostResource)
    throw new Error("A sign-in at Cloudflare serves a mind hostname alone.");
  const props: GrantProps = {
    userId: session.userId,
    email: session.email,
    method: session.method,
    ...(letIn && {
      deadline: Date.now() + letIn.seconds * 1000,
      letIn: {
        reason: letIn.reason,
        clientName: clientName || authRequest.clientId,
        ...(letIn.signer && { signer: { actor: letIn.signer.actor, key: letIn.signer.key } }),
      },
    }),
  };
  const { redirectTo } = await oauthHelpers(env, hostResource).completeAuthorization({
    request: authRequest,
    userId: session.userId,
    // what /keys shows of this sign-in (./oauth.ts `signInsOf`)
    metadata: {
      clientName: clientName || authRequest.clientId,
      resource: authRequest.resource,
      logoUri: client?.logoUri,
      until: props.deadline,
    } satisfies SignInMetadata,
    scope: authRequest.scope,
    revokeExistingGrants: false,
    props,
  });
  return { redirectTo, grantId: grantIdOf(redirectTo), props };
}

async function approve(
  env: Env,
  session: Session,
  authRequest: AuthRequest,
  client: AskingClient,
  headers: Headers,
) {
  const clientName = client?.clientName;
  const hostResource = mindHostResourceOf(env, authRequest.resource);
  const { redirectTo, grantId, props } = await complete(
    env,
    session,
    authRequest,
    hostResource,
    client,
  );
  const facts = new AccountFacts();
  facts.add(session.userId, {
    type: "events.iterate.com/account/consent-approved",
    payload: {
      clientId: authRequest.clientId,
      clientName: clientName || authRequest.clientId,
      minds: null,
      scopes: authRequest.scope,
    },
    idempotencyKey: `account/consent-approved/${grantId}`,
  });
  if (props.letIn && props.deadline)
    facts.add(session.userId, {
      type: "events.iterate.com/account/let-in-approved",
      payload: {
        grantId,
        clientId: authRequest.clientId,
        clientName: props.letIn.clientName,
        reason: props.letIn.reason,
        until: props.deadline,
        signer: props.letIn.signer,
      },
      idempotencyKey: `account/let-in-approved/${grantId}`,
    });
  headers.set("location", redirectTo);
  headers.set("cache-control", "no-store");
  return facts.on(new Response(null, { status: 302, headers }));
}

const isDeviceRequest = (env: Env, authRequest: AuthRequest) =>
  authRequest.redirectUri === `${issuerOf(env)}${DEVICE_CALLBACK_PATH}`;

// The id is a metadata document's https URL, which the library fetched to resolve the client, and
// the redirect is on that same origin, so the code goes nowhere else.
function isTrustedClient(env: Env, authRequest: AuthRequest) {
  const trusted = iterateConfigOf(env).trustedClients || [];
  if (!URL.canParse(authRequest.clientId) || !URL.canParse(authRequest.redirectUri)) return false;
  const client = new URL(authRequest.clientId);
  return (
    client.protocol === "https:" &&
    // Never iterate Cloud's MCP relay, whatever the config lists: its one client stands for every
    // app behind it (internal-packages/installer worker/mcp-relay.js), so a member is always asked.
    client.pathname !== "/oauth2/client.json" &&
    trusted.includes(client.origin) &&
    new URL(authRequest.redirectUri).origin === client.origin
  );
}

function resourceInWords(env: Env, resource: string | undefined) {
  const { domain } = iterateConfigOf(env);
  if (resource === mindProvideUrlOf(domain))
    return "its /provide link, as the computer that runs the mind: it receives every request and all mail";
  return resource === mindMcpUrlOf(domain) ? "its MCP server" : "its API";
}

// The library's codes are `<userId>:<grantId>:<secret>`.
function grantIdOf(redirectTo: string) {
  const grantId = new URL(redirectTo).searchParams.get("code")?.split(":")[1];
  if (!grantId) throw new Error("The authorization code names no grant.");
  return grantId;
}
