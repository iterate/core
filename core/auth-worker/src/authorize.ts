import {
  type AuthRequest,
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import { cookieValueOf } from "iterate/lib";
import { mindMcpUrlOf, mindProvideConnectResourceOf } from "iterate/mind-api";
import { AccountFacts } from "./account-facts.ts";
import { appOf, appTakes, askingAppOf } from "./asking-app.ts";
import {
  clearGuestCookie,
  clearMindChoiceCookie,
  clearMindCookie,
  clearMindFreshCookie,
  clearSessionCookie,
  endThisSession,
  guestCookie,
  guestOf,
  MIND_FRESH_COOKIE,
  mindChoiceCookie,
  mindChoiceOf,
  mindFreshOf,
  mindSessionOf,
  type PersonSession,
  requestHashOf,
  personSessionOf,
} from "./cookies.ts";
import { configOf, type Env, issuerOf } from "./env.ts";
import {
  AUTHORIZE_ENDPOINT,
  type GrantProps,
  grantedScopes,
  hostCallbackOf,
  oauthHelpers,
  type SignInMetadata,
  mindHostResourceOf,
} from "./oauth.ts";
import { isMemberSession } from "./members.ts";
import { mindMarkOf } from "./mind-mark.ts";
import { CHOICE_FIELD, chooserPage, consentPage, errorPage, notMemberPage } from "./pages.ts";
import { signInHref } from "./sign-in.ts";
import { admitted, TOO_MANY } from "./device/limits.ts";
import { GUEST_SESSIONS_PER_TEN_MINUTES, guestRefusal } from "./guest-sign-in.ts";
import { mindPersonName } from "./mind-sign-in.ts";
import { CALLBACK_PATH as DEVICE_CALLBACK_PATH } from "./device/protocol.ts";
import { deviceStore } from "./device/store.ts";

export async function authorizeResponse(env: Env, request: Request) {
  const answer = await authorizeAnswer(env, request);
  // a mind sign-in's fresh mark answers this authorization or none (./cookies.ts `mindFreshCookie`)
  if (!cookieValueOf(request.headers.get("cookie"), MIND_FRESH_COOKIE)) return answer;
  // a mark that was begun for another request stays for that one (`freshAnswers`)
  const fresh = await mindFreshOf(env, request);
  if (
    fresh?.request &&
    fresh.request !== (await requestHashOf(promptOf(new URL(request.url)).here))
  )
    return answer;
  const headers = new Headers(answer.headers);
  headers.append("set-cookie", clearMindFreshCookie);
  return new Response(answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers,
  });
}

async function authorizeAnswer(env: Env, request: Request) {
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

/** `choice`: whom the chooser's own POST chose for this request (`chosen`), of the two people
 *  that its page named: the person signed in here (`person`, their user id) or the mind's person
 *  (`user`). The request is then answered for that one alone, or not at all. Nothing else passes
 *  it. */
type Choice = { as: "mind" | "person"; person: string; user: string; app: string };

async function describe(env: Env, request: Request, choice?: Choice) {
  const config = configOf(env);
  const hostResource = mindHostResourceOf(
    config,
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
          ? "A mind hostname grants only `identity`."
          : "The mind's API and MCP server grant only `iterate`.",
      ),
      302,
    );
  const authRequest = { ...parsed, scope };
  const { prompt, here } = promptOf(new URL(request.url));
  // a hostname's own sign-in: the code goes to ingress on that host alone, and is not a consent
  const hostSignIn = hostResource && authRequest.redirectUri === hostCallbackOf(hostResource);
  // Anyone signed in: a mind hostname takes a person who is no member (`grantRefusal`).
  const person = await personSessionOf(env, request);
  // AN APP NAMES HOW ITS PEOPLE SIGN IN, and this endpoint holds every code for the app's host to
  // it, whichever client asks. A session that the app does not take is no session here: the
  // person goes to the sign-in for this request, which offers the app's methods alone, unless
  // their mind vouched for them and the app names "mind".
  const takesPerson = !person || !hostResource || (await hostTakes(env, hostResource, person));
  if (takesPerson === null) return errorPage(TOO_MANY, 429);
  // A guest's cookie counts only where nobody is signed in, for a host's own sign-in whose app
  // names guests (`guestAt`), and a mind's cookie too (`mindPersonAt`). BESIDE A PERSON'S SESSION
  // a mind's cookie counts in two cases alone. The app does not take that session, and the mind
  // sign-in that was begun for THIS REQUEST just completed (a fresh mark that names it): the
  // person was sent to the sign-in for this request, and that was their answer. A sign-in that
  // an app's page began names no request, and answers nothing here: the sign-in page comes. Or the app takes the session, and the person chose
  // the mind's person on the chooser's page (`choice`).
  let session: SignedIn | null = null;
  // whether this request spent the fresh mark, which answers a `select_account` too
  let fresh = false;
  if (choice) {
    if (!hostSignIn || new URL(hostResource).host !== choice.app) return choiceEnded();
    if (choice.as === "person") {
      // the person whom the page named, still signed in and still taken: no other, and never
      // the mind's person in their place
      if (person?.userId !== choice.person || !takesPerson) return choiceEnded();
      session = person;
    } else {
      const mind = await mindPersonAt(env, hostResource, request);
      if (mind?.userId !== choice.user) return choiceEnded();
      session = mind;
    }
  } else if (person && takesPerson) session = person;
  else if (hostSignIn && person) {
    const mind = await mindPersonAt(env, hostResource, request);
    fresh = Boolean(
      mind &&
      (await freshAnswers(env, request, mind.userId, new URL(hostResource).host, here, true)),
    );
    if (fresh) session = mind;
  } else if (hostSignIn)
    session =
      (await guestAt(env, hostResource, request)) ||
      (await mindPersonAt(env, hostResource, request));
  const guest = session?.method === "guest";
  // a member of another mind, as a guest: a cookie of their own, with no session row
  const cookieOnly = guest || session?.method === "mind";
  const signIn = `${issuerOf(env)}${signInHref(here)}`;
  if (!session) return Response.redirect(signIn, 302);
  // A MIND SIGN-IN THAT JUST COMPLETED for this host is the answer to its `select_account`, once:
  // the person signed out here, then signed in with their mind (./cookies.ts `mindFreshCookie`).
  const answered =
    prompt === "select_account" &&
    hostSignIn &&
    session.method === "mind" &&
    (fresh || (await freshAnswers(env, request, session.userId, new URL(hostResource).host, here)));
  const asked = answered ? null : prompt;
  // BESIDE A PERSON'S SESSION the same mind sign-in answers nothing by itself: the chooser offers
  // both people, and the person's press decides (`chosen`). So a mind sign-in that another site
  // ran in this browser replaces nobody.
  const offer =
    asked === "select_account" && hostSignIn && !cookieOnly
      ? await mindOffer(env, request, hostResource, here, session.userId)
      : null;
  // OpenID Connect's `prompt`. `login`: sign in again, whoever is signed in. `select_account`: say
  // who is signed in and offer another account. Either comes back here without it. A guest's
  // cookie ends for either: the name form is the page that says who they are, and its answer is
  // a new guest. A member of another mind's cookie ends too: their mind is asked again.
  if (asked === "login" || (asked && cookieOnly)) {
    const facts = new AccountFacts();
    if (!cookieOnly) await endThisSession(env, request, facts);
    return facts.on(
      new Response(null, {
        status: 302,
        headers: {
          location: signIn,
          "set-cookie": guest
            ? clearGuestCookie
            : cookieOnly
              ? clearMindCookie
              : clearSessionCookie,
          "cache-control": "no-store",
        },
      }),
    );
  }
  if (asked === "select_account")
    return chooserPage({
      mind: config.controlPlaneHostname,
      mindMark: await mindMarkOf(env),
      email: session.email,
      here,
      // an app's own sign-in says which app, to a person who is no member: a member's page is
      // the mind's own
      app: (await isMemberSession(env, session)) ? null : await askingAppOf(env, here),
      signedOutOf: hostSignIn ? new URL(hostResource).host : undefined,
      mindHostname: offer?.hostname,
      headers: offer
        ? new Headers({ "set-cookie": offer.cookie, "cache-control": "no-store" })
        : undefined,
    });
  const refused = await grantRefusal(env, session, hostResource, here);
  if (refused) return refused;
  // A GUEST'S NEXT 15 MINUTES on this host (./guest-sign-in.ts): counted for the whole stack,
  // since anyone can be a guest, and for this guest, so that one cookie cannot use up the stack's
  // number and stop every other guest's renewal. The cookie is set again, so it ends 30 days
  // after the browser last came.
  if (hostSignIn && guest) {
    if (
      !(await admitted(
        env,
        "guest-session",
        request,
        GUEST_SESSIONS_PER_TEN_MINUTES,
        session.userId,
      ))
    )
      return guestRefusal("session-rate", new URL(hostResource).host);
    const { redirectTo } = await complete(env, session, authRequest, hostResource);
    return new Response(null, {
      status: 302,
      headers: {
        location: redirectTo,
        "set-cookie": await guestCookie(env, {
          id: session.userId,
          key: session.email,
          name: session.name || "",
        }),
        "cache-control": "no-store",
      },
    });
  }
  // a hostname's own sign-in: the code goes to ingress on that host alone, and is not a consent
  if (hostSignIn) {
    const { redirectTo } = await complete(env, session, authRequest, hostResource);
    return Response.redirect(redirectTo, 302);
  }
  // describe first: a failed lookup leaves nothing in KV
  const details = await helpers.describeConsent(authRequest);
  const consent = await helpers.beginConsent(authRequest);
  return consentPage({
    details,
    handle: consent.handle,
    email: session.email,
    mind: config.controlPlaneHostname,
    mindMark: await mindMarkOf(env),
    resource: resourceInWords(env, authRequest.resource),
    host: hostResource ? new URL(hostResource).host : undefined,
    here,
    headers: consent.headers,
  });
}

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
  if (form?.has(CHOICE_FIELD)) return chosen(env, request, form);
  const handle = form?.get("handle");
  if (typeof handle !== "string") return errorPage("This form is incomplete. Start again.", 400);
  const session = await personSessionOf(env, request);
  if (!session) return errorPage("You are signed out. Go back to the app and start again.", 401);
  const helpers = oauthHelpers(env);
  if (form?.get("decision") !== "allow") {
    const denied = await helpers.denyConsent(request, handle);
    denied.headers.set("cache-control", "no-store");
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await helpers.approveConsent(request, handle);
  // the resource is the one the consent was begun with, kept by the library: the form names none
  const hostResource = mindHostResourceOf(configOf(env), approved.request.resource);
  const refused = await grantRefusal(env, session, hostResource, "/");
  if (refused) return refused;
  // the session may be another than the one that the consent page was shown to
  if (hostResource && !(await hostTakes(env, hostResource, session)))
    return errorPage("This app does not take the way you signed in. Start again from the app.");
  const client = await helpers.lookupClient(approved.request.clientId);
  return approve(env, session, approved.request, client, approved.headers);
}

/** WHO A GRANT IS FOR: a person's session at the issuer, or a guest or a member of another mind,
 *  who have no session row (./guest-sign-in.ts, ./mind-sign-in.ts). `name`: the name a guest
 *  typed, or the other mind's hostname, which the grant keeps. `mind`: the mind that vouched, and
 *  `until` when that cookie ends (epoch ms), which the grant keeps as its deadline. */
type SignedIn = Pick<PersonSession, "userId" | "email" | "method"> & {
  name?: string;
  mind?: { id: string; hostname: string; userId: string };
  until?: number;
};

/** THE MEMBER OF ANOTHER MIND THIS BROWSER IS, for the own sign-in of the host at `hostResource`,
 *  or null: the host's app names "mind". Read here alone, as the guest's cookie is. */
async function mindPersonAt(
  env: Env,
  hostResource: string,
  request: Request,
): Promise<SignedIn | null> {
  const app = await appOf(env, hostResource);
  if (!app?.signIn.includes("mind")) return null;
  const person = await mindSessionOf(env, request);
  if (!person) return null;
  return {
    userId: person.userId,
    email: person.email,
    method: "mind",
    name: mindPersonName(person.mind.hostname),
    mind: person.mind,
    until: person.expiresAt,
  };
}

/** THE GUEST THIS BROWSER IS, for the own sign-in of the host at `hostResource`, or null: the
 *  host's app names guests, and no owner blocked this guest. Read here alone, so the cookie gives
 *  no reach by itself. */
async function guestAt(env: Env, hostResource: string, request: Request): Promise<SignedIn | null> {
  const app = await appOf(env, hostResource);
  if (!app?.signIn.includes("guest")) return null;
  const guest = await guestOf(env, request);
  return guest && !guest.blocked
    ? { userId: guest.userId, email: guest.email, method: "guest", name: guest.name }
    : null;
}

/** Whether this browser's fresh mind sign-in (./cookies.ts `mindFreshCookie`) is the one of
 *  `userId` for the app at `host`, taken now for the first time. */
async function freshAnswers(
  env: Env,
  request: Request,
  userId: string,
  host: string,
  here: string,
  boundOnly = false,
) {
  const fresh = await mindFreshOf(env, request);
  if (!fresh || fresh.user !== userId || fresh.app !== host) return false;
  // `boundOnly`: only a sign-in that was begun for this very request answers
  if (boundOnly && !fresh.request) return false;
  // a sign-in that was begun for one request answers that request alone: another request for
  // the same host does not spend its mark
  if (fresh.request && fresh.request !== (await requestHashOf(here))) return false;
  return once(env, `mind-fresh:${fresh.jti}`, fresh.exp * 1000);
}

/** Whether `mark` is taken now for the first time: a repeat cannot insert (the statements'
 *  table, as ./mind-sign-in.ts takes a vouch). */
async function once(env: Env, mark: string, expires: number) {
  const [, inserted] = await env.DB.batch([
    env.DB.prepare(`delete from statements where expires <= ?1`).bind(Date.now()),
    env.DB.prepare(
      `insert into statements (hash, expires) values (?1, ?2) on conflict do nothing`,
    ).bind(mark, expires),
  ]);
  return Boolean(inserted?.meta.changes);
}

/** THE MIND PERSON THAT THE CHOOSER OFFERS beside a person's session, for the request `here` of
 *  the host's own sign-in, or null: this browser's mind sign-in for that host just completed
 *  (the fresh mark, spent here), and the app names "mind". The cookie is the choice that the
 *  page's POST takes (./cookies.ts `mindChoiceCookie`): for that person, that host and that
 *  request alone. */
async function mindOffer(
  env: Env,
  request: Request,
  hostResource: string,
  here: string,
  person: string,
) {
  const mind = await mindPersonAt(env, hostResource, request);
  const { host } = new URL(hostResource);
  if (!mind?.mind || !(await freshAnswers(env, request, mind.userId, host, here))) return null;
  return {
    hostname: mind.mind.hostname,
    cookie: await mindChoiceCookie(
      env,
      { person, user: mind.userId, app: host, request: await requestHashOf(here) },
      AUTHORIZE_ENDPOINT,
    ),
  };
}

/** THE CHOOSER'S PRESS, when it offered a mind person too (`mindOffer`): a POST from the page
 *  (`decide` checked its origin) with the request it showed, `here`, and "mind" or "person". The
 *  choice is this browser's, for that request, and is taken once: so one page makes one code,
 *  for one of the two, and a second request for the same host needs a page of its own. Then the
 *  request is answered as a GET of it is, with every check of `describe`: for "mind", as the
 *  mind person, whose cookie and whose app's "mind" are read again. */
async function chosen(env: Env, request: Request, form: FormData) {
  const here = form.get("here");
  const as = form.get(CHOICE_FIELD);
  if (typeof here !== "string" || (as !== "mind" && as !== "person")) return choiceEnded();
  const issuer = issuerOf(env);
  const url = URL.parse(here, issuer);
  if (!url || url.origin !== issuer || url.pathname !== AUTHORIZE_ENDPOINT) return choiceEnded();
  // the choice of this request's own page: a chooser for another request has another cookie,
  // which this press neither reads nor ends
  const hash = await requestHashOf(here);
  const choice = await mindChoiceOf(env, request, hash);
  if (!choice) return choiceEnded();
  if (!(await once(env, `mind-choice:${choice.jti}`, choice.exp * 1000))) return choiceEnded(hash);
  const headers = new Headers(request.headers);
  headers.delete("content-type");
  headers.delete("content-length");
  const answer = await describe(env, new Request(url, { headers }), {
    as,
    person: choice.person,
    user: choice.user,
    app: choice.app,
  });
  console.info({ event: "auth.chooser-chose", as, host: choice.app, status: answer.status });
  const answered = new Headers(answer.headers);
  answered.append("set-cookie", clearMindChoiceCookie(hash, AUTHORIZE_ENDPOINT));
  answered.set("cache-control", "no-store");
  return new Response(answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers: answered,
  });
}

/** A choice that is gone: used, timed out, or for another request or another person. With
 *  `requestHash`, that request's own cookie ends with it. */
function choiceEnded(requestHash?: string) {
  const headers = new Headers({ "cache-control": "no-store" });
  if (requestHash)
    headers.set("set-cookie", clearMindChoiceCookie(requestHash, AUTHORIZE_ENDPOINT));
  return errorPage("This choice ended. Go back to the app and sign in again.", 403, headers, []);
}

/** Whether the app at `hostResource` takes `session` (./asking-app.ts `appTakes`). Null: the
 *  app could not be asked, since too many new hostnames were asked about just now. */
async function hostTakes(env: Env, hostResource: string, session: SignedIn) {
  const app = await appOf(env, hostResource);
  return app && appTakes(app, session);
}

/** WHY A SESSION GETS NO GRANT, or null. A mind hostname takes the identity of anyone signed in,
 *  a person who is no member too: an app there has users of its own, and says how they sign in
 *  (`hostTakes`). The mind's API, its MCP server and the right to hand in a mind that runs
 *  elsewhere take a member's session alone, which is a passkey's (./members.ts
 *  `isMemberSession`). A grant keeps how its session's person signed in (./oauth.ts
 *  `GrantProps`). */
async function grantRefusal(
  env: Env,
  session: SignedIn,
  hostResource: string | null,
  here: string,
) {
  if (hostResource || (await isMemberSession(env, session))) return null;
  return notMemberPage({ mind: configOf(env).controlPlaneHostname, email: session.email, here });
}

/** What a grant keeps of its client: the name and the logo that the client gave. */
type AskingClient = { clientName?: string; logoUri?: string } | null;

async function complete(
  env: Env,
  session: SignedIn,
  authRequest: AuthRequest,
  hostResource: string | null,
  client?: AskingClient,
) {
  const clientName = client?.clientName;
  // a device's request: its code goes to this stack's own device callback
  const letIn =
    authRequest.redirectUri === `${issuerOf(env)}${DEVICE_CALLBACK_PATH}`
      ? (await deviceStore(env.OAUTH_KV).byKey(authRequest.state))?.letIn
      : undefined;
  const props: GrantProps = {
    userId: session.userId,
    email: session.email,
    method: session.method,
    name: session.name,
    ...(session.mind && { mind: session.mind, deadline: session.until }),
    // a rule to remove, with its unmarked case (./oauth.ts `GrantProps.standingByMethod`)
    standingByMethod: true,
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
      method: session.method,
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
  session: PersonSession,
  authRequest: AuthRequest,
  client: AskingClient,
  headers: Headers,
) {
  const clientName = client?.clientName;
  const hostResource = mindHostResourceOf(configOf(env), authRequest.resource);
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

function resourceInWords(env: Env, resource: string | undefined) {
  const config = configOf(env);
  if (resource === mindProvideConnectResourceOf(config.controlPlaneHostname))
    return "the right to hand in the mind, as the computer that runs it: it receives every request and all mail";
  return resource === mindMcpUrlOf(config.controlPlaneHostname) ? "its MCP server" : "its API";
}

// The library's codes are `<userId>:<grantId>:<secret>`.
function grantIdOf(redirectTo: string) {
  const grantId = new URL(redirectTo).searchParams.get("code")?.split(":")[1];
  if (!grantId) throw new Error("The authorization code names no grant.");
  return grantId;
}
