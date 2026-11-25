import { mindApiUrlOf } from "iterate/mind-api";
import type { TokenIdentity } from "iterate/workers";
import { z } from "zod";
import { base64url } from "iterate/signed";
import { AccountFacts } from "./account-facts.ts";
import { atMindsZone, isOwner, isOwnerByPattern } from "./config.ts";
import { sha256Hex } from "./device/protocol.ts";
import {
  endSessions,
  GUEST_KEY_PREFIX,
  type PersonSession,
  type Session,
  sessionOf,
} from "./cookies.ts";
import { ENROLMENT_MS, FIRST_PASSKEY_PATH } from "./enrolment.ts";
import { configOf, type Env, issuerOf } from "./env.ts";
import { blockedOf, isBlocked } from "./blocked.ts";
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

/** WHO IS A MEMBER: an owner, whom the config names by address, whoever an owner or a member
 *  added on `/members`, whose row is in D1, and an owner by an owner email pattern whom no owner
 *  blocked. A BLOCK ENDS ONE PERSON OF A PATTERN (`block`): the config cannot name them, so the
 *  `blocked` row does, and every reader of this function then answers them as no member: a
 *  passkey's sign-in, a session, a grant, a key, the first passkey's proofs and the recovery
 *  command's link. An owner by address and an added member are never blocked. */
export async function isMember(env: Env, email: string): Promise<boolean> {
  if (await isMemberByName(env, email)) return true;
  // a key that is no address is nobody's, and an address at a zone of the mind is no member
  if (!email.includes("@")) return false;
  const config = configOf(env);
  if (atMindsZone(config, email) || !isOwnerByPattern(config, email)) return false;
  return !(await isBlocked(env, email));
}

/** A MEMBER WHOM SOMETHING NAMES BY ADDRESS: an owner in `ownerEmails`, or a row of `/members`.
 *  Never one by a pattern. What predates the patterns asks this (./oauth.ts `grantIsMembers`). */
export async function isMemberByName(env: Env, email: string): Promise<boolean> {
  // a key that is no address (a guest's row, ./cookies.ts `GUEST_KEY_PREFIX`) is nobody's
  if (!email.includes("@")) return false;
  const config = configOf(env);
  // An address at a zone of the mind is no member: `add` refuses one, and a deploy that gives the
  // mind another zone ends the members whose address is there.
  if (atMindsZone(config, email)) return false;
  return config.ownerEmails.includes(email.trim().toLowerCase()) || (await isAdded(env, email));
}

/** WHETHER A SESSION ACTS AS A MEMBER: a passkey opened it, and its address is a member's now. A
 *  session that a mailed code opened for a person who was no member is never a member's, whatever
 *  its address becomes: mail must not open the mind. */
export const isMemberSession = async (env: Env, session: Pick<PersonSession, "method" | "email">) =>
  session.method === "passkey" && (await isMember(env, session.email));

/** Who changes the members: a session's person, or a member's token's. */
type Actor = Pick<Session, "userId" | "email">;

/** Whether the member with this address holds a passkey that is not removed. */
async function memberHoldsPasskey(env: Env, email: string): Promise<boolean> {
  const held = await env.DB.prepare(
    `select 1 from keys where format = 'webauthn' and revoked_at is null and outsider = 0
       and user_id = (select id from users where email = ?1) limit 1`,
  )
    .bind(email.trim().toLowerCase())
    .first();
  return Boolean(held);
}

async function isAdded(env: Env, email: string): Promise<boolean> {
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
  if (bearer || (request.method === "POST" && sentJson)) {
    // the statement is the credential: its signer needs no token and no session
    if (request.method === "POST") return addedBySignature(env, request);
    const identity = bearer
      ? await whoIs(bearer, mindApiUrlOf(configOf(env).controlPlaneHostname))
      : null;
    if (!identity?.member || !identity.principal.email)
      return json({ error: "A member's token for the mind's API is needed." }, 401);
    return jsonResponse(env, request, {
      userId: identity.principal.actor,
      email: identity.principal.email,
    });
  }
  const session = await sessionOf(env, request);
  if (!session)
    return new Response(null, {
      status: 303,
      headers: { location: signInHref(MEMBERS_PATH), "cache-control": "no-store" },
    });
  if (!(await isMember(env, session.email)))
    return notMemberPage({ mind: configOf(env).controlPlaneHostname, email: session.email });
  const owner = isOwner(configOf(env), session.email);
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
      : { error: "Only an owner does this." };
    const outcome = "error" in press ? press : await act(env, session, email, press);
    if ("error" in outcome) return membersPage(env, { owner, error: outcome.error });
    return outcome.facts.on(await membersPage(env, { owner, notice: outcome.notice }));
  }
  if (action === "block" || action === "unblock") {
    const outcome = owner
      ? await (action === "block" ? block(env, session, email) : unblock(env, session, email))
      : { error: "Only an owner blocks a person." };
    if ("error" in outcome) return membersPage(env, { owner, error: outcome.error });
    return outcome.facts.on(await membersPage(env, { owner, notice: outcome.notice }));
  }
  if (action === "end-access") {
    const outcome = owner
      ? await endAccessOf(env, email, endsOf(form))
      : { error: "Only an owner ends another member's access." };
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

async function jsonResponse(env: Env, request: Request, actor: Actor) {
  if (request.method === "GET") return json(await membersOf(env), 200);
  if (request.method !== "DELETE") return json({ error: "GET, POST or DELETE" }, 405);
  const body = z.object({ email: z.string() }).safeParse(await request.json().catch(() => null));
  if (!body.success) return json({ error: 'Send { "email": "…" }.' }, 400);
  const outcome = await remove(env, actor, body.data.email);
  if ("error" in outcome) return json({ error: outcome.error }, outcome.status);
  return outcome.facts.on(json(await membersOf(env), 200));
}

async function addedBySignature(env: Env, request: Request) {
  const change = await signedChange(env, await request.json().catch(() => null), MEMBER_ADDED);
  if ("refused" in change)
    return json(
      {
        error: `No member was added: ${change.refused}. Send { statement, signature }: a statement of ${MEMBER_ADDED} at / with the payload { "email": "…" }, signed by a member's key. A token or a session adds no one.`,
      },
      403,
    );
  const outcome = await add(env, change);
  if ("error" in outcome) return json({ error: outcome.error }, outcome.status);
  return outcome.facts.on(json(await membersOf(env), 200));
}

/** The members: the owners, whom the config names by address or by pattern, and those added
 *  here. `ownerPatterns` names no person: who signed in by one is not listed. */
async function membersOf(
  env: Env,
): Promise<{ owners: string[]; ownerPatterns: string[]; added: Added[] }> {
  const { results } = await env.DB.prepare(
    "select email, added_by as addedBy, added_at as addedAt from members order by added_at",
  ).all<Added>();
  const config = configOf(env);
  return {
    owners: config.ownerEmails,
    ownerPatterns: config.ownerEmailPatterns || [],
    added: results,
  };
}

type Outcome = { facts: AccountFacts } | { error: string; status: number };

async function add(env: Env, change: SignedChange): Promise<Outcome> {
  const { principal } = change.signer;
  const email = String(change.payload.email ?? "")
    .trim()
    .toLowerCase();
  if (!z.email().safeParse(email).success) return { error: "Enter an email address.", status: 400 };
  const config = configOf(env);
  if (atMindsZone(config, email))
    return {
      error: `An address at ${config.zones.join(" or ")} cannot be a member: the mind receives its mail, so the mind could sign in as that member.`,
      status: 400,
    };
  if (isOwner(config, email))
    return { error: `${email} is a member already: an owner.`, status: 400 };
  // One batch, which D1 runs as one transaction: a member is never blocked, so the address's
  // block goes as the address becomes a member's. A row left behind would refuse the member's
  // sign-in on every hostname of the mind (./oauth.ts `grantLifetime`).
  // A PASSKEY THAT THE ADDRESS HELD BEFORE IT WAS A MEMBER'S never becomes a member's
  // (../migrations/0016): whoever added it was no member then, and a key from before that column
  // reads 0 there. So the address's keys are marked as it becomes a member's, and the member gets
  // a passkey of their own by the owner's link (./enrolment.ts), which revokes them.
  const now = Date.now();
  const [added, unblocked] = await env.DB.batch([
    env.DB.prepare(
      "insert into members (email, added_by, added_at) values (?1, ?2, ?3) on conflict (email) do nothing returning email",
    ).bind(email, principal.email, now),
    env.DB.prepare("delete from blocked where email = ?1 returning email").bind(email),
    env.DB.prepare(
      `update keys set outsider = 1
       where format = 'webauthn' and revoked_at is null and outsider = 0
         and user_id = (select id from users where email = ?1)
         and exists (select 1 from members where email = ?1 and added_at = ?2)`,
    ).bind(email, now),
  ]);
  const facts = new AccountFacts();
  if (unblocked?.results[0])
    facts.add(principal.actor, {
      type: "events.iterate.com/account/person-unblocked",
      payload: { email },
    });
  if (added?.results[0])
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
  if (!person || !ends || !(await endAccess(env, person.id, "all", ends, facts)))
    return { error: "That access is not there any more.", status: 404 };
  console.info({ event: "auth.member-access-ended", of: person.id });
  return { facts };
}

/** Each member's apps and devices with access, for an owner. A browser's own sign-in on one of
 *  the mind's pages is left out: it ends by itself within a day. */
async function accessOfMembers(
  env: Env,
): Promise<{ email: string; clients: ClientWithAccess[] }[]> {
  // a row whose key is no address (a Cloudflare user, a guest) is never a member's, and guests
  // may be many: they are not read
  const { results } = await env.DB.prepare(
    "select id, email from users where email like '%@%' order by email",
  ).all<{
    id: string;
    email: string;
  }>();
  const members: { email: string; clients: ClientWithAccess[] }[] = [];
  for (const person of results) {
    if (!(await isMember(env, person.email))) continue;
    const clients = (await sessionsByClientOf(env, person.id, "all")).filter(
      (client) => !client.host,
    );
    if (clients.length) members.push({ email: person.email, clients });
  }
  return members;
}

async function remove(env: Env, actor: Actor, typed: string): Promise<Outcome> {
  const email = typed.trim().toLowerCase();
  // a removed row would leave an owner by a pattern an owner: the block is what ends them
  if (isOwnerByPattern(configOf(env), email))
    return {
      error: `${email} is an owner by an owner email pattern, so a removal would change nothing. Block this address: that ends it for this one person.`,
      status: 400,
    };
  const removed = await env.DB.prepare("delete from members where email = ?1 returning email")
    .bind(email)
    .first();
  if (!removed)
    return {
      error: isOwner(configOf(env), email)
        ? `${email} is an owner, which only a deploy changes.`
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

// A lost passkey's way back in, with the link below: an owner removes the member's keys, and
// makes the member a sign-in link. Never for an owner's keys: no owner takes another owner's keys
// away, and an owner with no passkey left comes back by the recovery command (./enrolment.ts).
/** AN OWNER'S ACT ON ANOTHER MEMBER'S WAY IN TAKES THE OWNER'S PASSKEY. A link for a member lets a
 *  new key act as that member, and the removal of a member's keys is the step before one. So
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
  if (isOwner(configOf(env), email))
    return {
      error: `${email} is an owner. Nobody but an owner removes that owner's keys. An owner who lost every passkey gets back in by the recovery command, which whoever holds this mind's Cloudflare account runs.`,
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
  // what the lost device was given outlives its passkey: the apps, the CLI, a hostname's cookie
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
    notice: `${email} has no keys now, and is signed out of every app and device. Make a sign-in link for this member below: it lets them add a new passkey. A code by email does not.`,
  };
}

// An added member's one way to a first passkey, and the way back in for a member whose keys an
// owner removed: a page (./enrolment.ts) for one use within a day. The link is shown
// once, to the owner, who passes it on; the stack keeps its hash. Never for an owner: no owner
// makes a way in as another owner, and the link's own page refuses a person who is an owner by
// the time it is opened.
async function memberLink(
  env: Env,
  actor: Actor,
  typed: string,
  press: SignedChange,
): Promise<{ facts: AccountFacts; notice: string } | { error: string }> {
  const email = typed.trim().toLowerCase();
  if (isOwner(configOf(env), email))
    return {
      error: `${email} is an owner. An owner signs in with their own passkey: the first one is added after Cloudflare proved the address, on the sign-in page, and after the loss of every passkey the recovery command is the way back.`,
    };
  if (!(await isMember(env, email)))
    return { error: `${email} is not a member. Add the member first.` };
  // The link is for a member with no passkey. Beside a passkey that the member holds, it would
  // add a second key that the member does not know of.
  if (await memberHoldsPasskey(env, email))
    return {
      error: `${email} has a passkey here. If it is lost, remove this member's keys first: then the link lets them add a new one.`,
    };
  const ticket = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expires = Date.now() + ENROLMENT_MS;
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
    notice: `Give this link to ${email}, and to nobody else. It works once, within 24 hours, and is not shown again: ${issuerOf(env)}${FIRST_PASSKEY_PATH}#${ticket}`,
  };
}

// For a person who is no member: an app's end user, who signs in with a code by email. A member
// is removed, not blocked, since a member's standing comes from the members' list.
async function block(
  env: Env,
  actor: Actor,
  typed: string,
): Promise<{ facts: AccountFacts; notice: string } | { error: string }> {
  const email = await blockKeyOf(env, typed);
  if (!email.includes("@") && !email.startsWith(GUEST_KEY_PREFIX))
    return { error: "Type the address to block, or a guest's id (user_…)." };
  // AN OWNER BY A PATTERN IS ENDED BY A BLOCK, and by nothing else that an owner can do: the
  // row below is what `isMember` reads. A row of `/members` for the address goes with it, so the
  // person is no member by it either. Anyone else who is a member is removed, not blocked.
  const byPattern = isOwnerByPattern(configOf(env), email);
  if (!byPattern && (await isMember(env, email)))
    return { error: `${email} is a member. Remove the member first; a member is never blocked.` };
  const blocking = env.DB.prepare(
    "insert into blocked (email, blocked_by, blocked_at) values (?1, ?2, ?3) on conflict do nothing",
  ).bind(email, actor.email, Date.now());
  // one batch, which D1 runs as one transaction: never blocked and still a member by a row
  await env.DB.batch(
    byPattern
      ? [blocking, env.DB.prepare("delete from members where email = ?1").bind(email)]
      : [blocking],
  );
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
    notice: byPattern
      ? `${email} is blocked: it is no owner and no member now, its passkeys sign nobody in, and it is signed out of every app and device. It stays so while the block is there, whatever the owner email patterns say.`
      : email.startsWith(GUEST_KEY_PREFIX)
        ? `The guest ${typed.trim()} is blocked, and is signed out of every app. A person who comes back as a new guest is a new guest: end the link they came by.`
        : `${email} is blocked: no sign-in code goes to it, and it is signed out of every app.`,
  };
}

/** WHAT A BLOCK OR AN UNBLOCK NAMES in the `blocked` table: the address an owner typed, or, for a
 *  guest's user id (`user_…`, as the guest's events name them), the key of that guest's row. A
 *  guest has no address, so the id is how an owner names one. Any other person's id names
 *  nothing: a person with an address is blocked by it. */
async function blockKeyOf(env: Env, typed: string): Promise<string> {
  const named = typed.trim();
  if (!/^user_[0-9a-f]{32}$/.test(named)) return named.toLowerCase();
  const person = await env.DB.prepare("select email from users where id = ?1")
    .bind(named)
    .first<{ email: string }>();
  return person?.email.startsWith(GUEST_KEY_PREFIX) ? person.email : "";
}

async function unblock(
  env: Env,
  actor: Actor,
  typed: string,
): Promise<{ facts: AccountFacts; notice: string } | { error: string }> {
  const email = (await blockKeyOf(env, typed)) || typed.trim().toLowerCase();
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

async function membersPage(
  env: Env,
  { owner, error, notice }: { owner: boolean; error?: string; notice?: string },
) {
  const mind = configOf(env).controlPlaneHostname;
  const { owners, ownerPatterns, added } = await membersOf(env);
  const ownerRows = [
    ...owners.map((email) => `<li>${text(email)} <span class="muted">(an owner)</span></li>`),
    ...ownerPatterns.map(
      (pattern) =>
        `<li>${text(pattern)} <span class="muted">(every address at this domain is an owner)</span></li>`,
    ),
  ].join("");
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
        (ends, button, label) => `<form method="post" action="${MEMBERS_PATH}">
          <input type="hidden" name="action" value="end-access">
          <input type="hidden" name="email" value="${text(email)}">
          ${endFields(ends)}
          <button type="submit" class="secondary small" aria-label="${text(label)}">${text(button)}</button>
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
    title: `Members of ${mind}`,
    wide: true,
    status: error ? 400 : 200,
    body: `<h1>Members of ${text(mind)}</h1>
      <p>A member can use everything in this mind, and add or remove members.</p>
      ${error || notice ? `<p><strong>${text(error || notice || "")}</strong></p>` : ""}
      <ul>${ownerRows}${addedRows}</ul>
      <form id="add" class="stack">
        <label>Email <input type="email" name="email" autocomplete="off" required></label>
        <button type="submit">Add a member</button>
        <p id="status" class="muted" role="status"></p>
      </form>
      <p class="muted">Adding asks for your passkey. ${
        owner
          ? `Then make the new member a <a href="#link">sign-in link</a>`
          : "Then an owner makes the new member a sign-in link on this page"
      }, to set up a passkey of their own.</p>
      ${
        owner
          ? `<h2 id="access">Apps and devices with access</h2>
      <p>What each member let in, and what it reaches. Revoke one and it stops working at once. The member can let it in again.</p>
      ${accessRows ? `<ul class="access-list">${accessRows}</ul>` : `<p class="muted">No app or device has access.</p>`}
      <h2>A member lost a passkey</h2>
      <p>Remove the member's keys, which signs them out everywhere. Then make them a sign-in link below.</p>
      <form method="post" action="${MEMBERS_PATH}" class="stack" data-signed="${MEMBER_KEYS_REMOVED}">
        <input type="hidden" name="action" value="remove-keys">
        <input type="hidden" name="signed">
        <label>The member's email <input type="email" name="email" autocomplete="off" required></label>
        <button type="submit">Remove this member's keys</button>
        <p class="muted" role="status" data-status>Your passkey signs this.</p>
      </form>
      <h2 id="link">A sign-in link for a member</h2>
      <p>For a new member, or one whose keys you removed. It works once, within 24 hours, to add a passkey. Whoever holds the link is that member, so send it yourself.</p>
      <form method="post" action="${MEMBERS_PATH}" class="stack" data-signed="${MEMBER_LINK_MADE}">
        <input type="hidden" name="action" value="link">
        <input type="hidden" name="signed">
        <label>The member's email <input type="email" name="email" autocomplete="off" required></label>
        <button type="submit">Make a sign-in link</button>
        <p class="muted" role="status" data-status>Your passkey signs this.</p>
      </form>
      <h2>Block a person</h2>
      <p>Anyone can sign in to this mind's apps with a code by email. A blocked address gets no code, and is signed out of every app at once. A person who is an owner by a pattern is ended here too: blocked, they are no member, and their passkeys sign nobody in.</p>
      <ul>${blockedRows}</ul>
      <form method="post" action="${MEMBERS_PATH}" class="stack">
        <input type="hidden" name="action" value="block">
        <label>The person's email, or a guest's id <input type="text" name="email" autocomplete="off" required></label>
        <button type="submit">Block this person</button>
      </form>`
          : ""
      }`,
    script: `${signScript(mind)}${ADD_SCRIPT}`,
    imageOrigin: logoOriginsOf(access.flatMap(({ clients }) => clients)),
  });
}

const ADD_SCRIPT = `
const form = document.getElementById("add");
const status = document.getElementById("status");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusSay(status, "Waiting for your passkey…");
  try {
    const signed = await signedStatement({ type: "${MEMBER_ADDED}", payload: { email: form.email.value.trim().toLowerCase() } });
    const answer = await fetch("${MEMBERS_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
    if (!answer.ok) throw new Error((await answer.json()).error);
    location.reload();
  } catch (error) {
    statusFailed(status, error, "The member was not added.", "No passkey was used, so no member was added.");
  }
});
// An owner's act on a member's way in: the owner's passkey signs the act and the member it names.
for (const act of document.querySelectorAll("form[data-signed]"))
  act.addEventListener("submit", async (event) => {
    if (act.signed.value) return;
    event.preventDefault();
    const said = act.querySelector("[data-status]");
    try {
      statusSay(said, "Waiting for your passkey…");
      act.signed.value = JSON.stringify(await signedStatement({ type: act.dataset.signed, payload: { email: act.email.value.trim().toLowerCase() } }));
      act.submit();
    } catch (error) {
      statusFailed(said, error, "Nothing was changed.", "No passkey was used, so nothing was changed.");
    }
  });`;

const json = (value: unknown, status: number) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

/** EVERYTHING A PERSON HOLDS HERE ENDS: every grant (./oauth.ts `endGrantsOf`) and every
 *  browser's session at the issuer (./cookies.ts `endSessions`). */
async function endAllOf(env: Env, userId: string, facts: AccountFacts) {
  await endGrantsOf(env, userId, facts);
  await endSessions(env, userId, "all", "all", facts);
}
