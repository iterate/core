// statement-drafts.ts — A STATEMENT THAT AN AGENT ASKS A PERSON TO SIGN. The agent proposes it
// (`AuthService.proposeStatement`) and gets a link that carries only a random id. The page at the
// link needs no sign-in: it shows the exact statement, and a passkey press signs it. The signed
// statement goes through the intake of `POST /statements`, so it lands as an event with the person
// as its signer, or is refused as there.
import { codedError } from "iterate/lib";
import { withFacts } from "iterate/facts";
import type { MindConfig } from "iterate/mind-config";
import { base64url, PLATFORM_NAMESPACES, statementHashOf, statementOf } from "iterate/signed";
import type { AuthService, ProposedBy } from "iterate/workers";
import { z } from "zod";
import { configOf, type Env, issuerOf } from "./env.ts";
import { canonicalPath, honouredNext } from "./key-rules.ts";
import { meldRuleOf } from "./minds.ts";
import { page, text } from "./pages.ts";
import { SIGN_HELPERS } from "./signed-change.ts";
import { verifiedStatement } from "./keys.ts";
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
  asked_by: string | null;
  signer_email: string | null;
  next: string | null;
};

// iterate/workers `ProposedBy`, as the mind Worker sends it and as the row keeps it.
const AskedBy = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("member"), email: z.string().optional() }),
  z.strictObject({ kind: z.literal("person"), email: z.string() }),
  z.strictObject({ kind: z.literal("guest"), name: z.string() }),
  z.strictObject({ kind: z.literal("mind"), hostname: z.string() }),
  z.strictObject({ kind: z.literal("code") }),
]) satisfies z.ZodType<ProposedBy>;

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
  by: AskedBy.optional(),
  signerEmail: z.string().trim().toLowerCase().min(1).optional(),
  next: z.string().optional(),
});

export async function proposeStatement(
  env: Env,
  input: Parameters<AuthService["proposeStatement"]>[0],
): ReturnType<AuthService["proposeStatement"]> {
  const proposal = Proposal.safeParse(input);
  if (!proposal.success) throw codedError("INVALID_INPUT", proposal.error.issues[0]!.message);
  const { type, payload, from, by, signerEmail, next } = proposal.data;
  // the named person's own context, in any letter case, is the one path the intake takes for them
  const own = signerEmail && `/people/${signerEmail}`;
  const path = own && proposal.data.path.toLowerCase() === own ? own : proposal.data.path;
  const issuer = issuerOf(env);
  // the rule of /keys/enrol's own `next` (./key-rules.ts `honouredNext`), as a whole https URL
  if (next && (!/^https:\/\//.test(next) || !honouredNext(next, configOf(env))))
    throw codedError("INVALID_INPUT", "`next` is an https URL on a host of this mind");
  const payloadText = JSON.stringify(payload);
  const id = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const now = Date.now();
  const expires = now + LIFETIME_MS;
  const [, inserted] = await env.DB.batch([
    env.DB.prepare("delete from statement_drafts where expires <= ?1").bind(now),
    env.DB.prepare(
      `insert into statement_drafts (id, path, type, payload, asked_from, next, at, expires, signer_email, asked_by)
       select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
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
      by ? JSON.stringify(by) : null,
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
    "select id, path, type, payload, asked_from, asked_by, signer_email, next from statement_drafts where id = ?1 and expires > ?2",
  )
    .bind(id, Date.now())
    .first<Draft>();
}

function draftPage(env: Env, draft: Draft | null): Response {
  // 404, in words that are no failure for someone who has just signed with the link
  if (!draft)
    return page({
      title: "This link is closed",
      status: 404,
      body: `<h1>This link is closed</h1><p>This link was used, or its day is over. A statement that you signed with it is in. To sign another, ask for a new link.</p>`,
    });
  const mind = configOf(env).controlPlaneHostname;
  const payload: unknown = JSON.parse(draft.payload);
  const shown = JSON.stringify(payload, null, 2);
  const values = JSON.stringify({
    id: draft.id,
    mind,
    path: draft.path,
    type: draft.type,
    payload: draft.payload,
  });
  const meaning = meaningOf(draft.path, draft.type, payload, configOf(env));
  const unknown = `<p>This adds one event of the type <code>${text(draft.type)}</code> to ${contextWords(draft.path)} of ${text(mind)}. This page cannot say what the event means: read it below before you sign.</p>`;
  const signer = draft.signer_email
    ? `<p>Only <code>${text(draft.signer_email)}</code> can sign it.</p>`
    : "";
  return page({
    title: "Sign this statement?",
    wide: true,
    body: `<h1>Sign this statement?</h1>
      ${"refused" in meaning ? `${unknown}<p>${text(mind)} refuses such a rule, so it would refuse your signature too: ${text(meaning.refused)}.</p>` : meaning.words || unknown}
      <p>${proposerWords(draft)}</p>
      ${signer}
      <details${"words" in meaning && meaning.words ? "" : " open"}>
        <summary>The exact event</summary>
        <p>Your passkey signs this text. Context <code>${text(draft.path)}</code>, event type <code>${text(draft.type)}</code>:</p>
        <pre>${text(shown)}</pre>
      </details>
      <form class="actions" data-draft="${text(values)}">
        <button type="submit">Sign with your passkey</button>
      </form>
      <p id="status" class="muted" role="status">Your passkey's signature adds this event to ${text(mind)}, with you as its signer.</p>`,
    script: `${SIGN_HELPERS}${PRESS_SCRIPT}`,
  });
}

/** What a statement of a type that the platform knows does, in words, as HTML (`words` is "" for
 *  any other type), or why this mind refuses it: a meld rule is explained only when the press's
 *  own check (./minds.ts `meldRuleOf`) would take it. */
function meaningOf(
  path: string,
  type: string,
  payload: unknown,
  own: Pick<MindConfig, "mindId" | "controlPlaneHostname">,
): { words: string } | { refused: string } {
  if (type !== "events.iterate.com/mind-meld/configured") return { words: "" };
  const rule = meldRuleOf(path, payload, own);
  if ("refused" in rule) return rule;
  const mind = own.controlPlaneHostname;
  const name = `<strong>${text(rule.name)}</strong> (id <code>${text(rule.mind.slice(0, 12))}…</code>)`;
  if (!rule.append.length)
    return {
      words: `<p>End the rule that lets the mind ${name} add events to ${text(mind)}. It adds none from then on.</p>`,
    };
  const paths = rule.append
    .map(
      (prefix) =>
        `<li><code>${text(prefix)}</code>${prefix === "/" ? " (the root: every context of the mind)" : ""}</li>`,
    )
    .join("");
  const key = rule.key
    ? `the one key <code>${text(rule.key.slice(0, 8))}</code>`
    : "any key that it publishes for statements";
  return {
    words: `<p>Let the mind ${name} add events to ${text(mind)}, under these contexts and the contexts beneath them:</p>
      <ul>${paths}</ul>
      <p>It signs each event with ${key}. This takes the place of any rule for ${name} that a member signed before.</p>`,
  };
}

/** A context of this mind in words: the root is never a bare "/". */
function contextWords(path: string) {
  if (path === "/") return "the root context (<code>/</code>)";
  if (path.startsWith("/agents/")) return `the agent at <code>${text(path)}</code>`;
  return `the context <code>${text(path)}</code>`;
}

/** Who asked for the statement, as the platform stamped the call, and where in the mind it came
 *  from. What a person may have written themselves (a guest's name) is marked as their own. */
function proposerWords(draft: Draft) {
  const by = AskedBy.safeParse(JSON.parse(draft.asked_by || "null"));
  const where = draft.asked_from ? placeWords(draft.asked_from) : "";
  if (!by.success) return where ? `It was proposed ${where}.` : "It was proposed by this mind.";
  const asker = by.data;
  if (asker.kind === "code")
    // code that runs in a member's own request stamps "code" too: the platform knows no more
    return `Proposed by this mind's own code${where ? ` ${where}` : ""}. The platform cannot tell whether a person asked for it: sign it only if you expected it.`;
  const who =
    asker.kind === "member"
      ? `${asker.email ? `<strong>${text(asker.email)}</strong>, a member` : "a member"} signed in to this mind`
      : asker.kind === "person"
        ? `<strong>${text(asker.email)}</strong>, who is signed in to this mind and is no member`
        : asker.kind === "guest"
          ? `a guest of this mind, who says their name is &ldquo;${text(asker.name)}&rdquo;`
          : `the mind <strong>${text(asker.hostname)}</strong>`;
  return `Proposed by ${who}${where ? `, ${where}` : ""}.`;
}

function placeWords(path: string) {
  if (path === "/") return "at the mind's root context (<code>/</code>)";
  if (path.startsWith("/agents/")) return `through the agent at <code>${text(path)}</code>`;
  return `at the context <code>${text(path)}</code>`;
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
    statusSay(status, "Waiting for your passkey…");
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
    if (!answer.ok) throw new Error(body.say || "Not signed: " + (body.refused || "the mind did not take it") + ".");
    form.hidden = true;
    document.querySelector("h1").textContent = "Signed";
    statusSay(status, "You signed it. The event is in " + draft.mind + ", at " + body.path + "." + (body.next ? " Taking you on…" : ""));
    status.classList.remove("muted");
    if (body.next) location.assign(body.next);
  } catch (error) {
    button.disabled = false;
    statusFailed(status, error, "The statement was not signed.");
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
  if (!draft) return refused(404, "this link has ended", mark, LINK_CLOSED);
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
  if (draft.signer_email && key.email !== draft.signer_email) {
    // Whose passkey it was, only once its signature proves that the one who pressed holds it: a
    // credential id alone is anyone's to send. The signer's own address is on the page already.
    const proven = await verifiedStatement(
      env,
      { statement: statementText, signature: { format: "webauthn", key: key.id, ...signature } },
      { once: false },
    );
    const holder = "refused" in proven ? null : proven.signer.principal.email;
    const whose = holder ? `That passkey is ${holder}'s.` : "That passkey cannot sign this.";
    return refused(
      403,
      `only ${draft.signer_email} signs this statement`,
      mark,
      `${whose} Only ${draft.signer_email} can sign this. Press again and choose the passkey of ${draft.signer_email}.`,
    );
  }
  const admitted = await admittedStatement(env, {
    statement: statementText,
    signature: { format: "webauthn", key: key.id, ...signature },
  });
  if ("refused" in admitted) return refused(admitted.status || 403, admitted.refused, mark);
  // The draft counts once: of two presses at once, the one that deletes it adds the event.
  const deleted = await env.DB.prepare("delete from statement_drafts where id = ?1 returning id")
    .bind(id)
    .first();
  if (!deleted) return refused(404, "this link has ended", mark, LINK_CLOSED);
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

const LINK_CLOSED =
  "Not signed: this link is closed. It was used, or its day is over. To sign, ask for a new link.";

/** `reason` for a program; `say`, when there is one, is the sentence for the person who pressed:
 *  what happened and what to do next. */
function refused(status: number, reason: string, draft?: string, say?: string) {
  console.info({ event: "auth.statement-refused", draft, reason });
  return Response.json(say ? { refused: reason, say } : { refused: reason }, {
    status,
    headers: NO_STORE,
  });
}
