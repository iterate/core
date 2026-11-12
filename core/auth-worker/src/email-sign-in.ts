import { waitUntil } from "cloudflare:workers";
import { sameOriginPath, cookieValueOf, reportIssue } from "iterate/lib";
import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import { askingAppOf } from "./asking-app.ts";
import { isBlocked } from "./blocked.ts";
import { emailAllowed } from "./config.ts";
import { sessionCookie } from "./cookies.ts";
import { sha256Hex } from "./device/protocol.ts";
import { clientOf } from "./device/limits.ts";
import { type Env, issuerOf, iterateConfigOf, offersGoogle } from "./env.ts";
import { appSignIn, errorPage, googleSignIn, page, passkeySignIn, text } from "./pages.ts";
import { addressProven } from "./keys.ts";
import { isAdded } from "./members.ts";
import { linkIdentity } from "./users.ts";

export const EMAIL_SIGN_IN_PATH = "/sign-in/email";
const CODE_PATH = `${EMAIL_SIGN_IN_PATH}/code`;
const COOKIE = "__Host-iterate-auth-code";
const LIFETIME_SECONDS = 10 * 60;
const TRIES = 5;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Challenge = { email: string; hash: string; tries: number; next: string };

// One statement, so two requests at once are counted one after the other. ?1 id, ?2 email, ?3 inbox,
// ?4 client, ?5 hash, ?6 next, ?7 named, ?8 mailable, ?9 now, ?10 expires at. Addresses no `email`
// rule names share 20 codes an hour for the whole stack: a whole domain is not a list of people.
const INSERT_CHALLENGE = `insert into email_challenges
  (id, email, inbox, client, hash, next, named, mailed, created_at, expires_at)
select ?1, ?2, ?3, ?4, ?5, ?6, ?7,
  case
    when ?8 = 0 then 0
    when ?7 = 1 then 1
    when (select count(*) from email_challenges
          where named = 0 and mailed = 1 and created_at > ?9 - ${HOUR}) < 20
      then 1
    else 0
  end,
  ?9, ?10
where not exists (select 1 from email_challenges where inbox = ?3 and created_at > ?9 - ${MINUTE})
  and (select count(*) from email_challenges where inbox = ?3 and created_at > ?9 - ${HOUR}) < 5
  and (select count(*) from email_challenges
       where client = ?4 and created_at > ?9 - ${10 * MINUTE}) < 20
returning mailed`;

// RFC 2606 and 6761 names are never mailed (a bounce costs the sender's reputation), but get a
// challenge all the same, so the smoke check can walk the pages.
const reservedDomain = /@(example\.(com|net|org)|[^@]+\.(test|example|invalid|localhost))$/i;

export async function emailSignInResponse(env: Env, request: Request) {
  const { pathname } = new URL(request.url);
  if (pathname !== EMAIL_SIGN_IN_PATH && pathname !== CODE_PATH) return null;
  if (!iterateConfigOf(env).login.methods.email) return new Response("Not found", { status: 404 });
  if (request.method === "POST" && request.headers.get("origin") !== issuerOf(env))
    return errorPage("Send this from its own page.", 403);
  if (pathname === EMAIL_SIGN_IN_PATH)
    return request.method === "POST" ? start(env, request) : addressPage(env, request);
  return request.method === "POST" ? finish(env, request) : codePage(env, request);
}

/** Whether a new address gets a code here. It is the stack's rule, which its config makes
 *  public, and never one address's standing: every address is still answered alike. */
function anyoneGetsACode(env: Env) {
  const { methods, allow } = iterateConfigOf(env).login;
  return Boolean(methods.email?.anyone || allow.some((rule) => "everyone" in rule));
}

/** Who gets a code here, as the mind's own two pages say it. */
function whoGetsACode(env: Env) {
  const { domain } = iterateConfigOf(env);
  return anyoneGetsACode(env)
    ? `Anyone can sign in to ${domain}. A new address gets an account of its own, with no access to the mind itself.`
    : `${domain} takes no new sign-ups: a code goes only to an address that is already a member. Any other address gets no code and no error.`;
}

/** The app that a sign-in is for, as both pages say it: its head, and its block with who gets a
 *  code. Null for the mind's own sign-in. */
async function askingOf(env: Env, next: string, heading?: string) {
  const app = await askingAppOf(env, next);
  if (!app) return null;
  const said = appSignIn(app, iterateConfigOf(env).domain, {
    heading,
    signUps: anyoneGetsACode(env) ? "anyone" : "members",
  });
  return { ...said, app };
}

/** The mind's own line above a form: who gets a code. A page with an app's block says that
 *  there, so it has no such line. */
function ruleAbove(env: Env, asking: object | null) {
  return asking ? "" : `<p class="muted">${text(whoGetsACode(env))}</p>`;
}

async function addressPage(env: Env, request: Request, error?: string, typed = "") {
  const { domain } = iterateConfigOf(env);
  const next = new URL(request.url).searchParams.get("next") || "/";
  const passkey = passkeySignIn(next);
  // a sign-in that an app of this mind started says which app, on each of its pages
  const asking = await askingOf(env, next);
  return page({
    title: asking?.title || `Sign in to ${domain}`,
    asker: asking?.asker,
    imageOrigin: asking?.imageOrigin,
    status: error ? 400 : 200,
    body: `${asking?.heading || `<h1>Sign in to ${text(domain)}</h1>`}
      <p class="muted">Enter your email. We send you a code to sign in with.</p>
      ${ruleAbove(env, asking)}
      ${error ? `<p role="alert">${text(error)}</p>` : ""}
      <form method="post" action="${EMAIL_SIGN_IN_PATH}" class="stack">
        <input type="hidden" name="next" value="${text(next)}">
        <label>Email <input type="email" name="email" value="${text(typed)}" autocomplete="email" placeholder="you@example.com" required></label>
        <button type="submit">Send a code</button>
      </form>
      ${passkey.body}${offersGoogle(env) ? googleSignIn(next) : ""}${asking?.about || ""}`,
    script: passkey.script,
  });
}

async function start(env: Env, request: Request) {
  const form = await request.formData().catch(() => null);
  const next = sameOriginPath(String(form?.get("next") || "/"), issuerOf(env));
  const typed = String(form?.get("email") || "");
  const email = typed.trim().toLowerCase();
  const again = (error: string) =>
    addressPage(
      env,
      new Request(`${issuerOf(env)}${EMAIL_SIGN_IN_PATH}?${new URLSearchParams({ next })}`),
      error,
      typed,
    );
  if (!z.email().safeParse(email).success) return again("Enter an email address.");
  const id = crypto.randomUUID();
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
  const { named, mailable } = await whoIsMailed(env, email);
  const now = Date.now();
  const [, added] = await env.DB.batch<{ mailed: number }>([
    env.DB.prepare("delete from email_challenges where created_at <= ?1").bind(now - HOUR),
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
  if (!row) return again("Codes were asked for just now. Wait a minute, or an hour after five.");
  // after the answer, so every address is answered alike and in the same time
  if (row.mailed) waitUntil(mailCode(env, email, code));
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

async function mailCode(env: Env, email: string, code: string) {
  const { domain } = iterateConfigOf(env);
  try {
    const { messageId } = await env.SEND_EMAIL.send({
      from: { email: `sign-in@${domain}`, name: domain },
      to: [email],
      subject: `Your sign-in code for ${domain}`,
      text: `${code}\n\nEnter this code to sign in to ${domain}. It expires in 10 minutes.\n\nIf you did not try to sign in, ignore this email.\n`,
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
  if (!challenge) return restart(env, "/");
  // the code is for the app that the sign-in started from, and the page still says which
  const asking = await askingOf(env, challenge.next, "Enter your code");
  // ONE SENTENCE OVER THE FIELD: whose code, for which sign-in, and how long it lasts. What to do
  // when no code comes is under the button, with the way back.
  const where = asking ? `sign in to <strong>${text(asking.app.name)}</strong>` : "sign in here";
  return page({
    title: "Enter your code",
    asker: asking?.asker,
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
        "update email_challenges set tries = tries + 1 where id = ?1 and tries < ?2 and expires_at > ?3 returning email, hash, tries, next",
      )
        .bind(id, TRIES, Date.now())
        .first<Challenge>()
    : null;
  if (!id || !challenge) return restart(env, "/");
  const right = entered.length === 6 && (await sha256Hex(`${id}:${entered}`)) === challenge.hash;
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
  if (!spent) return restart(env, "/");
  // a code proves an address; `login.allow` still decides who is a member
  const user = await linkIdentity(env.DB, {
    provider: "email",
    subject: challenge.email,
    email: challenge.email,
  }).catch((error: unknown) => {
    console.warn({ event: "auth.sign-in-link-failed", message: String(error) });
    return null;
  });
  if (!user)
    return errorPage(`${challenge.email} belongs to another account here. Ask the mind's owner.`);
  const proven = await addressProven(env, user, challenge.next);
  if ("refused" in proven) {
    console.info({ event: "auth.sign-in-refused", method: "email", userId: user.id });
    return errorPage(proven.refused, 403, new Headers({ "set-cookie": cookie("", 0) }), [
      {
        href: `${EMAIL_SIGN_IN_PATH}?${new URLSearchParams({ next: challenge.next })}`,
        label: "Sign in with the passkey",
      },
    ]);
  }
  console.info({ event: "auth.signed-in", method: "email", userId: user.id });
  const facts = new AccountFacts();
  facts.add(user.id, {
    type: "events.iterate.com/account/signed-in",
    payload: { method: "email", at: Date.now() },
  });
  const headers = new Headers({
    location: proven.location,
    "cache-control": "no-store",
  });
  headers.append("set-cookie", await sessionCookie(env, user, "email"));
  headers.append("set-cookie", cookie("", 0));
  return facts.on(new Response(null, { status: 303, headers }));
}

const restart = (env: Env, next: string) =>
  new Response(null, {
    status: 303,
    headers: {
      location: `${EMAIL_SIGN_IN_PATH}?${new URLSearchParams({ next: sameOriginPath(next, issuerOf(env)) })}`,
      "set-cookie": cookie("", 0),
      "cache-control": "no-store",
    },
  });

async function whoIsMailed(env: Env, email: string) {
  const { methods, allow } = iterateConfigOf(env).login;
  // the table is read for every address alike, so the answer's time says nothing
  const added = await isAdded(env, email);
  const named =
    added ||
    emailAllowed(
      allow.filter((rule) => "email" in rule),
      email,
    );
  const domain = emailAllowed(
    allow.filter((rule) => "emailDomain" in rule),
    email,
  );
  const anyone = Boolean(methods.email?.anyone) || allow.some((rule) => "everyone" in rule);
  // someone an owner blocked gets the same page as anyone, and no mail
  const blocked = !named && (await isBlocked(env, email));
  return {
    named,
    mailable: !reservedDomain.test(email) && !blocked && (named || domain || anyone),
  };
}

const cookie = (id: string, maxAgeSeconds: number) =>
  `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
