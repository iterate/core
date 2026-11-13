import { mindApiUrlOf } from "iterate/mind-api";
import type { TokenIdentity } from "iterate/workers";
import { z } from "zod";
import { base64url } from "iterate/signed";
import { AccountFacts } from "./account-facts.ts";
import {
  atMindsDomain,
  emailAllowed,
  type EmailRule,
  FIRST_OWNER_PATH,
  FIRST_OWNER_TICKET_MS,
  isOwner,
  memberByConfig,
} from "./config.ts";
import { sha256Hex } from "./device/protocol.ts";
import { endSessions, type Session, sessionOf } from "./cookies.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { blockedOf } from "./blocked.ts";
import { clientsWithAccess, endFields, type Ends, endsOf, logoOriginsOf } from "./access-list.ts";
import { type ClientWithAccess, endAccess, endGrantsOf, sessionsByClientOf } from "./oauth.ts";
import { errorPage, notMemberPage, page, text } from "./pages.ts";
import { signInHref } from "./sign-in.ts";
import {
  MEMBER_ADDED,
  type SignedChange,
  signedChange,
  signedChangeBy,
  signerOf,
  signScript,
} from "./signed-change.ts";

/** What an owner signs to take a member's keys away, and to make a member's sign-in link. */
const MEMBER_KEYS_REMOVED = "events.iterate.com/account/member-keys-removed";
const MEMBER_LINK_MADE = "events.iterate.com/account/member-link-made";

const MEMBERS_PATH = "/members";

type Added = { email: string; addedBy: string; addedAt: number };

export async function isMember(env: Env, email: string): Promise<boolean> {
  const config = iterateConfigOf(env);
  // An address of the mind's own is no member, by a rule or by a row: `add` refuses one, and this
  // holds for a row from before it did.
  if (atMindsDomain(config.domain, email)) return false;
  return memberByConfig(config, email) || (await isAdded(env, email));
}

/** Who changes the members: a session's person, or a member's token's. */
type Actor = Pick<Session, "userId" | "email">;

/** What a session is to this stack. Only a live passkey's session acts as a "member". A mailed code
 *  and a sign-in at Google prove an address and no more, and the owner's ticket is a deploy's
 *  word: a member's session from one of them is "passkey-owed", and opens /keys alone, to add a
 *  passkey. The config's `google.signsInAlone` makes Google's session a member's too. */
export async function standingOf(
  env: Env,
  session: Session,
): Promise<"member" | "passkey-owed" | "not-member"> {
  // A sign-in at Cloudflare is never a member's, whatever its address (./cloudflare-sign-in.ts).
  if (session.method === "cloudflare" || !(await isMember(env, session.email))) return "not-member";
  if (session.method === "passkey") return "member";
  const { google } = iterateConfigOf(env).login.methods;
  return session.method === "google" && google?.signsInAlone ? "member" : "passkey-owed";
}

/** Where a "passkey-owed" session is sent from `here`, a path of this origin. */
export const passkeyOwedResponse = (here: string) =>
  new Response(null, {
    status: 303,
    headers: {
      location: `/keys?${new URLSearchParams({ next: here })}`,
      "cache-control": "no-store",
    },
  });

/** Whether the member with this address holds a passkey that is not removed. */
export async function memberHoldsPasskey(env: Env, email: string): Promise<boolean> {
  const held = await env.DB.prepare(
    `select 1 from keys where format = 'webauthn' and revoked_at is null
       and user_id = (select id from users where email = ?1) limit 1`,
  )
    .bind(email.trim().toLowerCase())
    .first();
  return Boolean(held);
}

export async function isAdded(env: Env, email: string): Promise<boolean> {
  const row = await env.DB.prepare("select 1 from members where email = ?1")
    .bind(email.trim().toLowerCase())
    .first();
  return Boolean(row);
}

// Authority stays here, never in the mind, whose code may be hostile: only a member's own
// credential to this Worker changes the members, and the mind's log only records it. To remove
// a member takes a member's token or session. To add one takes a member's key (./signed-change.ts).
export async function membersResponse(
  env: Env,
  request: Request,
  whoIs: (token: string, resource: string) => Promise<TokenIdentity | null>,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== MEMBERS_PATH) return null;
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const sentJson = request.headers.get("content-type")?.startsWith("application/json");
  if (request.method === "OPTIONS" || bearer || (request.method === "POST" && sentJson)) {
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    // the statement is the credential: its signer needs no token and no session
    if (request.method === "POST") return addedBySignature(env, request, cors);
    const identity = bearer ? await whoIs(bearer, mindApiUrlOf(iterateConfigOf(env).domain)) : null;
    if (!identity?.member || !identity.principal.email)
      return json({ error: "A member's token for the mind's API is needed." }, 401, cors);
    return jsonResponse(
      env,
      request,
      { userId: identity.principal.actor, email: identity.principal.email },
      cors,
    );
  }
  const session = await sessionOf(env, request);
  if (!session)
    return new Response(null, {
      status: 303,
      headers: { location: signInHref(env, MEMBERS_PATH), "cache-control": "no-store" },
    });
  const standing = await standingOf(env, session);
  if (standing === "not-member")
    return notMemberPage({ domain: iterateConfigOf(env).domain, email: session.email });
  if (standing === "passkey-owed") return passkeyOwedResponse(MEMBERS_PATH);
  const owner = isOwner(iterateConfigOf(env).login, session.email);
  if (request.method === "GET") return membersPage(env, { owner });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  // the session's cookie changes the members, so the form must come from this origin's own page
  if (request.headers.get("origin") !== issuerOf(env))
    return errorPage("Send this from its own page.", 403);
  const form = await request.formData().catch(() => null);
  const email = String(form?.get("email") || "");
  const action = form?.get("action");
  if (action === "remove-keys" || action === "link") {
    const [type, act] =
      action === "link"
        ? ([MEMBER_LINK_MADE, memberLink] as const)
        : ([MEMBER_KEYS_REMOVED, removeKeys] as const);
    const press = owner
      ? await ownerPress(env, session, form?.get("signed"), type, email)
      : { error: "Only an owner, a member the stack's config names, does this." };
    const outcome = "error" in press ? press : await act(env, session, email, press);
    if ("error" in outcome) return membersPage(env, { owner, error: outcome.error });
    return outcome.facts.on(await membersPage(env, { owner, notice: outcome.notice }));
  }
  if (action === "block" || action === "unblock") {
    const outcome = owner
      ? await (action === "block" ? block(env, session, email) : unblock(env, session, email))
      : { error: "Only an owner, a member the stack's config names, blocks a person." };
    if ("error" in outcome) return membersPage(env, { owner, error: outcome.error });
    return outcome.facts.on(await membersPage(env, { owner, notice: outcome.notice }));
  }
  if (action === "end-access") {
    const outcome = owner
      ? await endAccessOf(env, email, endsOf(form))
      : {
          error: "Only an owner, a member the stack's config names, ends another member's access.",
        };
    if ("error" in outcome) return membersPage(env, { owner, error: outcome.error });
    return outcome.facts.on(
      new Response(null, {
        status: 303,
        headers: { location: `${MEMBERS_PATH}#access`, "cache-control": "no-store" },
      }),
    );
  }
  if (action !== "remove")
    return membersPage(env, {
      owner,
      error: "To add a member, use the button on this page: your passkey signs it.",
    });
  const outcome = await remove(env, session, email);
  if ("error" in outcome) return membersPage(env, { owner, error: outcome.error });
  return outcome.facts.on(
    new Response(null, {
      status: 303,
      headers: { location: MEMBERS_PATH, "cache-control": "no-store" },
    }),
  );
}

async function jsonResponse(env: Env, request: Request, actor: Actor, cors: Headers) {
  if (request.method === "GET") return json(await membersOf(env), 200, cors);
  if (request.method !== "DELETE") return json({ error: "GET, POST or DELETE" }, 405, cors);
  const body = z.object({ email: z.string() }).safeParse(await request.json().catch(() => null));
  if (!body.success) return json({ error: 'Send { "email": "…" }.' }, 400, cors);
  const outcome = await remove(env, actor, body.data.email);
  if ("error" in outcome) return json({ error: outcome.error }, outcome.status, cors);
  return outcome.facts.on(json(await membersOf(env), 200, cors));
}

async function addedBySignature(env: Env, request: Request, cors: Headers) {
  const change = await signedChange(env, await request.json().catch(() => null), MEMBER_ADDED);
  if ("refused" in change)
    return json(
      {
        error: `No member was added: ${change.refused}. Send { statement, signature }: a statement of ${MEMBER_ADDED} at / with the payload { "email": "…" }, signed by a member's key. A token or a session adds no one.`,
      },
      403,
      cors,
    );
  const outcome = await add(env, change);
  if ("error" in outcome) return json({ error: outcome.error }, outcome.status, cors);
  return outcome.facts.on(json(await membersOf(env), 200, cors));
}

async function membersOf(env: Env): Promise<{ config: EmailRule[]; added: Added[] }> {
  const { results } = await env.DB.prepare(
    "select email, added_by as addedBy, added_at as addedAt from members order by added_at",
  ).all<Added>();
  return { config: iterateConfigOf(env).login.allow, added: results };
}

type Outcome = { facts: AccountFacts } | { error: string; status: number };

async function add(env: Env, change: SignedChange): Promise<Outcome> {
  const { principal } = change.signer;
  const email = String(change.payload.email ?? "")
    .trim()
    .toLowerCase();
  if (!z.email().safeParse(email).success) return { error: "Enter an email address.", status: 400 };
  const { domain, login } = iterateConfigOf(env);
  if (atMindsDomain(domain, email))
    return {
      error: `An address at ${domain} cannot be a member: the mind receives its mail, so the mind could sign in as that member.`,
      status: 400,
    };
  if (emailAllowed(login.allow, email))
    return { error: `${email} is a member already, through the stack's config.`, status: 400 };
  const added = await env.DB.prepare(
    "insert into members (email, added_by, added_at) values (?1, ?2, ?3) on conflict (email) do nothing returning email",
  )
    .bind(email, principal.email, Date.now())
    .first();
  const facts = new AccountFacts();
  if (added)
    facts.add(principal.actor, { type: MEMBER_ADDED, payload: { email, ...signerOf(change) } });
  return { facts };
}

/** An owner ends an app's or a device's access of a member: one sign-in, or all that one client
 *  holds as that member. It takes the owner's session alone, as the removal of a member does: it
 *  lets fewer act, and removes no key. The member can let the app in again. */
async function endAccessOf(env: Env, typed: string, ends: Ends | null): Promise<Outcome> {
  const person = await env.DB.prepare("select id from users where email = ?1")
    .bind(typed.trim().toLowerCase())
    .first<{ id: string }>();
  const facts = new AccountFacts();
  if (!person || !ends || !(await endAccess(env, person.id, ends, facts)))
    return { error: "That access is not there any more.", status: 404 };
  console.info({ event: "auth.member-access-ended", of: person.id });
  return { facts };
}

/** Each member's apps and devices with access, for an owner. A browser's own sign-in on one of
 *  the mind's pages is left out: it ends by itself within a day. */
async function accessOfMembers(
  env: Env,
): Promise<{ email: string; clients: ClientWithAccess[] }[]> {
  const { results } = await env.DB.prepare("select id, email from users order by email").all<{
    id: string;
    email: string;
  }>();
  const members: { email: string; clients: ClientWithAccess[] }[] = [];
  for (const person of results) {
    if (!(await isMember(env, person.email))) continue;
    const clients = (await sessionsByClientOf(env, person.id)).filter((client) => !client.host);
    if (clients.length) members.push({ email: person.email, clients });
  }
  return members;
}

async function remove(env: Env, actor: Actor, typed: string): Promise<Outcome> {
  const email = typed.trim().toLowerCase();
  const removed = await env.DB.prepare("delete from members where email = ?1 returning email")
    .bind(email)
    .first();
  if (!removed)
    return {
      error: emailAllowed(iterateConfigOf(env).login.allow, email)
        ? `${email} is a member through the stack's config, which only a deploy changes.`
        : `${email} is not an added member.`,
      status: 404,
    };
  const facts = new AccountFacts();
  const person = await env.DB.prepare("select id from users where email = ?1")
    .bind(email)
    .first<{ id: string }>();
  // What the member was given ends now, as for a blocked person: an app's sign-in, the CLI's, a
  // hostname's own, the browsers' sessions here. The keys stay, since a session removes no key
  // (./signed-change.ts): the members row is what ends them (./keys.ts `personKeyRefusal`).
  if (person) await endAllOf(env, person.id, facts);
  facts.add(actor.userId, {
    type: "events.iterate.com/account/member-removed",
    payload: { email },
  });
  return { facts };
}

// A lost passkey's way back in. A mailed code signs in a member who holds no passkey, so this is
// an owner's alone, and never for an owner's keys: an owner's way back in is a deploy's ticket.
/** AN OWNER'S ACT ON ANOTHER MEMBER'S WAY IN TAKES THE OWNER'S PASSKEY. A link for a member lets a
 *  new key act as that member, and with the member's keys removed a mailed code does the same. So
 *  each is a statement of `type` that names the member, signed by a passkey of the owner whose
 *  session posts it. A session alone, which can be stolen, does neither. */
async function ownerPress(
  env: Env,
  actor: Actor,
  signed: unknown,
  type: string,
  typed: string,
): Promise<SignedChange | { error: string }> {
  const change = await signedChangeBy(env, signed, type, actor.email);
  if ("refused" in change)
    return {
      error: `Nothing was changed: ${change.refused}. This takes a press of your passkey.`,
    };
  if (change.payload.email !== typed.trim().toLowerCase())
    return { error: "Nothing was changed: the signed statement names another member." };
  return change;
}

async function removeKeys(
  env: Env,
  actor: Actor,
  typed: string,
  press: SignedChange,
): Promise<{ facts: AccountFacts; notice: string } | { error: string }> {
  const email = typed.trim().toLowerCase();
  if (isOwner(iterateConfigOf(env).login, email))
    return {
      error: `${email} is an owner. An owner removes their own keys, or gets in again with a deploy.`,
    };
  const at = Date.now();
  const { results } = await env.DB.prepare(
    `update keys set revoked_at = ?1
     where revoked_at is null and user_id = (select id from users where email = ?2)
     returning id, label, user_id as userId`,
  )
    .bind(at, email)
    .all<{ id: string; label: string; userId: string }>();
  if (!results.length) return { error: `${email} has no keys here.` };
  const facts = new AccountFacts();
  // what the lost device was given outlives its passkey: the apps, the CLI, a hostname's cookie,
  // a browser's session opened by a mailed code
  await endAllOf(env, results[0]!.userId, facts);
  for (const key of results)
    facts.add(key.userId, {
      type: "events.iterate.com/account/key-removed",
      payload: { key: key.id, label: key.label, at, removedBy: actor.userId, ...signerOf(press) },
      idempotencyKey: `account/key-removed:${key.id}:${at}`,
    });
  console.info({ event: "auth.member-keys-removed", by: actor.userId, keys: results.length });
  return {
    facts,
    notice: `${email} has no keys now, and is signed out of every app and device. A code by email signs this member in once, to add a new passkey.`,
  };
}

// A member's way to a first passkey where no code can be mailed, and a way back in for a member
// who lost every passkey: the page the first owner's ticket opens (./first-owner.ts), for one use
// within a day. The link is shown once, to the owner, who passes it on; the stack keeps its hash.
// Never for an owner: an owner's way in is a deploy's ticket.
async function memberLink(
  env: Env,
  actor: Actor,
  typed: string,
  press: SignedChange,
): Promise<{ facts: AccountFacts; notice: string } | { error: string }> {
  const email = typed.trim().toLowerCase();
  if (isOwner(iterateConfigOf(env).login, email))
    return { error: `${email} is an owner. An owner gets in with a deploy's link.` };
  if (!(await isMember(env, email)))
    return { error: `${email} is not a member. Add the member first.` };
  // The link is for a member with no passkey. Beside a passkey that the member holds, it would
  // add a second key that the member does not know of.
  if (await memberHoldsPasskey(env, email))
    return {
      error: `${email} has a passkey here. If it is lost, remove this member's keys first: then the link lets them add a new one.`,
    };
  const ticket = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expires = Date.now() + FIRST_OWNER_TICKET_MS;
  await env.DB.prepare(
    "insert into member_tickets (hash, email, made_by, expires_at) values (?1, ?2, ?3, ?4)",
  )
    .bind(await sha256Hex(ticket), email, actor.email, expires)
    .run();
  const facts = new AccountFacts();
  facts.add(actor.userId, {
    type: MEMBER_LINK_MADE,
    payload: { email, expires, ...signerOf(press) },
  });
  console.info({ event: "auth.member-link-made", by: actor.userId });
  return {
    facts,
    notice: `Give this link to ${email}, and to nobody else. It works once, within 24 hours, and is not shown again: ${issuerOf(env)}${FIRST_OWNER_PATH}#${ticket}`,
  };
}

// For a person who is no member: an app's end user, on a stack whose sign-in is open to anyone. A
// member is removed, not blocked, since a member's standing comes from the members' list.
async function block(
  env: Env,
  actor: Actor,
  typed: string,
): Promise<{ facts: AccountFacts; notice: string } | { error: string }> {
  const email = typed.trim().toLowerCase();
  if (!email.includes("@")) return { error: "Type the address to block." };
  if (await isMember(env, email))
    return { error: `${email} is a member. Remove the member first; a member is never blocked.` };
  await env.DB.prepare(
    "insert into blocked (email, blocked_by, blocked_at) values (?1, ?2, ?3) on conflict do nothing",
  )
    .bind(email, actor.email, Date.now())
    .run();
  const facts = new AccountFacts();
  const person = await env.DB.prepare("select id from users where email = ?1")
    .bind(email)
    .first<{ id: string }>();
  // what they hold ends now: an app's session on a hostname, an agent's token, a browser's session
  if (person) await endAllOf(env, person.id, facts);
  facts.add(actor.userId, {
    type: "events.iterate.com/account/person-blocked",
    payload: { email },
  });
  console.info({ event: "auth.person-blocked", by: actor.userId, known: Boolean(person) });
  return {
    facts,
    notice: `${email} is blocked: no sign-in code goes to it, and it is signed out of every app.`,
  };
}

async function unblock(
  env: Env,
  actor: Actor,
  typed: string,
): Promise<{ facts: AccountFacts; notice: string } | { error: string }> {
  const email = typed.trim().toLowerCase();
  const removed = await env.DB.prepare("delete from blocked where email = ?1 returning email")
    .bind(email)
    .first();
  if (!removed) return { error: `${email} is not blocked.` };
  const facts = new AccountFacts();
  facts.add(actor.userId, {
    type: "events.iterate.com/account/person-unblocked",
    payload: { email },
  });
  return { facts, notice: `${email} is no longer blocked.` };
}

function ruleInWords(rule: EmailRule) {
  if ("everyone" in rule) return "Everyone who signs in";
  if ("emailDomain" in rule) return `Anyone at ${rule.emailDomain}`;
  return rule.subaddresses ? `${rule.email}, and its +tags` : rule.email;
}

/** A rule that admits addresses nobody named: each is a member with no passkey until it adds one. */
const isWide = (rule: EmailRule) => !("email" in rule) || rule.subaddresses === true;

async function membersPage(
  env: Env,
  { owner, error, notice }: { owner: boolean; error?: string; notice?: string },
) {
  const { domain } = iterateConfigOf(env);
  const { config, added } = await membersOf(env);
  const fromConfig = config
    .map(
      (rule) =>
        `<li>${text(ruleInWords(rule))} <span class="muted">(the stack's config${isWide(rule) ? ", wide" : ""})</span></li>`,
    )
    .join("");
  const wide = config.some(isWide)
    ? `<p><strong>A wide rule admits addresses nobody named.</strong> Whoever reads the mail of one of them that has no passkey yet signs in by a code, adds a passkey, and can then approve requests and add members. A stack that approves things names each member by the exact address.</p>`
    : "";
  const addedRows = added
    .map(
      (row) => `<li>${text(row.email)} <span class="muted">(added by ${text(row.addedBy)})</span>
        <form method="post" action="${MEMBERS_PATH}">
          <input type="hidden" name="action" value="remove">
          <input type="hidden" name="email" value="${text(row.email)}">
          <button type="submit" class="link">Remove</button>
        </form></li>`,
    )
    .join("");
  const access = owner ? await accessOfMembers(env) : [];
  const accessRows = access
    .map(({ email, clients }) =>
      clientsWithAccess(
        env,
        clients,
        (ends, button) => `<form method="post" action="${MEMBERS_PATH}" class="inline">
          <input type="hidden" name="action" value="end-access">
          <input type="hidden" name="email" value="${text(email)}">
          ${endFields(ends)}
          <button type="submit" class="link">${button}</button>
        </form>`,
        email,
      ),
    )
    .join("");
  const blockedRows = owner
    ? (await blockedOf(env))
        .map(
          (
            row,
          ) => `<li>${text(row.email)} <span class="muted">(blocked by ${text(row.blockedBy)})</span>
        <form method="post" action="${MEMBERS_PATH}">
          <input type="hidden" name="action" value="unblock">
          <input type="hidden" name="email" value="${text(row.email)}">
          <button type="submit" class="link">Unblock</button>
        </form></li>`,
        )
        .join("")
    : "";
  return page({
    title: `Members of ${domain}`,
    wide: true,
    status: error ? 400 : 200,
    body: `<h1>Members of ${text(domain)}</h1>
      <p>A member may use the mind's API, its MCP server and its apps, and add or remove other members.</p>
      ${error || notice ? `<p><strong>${text(error || notice || "")}</strong></p>` : ""}
      <ul>${fromConfig}${addedRows}</ul>
      ${wide}
      <form id="add" class="stack">
        <label>Email <input type="email" name="email" autocomplete="off" required></label>
        <button type="submit">Add a member</button>
        <p id="status" class="muted" role="status"></p>
      </form>
      <p class="muted">Your passkey signs the add: a session or a token alone adds no one. A new member signs in once with a code by email, and adds a passkey. After that, only the passkey signs the member in.</p>
      ${
        owner
          ? `<h2 id="access">Apps and devices with access</h2>
      <p>Each app, CLI, device or agent that a member let in, and what it reaches as that member. Revoke one, and it and every token it holds stop working at once. The member can let it in again. A member sees and revokes their own on the keys page.</p>
      ${accessRows ? `<ul class="access-list">${accessRows}</ul>` : `<p class="muted">No app or device has access.</p>`}
      <h2>A member lost a passkey</h2>
      <p>Remove the member's keys. This signs the member out of every app and device. A code by email then signs the member in once, to add a new passkey.</p>
      <form method="post" action="${MEMBERS_PATH}" class="stack" data-signed="${MEMBER_KEYS_REMOVED}">
        <input type="hidden" name="action" value="remove-keys">
        <input type="hidden" name="signed">
        <label>The member's email <input type="email" name="email" autocomplete="off" required></label>
        <button type="submit">Remove this member's keys</button>
        <p class="muted" role="status" data-status>Your passkey signs this.</p>
      </form>
      <h2>A sign-in link for a member</h2>
      <p>For a member who has no passkey here and cannot get a code by email. The link signs the member in once, to add a passkey. Whoever holds the link is that member, so pass it on yourself.</p>
      <form method="post" action="${MEMBERS_PATH}" class="stack" data-signed="${MEMBER_LINK_MADE}">
        <input type="hidden" name="action" value="link">
        <input type="hidden" name="signed">
        <label>The member's email <input type="email" name="email" autocomplete="off" required></label>
        <button type="submit">Make a sign-in link</button>
        <p class="muted" role="status" data-status>Your passkey signs this.</p>
      </form>
      <h2>Block a person who is not a member</h2>
      <p>For a stack whose sign-in is open to anyone, so that its apps have users of their own. A blocked address gets no sign-in code, and is signed out of every app at once.</p>
      <ul>${blockedRows}</ul>
      <form method="post" action="${MEMBERS_PATH}" class="stack">
        <input type="hidden" name="action" value="block">
        <label>The person's email <input type="email" name="email" autocomplete="off" required></label>
        <button type="submit">Block this person</button>
      </form>`
          : ""
      }`,
    script: `${signScript(domain)}${ADD_SCRIPT}`,
    imageOrigin: logoOriginsOf(access.flatMap(({ clients }) => clients)),
  });
}

const ADD_SCRIPT = `
const form = document.getElementById("add");
const status = document.getElementById("status");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Waiting for your passkey…";
  try {
    const signed = await signedStatement({ type: "${MEMBER_ADDED}", payload: { email: form.email.value.trim().toLowerCase() } });
    const answer = await fetch("${MEMBERS_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
    if (!answer.ok) throw new Error((await answer.json()).error);
    location.reload();
  } catch (error) {
    status.textContent = error.name === "NotAllowedError" ? "No passkey was used, so no member was added." : error.message || "The member was not added.";
  }
});
// An owner's act on a member's way in: the owner's passkey signs the act and the member it names.
for (const act of document.querySelectorAll("form[data-signed]"))
  act.addEventListener("submit", async (event) => {
    if (act.signed.value) return;
    event.preventDefault();
    const said = act.querySelector("[data-status]");
    try {
      said.textContent = "Waiting for your passkey…";
      act.signed.value = JSON.stringify(await signedStatement({ type: act.dataset.signed, payload: { email: act.email.value.trim().toLowerCase() } }));
      act.submit();
    } catch (error) {
      said.textContent = error.name === "NotAllowedError" ? "No passkey was used, so nothing was changed." : error.message || "Nothing was changed.";
    }
  });`;

// The bearer is the credential here, never a cookie.
function corsHeaders(env: Env, request: Request) {
  const headers = new Headers({ vary: "Origin" });
  const origin = request.headers.get("origin");
  if (origin && (iterateConfigOf(env).trustedClients || []).includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "GET, POST, DELETE");
    headers.set("access-control-allow-headers", "authorization, content-type");
    headers.set("access-control-max-age", "600");
  }
  return headers;
}

function json(value: unknown, status: number, cors: Headers) {
  const headers = new Headers(cors);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(value), { status, headers });
}

/** EVERYTHING A PERSON HOLDS HERE ENDS: every grant (./oauth.ts `endGrantsOf`) and every
 *  browser's session at the issuer (./cookies.ts `endSessions`). */
async function endAllOf(env: Env, userId: string, facts: AccountFacts) {
  await endGrantsOf(env, userId, facts);
  await endSessions(env, userId, "all", facts);
}
