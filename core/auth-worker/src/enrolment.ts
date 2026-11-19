// enrolment.ts — THE FIRST PASSKEY, and the one session that may add it. Whoever holds a member's
// mailbox must not hold the mind, so exactly three proofs open such a session, each good for that
// one thing, once (`proofRefusal` decides):
//
//   Cloudflare Access  (./access-sign-in.ts; the proof "cloudflare-access") proves the address of
//                      an owner who has NEVER had a passkey: a removed passkey counts as had. So
//                      whoever holds an owner's mailbox gets in only by adding a passkey before
//                      the owner does, as the mind is made.
//   an owner's link    (./members.ts `memberLink`; "member-link") opens one for a member who is no
//                      owner and has no passkey now: a new member, or one whose keys an owner
//                      removed.
//   a recovery link    ("recovery-link") is a link that the recovery command made, which whoever
//                      holds the mind's Cloudflare account runs: for an owner who has no passkey
//                      left.
//
// THE MIND'S OWN MAILED CODE IS NONE OF THEM (./email-sign-in.ts): it is for the people of the
// mind's apps, who are no members, and opens no way into the mind.
//
// Such a session is a row of `browser_sessions` whose `method` is the proof's (`Proof`), which
// is never a sign-in method (iterate/principal `SignInMethod`). No reader of ./cookies.ts answers
// it, so to every other page and to the stack's other Workers its browser is signed out. It
// reaches this page and the POST that records the first passkey, and sign-out (./sign-in.ts). The
// write that records the passkey holds the same condition as the session's making, in its own
// statement, and ends every such session of the person.
//
//   GET  /keys/first        the form, for a browser with such a session; else the page a link
//                           opens, which spends the ticket in the link's fragment and loads again
//   POST /keys/first        records the first passkey, and answers the passkey's own session
//   POST /keys/first/link   spends a link's ticket
import { base64url, fromBase64url, keyIdOf } from "iterate/signed";
import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import { isOwner } from "./config.ts";
import { cookieClaimsOf, cookieOf, newSessionId, sessionCookie, userAgentOf } from "./cookies.ts";
import { sha256Hex } from "./device/protocol.ts";
import { configOf, type Env, homeOf, issuerOf } from "./env.ts";
import { honouredNext } from "./key-rules.ts";
import { outsiderKeysRevoked, outsiderKeysRevokedFacts } from "./keys-pages.ts";
import { isMember } from "./members.ts";
import { page, text } from "./pages.ts";
import { SIGN_HELPERS } from "./signed-change.ts";
import { stackKeyOf } from "./stack-key.ts";
import { userOf } from "./users.ts";

export const FIRST_PASSKEY_PATH = "/keys/first";
const LINK_PATH = `${FIRST_PASSKEY_PATH}/link`;

/** How long such a session lasts, and a link before it is spent. */
export const ENROLMENT_MS = 24 * 3600_000;

/** `member_tickets.made_by` of a link that the recovery command made. An owner's link has the
 *  owner's address there, which is never this word. */
export const RECOVERY_COMMAND = "recovery-command";

/** What proved the address: the session's `method`. */
const Proof = z.enum(["cloudflare-access", "member-link", "recovery-link"]);
type Proof = z.infer<typeof Proof>;
/** The same, as SQL: the rows of `browser_sessions` that are this module's. A row of another
 *  method is a passkey's session or a mailed code's (./cookies.ts), and adds no passkey. */
const PROOF_METHODS = `(${Proof.options.map((proof) => `'${proof}'`).join(", ")})`;

const CHALLENGE_SECONDS = 5 * 60;
const CHALLENGE_KEY_PREFIX = "iterate-first-passkey-challenge:";

/** THE PASSKEY THAT BARS A PROOF, as SQL over the `keys` rows of the user `user` (a column or a
 *  parameter): for Cloudflare Access any passkey the person ever had, for a link one that is not
 *  removed. `proof` is the SQL of the session's method. One text, so the session's making and the
 *  passkey's write hold the same condition, each in its own statement. A passkey that was added
 *  while its owner was no member is none (../migrations/0016): whoever added it would otherwise
 *  lock the member out, and the member's first passkey revokes it. */
const barringPasskey = (user: string, proof: string) =>
  `select 1 from keys k where k.user_id = ${user} and k.format = 'webauthn' and k.outsider = 0
     and (${proof} = 'cloudflare-access' or k.revoked_at is null)`;

/** WHO MAY ENROL: why a proof opens no session, in words for the person, or null. The one
 *  decision for the session's making and for its reading. Each refusal says the one way that is
 *  left, and never one the server forbids. */
async function proofRefusal(env: Env, email: string, proof: Proof): Promise<string | null> {
  const config = configOf(env);
  const mind = config.controlPlaneHostname;
  // WHOSE ADDRESS A PROOF IS FOR. The policy of Cloudflare Access names the owners alone, and the
  // recovery command is an owner's way back. An owner's link is for an added member: no owner
  // makes a way in as another owner.
  const owner = isOwner(config, email);
  if (owner && proof === "member-link")
    return `${email} is an owner of ${mind}. An owner's link signs in no owner.`;
  if (!owner && proof === "cloudflare-access")
    return `${email} is not an owner of ${mind}, and Cloudflare Access signs in an owner alone. Sign in with your passkey.`;
  if (!owner && proof === "recovery-link")
    return `${email} is not an owner of ${mind}, and the recovery command's link signs in an owner alone.`;
  if (!(await isMember(env, email))) return `${email} is not a member of ${mind}.`;
  const passkeys = await passkeysOf(env, email);
  if (passkeys === "held")
    return `${email} has a passkey for ${mind}, so nothing else signs it in. Sign in with the passkey.`;
  if (passkeys === "removed" && proof === "cloudflare-access")
    return `${email} had a passkey for ${mind}, so Cloudflare's proof of the address signs it in no more. An owner with no passkey left gets back in by the recovery command, which whoever holds this mind's Cloudflare account runs.`;
  return null;
}

/** THE PASSKEYS OF AN ADDRESS, as a refusal reads them: "none" that the person ever had, one that
 *  is "held" now, or "removed", each of them. An outsider's passkey counts as none
 *  (`barringPasskey`). */
export async function passkeysOf(env: Env, email: string): Promise<"none" | "held" | "removed"> {
  const had = await env.DB.prepare(
    `select count(*) as ever, count(k.revoked_at) as removed from keys k
     where k.format = 'webauthn' and k.outsider = 0
       and k.user_id = (select id from users where email = ?1)`,
  )
    .bind(email)
    .first<{ ever: number; removed: number }>();
  if (!had?.ever) return "none";
  return had.ever > had.removed ? "held" : "removed";
}

/** A NEW SESSION THAT MAY ADD THE FIRST PASSKEY, for the person of `email`, or the refusal's
 *  words. One statement makes the row only while no passkey bars the proof, so a proof redeemed
 *  while another browser records the passkey leaves no session. */
export async function enrolmentCookie(
  env: Env,
  request: Request,
  email: string,
  proof: Proof,
): Promise<{ setCookie: string; facts: AccountFacts } | { refused: string }> {
  const refused = await proofRefusal(env, email, proof);
  if (refused) return { refused };
  const user = await userOf(env.DB, email);
  const session = newSessionId();
  const now = Date.now();
  const made = await env.DB.prepare(
    `insert into browser_sessions
       (id, user_id, method, key_id, user_agent, created_at, last_seen_at, expires_at)
     select ?1, ?2, ?3, null, ?4, ?5, ?5, ?6
     where not exists (${barringPasskey("?2", "?3")})
     returning id`,
  )
    .bind(session, user.id, proof, userAgentOf(request), now, now + ENROLMENT_MS)
    .first();
  // a passkey was recorded since the check above: the words for it are that check's
  if (!made)
    return { refused: (await proofRefusal(env, email, proof)) || "Sign in with the passkey." };
  console.info({ event: "auth.signed-in", method: proof, userId: user.id });
  const facts = new AccountFacts();
  facts.add(user.id, {
    type: "events.iterate.com/account/signed-in",
    payload: { method: proof, session, at: now },
  });
  return { setCookie: await cookieOf(env, user, session, ENROLMENT_MS / 1000), facts };
}

/** THE BROWSER'S SESSION THAT MAY ADD THE FIRST PASSKEY, or null: its cookie, a row that is not
 *  ended and not expired, and a person whom its proof would still let enrol now (`proofRefusal`):
 *  a deploy may have changed who is an owner, and a passkey may have been added since. */
async function enrolmentOf(env: Env, request: Request) {
  const claims = await cookieClaimsOf(env, request);
  if (!claims) return null;
  const row = await env.DB.prepare(
    `select s.method from browser_sessions s
     where s.id = ?1 and s.user_id = ?2 and s.method in ${PROOF_METHODS}
       and s.ended_at is null and s.expires_at > ?3`,
  )
    .bind(claims.session, claims.userId, Date.now())
    .first<{ method: string }>();
  const proof = Proof.safeParse(row?.method);
  if (!proof.success || (await proofRefusal(env, claims.email, proof.data))) return null;
  return { id: claims.session, userId: claims.userId, email: claims.email };
}

export async function firstPasskeyResponse(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const get = request.method === "GET" || request.method === "HEAD";
  const post = request.method === "POST";
  if (
    !(url.pathname === FIRST_PASSKEY_PATH && (get || post)) &&
    !(url.pathname === LINK_PATH && post)
  )
    return null;
  // the page's own script alone
  if (post && request.headers.get("origin") !== issuerOf(env))
    return json({ error: "use this site's own page" }, 403);
  if (url.pathname === LINK_PATH) return linkSpent(env, request);
  const session = await enrolmentOf(env, request);
  if (post)
    return session
      ? firstPasskeyAdded(env, request, session)
      : json({ error: "This sign-in is over. Sign in again." }, 403);
  const next = honouredNext(url.searchParams.get("next"), configOf(env));
  return session ? formPage(env, session, next) : linkPage(env, next);
}

async function formPage(env: Env, session: { userId: string; email: string }, next: string | null) {
  const mind = configOf(env).controlPlaneHostname;
  const challenge = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.OAUTH_KV.put(`${CHALLENGE_KEY_PREFIX}${challenge}`, session.userId, {
    expirationTtl: CHALLENGE_SECONDS,
  });
  // The person came for one thing, so the page is that one thing: why, what the browser asks
  // next, and the button.
  return page({
    title: `Add your passkey to ${mind}`,
    body: `<h1>Add your passkey to ${text(mind)}</h1>
      <p>${text(mind)} needs a passkey at your first sign-in. From then on it is how you sign in here, and how you approve what your agents ask for.</p>
      <p>Press the button, and your browser asks for your fingerprint, your face or a security key.</p>
      <form id="add" class="stack" data-challenge="${text(challenge)}" data-user="${text(session.userId)}" data-email="${text(session.email)}" data-rp="${text(mind)}" data-next="${text(next || "")}">
        <button type="submit">Add a passkey</button>
        <details><summary>Name it (optional)</summary><input name="label" maxlength="100" size="28" aria-label="Name" placeholder="such as YubiKey"></details>
        <p id="status" class="muted" role="status"></p>
      </form>`,
    script: `${SIGN_HELPERS}${FORM_SCRIPT}`,
  });
}

// No credential is excluded: the person has no passkey here that counts, and one that was removed
// may be made again on the device that held it. The answer names where the browser goes on.
const FORM_SCRIPT = `
const form = document.getElementById("add");
const status = document.getElementById("status");
// A link opened in a browser that holds such a session already, perhaps another person's: the
// link's ticket is spent, and the page loads again for the person the link names.
if (location.hash.length > 1)
  fetch("${LINK_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: location.hash.slice(1) }) }).then((answer) => {
    history.replaceState(null, "", location.pathname + location.search);
    if (answer.ok) location.reload();
  });
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const { challenge, user, email, rp, next } = form.dataset;
  try {
    statusSay(status, "Waiting for your new passkey…");
    // With no name typed the passkey is named after the device, where the browser says which,
    // and the day: the press never waits for a name.
    const day = new Date().toISOString().slice(0, 10);
    const typed = form.label.value.trim();
    const device = navigator.userAgentData && navigator.userAgentData.platform ? navigator.userAgentData.platform + " passkey" : "Passkey";
    const credential = await navigator.credentials.create({ publicKey: {
      rp: { id: rp, name: rp },
      // The name is what a password manager lists the passkey under: its name here, this host and
      // the day, so that a person's passkeys are told apart there. The address is the displayName.
      user: { id: enc.encode(user), name: [typed || device, rp, day].join(" · "), displayName: email },
      challenge: unb64u(challenge),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      attestation: "none",
    } });
    const body = { label: typed || device + ", " + day, publicKey: b64u(credential.response.getPublicKey()), credentialId: credential.id, clientDataJSON: b64u(credential.response.clientDataJSON), next };
    const response = await fetch("${FIRST_PASSKEY_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error);
    // said before the next page loads: "Waiting for your new passkey…" would stand there meanwhile
    statusSay(status, "Your passkey is added. One moment…");
    location.assign(answer.next);
  } catch (error) {
    statusFailed(status, error, "The passkey was not added.");
  }
});`;

const FirstPasskey = z.object({
  /** A name is the person's to give or to leave out: with none, the key is named after the day. */
  label: z.string().max(100).optional(),
  publicKey: z.string(),
  credentialId: z.string(),
  clientDataJSON: z.string(),
  next: z.string().optional(),
});
const ClientData = z.object({ type: z.string(), origin: z.string(), challenge: z.string() });

async function firstPasskeyAdded(
  env: Env,
  request: Request,
  session: { id: string; userId: string; email: string },
): Promise<Response> {
  const input = FirstPasskey.safeParse(await request.json().catch(() => null));
  const clientData = ClientData.safeParse(
    input.success ? clientDataOf(input.data.clientDataJSON) : null,
  );
  if (!input.success || !clientData.success)
    return json(
      {
        error:
          "Send the passkey's public key, credential id and client data as JSON, and a name of at most 100 characters if you name it.",
      },
      400,
    );
  if (clientData.data.type !== "webauthn.create" || clientData.data.origin !== issuerOf(env))
    return json({ error: "This is not a passkey made on this page." }, 403);
  const challengeKey = `${CHALLENGE_KEY_PREFIX}${clientData.data.challenge}`;
  if ((await env.OAUTH_KV.get(challengeKey)) !== session.userId)
    return json({ error: "This page expired. Reload it and try again." }, 403);
  await env.OAUTH_KV.delete(challengeKey);
  const { publicKey, credentialId } = input.data;
  const key = await passkeyIdOf(env, publicKey);
  if (!key) return json({ error: "This passkey's key is not a P-256 key." }, 400);
  const at = Date.now();
  const label = input.data.label?.trim() || `Passkey, ${new Date(at).toISOString().slice(0, 10)}`;
  // One transaction. The passkey is recorded only while this session is live and no passkey bars
  // its proof: of two browsers at once, one records a passkey. Then every session of this person
  // that may add a first passkey ends, this one and any other browser's.
  const [added, ended, revoked] = await env.DB.batch<{ id: string; label: string }>([
    env.DB.prepare(
      `insert into keys
         (id, user_id, public_key, format, credential_id, label, added_via, added_by, added_at)
       select ?1, ?2, ?3, 'webauthn', ?4, ?5, 'keys-page', ?2, ?6
       where exists (select 1 from browser_sessions s
         where s.id = ?7 and s.user_id = ?2 and s.method in ${PROOF_METHODS}
           and s.ended_at is null and s.expires_at > ?6
           and not exists (${barringPasskey("?2", "s.method")}))
       on conflict do nothing`,
    ).bind(key, session.userId, publicKey, credentialId, label, at, session.id),
    env.DB.prepare(
      `update browser_sessions set ended_at = ?2
       where user_id = ?1 and method in ${PROOF_METHODS} and ended_at is null
         and exists (select 1 from keys k where k.user_id = ?1 and k.format = 'webauthn'
           and k.revoked_at is null and k.outsider = 0)
       returning id`,
    ).bind(session.userId, at),
    // the passkeys from before the address was a member's end with it, in the same transaction
    outsiderKeysRevoked(env, session.userId, key, at),
  ]);
  if (!added?.meta.changes)
    return json({ error: "This sign-in is over: you have a passkey now. Sign in with it." }, 409);
  const facts = new AccountFacts();
  outsiderKeysRevokedFacts(facts, session.userId, at, revoked?.results || []);
  facts.add(session.userId, {
    type: "events.iterate.com/account/key-added",
    payload: { key, label, format: "webauthn", at },
    idempotencyKey: `account/key-added:${key}`,
  });
  for (const { id } of ended?.results || [])
    facts.add(session.userId, {
      type: "events.iterate.com/account/session-ended",
      payload: { session: id, at },
      idempotencyKey: `account/session-ended/${id}`,
    });
  // the passkey was made in this browser, so this browser's session is that passkey's now
  const user = { id: session.userId, email: session.email };
  const made = await sessionCookie(env, request, user, key);
  facts.add(session.userId, {
    type: "events.iterate.com/account/signed-in",
    payload: { method: "passkey", key, session: made.session, at },
  });
  console.info({ event: "auth.first-passkey-added", userId: session.userId });
  return facts.on(
    Response.json(
      // where the browser goes on: the `next` the page was given, checked again here, else the
      // mind's own front page
      { key, label, next: honouredNext(input.data.next || null, configOf(env)) || homeOf(env) },
      { headers: { "set-cookie": made.setCookie, "cache-control": "no-store" } },
    ),
  );
}

/** What a browser says of the passkey it made, or null for text that is no base64url of JSON. */
function clientDataOf(clientDataJSON: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(clientDataJSON)));
  } catch {
    return null;
  }
}

/** The id of a P-256 public key that may be a person's passkey, or null: for another kind of key,
 *  and for the stack's own. */
async function passkeyIdOf(env: Env, publicKey: string): Promise<string | null> {
  try {
    await crypto.subtle.importKey(
      "spki",
      fromBase64url(publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
  const key = await keyIdOf(publicKey);
  if (key === (await stackKeyOf(env)).key) return null;
  return key;
}

/** A LINK'S TICKET, SPENT BY THIS CALL: an owner's (./members.ts `memberLink`), or the recovery
 *  command's. It signs in the person it names, once, within its day. */
async function linkSpent(env: Env, request: Request): Promise<Response> {
  const body = z.object({ ticket: z.string() }).safeParse(await request.json().catch(() => null));
  const row = body.success
    ? await env.DB.prepare(
        `update member_tickets set spent_at = ?2
         where hash = ?1 and spent_at is null and expires_at > ?2
         returning email, made_by as madeBy`,
      )
        .bind(await sha256Hex(body.data.ticket), Date.now())
        .first<{ email: string; madeBy: string }>()
    : null;
  const opened = row
    ? await enrolmentCookie(
        env,
        request,
        row.email,
        row.madeBy === RECOVERY_COMMAND ? "recovery-link" : "member-link",
      )
    : { refused: "no such link, or used before, or over" };
  if ("refused" in opened) {
    console.info({ event: "auth.sign-in-link-refused", reason: opened.refused });
    // every refusal alike: which of them it was is said to the log alone
    return json({ error: "used before, or over" }, 403);
  }
  return opened.facts.on(json({}, 200, new Headers({ "set-cookie": opened.setCookie })));
}

function linkPage(env: Env, next: string | null) {
  const mind = configOf(env).controlPlaneHostname;
  const signIn = `/sign-in?${new URLSearchParams({ next: next || homeOf(env) })}`;
  return page({
    title: `Add your passkey to ${mind}`,
    body: `<h1>Add your passkey to ${text(mind)}</h1>
      <p id="status" class="muted" role="status">Signing you in…</p>
      <div id="over" hidden>
        <p>This link was used before, or its 24 hours are over.</p>
        <p>Ask whoever gave you the link for a new one. With a passkey for ${text(mind)}, <a href="${text(signIn)}">sign in</a>.</p>
      </div>`,
    script: LINK_SCRIPT,
  });
}

// The ticket is in the fragment, which no server and no log sees. It leaves the address bar once
// the Worker answered, so a reload after a failed connection sends it again. Spent, the page
// loads again, as the form.
const LINK_SCRIPT = `
const ticket = location.hash.slice(1);
const status = document.getElementById("status");
const answered = (ok) => {
  history.replaceState(null, "", location.pathname + location.search);
  if (ok) return location.reload();
  status.hidden = true;
  document.getElementById("over").hidden = false;
};
if (!ticket) answered(false);
else fetch("${LINK_PATH}", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ticket }),
}).then(
  (answer) => answered(answer.ok),
  () => { statusRefused(status, "This site could not be reached. Reload the page to try again."); },
);`;

function json(body: unknown, status = 200, headers = new Headers()) {
  headers.set("cache-control", "no-store");
  return Response.json(body, { status, headers });
}
