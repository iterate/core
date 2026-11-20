// mind-sign-in.ts — SIGN IN WITH YOUR MIND, the sign-in method "mind", for an app of this mind that
// names it (iterate/app-description `AppDescription.signIn`): a person proves that they are a
// member of ANOTHER mind, and that mind's word is the proof. This mind is A; the person's mind is
// B, at the hostname they type (or that the app's link names: iterate/sdk `auth.mindSignIn`).
//
//   GET  /sign-in/mind?next=…[&mind=<B>]   the one field, "Your mind's address"; with `mind`, no
//                                          field: it goes on at once, as the POST does
//   POST /sign-in/mind                     reads B's identity log, asks B whether it can vouch,
//                                          keeps a state and a nonce for this browser, and sends
//                                          it to B's ./vouch.ts
//   POST /sign-in/mind/return              B's page posts B's signed statement here; checked, it
//                                          opens this mind's own session of the person
//   GET  /sign-in/mind/app?host=<host>     B asks which app of this mind it vouches for: `{ host,
//                                          name }` for an app of this mind that names "mind", a
//                                          404 for any other hostname (`appNamed`)
//
// THE STATEMENT is one of B's, signed with the working key that B's log lists, in the form of every
// statement between minds: for A's id, from B's id, of the type `SIGN_IN_VOUCHED_TYPE`, at path
// "/", with `{ state, nonce, user, member: true, to }`, living 60 seconds. `to` is where B sent it:
// this mind's issuer origin, the first hostname of this mind's log, and nothing else. So a proof
// that reached another host this mind's log lists opens nothing here. It is checked as a mind's
// signed request is (./mind-fetch.ts), and its `state` and `nonce` must be this browser's, so a
// statement for another browser opens nothing here. It is taken once.
//
// WHAT IT OPENS: a person whose method is "mind", whose row's key is `mind:<B's id>:<their user id
// at B>` (./cookies.ts `MIND_KEY_PREFIX`): no address, so they are no member of A, and no member's
// page, API, MCP server or consent takes them. Like a guest's (./guest-sign-in.ts), their cookie
// is read by the authorization endpoint alone, for a host's own sign-in whose app names "mind".
// It lasts 24 hours and is not renewed: a member whom B removes keeps A's session that long at
// most. B sends no address and no name: the person's name here is B's hostname.
//
// LOGIN CSRF. Another site can start this in a visitor's browser with ITS OWN mind, and finish it:
// the visitor is then a member of the attacker's mind here. The state binds the return to the
// browser that started, which bounds it to that; an app that shows what belongs to a mind says
// whose mind it is first (iterate/sdk `auth.person`).
//
// A STRANGER TYPES THE HOSTNAME, so this Worker fetches what anyone names: https alone, a 5-second
// limit, counted for each visitor's address (`admitted`, "mind"), and the page answers one of three
// fixed sentences, with nothing of what the host answered.
import { publishedMindOf } from "iterate/mind-identity-log";
import { displayNameOf } from "iterate/principal";
import {
  envelopeOf,
  isMindControlPlaneHostname,
  isMindId,
  statementHashOf,
  statementOf,
  verifySignature,
} from "iterate/signed";
import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import { type AskingApp, appOf, askingAppOf } from "./asking-app.ts";
import {
  clearGuestCookie,
  clearMindFormCookie,
  MIND_FORM_PATH,
  MIND_KEY_PREFIX,
  mindFormCookie,
  mindFormOf,
  mindFreshCookie,
  mindSessionCookie,
} from "./cookies.ts";
import { admitted, TOO_MANY } from "./device/limits.ts";
import { configOf, type Env, issuerOf } from "./env.ts";
import { honouredNext } from "./key-rules.ts";
import { mindSignerOf } from "./minds.ts";
import { mindHostResourceOf } from "./oauth.ts";
import { appSignIn, errorPage, page, text } from "./pages.ts";
import { stackKeyOf } from "./stack-key.ts";
import { userOf } from "./users.ts";

export const MIND_RETURN_PATH = `${MIND_FORM_PATH}/return`;
/** Where B asks which app of this mind a sign-in is for (./vouch.ts). */
export const MIND_APP_PATH = `${MIND_FORM_PATH}/app`;
/** The longest app name that B's page shows. */
export const APP_NAME_MAX = 64;
/** Where a mind vouches for its member (./vouch.ts). */
export const VOUCH_PATH = "/sign-in/vouch";
export const SIGN_IN_VOUCHED_TYPE = "events.iterate.com/account/sign-in-vouched";
/** How long a vouch lives, from its `at`. */
const VOUCH_LIFETIME_MS = 60_000;
/** What the two clocks may differ by. */
const CLOCK_SKEW_MS = 30_000;
/** The probe of B's vouch route waits this long. */
const PROBE_MS = 5_000;
/** A statement and its ML-DSA-65 signature are about 5 KiB as a form. */
const RETURN_MAX_BYTES = 32 * 1024;

/** The three answers about a hostname that someone typed, fixed: nothing of what the host said. */
export const NO_MIND = "No mind answers at that address. Check it, and try again.";
export const OLDER_RELEASE =
  "That mind runs an older release of iterate, which cannot sign you in here yet. Its owner can deploy the latest release.";
const THIS_MIND = "That is this mind. Type the address of your own mind.";

/** The payload of B's statement: the browser's state and nonce, and whom B vouches for. */
const VouchedPayload = z.strictObject({
  state: z.string().min(1),
  nonce: z.string().min(1),
  user: z.string().min(1).max(200),
  member: z.literal(true),
  to: z.string().min(1),
});

export async function mindSignInResponse(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === MIND_RETURN_PATH)
    return request.method === "POST"
      ? returned(env, request)
      : new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  if (url.pathname === MIND_APP_PATH)
    return request.method === "GET"
      ? appNamed(env, url.searchParams.get("host") || "")
      : new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  if (url.pathname !== MIND_FORM_PATH) return null;
  if (request.method === "GET" || request.method === "HEAD") {
    const sign = await signInFor(env, url.searchParams.get("next"));
    if (!sign) return new Response("Not found", { status: 404 });
    const typed = url.searchParams.get("mind");
    return typed ? start(env, request, sign, typed) : formPage(sign);
  }
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  if (request.headers.get("origin") !== issuerOf(env))
    return errorPage("Send this from its own page.", 403);
  const form = await request.formData().catch(() => null);
  const sign = await signInFor(env, String(form?.get("next") || ""));
  if (!sign) return new Response("Not found", { status: 404 });
  return start(env, request, sign, String(form?.get("mind") || ""));
}

/** A sign-in by another mind: where it goes on to, and the app that takes it. */
type SignIn = { next: string; app: AskingApp };

/** THE SIGN-IN THAT `next` GOES ON TO, when its app names "mind", else null. `next` is an
 *  address of this mind's own (`honouredNext`): the authorization of a host's own sign-in, as the
 *  sign-in page has it, or a page of the app itself, as `auth.mindSignIn` sends. */
async function signInFor(env: Env, asked: string | null): Promise<SignIn | null> {
  const config = configOf(env);
  const next = honouredNext(asked, config);
  if (!next) return null;
  const url = new URL(next);
  const app =
    url.origin === issuerOf(env)
      ? await askingAppOf(env, next)
      : mindHostResourceOf(config, url.origin)
        ? await appOf(env, url.origin)
        : null;
  return app?.signIn.includes("mind") ? { next, app } : null;
}

async function start(env: Env, request: Request, sign: SignIn, typed: string): Promise<Response> {
  const hostname = typed
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/$/, "");
  const again = (error: string, status = 400) => formPage(sign, error, typed, status);
  if (!isMindControlPlaneHostname(hostname))
    return again("Type your mind's address, such as iterate.example.com.");
  const own = configOf(env);
  if (hostname === own.controlPlaneHostname) return again(THIS_MIND);
  if (!(await admitted(env, "mind", request))) return again(TOO_MANY, 429);
  const published = await publishedMindOf(hostname, (asked) => fetch(asked));
  if ("why" in published) {
    console.info({ event: "auth.mind-sign-in-refused", reason: "no-mind" });
    return again(NO_MIND);
  }
  if (published.expected === own.mindId) return again(THIS_MIND);
  if (!(await vouchesHere(hostname))) {
    console.info({ event: "auth.mind-sign-in-refused", reason: "older-release" });
    return again(OLDER_RELEASE);
  }
  const state = randomToken();
  const nonce = randomToken();
  const at = new URL(`https://${hostname}${VOUCH_PATH}`);
  at.search = new URLSearchParams({
    for: own.controlPlaneHostname,
    app: sign.app.host,
    state,
    nonce,
  }).toString();
  return new Response(null, {
    status: 303,
    headers: {
      location: at.href,
      "set-cookie": await mindFormCookie(env, {
        next: sign.next,
        app: sign.app.host,
        hostname,
        mind: published.expected,
        state,
        nonce,
      }),
      "cache-control": "no-store",
    },
  });
}

/** WHICH APP OF THIS MIND `host` IS, for B's Continue page (./vouch.ts): B asks this issuer,
 *  which this mind's log names, so the answer is this mind's word and not the browser's. Only a
 *  hostname of this mind's zones is read, and an app that does not name "mind" gets the same 404
 *  as no app: the page names an app only where this way can sign in to it. */
async function appNamed(env: Env, host: string): Promise<Response> {
  const origin = URL.parse(`https://${host}`)?.origin;
  const resource =
    origin && origin === `https://${host}` ? mindHostResourceOf(configOf(env), origin) : null;
  const app = resource ? await appOf(env, resource) : null;
  if (!app?.signIn.includes("mind"))
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  return Response.json(
    { host: app.host, name: app.name.slice(0, APP_NAME_MAX) },
    { headers: { "cache-control": "no-store" } },
  );
}

/** Whether the mind at `hostname` has the vouch route: a release before it answers 404 there. */
async function vouchesHere(hostname: string): Promise<boolean> {
  const answer = await fetch(`https://${hostname}${VOUCH_PATH}`, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(PROBE_MS),
  }).catch(() => null);
  return Boolean(answer?.ok);
}

async function returned(env: Env, request: Request): Promise<Response> {
  // A refusal keeps the form cookie: an answer for another tab, or a forged one, must not end the
  // sign-in that waits in this browser. It ends by itself in ten minutes.
  const refused = (reason: string) => {
    console.info({ event: "auth.mind-sign-in-refused", reason });
    return errorPage(
      "Your mind's answer does not sign you in here. Start again from the app.",
      403,
      new Headers({ "cache-control": "no-store" }),
      [],
    );
  };
  if (Number(request.headers.get("content-length")) > RETURN_MAX_BYTES)
    return refused("the answer is too long");
  const form = await mindFormOf(env, request);
  if (!form) return refused("no sign-in waits in this browser");
  const sent = await request.formData().catch(() => null);
  const vouched = await vouchedIn(env, String(sent?.get("envelope") || ""), form);
  if ("refused" in vouched) return refused(vouched.refused);
  const mind = { id: form.mind, hostname: form.hostname, userId: vouched.user };
  const user = await userOf(env.DB, `${MIND_KEY_PREFIX}${mind.id}:${mind.userId}`);
  console.info({ event: "auth.signed-in", method: "mind", userId: user.id, mind: mind.id });
  const facts = new AccountFacts();
  facts.add(user.id, {
    type: "events.iterate.com/account/signed-in",
    payload: { method: "mind", mind: mind.id, hostname: mind.hostname, at: Date.now() },
  });
  const headers = new Headers({ location: form.next, "cache-control": "no-store" });
  headers.append(
    "set-cookie",
    await mindSessionCookie(env, { id: user.id, key: user.email, mind }),
  );
  headers.append("set-cookie", clearMindFormCookie);
  // one way at a time: authorize reads a guest's cookie before this one
  headers.append("set-cookie", clearGuestCookie);
  // the app's next authorization takes this sign-in as the answer to a prompt, once
  // (./authorize.ts): it was the person's answer, made after any sign-out
  if (form.app)
    headers.append("set-cookie", await mindFreshCookie(env, { user: user.id, app: form.app }));
  return facts.on(new Response(null, { status: 303, headers }));
}

/** THE PERSON B VOUCHES FOR in `sent`, the envelope as JSON text, or why not. Every field is
 *  checked against what this browser waits for (`form`), then the signer's log, the key and the
 *  signature, then the clock again, then once. */
async function vouchedIn(
  env: Env,
  sent: string,
  form: { hostname: string; mind: string; state: string; nonce: string },
): Promise<{ user: string } | { refused: string }> {
  const envelope = envelopeOf(parsedJson(sent));
  if (!envelope) return { refused: "no signed statement" };
  const fields = statementOf(envelope.statement);
  if ("refused" in fields) return fields;
  const own = configOf(env);
  if (fields.type !== SIGN_IN_VOUCHED_TYPE) return { refused: "another type" };
  if (envelope.signature.format !== "ML-DSA-65") return { refused: "not a mind's working key" };
  if (fields.mind !== own.mindId) return { refused: "for another mind" };
  if (!isMindId(form.mind) || fields.from !== form.mind || fields.fromHost !== form.hostname)
    return { refused: "from another mind than the one asked" };
  if (fields.path !== "/") return { refused: 'a vouch has the path "/"' };
  const payload = VouchedPayload.safeParse(fields.payload);
  if (!payload.success) return { refused: "the payload is no vouch" };
  if (payload.data.state !== form.state || payload.data.nonce !== form.nonce)
    return { refused: "for another browser" };
  if (payload.data.to !== issuerOf(env)) return { refused: "sent to another place" };
  const now = Date.now();
  if (fields.expires <= now) return { refused: "expired" };
  if (
    fields.at >= fields.expires ||
    fields.at > now + CLOCK_SKEW_MS ||
    fields.expires - fields.at > VOUCH_LIFETIME_MS
  )
    return { refused: "a vouch lives 60 seconds at most" };
  if (envelope.signature.key === (await stackKeyOf(env)).key)
    return { refused: "signed with this mind's own key" };
  const signer = await mindSignerOf(env, envelope);
  if (!signer) return { refused: "names no mind as from" };
  if ("refused" in signer) return signer;
  if (signer.mind !== form.mind) return { refused: "signed by another mind" };
  if (signer.key.format !== envelope.signature.format) return { refused: "another key format" };
  const issuer = issuerOf(env);
  const verified = await verifySignature(envelope, signer.key.publicKey, {
    origin: issuer,
    rpId: new URL(issuer).hostname,
  });
  if ("refused" in verified) return verified;
  if (Date.now() >= fields.expires) return { refused: "expired" };
  // once: a repeat cannot insert
  const [, inserted] = await env.DB.batch([
    env.DB.prepare(`delete from statements where expires <= ?1`).bind(Date.now()),
    env.DB.prepare(
      `insert into statements (hash, expires) values (?1, ?2) on conflict do nothing`,
    ).bind(await statementHashOf(envelope.statement), fields.expires),
  ]);
  if (!inserted?.meta.changes) return { refused: "seen before" };
  return { user: payload.data.user };
}

const parsedJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const randomToken = () => crypto.randomUUID().replaceAll("-", "");

/** THE ONE FIELD, for the sign-in `sign`. */
function formPage({ next, app }: SignIn, error?: string, typed = "", status = 200) {
  const asking = appSignIn(app);
  return page({
    title: asking.title,
    mark: asking.mark,
    centered: true,
    imageOrigin: asking.imageOrigin,
    status: error ? status : 200,
    body: `${asking.heading}
      <p class="muted center">Sign in as a member of your own mind. Your mind asks you to confirm, and sends no email address.</p>
      ${error ? `<p class="center" role="alert"><strong>${text(error)}</strong></p>` : ""}
      <form method="post" action="${MIND_FORM_PATH}" class="stack">
        <input type="hidden" name="next" value="${text(next)}">
        <label>Your mind's address <input type="text" name="mind" value="${text(typed)}" placeholder="iterate.example.com" autocomplete="url" autocapitalize="none" spellcheck="false" autofocus required></label>
        <button type="submit">Continue</button>
      </form>${asking.about}`,
  });
}

/** The name of a member of another mind, to show: that mind's hostname. */
export const mindPersonName = (hostname: string) => displayNameOf(hostname);
