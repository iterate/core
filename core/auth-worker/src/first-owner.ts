import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import { FIRST_OWNER_PATH, type FirstOwnerTicket, firstOwnerTicketOf } from "./config.ts";
import { sessionCookie, sessionOf } from "./cookies.ts";
import { sha256Hex } from "./device/protocol.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { honouredNext } from "./key-rules.ts";
import { isMember } from "./members.ts";
import { page, text } from "./pages.ts";
import { linkIdentity } from "./users.ts";

export async function firstOwnerResponse(env: Env, request: Request): Promise<Response> {
  if (request.method !== "POST") return firstOwnerPage(env, new URL(request.url));
  if (request.headers.get("origin") !== issuerOf(env))
    return json({ error: "use this site's own page" }, 403);
  const body = z.object({ ticket: z.string() }).safeParse(await request.json().catch(() => null));
  const now = Date.now();
  const ticket = await spentTicket(env, body.data?.ticket, now);
  if ("refused" in ticket) {
    console.info({ event: "auth.first-owner-ticket-refused", reason: ticket.refused });
    // The wizard keeps its link: a second press in the browser the ticket signed in goes on.
    if (await sessionOf(env, request)) return json({});
    // every refusal alike: which of them it was is said to the log alone
    return json({ error: "used before, or over" }, 403);
  }
  const user = await linkIdentity(env.DB, {
    provider: "email",
    subject: ticket.email,
    email: ticket.email,
  });
  console.info({ event: "auth.signed-in", method: "first-owner-ticket", userId: user.id });
  const facts = new AccountFacts();
  facts.add(user.id, {
    type: "events.iterate.com/account/signed-in",
    payload: { method: "first-owner-ticket", at: now },
  });
  return facts.on(
    json(
      {},
      200,
      new Headers({ "set-cookie": await sessionCookie(env, user, "first-owner-ticket") }),
    ),
  );
}

async function spentTicket(
  env: Env,
  given: string | undefined,
  now: number,
): Promise<Pick<FirstOwnerTicket, "email"> | { refused: string }> {
  const hash = given ? await sha256Hex(given) : "";
  const members = hash ? await spentMemberTicket(env, hash, now) : null;
  if (members) return members;
  if (!env.FIRST_OWNER_TICKET) return { refused: "no ticket is bound" };
  const ticket = firstOwnerTicketOf(env.FIRST_OWNER_TICKET, iterateConfigOf(env), now);
  if ("refused" in ticket) return ticket;
  if (ticket.expires <= now) return { refused: "its 24 hours are over" };
  if (hash !== ticket.hash) return { refused: "not the ticket" };
  // The ticket is a deploy's word, and whoever deploys this Worker owns the stack: so it counts on a
  // stack with users and keys too, as an owner's way back in. One statement: of two posts, one wins.
  const spent = await env.DB.prepare(
    "insert into spent_tickets (hash, spent_at) values (?1, ?2) on conflict do nothing returning hash",
  )
    .bind(ticket.hash, now)
    .first();
  return spent ? ticket : { refused: "used before" };
}

/** A link an owner made for a member (./members.ts `memberLink`), spent by this call: null when
 *  `hash` is no such link's. It signs in someone who is still a member, once, within its day. */
async function spentMemberTicket(
  env: Env,
  hash: string,
  now: number,
): Promise<{ email: string } | { refused: string } | null> {
  const row = await env.DB.prepare(
    `update member_tickets set spent_at = ?2
     where hash = ?1 and spent_at is null and expires_at > ?2
     returning email`,
  )
    .bind(hash, now)
    .first<{ email: string }>();
  if (row) return (await isMember(env, row.email)) ? row : { refused: "no longer a member" };
  const known = await env.DB.prepare("select 1 from member_tickets where hash = ?1")
    .bind(hash)
    .first();
  return known ? { refused: "a member's link, used before or over" } : null;
}

function firstOwnerPage(env: Env, url: URL) {
  const { domain, trustedClients } = iterateConfigOf(env);
  const next = honouredNext(url.searchParams.get("next"), issuerOf(env), trustedClients);
  const keys = next ? `/keys?${new URLSearchParams({ next })}` : "/keys";
  const signIn = `/sign-in?${new URLSearchParams({ next: keys })}`;
  const mailsCodes = Boolean(iterateConfigOf(env).login.methods.email);
  const recovery = env.CLOUD_ORIGIN
    ? `<a href="${text(env.CLOUD_ORIGIN)}">Run the recovery in the iterate wizard</a>`
    : "Run the recovery in the iterate wizard";
  return page({
    title: `Add your passkey to ${domain}`,
    body: `<h1>Add your passkey to ${text(domain)}</h1>
      <p id="status" class="muted" role="status">Signing you in…</p>
      <div id="over" hidden>
        <p>This link was used before, or its 24 hours are over.</p>
        ${
          mailsCodes
            ? `<p>No passkey yet? <a href="${text(signIn)}">Sign in with a code we email you</a>, then add your passkey.</p>
        <p>Added one already? <a href="${text(signIn)}">Sign in with your passkey</a>.</p>`
            : `<p><a href="${text(signIn)}">Sign in</a>.</p>`
        }
        <p>Lost your passkey? ${recovery}.</p>
        <a id="keys" href="${text(keys)}" hidden></a>
      </div>`,
    script: SCRIPT,
  });
}

// The ticket is in the fragment, which no server and no log sees. It leaves the address bar once
// the Worker answered, so a reload after a failed connection sends it again.
const SCRIPT = `
const ticket = location.hash.slice(1);
const status = document.getElementById("status");
const answered = (ok) => {
  history.replaceState(null, "", location.pathname + location.search);
  if (ok) return location.replace(document.getElementById("keys").href);
  status.hidden = true;
  document.getElementById("over").hidden = false;
};
if (!ticket) answered(false);
else fetch("${FIRST_OWNER_PATH}", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ticket }),
}).then(
  (answer) => answered(answer.ok),
  () => { status.textContent = "This site could not be reached. Reload the page to try again."; },
);`;

function json(body: unknown, status = 200, headers = new Headers()) {
  headers.set("cache-control", "no-store");
  return Response.json(body, { status, headers });
}
