import {
  type AuthRequest,
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import { projectMcpUrlOf, projectProvideUrlOf } from "iterate/project-api";
import { AccountFacts } from "./account-facts.ts";
import { type Session, sessionOf } from "./cookies.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import {
  GRANT_LIFETIME_MS,
  type GrantProps,
  grantedScopes,
  hostCallbackOf,
  oauthHelpers,
  projectHostResourceOf,
} from "./oauth.ts";
import { passkeyOwedResponse, standingOf } from "./members.ts";
import { consentPage, errorPage, notMemberPage } from "./pages.ts";
import { signInHref } from "./sign-in.ts";
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
  const hostResource = projectHostResourceOf(
    env,
    new URL(request.url).searchParams.get("resource"),
  );
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
          ? "A project hostname grants only `identity`."
          : "The project's API and MCP server grant only `iterate`.",
      ),
      302,
    );
  const authRequest = { ...parsed, scope };
  const session = await sessionOf(env, request);
  const url = new URL(request.url);
  if (!session)
    return Response.redirect(`${issuerOf(env)}${signInHref(env, url.pathname + url.search)}`, 302);
  const refused = await notMemberRefusal(env, session, hostResource, url.pathname + url.search);
  if (refused) return refused;
  // a hostname's own sign-in: the code goes to ingress on that host alone, and is not a consent
  if (hostResource && authRequest.redirectUri === hostCallbackOf(hostResource)) {
    const { redirectTo } = await complete(env, session, authRequest, hostResource);
    return Response.redirect(redirectTo, 302);
  }
  // A device code can be sent by someone else, so a device always gets the page; so does `/provide`:
  // a trusted app is trusted to use the project, not to run it.
  if (
    !isDeviceRequest(env, authRequest) &&
    authRequest.resource !== projectProvideUrlOf(iterateConfigOf(env).domain) &&
    isTrustedClient(env, authRequest)
  ) {
    const client = await helpers.lookupClient(authRequest.clientId);
    return approve(env, session, authRequest, client?.clientName, new Headers());
  }
  // describe first: a failed lookup leaves nothing in KV
  const details = await helpers.describeConsent(authRequest);
  const consent = await helpers.beginConsent(authRequest);
  return consentPage({
    details,
    handle: consent.handle,
    email: session.email,
    domain: iterateConfigOf(env).domain,
    resource: resourceInWords(env, authRequest.resource),
    host: hostResource ? new URL(hostResource).host : undefined,
    headers: consent.headers,
  });
}

async function decide(env: Env, request: Request) {
  // the session's cookie approves a grant, so the form must come from this page
  if (request.headers.get("origin") !== issuerOf(env))
    return errorPage("Approve this from its own page.", 403);
  const form = await request.formData().catch(() => null);
  const handle = form?.get("handle");
  if (typeof handle !== "string") return errorPage("This form is incomplete. Start again.", 400);
  const session = await sessionOf(env, request);
  if (!session) return errorPage("You are signed out. Go back to the app and start again.", 401);
  const helpers = oauthHelpers(env);
  if (form?.get("decision") !== "allow") {
    const denied = await helpers.denyConsent(request, handle);
    denied.headers.set("cache-control", "no-store");
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await helpers.approveConsent(request, handle);
  const hostResource = projectHostResourceOf(env, approved.request.resource);
  const refused = await notMemberRefusal(env, session, hostResource, "/");
  if (refused) return refused;
  const client = await helpers.lookupClient(approved.request.clientId);
  return approve(env, session, approved.request, client?.clientName, approved.headers);
}

// A project hostname takes anyone's identity, and gives a member's the project: so a member's
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
  const { domain, login } = iterateConfigOf(env);
  return notMemberPage({ domain, email: session.email, issuer: login.methods.iterate?.issuer });
}

async function complete(
  env: Env,
  session: Session,
  authRequest: AuthRequest,
  hostResource: string | null,
  clientName?: string,
) {
  const letIn = isDeviceRequest(env, authRequest)
    ? (await deviceStore(env.OAUTH_KV).byKey(authRequest.state))?.letIn
    : undefined;
  const props: GrantProps = {
    userId: session.userId,
    email: session.email,
    deadline: Date.now() + (letIn ? letIn.seconds * 1000 : GRANT_LIFETIME_MS),
    ...(letIn && {
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
    metadata: { clientName: clientName || authRequest.clientId },
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
  clientName: string | undefined,
  headers: Headers,
) {
  const hostResource = projectHostResourceOf(env, authRequest.resource);
  const { redirectTo, grantId, props } = await complete(
    env,
    session,
    authRequest,
    hostResource,
    clientName,
  );
  const facts = new AccountFacts();
  facts.add(session.userId, {
    type: "events.iterate.com/account/consent-approved",
    payload: {
      clientId: authRequest.clientId,
      clientName: clientName || authRequest.clientId,
      projects: null,
      scopes: authRequest.scope,
    },
    idempotencyKey: `account/consent-approved/${grantId}`,
  });
  if (props.letIn)
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
    trusted.includes(client.origin) &&
    new URL(authRequest.redirectUri).origin === client.origin
  );
}

function resourceInWords(env: Env, resource: string | undefined) {
  const { domain } = iterateConfigOf(env);
  if (resource === projectProvideUrlOf(domain))
    return "its /provide link, as the computer that runs the project: it receives every request and all mail";
  return resource === projectMcpUrlOf(domain) ? "its MCP server" : "its API";
}

// The library's codes are `<userId>:<grantId>:<secret>`.
function grantIdOf(redirectTo: string) {
  const grantId = new URL(redirectTo).searchParams.get("code")?.split(":")[1];
  if (!grantId) throw new Error("The authorization code names no grant.");
  return grantId;
}
