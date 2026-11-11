// The page's script hashes each stored text itself and offers approval only when that hash is the
// digest. The signature is the credential, so the statements route asks for no session.
import { APPROVALS_CONTEXT, RUN_ACTS_HEADER } from "iterate/acts";
import { withFacts } from "iterate/facts";
import { errorCode } from "iterate/lib";
import { SECRET_PATH } from "iterate/secret-placeholder";
import type { SecretAnswer } from "iterate/workers";
import { z } from "zod";
import type { Envelope } from "iterate/signed";
import type { GateDecision, GateFacts, GateState, RuleWriter } from "./acts-gate.ts";
import { ACT_RULES_PATH, ACTS_SCRIPT, actRules, actsData, heldActs } from "./acts-page.ts";
import type { ApprovalRule, HeldRequest } from "./approval.ts";
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
    approvals(path: string): Promise<{ rule: ApprovalRule | null; held: HeldRow[] }>;
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
  };
};

/** The page and its two POST routes. */
export const isApprovalsPath = (pathname: string) =>
  pathname === SECRET_APPROVALS_PATH ||
  pathname === STATEMENTS_PATH ||
  pathname === RULES_PATH ||
  pathname === ACT_RULES_PATH;

export async function secretApprovals(request: Request, deps: ApprovalsDeps): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === STATEMENTS_PATH && request.method === "POST") return statement(request, deps);
  const admission = admitted(request, false);
  if (admission instanceof Response) return admission;
  const by = { userId: admission.by?.userId || "", email: admission.by?.email || "" };
  if (pathname === RULES_PATH && request.method === "POST") {
    const form = await request.formData();
    const path = String(form.get("path") ?? "");
    if (!SECRET_PATH.test(path)) return callbackPage(400, "Name a secret as /secrets/<name>.");
    const words = (name: string) =>
      String(form.get(name) ?? "")
        .split(/[\s,]+/)
        .filter(Boolean);
    try {
      const answer = await deps.secretOf(path).tightenRule(path, {
        rule: {
          methods: words("methods"),
          hosts: words("hosts"),
          jsonStrings: words("jsonStrings"),
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
      return callbackPage(400, error instanceof Error ? error.message : String(error));
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
  if (pathname === SECRET_APPROVALS_PATH && request.method === "GET") return page(deps);
  return new Response("Method not allowed", { status: 405 });
}

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
  const reply = answer.result.error
    ? refuse(answer.result.error, 403)
    : Response.json({ ok: true });
  return withFacts(reply, answer.facts);
}

// The script shows a request's parts, from the text it hashed.
async function page(deps: ApprovalsDeps): Promise<Response> {
  const secrets: { path: string; rule: ApprovalRule | null; held: HeldRow[] }[] = [];
  for (const path of await deps.index.paths()) {
    const { rule, held } = await deps.secretOf(path).approvals(path);
    if (!rule && !held.length) await deps.index.remove(path);
    else secrets.push({ path, rule, held: held.sort((a, b) => b.at - a.at) });
  }
  const gate = await deps.gate.state();
  const waiting = secrets.filter((secret) => secret.held.length);
  waiting.sort((a, b) => b.held[0]!.at - a.held[0]!.at);
  const requests = waiting
    .map(
      ({ path, held }) =>
        `<section data-secret="${escaped(path)}"><h2>${escaped(path)}</h2>${held
          .map(
            (row) => `<fieldset id="request-${escaped(row.digest)}">
<legend><label><input type="checkbox" data-pick="${escaped(row.digest)}" disabled> ${escaped(summaryOf(row.text))}</label></legend>
<p class="muted">Waiting since ${new Date(row.at).toISOString()}.${row.state === "approved" ? " Approved: it goes when the same request is sent again." : ""}${row.from ? ` It says it came from ${escaped(row.from)}: a claim, not checked.` : ""}</p>
<pre data-text></pre><p class="muted" data-check>Checking…</p></fieldset>`,
          )
          .join(
            "",
          )}<p class="actions"><button type="button" data-approve>Approve the chosen requests</button> <button type="button" class="link" data-reject>Reject them</button></p></section>`,
    )
    .join("");
  const rules = secrets
    .filter((secret) => secret.rule)
    .map(({ path, rule }) => ruleForm(path, rule!))
    .join("");
  const body = [
    "<h1>Approvals</h1>",
    `<p role="alert" data-type="error" data-keys hidden>You have no passkey or security key here. <a href="/keys?next=${encodeURIComponent(SECRET_APPROVALS_PATH)}">Add one</a>, then come back.</p>`,
    `<p role="alert" data-type="error" data-failure hidden></p>`,
    heldActs(gate),
    requests || (gate.held.length ? "" : "<p>Nothing waits for approval.</p>"),
    actRules(gate),
    "<h2>Rules for requests with a secret</h2>",
    "<p>A request with a secret whose method and host its rule names waits here for a signed yes. Adding a method or a host saves at once; anything else is signed with your key.</p>",
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
    200,
    `${body}<script type="application/json" id="approvals-data">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script><script nonce="${nonce}">${SCRIPT}${ACTS_SCRIPT}</script>`,
    "'self'",
    nonce,
    true,
  );
}

function summaryOf(text: string): string {
  const held = JSON.parse(text) as HeldRequest;
  return `${held.method} ${held.url}`;
}

function ruleForm(path: string, rule: ApprovalRule | null): string {
  const field = (name: string, label: string, value: string, required = "required") =>
    `<label>${label}<br><input name="${name}" value="${escaped(value)}" size="44" ${required}></label>`;
  return `<form method="post" action="${RULES_PATH}" class="stack" data-rule>
${path ? `<input type="hidden" name="path" value="${escaped(path)}"><h3>${escaped(path)}</h3>` : `<h3>A new rule</h3>${field("path", "Secret", "/secrets/")}`}
${field("methods", "Methods", rule?.methods.join(", ") ?? "POST")}
${field("hosts", "Hosts", rule?.hosts.join(", ") ?? "")}
${field("jsonStrings", "Only when the JSON body holds one of these, or leave empty for every request", rule?.jsonStrings?.join(", ") ?? "", "")}
<p class="muted">For an API that reads and acts through one address: EmailSubmission/set holds a mail sent through JMAP and lets a read go. With this, a body that is not JSON waits too.</p>
<p class="actions"><button type="submit">Save</button>${path ? ` <button type="button" class="link" data-sign-rule>Sign and save</button> <button type="button" class="link" data-remove-rule>Remove, signed</button>` : ""}</p></form>`;
}

// `signedBytes` must match iterate/signed's: DSSE's pre-authentication encoding, lengths in bytes.
const SCRIPT = `
const data = JSON.parse(document.getElementById("approvals-data").textContent);
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
const fail = (error) => { failure.textContent = String(error && error.message || error); failure.hidden = false; };

let keys = [];
const keysLoaded = fetch("/keys.json", { credentials: "same-origin" })
  .then((answer) => answer.ok ? answer.json() : { keys: [] })
  .then((answer) => { keys = answer.keys || []; document.querySelector("[data-keys]").hidden = keys.length > 0; });

async function sign(fields) {
  await keysLoaded;
  if (!keys.length) throw new Error("Add a passkey or a security key first.");
  const now = Date.now();
  const statement = JSON.stringify({ mind: data.mind, ...fields, at: now, expires: now + 5 * 60000, nonce: b64u(crypto.getRandomValues(new Uint8Array(16))) });
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge: await sha256(signedBytes(statement)),
    rpId: location.hostname,
    userVerification: "preferred",
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
  location.reload();
}

for (const held of data.held) {
  const row = document.getElementById("request-" + held.digest);
  const request = JSON.parse(held.text);
  row.querySelector("[data-text]").textContent = [request.method + " " + request.url, ...request.headers.map(([name, value]) => name + ": " + value), "", request.body].join("\\n");
  sha256(enc.encode(held.text)).then((digest) => {
    const good = hex(digest) === held.digest;
    row.querySelector("[data-check]").textContent = good ? "Checked: this is exactly what will be sent. Request " + held.digest.slice(0, 12) + "." : "This is not the request that waits, so it cannot be approved here.";
    if (good) row.dataset.checked = held.digest;
    row.querySelector("[data-pick]").disabled = !good;
    row.querySelector("[data-pick]").checked = good;
  });
}

for (const section of document.querySelectorAll("[data-secret]")) {
  const path = section.dataset.secret;
  const chosen = () => [...section.querySelectorAll("[data-pick]:checked")].map((box) => box.dataset.pick);
  section.querySelector("[data-approve]").addEventListener("click", () => {
    const about = chosen();
    if (about.length) sign({ path, type: data.types.approved, about }).catch(fail);
  });
  section.querySelector("[data-reject]").addEventListener("click", () => {
    const about = chosen();
    const reason = about.length && prompt("Why do you reject it?");
    if (reason) sign({ path, type: data.types.rejected, about, payload: { reason } }).catch(fail);
  });
}

for (const form of document.querySelectorAll("[data-rule]")) {
  const words = (name) => form.elements[name].value.split(/[\\s,]+/).filter(Boolean);
  const path = () => form.elements.path.value;
  form.querySelector("[data-sign-rule]")?.addEventListener("click", () =>
    sign({ path: path(), type: data.types.rule, payload: { rule: { methods: words("methods"), hosts: words("hosts"), jsonStrings: words("jsonStrings") } } }).catch(fail));
  form.querySelector("[data-remove-rule]")?.addEventListener("click", () =>
    sign({ path: path(), type: data.types.rule, payload: { rule: null } }).catch(fail));
}

const wanted = new URLSearchParams(location.search).get("digest");
if (wanted) document.getElementById("request-" + wanted)?.scrollIntoView({ block: "center" });
`;
