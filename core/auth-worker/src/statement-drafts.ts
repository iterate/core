// statement-drafts.ts — A STATEMENT THAT AN AGENT ASKS A PERSON TO SIGN. The agent proposes it
// (`AuthService.proposeStatement`) and gets a link that carries only a random id. The page at the
// link needs no sign-in: it shows the exact statement, and a passkey press signs it. The signed
// statement goes through the intake of `POST /statements`, so it lands as an event with the person
// as its signer, or is refused as there.
import { codedError } from "iterate/lib";
import { withFacts } from "iterate/facts";
import { base64url, PLATFORM_NAMESPACES, statementHashOf, statementOf } from "iterate/signed";
import type { AuthService } from "iterate/workers";
import { z } from "zod";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { canonicalPath, honouredNext } from "./key-rules.ts";
import { KEYS_PATH } from "./keys-pages.ts";
import { page, text } from "./pages.ts";
import { SIGN_HELPERS } from "./signed-change.ts";
import { admittedStatement, MOST_PAYLOAD_BYTES } from "./statements.ts";

const SIGN_STATEMENT_PATH = "/statements/sign";

const LIFETIME_MS = 24 * 3600 * 1000;
const MOST_OPEN = 100;

type Draft = {
  id: string;
  path: string;
  type: string;
  payload: string;
  asked_from: string | null;
  signer_email: string | null;
  next: string | null;
};

// What an agent proposes comes over RPC from the mind, which may be hostile.
const Proposal = z.object({
  path: z
    .string()
    .refine(canonicalPath, "name the context by its own path: no empty, . or .. segment"),
  type: z
    .string()
    .min(1, "a statement needs a type")
    .refine(
      (type) => !PLATFORM_NAMESPACES.some((name) => type.startsWith(`events.iterate.com/${name}/`)),
      "the type is the platform's own",
    ),
  payload: z
    .record(z.string(), z.unknown(), "a payload is a plain object")
    .default({})
    .refine(
      (payload) => new TextEncoder().encode(JSON.stringify(payload)).length <= MOST_PAYLOAD_BYTES,
      "a payload is at most 64 KiB of JSON",
    ),
  from: z.string().optional(),
  signerEmail: z.string().trim().toLowerCase().min(1).optional(),
  next: z.string().optional(),
});

export async function proposeStatement(
  env: Env,
  input: Parameters<AuthService["proposeStatement"]>[0],
): ReturnType<AuthService["proposeStatement"]> {
  const proposal = Proposal.safeParse(input);
  if (!proposal.success) throw codedError("INVALID_INPUT", proposal.error.issues[0]!.message);
  const { type, payload, from, signerEmail, next } = proposal.data;
  // the named person's own context, in any letter case, is the one path the intake takes for them
  const own = signerEmail && `/people/${signerEmail}`;
  const path = own && proposal.data.path.toLowerCase() === own ? own : proposal.data.path;
  const issuer = issuerOf(env);
  // the rule of /keys/enrol's own `next` (./key-rules.ts `honouredNext`), as a whole https URL
  if (next && (!/^https:\/\//.test(next) || !honouredNext(next, issuer)))
    throw codedError("INVALID_INPUT", "`next` is an https URL on a host of this mind");
  const payloadText = JSON.stringify(payload);
  const id = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const now = Date.now();
  const expires = now + LIFETIME_MS;
  const [, inserted] = await env.DB.batch([
    env.DB.prepare("delete from statement_drafts where expires <= ?1").bind(now),
    env.DB.prepare(
      `insert into statement_drafts (id, path, type, payload, asked_from, next, at, expires, signer_email)
       select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
       where (select count(*) from statement_drafts) < ${MOST_OPEN}
       returning id`,
    ).bind(
      id,
      path,
      type,
      payloadText,
      from || null,
      next ? new URL(next).href : null,
      now,
      expires,
      signerEmail || null,
    ),
  ]);
  if (!inserted?.results.length)
    throw codedError("UNAVAILABLE", `${MOST_OPEN} statements already wait for a member`, {
      kind: "overloaded",
      retryAfterMs: 3600 * 1000,
    });
  console.info({ event: "auth.statement-proposed", draft: await markOf(id), path, type });
  return { draft: id, signAt: `${issuer}${SIGN_STATEMENT_PATH}?draft=${id}`, expires };
}

export async function statementDraftsResponse(
  env: Env,
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== SIGN_STATEMENT_PATH) return null;
  if (request.method === "GET" || request.method === "HEAD")
    return draftPage(env, await openDraft(env, url.searchParams.get("draft")));
  if (request.method === "POST") return pressed(env, request);
  return new Response("Not found", { status: 404 });
}

async function openDraft(env: Env, id: unknown): Promise<Draft | null> {
  if (typeof id !== "string" || !id) return null;
  return env.DB.prepare(
    "select id, path, type, payload, asked_from, signer_email, next from statement_drafts where id = ?1 and expires > ?2",
  )
    .bind(id, Date.now())
    .first<Draft>();
}

function draftPage(env: Env, draft: Draft | null): Response {
  if (!draft)
    return page({
      title: "This link has ended",
      status: 404,
      body: `<h1>This link has ended</h1><p>The statement was signed already, or its day is over. Ask for a new link.</p>`,
    });
  const { domain } = iterateConfigOf(env);
  const shown = JSON.stringify(JSON.parse(draft.payload), null, 2);
  const values = JSON.stringify({
    id: draft.id,
    mind: domain,
    path: draft.path,
    type: draft.type,
    payload: draft.payload,
  });
  const asker = draft.asked_from
    ? `<p>Asked by <code>${text(draft.asked_from)}</code> <span class="muted">(what the asker says of itself)</span></p>`
    : "";
  const signer = draft.signer_email
    ? `<p>Only <code>${text(draft.signer_email)}</code> can sign it.</p>`
    : "";
  // signed out, /keys sends a person to the sign-in page first
  const addPasskey = `${KEYS_PATH}?${new URLSearchParams({ next: `${SIGN_STATEMENT_PATH}?draft=${draft.id}` })}`;
  return page({
    title: "Sign this statement?",
    wide: true,
    body: `<h1>Sign this statement?</h1>
      <p>Your passkey's signature adds this event to ${text(domain)}, with you as its signer.</p>
      ${asker}${signer}
      <p>Context <code>${text(draft.path)}</code></p>
      <p>Event type <code>${text(draft.type)}</code></p>
      <pre>${text(shown)}</pre>
      <form class="actions" data-draft="${text(values)}">
        <button type="submit">Sign with your passkey</button>
      </form>
      <p id="status" class="muted" role="status"></p>
      <p class="muted">No passkey for ${text(domain)} yet? <a href="${text(addPasskey)}">Sign in and add one</a>, and it brings you back here.</p>`,
    script: `${SIGN_HELPERS}${PRESS_SCRIPT}`,
  });
}

// The press: the statement is made of the draft's own values, and a discoverable passkey signs it.
// The page needs no session, so it cannot read /keys.json: the server finds the key by its
// credential id.
const PRESS_SCRIPT = `
const form = document.querySelector("form[data-draft]");
const status = document.getElementById("status");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const draft = JSON.parse(form.dataset.draft);
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    status.textContent = "Waiting for your passkey…";
    const now = Date.now();
    const statement = JSON.stringify({ mind: draft.mind, path: draft.path, type: draft.type, payload: JSON.parse(draft.payload), at: now, expires: now + 5 * 60000, nonce: b64u(crypto.getRandomValues(new Uint8Array(16))) });
    const assertion = await navigator.credentials.get({ publicKey: {
      challenge: await sha256(signedBytes(statement)),
      rpId: location.hostname,
      userVerification: "required",
    } });
    const { signature, authenticatorData, clientDataJSON } = assertion.response;
    const answer = await fetch("${SIGN_STATEMENT_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft: draft.id, statement, credentialId: assertion.id, sig: b64u(signature), authenticatorData: b64u(authenticatorData), clientDataJSON: b64u(clientDataJSON) }) });
    const body = await answer.json().catch(() => ({}));
    if (!answer.ok) throw new Error("Not signed: " + (body.refused || "the mind did not take it") + ".");
    form.hidden = true;
    status.textContent = "Signed. The event is on " + body.path + ".";
    if (body.next) location.assign(body.next);
  } catch (error) {
    button.disabled = false;
    status.textContent = error.name === "NotAllowedError" ? "No passkey was used. Try again." : error.message || "The statement was not signed.";
  }
});`;

const Press = z.object({
  draft: z.string(),
  statement: z.string(),
  credentialId: z.string(),
  sig: z.string(),
  authenticatorData: z.string(),
  clientDataJSON: z.string(),
});

async function pressed(env: Env, request: Request): Promise<Response> {
  const press = Press.safeParse(await request.json().catch(() => null));
  if (!press.success) return refused(400, "send the passkey's answer as JSON");
  const { draft: id, statement: statementText, credentialId, ...signature } = press.data;
  const mark = await markOf(id);
  const draft = await openDraft(env, id);
  if (!draft) return refused(404, "this link has ended", mark);
  const statement = statementOf(statementText);
  if (
    "refused" in statement ||
    statement.path !== draft.path ||
    statement.type !== draft.type ||
    JSON.stringify(statement.payload || {}) !== JSON.stringify(JSON.parse(draft.payload))
  )
    return refused(403, "the statement is not the one this link shows", mark);
  const key = await env.DB.prepare(
    `select k.id, u.email from keys k left join users u on u.id = k.user_id
     where k.credential_id = ?1 and k.format = 'webauthn' and k.revoked_at is null`,
  )
    .bind(credentialId)
    .first<{ id: string; email: string | null }>();
  if (!key) return refused(403, "the passkey is not one this mind knows", mark);
  // before the intake, which may write (a meld's row): the draft names the one person who signs it
  if (draft.signer_email && key.email !== draft.signer_email)
    return refused(403, `only ${draft.signer_email} signs this statement`, mark);
  const admitted = await admittedStatement(env, {
    statement: statementText,
    signature: { format: "webauthn", key: key.id, ...signature },
  });
  if ("refused" in admitted) return refused(admitted.status || 403, admitted.refused, mark);
  // The draft counts once: of two presses at once, the one that deletes it adds the event.
  const deleted = await env.DB.prepare("delete from statement_drafts where id = ?1 returning id")
    .bind(id)
    .first();
  if (!deleted) return refused(404, "this link has ended", mark);
  console.info({ event: "auth.statement-signed", draft: mark, path: draft.path, type: draft.type });
  return withFacts(
    Response.json({ ...admitted.answer, next: draft.next }, { headers: NO_STORE }),
    admitted.facts,
  );
}

/** A draft's name in a log line: a short hash. The id is the link's whole secret, and whoever reads
 *  the logs must not be able to open the page with it. */
const markOf = async (id: string) => (await statementHashOf(id)).slice(0, 8);

const NO_STORE = { "cache-control": "no-store" };

function refused(status: number, reason: string, draft?: string) {
  console.info({ event: "auth.statement-refused", draft, reason });
  return Response.json({ refused: reason }, { status, headers: NO_STORE });
}
