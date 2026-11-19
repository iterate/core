// email-sign-in.ts — THE MAILED CODE, the sign-in method "email": six digits, mailed through
// Cloudflare Email Sending, that prove an address. The mail comes from where the person is
// (`mailCode`): `sign-in@<the zone of the app's hostname>` under the app's name for an app's own
// sign-in, and `sign-in@<the zone of the control-plane hostname>` for an outside client's sign-in
// to an app. IT IS FOR THE PEOPLE OF THE MIND'S APPS, AND OPENS NO WAY INTO THE MIND. What the
// proof opens depends on whose address it is as the code is typed:
//
//   a person who is no member   a session that is no member's (./cookies.ts `emailSessionCookie`):
//                               an app of the mind with users of its own takes it, when it names
//                               "email"
//   a member, with a passkey    nothing, and the words say what signs that member in
//   or with none                (`memberRefusal`): the passkey, Cloudflare Access for an owner
//                               (./access-sign-in.ts), an owner's sign-in link for an added member
//
// A SIGN-IN THAT DOES NOT NAME "email" HAS NO SUCH PAGE: an app says how its people sign in
// (./asking-app.ts `signInOf`), and for one that names the passkey alone, as for the control
// plane's own sign-in, the address page leads back to the sign-in page, and no code is mailed in
// its name.
//
// ANYONE MAY ASK FOR A CODE, so that the mind's apps have users of their own. The limits keep the
// mind's zone from being a way to mail the world (`INSERT_CHALLENGE`). Every address is answered
// alike and a member's address is mailed its code too, so the pages say nothing of who is a
// member: a member reads the refusal only after the right code, which proves the mailbox.
import { waitUntil } from "cloudflare:workers";
import { cookieValueOf, reportIssue } from "iterate/lib";
import { zoneOf } from "iterate/mind-config";
import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import { type AskingApp, askingAppOf, signInOf } from "./asking-app.ts";
import { isBlocked } from "./blocked.ts";
import { isOwner } from "./config.ts";
import { emailSessionCookie, sessionsOverRemoved } from "./cookies.ts";
import { sha256Hex } from "./device/protocol.ts";
import { clientOf, TOO_MANY } from "./device/limits.ts";
import { passkeysOf } from "./enrolment.ts";
import { configOf, type Env, homeOf, issuerOf } from "./env.ts";
import { honouredNext } from "./key-rules.ts";
import { appSignIn, errorPage, page, passkeySignIn, text } from "./pages.ts";
import { isMember } from "./members.ts";
import { signInHref } from "./sign-in.ts";
import { userOf } from "./users.ts";

const EMAIL_SIGN_IN_PATH = "/sign-in/email";
const CODE_PATH = `${EMAIL_SIGN_IN_PATH}/code`;
const COOKIE = "__Host-iterate-auth-code";
const LIFETIME_SECONDS = 10 * 60;
const TRIES = 5;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Challenge = {
  email: string;
  hash: string;
  tries: number;
  next: string;
  /** 1 when the code was mailed. */
  mailed: number;
};

/** How many codes an hour the whole mind mails to addresses that are no member's. A member's
 *  address is one that somebody named, and its code is no part of the count: a member always
 *  gets the mail whose code leads to the words of what signs them in. Any other address is one
 *  that anyone can type. */
export const NON_MEMBER_CODES_AN_HOUR = 20;
/** How many codes an hour one mailbox gets from all clients together: what keeps an inbox from a
 *  flood. One client address also gets one a minute for one mailbox. */
export const CODES_AN_HOUR_FOR_A_MAILBOX = 5;
/** How many codes one client address may ask for in ten minutes, mailed or not. */
const CHALLENGES_IN_TEN_MINUTES_FOR_A_CLIENT = 20;
/** How many challenges the whole mind holds that are not over yet, mailed or not, as the passkey's
 *  challenges are capped (./passkey-sign-in.ts): what a stranger with many addresses can make
 *  the mind store. A row is kept an hour, so the table holds six times this at most. */
export const LIVE_CHALLENGES = 120;
/** The longest `next` a challenge keeps. A longer one is not kept: the person goes on to the
 *  mind's front page. */
const NEXT_MAX_CHARACTERS = 2048;

// One statement, so two requests at once are counted one after the other. ?1 id, ?2 email, ?3
// inbox, ?4 client, ?5 hash, ?6 next, ?7 named (a member's address), ?8 mailable, ?9 now, ?10
// expires at.
//
// WHETHER THE CODE IS MAILED: never to an address that is not mailable; never past a mailbox's
// limits; always to a member's; to any other while the mind is under its cap for the hour.
// THE LIMITS OF A MAILBOX (`inbox`: the address without its `+tag`) count the codes MAILED to it:
// one a minute for each asking client, and `CODES_AN_HOUR_FOR_A_MAILBOX` from all of them. A
// request that mails nothing, such as one for `owner+tag@…` past the cap, spends none of them.
// A CHALLENGE THAT IS NOT MAILED IS MADE ALL THE SAME, for every reason alike, so the answer is
// the same for every address: it says nothing of whether the address is a member's, or of its
// mailbox's limits. Only the limits that hold for every address (a client's, the mind's live
// challenges) refuse the request.
const INSERT_CHALLENGE = `with code as (select
  case
    when ?8 = 0 then 0
    when exists (select 1 from email_challenges
                 where inbox = ?3 and client = ?4 and mailed = 1 and created_at > ?9 - ${MINUTE})
      then 0
    when (select count(*) from email_challenges
          where inbox = ?3 and mailed = 1 and created_at > ?9 - ${HOUR})
         >= ${CODES_AN_HOUR_FOR_A_MAILBOX}
      then 0
    when ?7 = 1 then 1
    when (select count(*) from email_challenges
          where named = 0 and mailed = 1 and created_at > ?9 - ${HOUR}) < ${NON_MEMBER_CODES_AN_HOUR}
      then 1
    else 0
  end as mailed)
insert into email_challenges
  (id, email, inbox, client, hash, next, named, mailed, created_at, expires_at)
select ?1, ?2, ?3, ?4, ?5, ?6, ?7, code.mailed, ?9, ?10 from code
where (select count(*) from email_challenges
       where client = ?4 and created_at > ?9 - ${10 * MINUTE}) < ${CHALLENGES_IN_TEN_MINUTES_FOR_A_CLIENT}
  and (select count(*) from email_challenges where expires_at > ?9) < ${LIVE_CHALLENGES}
returning mailed`;

// RFC 2606 and 6761 names are never mailed (a bounce costs the sender's reputation), but get a
// challenge all the same, so a check can walk the pages.
const reservedDomain = /@(example\.(com|net|org)|[^@]+\.(test|example|invalid|localhost))$/i;

export async function emailSignInResponse(env: Env, request: Request) {
  const { pathname } = new URL(request.url);
  if (pathname !== EMAIL_SIGN_IN_PATH && pathname !== CODE_PATH) return null;
  if (request.method === "POST" && request.headers.get("origin") !== issuerOf(env))
    return errorPage("Send this from its own page.", 403);
  if (pathname === CODE_PATH)
    return request.method === "POST" ? finish(env, request) : codePage(env, request);
  if (request.method === "POST") return start(env, request);
  const next = new URL(request.url).searchParams.get("next") || "/";
  const signIn = await signInOf(env, next);
  if (!signIn) return errorPage(TOO_MANY, 429);
  return signIn.methods.includes("email") ? emailAddressPage(env, next, signIn) : toSignIn(next);
}

/** The way back for a sign-in that does not name "email": its own sign-in page. */
const toSignIn = (next: string) =>
  new Response(null, {
    status: 303,
    headers: { location: signInHref(next), "cache-control": "no-store" },
  });

/** The mind's own line above a form: what a code gives. It is on the page of an outside client's
 *  sign-in to an app, which is headed with the mind's name. An app's own page leaves it out: its
 *  words are the mind's, not the app's. */
function ruleAbove(env: Env, asking: object | null) {
  if (asking) return "";
  const mind = text(configOf(env).controlPlaneHostname);
  return `<p class="muted">A code gives an account for the apps of ${mind}, with no access to the mind itself. A member signs in with a passkey.</p>`;
}

/** What the pages need of the sign-in that a code is for (./asking-app.ts `signInOf`). */
type SignIn = NonNullable<Awaited<ReturnType<typeof signInOf>>>;

/** THE ADDRESS PAGE: the form that asks for a code, and below it the passkey. A passkey counts at
 *  every app, whatever methods the app names, so a member can always use theirs here. It is `/sign-in/email`, and it is the sign-in page itself for a sign-in whose
 *  first method is "email" (./http.ts). `signIn` is the one that `next` goes on to. */
export function emailAddressPage(
  env: Env,
  next: string,
  signIn: SignIn,
  error?: string,
  typed = "",
) {
  const mind = configOf(env).controlPlaneHostname;
  const passkey = passkeySignIn(next, { alone: false, asksAtOpen: false });
  // a sign-in that an app of this mind started says which app, on each of its pages
  const asking = signIn.app ? appSignIn(signIn.app) : null;
  return page({
    title: asking?.title || `Sign in to ${mind}`,
    mark: asking?.mark,
    centered: true,
    imageOrigin: asking?.imageOrigin,
    status: error ? 400 : 200,
    body: `${asking?.heading || `<h1>Sign in to ${text(mind)}</h1>`}
      <p class="muted">Enter your email. We send you a code to sign in with.</p>
      ${ruleAbove(env, asking)}
      ${error ? `<p role="alert">${text(error)}</p>` : ""}
      <form method="post" action="${EMAIL_SIGN_IN_PATH}" class="stack">
        <input type="hidden" name="next" value="${text(next)}">
        <label>Email <input type="email" name="email" value="${text(typed)}" autocomplete="email" placeholder="you@example.com" required></label>
        <button type="submit">Send a code</button>
      </form>
      ${passkey.body}${asking?.about || ""}`,
    script: passkey.script,
  });
}

async function start(env: Env, request: Request) {
  const form = await request.formData().catch(() => null);
  // where the person goes on once signed in: an address of the mind's own, kept whole as it was
  // checked, else the mind's front page
  const asked = honouredNext(String(form?.get("next") || ""), configOf(env));
  const next = asked && asked.length <= NEXT_MAX_CHARACTERS ? asked : homeOf(env);
  const signIn = await signInOf(env, next);
  if (!signIn) return errorPage(TOO_MANY, 429);
  if (!signIn.methods.includes("email")) return toSignIn(next);
  const typed = String(form?.get("email") || "");
  const email = typed.trim().toLowerCase();
  const again = (error: string) => emailAddressPage(env, next, signIn, error, typed);
  if (!z.email().safeParse(email).success) return again("Enter an email address.");
  const id = crypto.randomUUID();
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
  // both are read for every address alike, so the answer's time says nothing
  const [named, blocked] = await Promise.all([isMember(env, email), isBlocked(env, email)]);
  // someone an owner blocked gets the same page as anyone, and no mail; a member is never blocked
  const mailable = !reservedDomain.test(email) && (named || !blocked);
  const now = Date.now();
  const [, , added] = await env.DB.batch<{ mailed: number }>([
    env.DB.prepare("delete from email_challenges where created_at <= ?1").bind(now - HOUR),
    sessionsOverRemoved(env, now),
    env.DB.prepare(INSERT_CHALLENGE).bind(
      id,
      email,
      email.replace(/\+[^@]*@/, "@"),
      clientOf(request),
      await sha256Hex(`${id}:${code}`),
      next,
      named ? 1 : 0,
      mailable ? 1 : 0,
      now,
      now + LIFETIME_SECONDS * 1000,
    ),
  ]);
  const row = added?.results[0];
  if (!row) return again("Codes were asked for just now. Wait ten minutes, then try again.");
  // after the answer, so every address is answered alike and in the same time
  if (row.mailed) waitUntil(mailCode(env, email, code, signIn.app));
  else console.info({ event: "email-sign-in.not-mailed" });
  return new Response(null, {
    status: 303,
    headers: {
      location: CODE_PATH,
      "set-cookie": cookie(id, LIFETIME_SECONDS),
      "cache-control": "no-store",
    },
  });
}

/** THE MAIL COMES FROM WHERE THE PERSON IS. `app` is the app whose own sign-in the code is for:
 *  the sender is `sign-in@<the zone of the app's hostname>`, and the app's name is the sender's
 *  name and in the subject, so a mind with two zones mails an app's people from the zone that
 *  they are on. With no app, an outside client's sign-in to an app (an MCP client's):
 *  `sign-in@<the zone of the control-plane hostname>`, under the control-plane hostname. The stack
 *  lets this Worker send as `sign-in@<zone>` for every zone of the mind (core/alchemy). */
async function mailCode(env: Env, email: string, code: string, app: AskingApp | null) {
  const config = configOf(env);
  const name = app?.name || config.controlPlaneHostname;
  // an app's own name is the app's choice: the mail also says the hostname, which is not
  const where = app && app.name !== app.host ? `${app.name} (${app.host})` : name;
  try {
    const { messageId } = await env.SEND_EMAIL.send({
      from: { email: `sign-in@${zoneOf(config, app?.host || config.controlPlaneHostname)}`, name },
      to: [email],
      subject: `Your sign-in code for ${name}`,
      text: `${code}\n\nEnter this code to sign in to ${where}. It expires in 10 minutes.\n\nIf you did not try to sign in, ignore this email.\n`,
    });
    console.info({ event: "email-sign-in.sent", messageId });
  } catch (error) {
    reportIssue("email-sign-in.send-failed", error);
  }
}

async function codePage(env: Env, request: Request, error?: string, status = 200) {
  const id = cookieValueOf(request.headers.get("cookie"), COOKIE);
  const challenge = id
    ? await env.DB.prepare(
        "select email, next from email_challenges where id = ?1 and tries < ?2 and expires_at > ?3",
      )
        .bind(id, TRIES, Date.now())
        .first<Pick<Challenge, "email" | "next">>()
    : null;
  if (!challenge) return restart();
  // the code is for the app that the sign-in started from, and the page still says which
  const app = await askingAppOf(env, challenge.next);
  const asking = app && { ...appSignIn(app, { heading: "Enter your code" }), app };
  // ONE SENTENCE OVER THE FIELD: whose code, for which sign-in, and how long it lasts. What to do
  // when no code comes is under the button, with the way back.
  const where = asking ? `sign in to <strong>${text(asking.app.host)}</strong>` : "sign in here";
  return page({
    title: "Enter your code",
    mark: asking?.mark,
    centered: true,
    imageOrigin: asking?.imageOrigin,
    status,
    body: `${asking?.heading || "<h1>Enter your code</h1>"}
      <p class="muted">If <strong>${text(challenge.email)}</strong> may ${where}, a code is on its way. It expires in 10 minutes.</p>
      ${ruleAbove(env, asking)}
      ${error ? `<p role="alert">${text(error)}</p>` : ""}
      <form method="post" action="${CODE_PATH}" class="stack">
        <label>Code <input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" autofocus required></label>
        <button type="submit">Sign in</button>
      </form>
      <p class="muted">No code after a minute? Check the spam folder, or <a href="${text(`${EMAIL_SIGN_IN_PATH}?${new URLSearchParams({ next: challenge.next })}`)}">use another email or send a new code</a>.</p>${asking?.about || ""}`,
  });
}

async function finish(env: Env, request: Request) {
  const id = cookieValueOf(request.headers.get("cookie"), COOKIE);
  const form = await request.formData().catch(() => null);
  const entered = String(form?.get("code") || "").replace(/\D/g, "");
  // the try is spent before the check, in one statement: no other request sees it unspent
  const challenge = id
    ? await env.DB.prepare(
        "update email_challenges set tries = tries + 1 where id = ?1 and tries < ?2 and expires_at > ?3 returning email, hash, tries, next, mailed",
      )
        .bind(id, TRIES, Date.now())
        .first<Challenge>()
    : null;
  if (!id || !challenge) return restart();
  // A challenge that was not mailed has no code that anyone was given: no entry is right for it,
  // and its page answers as for a wrong one.
  const right =
    entered.length === 6 &&
    (await sha256Hex(`${id}:${entered}`)) === challenge.hash &&
    challenge.mailed === 1;
  if (!right) {
    if (challenge.tries >= TRIES)
      return errorPage(
        "Too many tries. Ask for a new code.",
        400,
        new Headers({ "set-cookie": cookie("", 0) }),
        [
          {
            href: `${EMAIL_SIGN_IN_PATH}?${new URLSearchParams({ next: challenge.next })}`,
            label: "Send a new code",
          },
        ],
      );
    const left = TRIES - challenge.tries;
    return codePage(
      env,
      request,
      `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`,
      400,
    );
  }
  // spent once: of two right answers at once, one signs in
  const spent = await env.DB.prepare(
    "update email_challenges set expires_at = 0 where id = ?1 and expires_at > ?2 returning id",
  )
    .bind(id, Date.now())
    .first();
  if (!spent) return restart();
  // A code proves an address, and no more: it opens no way into the mind. A member's address, as
  // the code is typed, gets the words of what does sign that member in, and no session.
  if (await isMember(env, challenge.email)) {
    const refused = await memberRefusal(env, challenge.email, challenge.next);
    console.info({ event: "auth.sign-in-refused", method: "email" });
    return errorPage(refused.words, 403, new Headers({ "set-cookie": cookie("", 0) }), [
      refused.link,
    ]);
  }
  const user = await userOf(env.DB, challenge.email);
  const { setCookie, session } = await emailSessionCookie(env, request, user);
  console.info({ event: "auth.signed-in", method: "email", userId: user.id });
  const facts = new AccountFacts();
  facts.add(user.id, {
    type: "events.iterate.com/account/signed-in",
    payload: { method: "email", session, at: Date.now() },
  });
  // The session's cookie, the code's own cookie cleared, and on to where the sign-in was for: the
  // address that was checked when the code was asked for.
  const headers = new Headers({ location: challenge.next, "cache-control": "no-store" });
  headers.append("set-cookie", setCookie);
  headers.append("set-cookie", cookie("", 0));
  return facts.on(new Response(null, { status: 303, headers }));
}

/** WHY A RIGHT CODE SIGNS IN NO MEMBER, in words that say what does, and the link under them.
 *  Mail must not open the mind: a member signs in with a passkey, and the first one is added after
 *  a proof that ./enrolment.ts takes. `next` is where the sign-in was for. */
async function memberRefusal(env: Env, email: string, next: string) {
  const config = configOf(env);
  const mind = config.controlPlaneHostname;
  const owner = isOwner(config, email);
  const passkeys = await passkeysOf(env, email);
  const words = {
    held: `${email} has a passkey for ${mind}, so nothing else signs it in. Sign in with the passkey.`,
    removed: owner
      ? `${email} had a passkey for ${mind}, so a code by email signs it in no more. An owner with no passkey left gets back in by the recovery command, which whoever holds this mind's Cloudflare account runs.`
      : `${email} had a passkey for ${mind}, so a code by email signs it in no more. Ask an owner of the mind for a sign-in link.`,
    none: owner
      ? `${email} is an owner of ${mind}, and a code by email signs in no member. Prove your email address with Cloudflare, and then add a passkey.`
      : `${email} is a member of ${mind}, and a code by email signs in no member. Ask an owner of the mind for a sign-in link, and then add a passkey.`,
  }[passkeys];
  // an owner with no passkey yet goes on to Cloudflare Access; anyone else, back to the sign-in
  const link =
    owner && passkeys === "none"
      ? {
          href: `/sign-in/access?${new URLSearchParams({ next })}`,
          label: "Prove your email address with Cloudflare",
        }
      : { href: signInHref(next), label: "Sign in" };
  return { words, link };
}

const restart = () =>
  new Response(null, {
    status: 303,
    headers: {
      location: EMAIL_SIGN_IN_PATH,
      "set-cookie": cookie("", 0),
      "cache-control": "no-store",
    },
  });

const cookie = (id: string, maxAgeSeconds: number) =>
  `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
