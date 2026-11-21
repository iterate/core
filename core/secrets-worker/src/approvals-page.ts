// approvals-page.ts — THE PAGE WHERE A MEMBER'S KEY SIGNS, at /secrets/approvals of the platform's
// origin. A passkey's prompt does not show what it signs, so a member trusts this page to show
// it, and the mind's code, which may be hostile, has no part in the page:
// - The vault serves it. The boundary sends /secrets of the platform's origin here before the
//   mind sees a request, and an answer of the mind on that origin is an attachment in a sandbox.
// - It loads nothing from elsewhere: one script, by a nonce, and fetches to its own origin.
// - What the mind supplies is data, written as text: an act's text, a proposed rule, a name. The
//   words that say what a rule holds are made here.
// - No value comes from the page's address but `?digest=`, which ticks the one held row it names.
// - A press that was made on another origin, for another relying party or for another statement
//   is refused (iterate/signed `verifySignature`), and a statement counts once.
// The first two steps of core/alchemy/scripts/act-approval-proof.ts show this on a stack.
//
// The page's script hashes each stored text itself and offers approval only when that hash is the
// digest. The signature is the credential, so the statements route asks for no session.
import { APPROVALS_CONTEXT, RUN_ACTS_HEADER } from "iterate/acts";
import type { SecretBodyField } from "iterate/api";
import { withFacts } from "iterate/facts";
import { errorCode } from "iterate/lib";
import { SECRET_PATH } from "iterate/secret-placeholder";
import type { SecretAnswer } from "iterate/workers";
import { z } from "zod";
import type { Envelope } from "iterate/signed";
import type { GateDecision, GateFacts, GateState, RuleWriter } from "./acts-gate.ts";
import {
  ACT_RULES_PATH,
  ACTS_SCRIPT,
  actRules,
  actsData,
  heldActs,
  PROPOSALS_PATH,
  proposedRules,
  secretRuleInWords,
} from "./acts-page.ts";
import { type ApprovalRule, fillsOfText, type HeldRequest } from "./approval.ts";
import { admitted, callbackPage, escaped, plainPage } from "./callback-page.ts";
import type { HeldRow } from "./secret/durable-object.ts";
import { APPROVED, REJECTED, RULE_CONFIGURED } from "./secret/durable-object.ts";

const SECRET_APPROVALS_PATH = "/secrets/approvals";
const STATEMENTS_PATH = `${SECRET_APPROVALS_PATH}/statements`;
const RULES_PATH = `${SECRET_APPROVALS_PATH}/rules`;

// Shapes alone: the auth Worker checks the rest.
const EnvelopeInput = z.object({
  statement: z.string(),
  signature: z.discriminatedUnion("format", [
    z.object({ format: z.literal("p256"), key: z.string(), sig: z.string() }),
    z.object({
      format: z.literal("webauthn"),
      key: z.string(),
      sig: z.string(),
      authenticatorData: z.string(),
      clientDataJSON: z.string(),
    }),
  ]),
}) satisfies z.ZodType<Envelope>;

const ENVELOPE_LIMIT = 64 * 1024;

type ApprovalsDeps = {
  mind: string;
  index: { paths(): Promise<string[]>; remove(path: string): Promise<void> };
  secretOf(path: string): {
    approvals(
      path: string,
    ): Promise<{ rule: ApprovalRule | null; held: HeldRow[]; bodyFields?: SecretBodyField[] }>;
    tightenRule(
      path: string,
      input: { rule: unknown; by: { userId: string; email: string } },
    ): Promise<SecretAnswer<{ rule: ApprovalRule }>>;
    decide(path: string, envelope: Envelope): Promise<SecretAnswer<{ error?: string }>>;
  };
  /** The gate for a mail and for a verb's call (./acts-gate.ts). */
  gate: {
    state(): Promise<GateState>;
    setRules(input: { rules: unknown; by: RuleWriter }): Promise<{ facts: GateFacts }>;
    decide(envelope: Envelope): Promise<{ result: GateDecision; facts: GateFacts }>;
    proposalTaken(id: string, secret: string, rule: unknown): Promise<{ facts: GateFacts }>;
    rejectProposal(input: {
      id: string;
      by: { userId: string; email: string };
    }): Promise<{ facts: GateFacts }>;
  };
};

/** The page and its two POST routes. */
export const isApprovalsPath = (pathname: string) =>
  pathname === SECRET_APPROVALS_PATH ||
  pathname === STATEMENTS_PATH ||
  pathname === RULES_PATH ||
  pathname === ACT_RULES_PATH ||
  pathname === PROPOSALS_PATH;

export async function secretApprovals(request: Request, deps: ApprovalsDeps): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === STATEMENTS_PATH && request.method === "POST") return statement(request, deps);
  const admission = admitted(request, false);
  if (admission instanceof Response) return admission;
  const by = { userId: admission.by?.userId || "", email: admission.by?.email || "" };
  if (pathname === RULES_PATH && request.method === "POST") {
    const form = await request.formData();
    const path = String(form.get("path") ?? "");
    if (!SECRET_PATH.test(path))
      return callbackPage(request, 400, "Name a secret as /secrets/<name>.");
    const words = (name: string) =>
      String(form.get(name) ?? "")
        .split(/[\s,]+/)
        .filter(Boolean);
    // ONE FORM FOR ONE SECRET. "A new rule" is for a secret that has none. For a secret with a
    // rule its Save would change that rule, which this form does not show: the rule's own block
    // shows it, in words.
    if (form.get("new") && (await deps.secretOf(path).approvals(path)).rule)
      return plainPage(
        request,
        400,
        `<p role="alert" data-type="error">${escaped(path)} has a rule already. <a href="${SECRET_APPROVALS_PATH}#${escaped(ruleBlockId(path))}">Change it in its own block.</a></p>`,
      );
    try {
      const answer = await deps.secretOf(path).tightenRule(path, {
        rule: {
          methods: words("methods"),
          hosts: words("hosts"),
          jsonStrings: words("jsonStrings"),
          freePaths: words("freePaths"),
        },
        by,
      });
      return withFacts(
        new Response(null, {
          status: 303,
          headers: { location: SECRET_APPROVALS_PATH, "cache-control": "no-store" },
        }),
        answer.facts,
      );
    } catch (error) {
      return callbackPage(request, 400, error instanceof Error ? error.message : String(error));
    }
  }
  // The rules for acts, by a member's session alone. The gate says when that is not enough, and
  // the page then signs the same rules.
  if (pathname === ACT_RULES_PATH && request.method === "POST") {
    const body = z.object({ rules: z.unknown() }).safeParse(await request.json().catch(() => null));
    try {
      const { facts } = await deps.gate.setRules({ rules: body.data?.rules, by: { member: by } });
      return withFacts(Response.json({ ok: true }), facts);
    } catch (error) {
      const forbidden = errorCode(error) === "FORBIDDEN";
      return Response.json(
        { error: error instanceof Error ? error.message : String(error), signed: forbidden },
        { status: forbidden ? 403 : 400 },
      );
    }
  }
  // A member's no to a proposed rule. The session alone: a proposal holds nothing.
  if (pathname === PROPOSALS_PATH && request.method === "POST") {
    const body = z.object({ reject: z.string() }).safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "name the proposal" }, { status: 400 });
    const { facts } = await deps.gate.rejectProposal({ id: body.data.reject, by });
    return withFacts(Response.json({ ok: true }), facts);
  }
  if (pathname === SECRET_APPROVALS_PATH && request.method === "GET") return page(request, deps);
  return new Response("Method not allowed", { status: 405 });
}

/** A statement that sets a secret's rule and names the proposal it takes up. */
const SignedRule = z.object({ payload: z.object({ proposal: z.string(), rule: z.unknown() }) });

// The secret's object checks the path again once the statement is verified.
async function statement(request: Request, deps: ApprovalsDeps): Promise<Response> {
  const refuse = (error: string, status = 400) => Response.json({ error }, { status });
  const text = await request.text();
  if (text.length > ENVELOPE_LIMIT) return refuse("the envelope is too large");
  let envelope: Envelope;
  let path: unknown;
  try {
    envelope = EnvelopeInput.parse(JSON.parse(text));
    path = (JSON.parse(envelope.statement) as { path?: unknown }).path;
  } catch {
    return refuse("send { statement, signature } as JSON");
  }
  if (path === APPROVALS_CONTEXT) {
    const { result, facts } = await deps.gate.decide(envelope);
    if (result.error) return withFacts(refuse(result.error, 403), facts);
    // Acts whose caller stopped waiting: the boundary hands them to the mind, which does them now.
    // By their ids: an act's text does not fit a header.
    const headers = result.run?.length ? { [RUN_ACTS_HEADER]: result.run.join(",") } : undefined;
    return withFacts(Response.json({ ok: true }, { headers }), facts);
  }
  if (typeof path !== "string" || !SECRET_PATH.test(path))
    return refuse("the statement names no secret");
  const answer = await deps.secretOf(path).decide(path, envelope);
  if (answer.result.error) return withFacts(refuse(answer.result.error, 403), answer.facts);
  // A rule that a member signed for a proposal: the gate, which kept the proposal, is told. The
  // secret's own object verified the statement and took the rule; the gate compares it again.
  const signed = SignedRule.safeParse(JSON.parse(envelope.statement));
  const taken = signed.success
    ? await deps.gate.proposalTaken(signed.data.payload.proposal, path, signed.data.payload.rule)
    : { facts: [] };
  return withFacts(Response.json({ ok: true }), [...answer.facts, ...taken.facts]);
}

// The script shows a request's parts, from the text it hashed.
async function page(request: Request, deps: ApprovalsDeps): Promise<Response> {
  const secrets: {
    path: string;
    rule: ApprovalRule | null;
    held: HeldRow[];
    bodyFields?: SecretBodyField[];
  }[] = [];
  for (const path of await deps.index.paths()) {
    const { rule, held, bodyFields } = await deps.secretOf(path).approvals(path);
    if (!rule && !held.length) await deps.index.remove(path);
    else secrets.push({ path, rule, held: held.sort((a, b) => b.at - a.at), bodyFields });
  }
  const gate = await deps.gate.state();
  const waiting = secrets.filter((secret) => secret.held.length);
  waiting.sort((a, b) => b.held[0]!.at - a.held[0]!.at);
  const requests = waiting
    .map(
      ({ path, held }) =>
        `<section data-secret="${escaped(path)}"><h2>Requests with ${escaped(path)}</h2>${held
          .map(
            (row) => `<fieldset id="request-${escaped(row.digest)}">
<legend><label><input type="checkbox" data-pick="${escaped(row.digest)}" disabled> ${escaped(summaryOf(row.text))}</label></legend>
<p class="muted">Waiting since ${new Date(row.at).toISOString().slice(0, 16).replace("T", " ")} UTC.${row.state === "approved" ? " Approved: it goes when the same request is sent again." : ""}${row.from ? ` It says it came from ${escaped(row.from)}: a claim, not checked.` : ""}</p>${filledInWords(path, row.text)}
<dl class="facts" data-parts></dl>
<details><summary>The exact text you sign for</summary><pre data-text></pre></details>
<p class="muted" data-check>Checking…</p></fieldset>`,
          )
          .join(
            "",
          )}<p class="actions"><button type="button" data-approve>Approve with passkey</button> <button type="button" class="link" data-reject>Reject with passkey</button></p></section>`,
    )
    .join("");
  const rules = secrets
    .filter((secret) => secret.rule)
    .map(({ path, rule, bodyFields }) => ruleForm(path, rule!, bodyFields))
    .join("");
  const body = [
    "<h1>Approvals</h1>",
    `<p role="alert" data-type="error" data-keys hidden>You have no passkey or security key here. <a href="/keys?next=${encodeURIComponent(SECRET_APPROVALS_PATH)}">Add one</a>, then come back.</p>`,
    `<p role="alert" data-type="error" data-failure hidden></p>`,
    heldActs(gate),
    proposedRules(gate, (path) => secrets.find((secret) => secret.path === path)?.rule),
    requests || (gate.held.length || gate.proposed.length ? "" : "<p>Nothing is waiting.</p>"),
    actRules(gate),
    "<h2>Rules for requests with a secret</h2>",
    "<p>A request that uses a secret and matches that secret's rule waits on this page until a member approves it with a passkey.</p>",
    rules,
    ruleForm("", null),
  ].join("");
  const data = {
    mind: deps.mind,
    held: waiting.flatMap(({ path, held }) =>
      held.map(({ digest, text }) => ({ path, digest, text })),
    ),
    types: { approved: APPROVED, rejected: REJECTED, rule: RULE_CONFIGURED },
    ...actsData(gate),
  };
  const nonce = crypto.randomUUID();
  return plainPage(
    request,
    200,
    `${body}<script type="application/json" id="approvals-data">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script><script nonce="${nonce}">${SCRIPT}${ACTS_SCRIPT}</script>`,
    {
      formAction: "'self'",
      scriptNonce: nonce,
      connects: true,
      wide: true,
      title: "Approvals",
      mind: deps.mind,
    },
  );
}

function summaryOf(text: string): string {
  const held = JSON.parse(text) as HeldRequest;
  return `${held.method} ${held.url}`;
}

/** WHAT A MEMBER RELEASES WITH A HELD REQUEST WHOSE BODY THE SECRET FILLS, in words, or "": the
 *  fields that the request was held with (./approval.ts `HeldRequest.fills`). Its body does not
 *  say it: a placeholder there reads the same in a request that fills nothing. */
function filledInWords(path: string, text: string): string {
  const fills = fillsOfText(text)?.fields || [];
  return fills.length
    ? `\n<p><strong>If you approve, the value of ${escaped(path)} is sent inside this request's body, in the field ${fills.map(escaped).join(" and ")}.</strong> If that service shows it back, this mind's own code can read the value, and from then on no rule holds it.</p>`
    : "";
}

/** A rule's form: a secret's own rule, or "A new rule" with no path. NO VALUE OF A FORM COMES
 *  FROM THE PAGE'S ADDRESS: a member saves or signs what the page shows, so what it shows is the
 *  vault's own or what the member typed. A rule that someone else wants is a proposal, which the
 *  vault keeps with who asked (./acts-gate.ts `propose`). `bodyFields`: the secret's own. A
 *  request that fills one waits whatever the rule names (./secret/durable-object.ts `fetch`), and
 *  the block says so under the rule's own words. */
export function ruleForm(
  path: string,
  rule: Pick<ApprovalRule, "methods" | "hosts" | "jsonStrings" | "freePaths"> | null,
  bodyFields?: readonly SecretBodyField[],
): string {
  const field = (name: string, label: string, value: string, required = "required") =>
    `<label>${label} <input name="${name}" value="${escaped(value)}" size="44" ${required}></label>`;
  // THE RULE IN WORDS, ABOVE ITS FIELDS: what waits and what stays free, as a proposed rule's row
  // says it. The page's script says them again from the fields as a member types.
  const words = path && rule ? secretRuleInWords({ ...rule, secret: path }) : "";
  return `<form method="post" action="${RULES_PATH}" class="stack" data-rule${path ? ` id="${escaped(ruleBlockId(path))}"` : ""}>
${path ? `<input type="hidden" name="path" value="${escaped(path)}"><h3>${escaped(path)}</h3>` : `<input type="hidden" name="new" value="1"><h3>A new rule</h3>${field("path", "Secret", "/secrets/")}<p role="alert" data-type="error" data-has-rule hidden></p>`}
<p data-words${words ? "" : " hidden"}>${escaped(words)}</p>${bodyFields?.length ? `\n<p>A request that sends ${escaped(path)} inside its body waits too, whatever its method and host: ${bodyFields.map(({ method, url, field }) => `a ${escaped(method)} to ${escaped(url)}, in the field ${escaped(field)}`).join("; ")}.</p>` : ""}
${field("methods", "Methods", rule?.methods.join(", ") ?? "POST")}
${field("hosts", "Hosts", rule?.hosts.join(", ") ?? "")}
${field("jsonStrings", "Only when the JSON body holds one of these (empty: every request)", rule?.jsonStrings?.join(", ") ?? "", "")}
${field("freePaths", "Paths that never wait (optional)", rule?.freePaths?.join(", ") ?? "", "")}
<details><summary>When to use the two optional fields</summary>
<p class="muted">The JSON body: for an API that reads and acts through one address. EmailSubmission/set holds a mail sent through JMAP and lets a read go. With this, a body that is not JSON waits too.</p>
<p class="muted">The paths: for an address that takes files, whose body is no JSON. /jmap/upload/ lets an attachment go to Fastmail. A path with a % or a query still waits.</p>
</details>
<p class="actions"><button type="submit">Save</button>${path ? ` <button type="button" class="link" data-sign-rule>Save with passkey</button> <button type="button" class="link" data-remove-rule>Remove with passkey</button>` : ""}</p>${
    path
      ? `
<p class="muted">Save takes a change after which more waits. Any other change, and Remove, take your passkey.</p>`
      : ""
  }</form>`;
}

/** The id of the block of a secret's own rule, which "A new rule" leads to. */
const ruleBlockId = (path: string) => `rule-${path}`;

/** WHAT A RULE'S FORM SAYS ABOVE ITS FIELDS AS A MEMBER TYPES. `typed` is the fields' rule in
 *  words, or nothing while they name no secret, method or host. The saved rule's words stay while
 *  the fields are that rule; a rule that differs is marked, so a member reads what a press saves
 *  or signs. It runs in the page: the script below carries its source. */
export const wordsAsTyped = (saved: string, typed: string) =>
  typed && typed !== saved ? `Not saved yet: ${typed}` : saved;

/** WHICH HELD ROW IS TICKED WHEN THE PAGE OPENS: the one the page's link names (`?digest=`), when
 *  the page's own hash of the row's text is its id. No other row: one press of Approve signs for
 *  every ticked row, and a member has read the row a link brought them to, not the rows under it.
 *  It runs in the page: the script below carries its source, for held requests and held acts. */
export const tickedAtOpen = (digest: string, good: boolean, wanted: string | null) =>
  good && digest === wanted;

// `signedBytes` must match iterate/signed's: DSSE's pre-authentication encoding, lengths in bytes.
export const SCRIPT = `
const data = JSON.parse(document.getElementById("approvals-data").textContent);
const tickedAtOpen = ${tickedAtOpen.toString()};
const secretRuleInWords = ${secretRuleInWords.toString()};
const wordsAsTyped = ${wordsAsTyped.toString()};
const wanted = new URLSearchParams(location.search).get("digest");
const enc = new TextEncoder();
const T = "application/vnd.iterate.statement+json";
const signedBytes = (text) => {
  const body = enc.encode(text);
  const head = enc.encode("DSSEv1 " + enc.encode(T).length + " " + T + " " + body.length + " ");
  const bytes = new Uint8Array(head.length + body.length);
  bytes.set(head);
  bytes.set(body, head.length);
  return bytes;
};
const b64u = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64u = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const failure = document.querySelector("[data-failure]");
// The line is at the page's head, so it is brought into view: a member at the buttons of a long
// page must see why a press did nothing.
const fail = (error) => { failure.textContent = String(error && error.message || error); failure.hidden = false; failure.scrollIntoView({ block: "center" }); };

// One row of a held thing's table (plain-page.css .facts): its name and its value as text, with
// every space and tab of the value as it is in the text that was hashed (.exact). A value of
// several lines goes in a pre; \`note\` is a quieter line over it, the page's own words.
const factRow = (label, value, { block = false, note = "" } = {}) => {
  const row = document.createElement("div");
  const name = document.createElement("dt");
  name.textContent = label;
  const cell = document.createElement("dd");
  if (note) {
    const said = document.createElement("span");
    said.className = "note";
    said.textContent = note;
    cell.append(said);
  }
  if (block) {
    const body = document.createElement("pre");
    body.textContent = value;
    cell.append(body);
  } else if (value) {
    cell.className = "exact";
    cell.append(value);
  }
  row.append(name, cell);
  return row;
};
// A press with nothing ticked says so: it must not look like a press that did nothing.
const noneChosen = () => fail("Tick what you mean first.");

let keys = [];
const keysLoaded = fetch("/keys.json", { credentials: "same-origin" })
  .then((answer) => answer.ok ? answer.json() : { keys: [] })
  .then((answer) => { keys = answer.keys || []; document.querySelector("[data-keys]").hidden = keys.length > 0; });

// stay: the caller signs more than one statement, and loads the page again itself.
async function sign(fields, stay) {
  await keysLoaded;
  if (!keys.length) throw new Error("Add a passkey or a security key first.");
  const now = Date.now();
  const statement = JSON.stringify({ mind: data.mind, ...fields, at: now, expires: now + 5 * 60000, nonce: b64u(crypto.getRandomValues(new Uint8Array(16))) });
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge: await sha256(signedBytes(statement)),
    rpId: location.hostname,
    userVerification: "required",
    allowCredentials: keys.map((key) => ({ type: "public-key", id: unb64u(key.credentialId) })),
  } });
  const key = keys.find((key) => key.credentialId === assertion.id);
  if (!key) throw new Error("That key is not one of yours here.");
  const { signature, authenticatorData, clientDataJSON } = assertion.response;
  const answer = await fetch("${STATEMENTS_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    statement,
    signature: { format: "webauthn", key: key.key, sig: b64u(signature), authenticatorData: b64u(authenticatorData), clientDataJSON: b64u(clientDataJSON) },
  }) });
  const result = await answer.json();
  if (result.error) throw new Error(result.error);
  if (!stay) location.reload();
}

for (const held of data.held) {
  const row = document.getElementById("request-" + held.digest);
  const request = JSON.parse(held.text);
  row.querySelector("[data-parts]").append(
    factRow("Method", request.method),
    factRow("To", request.url),
    ...request.headers.map(([name, value]) => factRow("Header " + name, value)),
    // no body is said in the page's own quiet words, which no body's text can look like
    request.body ? factRow("Body", request.body, { block: true }) : factRow("Body", "", { note: "No body." }),
  );
  row.querySelector("[data-text]").textContent = held.text;
  sha256(enc.encode(held.text)).then((digest) => {
    const good = hex(digest) === held.digest;
    const sent = request.fills ? "what will be sent, with the value in its body as said above" : "exactly what will be sent";
    row.querySelector("[data-check]").textContent = good ? "Checked: this is " + sent + ". Request " + held.digest.slice(0, 12) + "." : "This is not the request that waits, so it cannot be approved here.";
    if (good) row.dataset.checked = held.digest;
    row.querySelector("[data-pick]").disabled = !good;
    row.querySelector("[data-pick]").checked = tickedAtOpen(held.digest, good, wanted);
  });
}

for (const section of document.querySelectorAll("[data-secret]")) {
  const path = section.dataset.secret;
  const chosen = () => [...section.querySelectorAll("[data-pick]:checked")].map((box) => box.dataset.pick);
  section.querySelector("[data-approve]").addEventListener("click", () => {
    const about = chosen();
    if (!about.length) return noneChosen();
    sign({ path, type: data.types.approved, about }).catch(fail);
  });
  section.querySelector("[data-reject]").addEventListener("click", () => {
    const about = chosen();
    if (!about.length) return noneChosen();
    const reason = prompt("Why do you reject it?");
    if (reason) sign({ path, type: data.types.rejected, about, payload: { reason } }).catch(fail);
  });
}

for (const form of document.querySelectorAll("[data-rule]")) {
  const words = (name) => form.elements[name].value.split(/[\\s,]+/).filter(Boolean);
  const path = () => form.elements.path.value;
  // The fields' rule, read as Save's post is read. The words above the fields and the statement
  // that the key signs are both made from it.
  const typed = () => ({ methods: words("methods"), hosts: words("hosts"), jsonStrings: words("jsonStrings"), freePaths: words("freePaths") });
  const said = form.querySelector("[data-words]");
  const saved = said.textContent;
  // "A new rule" is for a secret that has none: a secret with a rule is changed in its own block.
  const hasRule = form.querySelector("[data-has-rule]");
  const leadsToBlock = () => {
    const block = hasRule && document.getElementById("rule-" + path());
    if (hasRule) hasRule.hidden = !block;
    if (block) {
      const link = document.createElement("a");
      link.href = "#" + block.id;
      link.textContent = "Change it in its own block";
      hasRule.replaceChildren(path() + " has a rule already. ", link, ".");
    }
    return Boolean(block);
  };
  form.addEventListener("input", () => {
    const rule = typed();
    const named = !leadsToBlock() && /^\\/secrets\\/./.test(path()) && rule.methods.length && rule.hosts.length;
    said.textContent = wordsAsTyped(saved, named ? secretRuleInWords({ secret: path(), ...rule }) : "");
    said.hidden = !said.textContent;
  });
  form.addEventListener("submit", (event) => { if (leadsToBlock()) event.preventDefault(); });
  form.querySelector("[data-sign-rule]")?.addEventListener("click", () =>
    sign({ path: path(), type: data.types.rule, payload: { rule: typed() } }).catch(fail));
  form.querySelector("[data-remove-rule]")?.addEventListener("click", () =>
    sign({ path: path(), type: data.types.rule, payload: { rule: null } }).catch(fail));
}

if (wanted) document.getElementById("request-" + wanted)?.scrollIntoView({ block: "center" });
`;
