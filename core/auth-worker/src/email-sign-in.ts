import { waitUntil } from "cloudflare:workers";
import { sameOriginPath, cookieValueOf, reportIssue } from "iterate/lib";
import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import { emailAllowed } from "./config.ts";
import { sessionCookie } from "./cookies.ts";
import { sha256Hex } from "./device/protocol.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { errorPage, page, passkeySignIn, text } from "./pages.ts";
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
  and (?4 is null or (select count(*) from email_challenges
                      where client = ?4 and created_at > ?9 - ${10 * MINUTE})
                     < 20)
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

function addressPage(env: Env, request: Request, error?: string, typed = "") {
  const { domain } = iterateConfigOf(env);
  const next = new URL(request.url).searchParams.get("next") || "/";
  const passkey = passkeySignIn(next);
  return page({
    title: `Sign in to ${domain}`,
    status: error ? 400 : 200,
    body: `<h1>Sign in to ${text(domain)}</h1>
      <p>Enter your email. We send you a code to sign in with.</p>
      ${error ? `<p><strong>${text(error)}</strong></p>` : ""}
      <form method="post" action="${EMAIL_SIGN_IN_PATH}" class="stack">
        <input type="hidden" name="next" value="${text(next)}">
        <input type="email" name="email" value="${text(typed)}" autocomplete="email" required aria-label="Email">
        <button type="submit">Send a code</button>
      </form>
      ${passkey.body}`,
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
      request.headers.get("cf-connecting-ip"),
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
  return page({
    title: "Enter your code",
    status,
    body: `<h1>Enter your code</h1>
      <p>If <strong>${text(challenge.email)}</strong> may sign in here, a code is on its way. It expires in 10 minutes.</p>
      ${error ? `<p><strong>${text(error)}</strong></p>` : ""}
      <form method="post" action="${CODE_PATH}" class="stack">
        <input name="code" inputmode="numeric" autocomplete="one-time-code" required aria-label="Code">
        <button type="submit">Sign in</button>
      </form>
      <p><a href="${text(`${EMAIL_SIGN_IN_PATH}?${new URLSearchParams({ next: challenge.next })}`)}">Use another email, or send a new code</a></p>`,
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
  return { named, mailable: !reservedDomain.test(email) && (named || domain || anyone) };
}

const cookie = (id: string, maxAgeSeconds: number) =>
  `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
