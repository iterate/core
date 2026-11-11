// acts-page.ts — THE PART OF /secrets/approvals FOR ACTS (./acts-gate.ts): a mail, and a call of a
// verb, that wait for a member's yes, and their rules. As for a held request, the page's script
// shows each act from the text it hashed itself, and offers approval only when that hash is the
// act's id. One column and plain controls: a member approves from a phone.
import {
  ACT_APPROVED,
  ACT_REJECTED,
  actOfText,
  type ActRule,
  APPROVALS_CONTEXT,
  GATE_LOCKED,
  GATE_UNLOCKED,
  RULE_SET,
} from "iterate/acts";
import type { HeldAct, ProposedRule } from "./acts-gate.ts";
import { summaryOf } from "./acts-gate.ts";
import { escaped } from "./callback-page.ts";

export const ACT_RULES_PATH = "/secrets/approvals/act-rules";

type Gate = {
  locked: boolean;
  rules: ActRule[];
  proposed: ProposedRule[];
  held: (HeldAct & { waited: boolean })[];
};

const ruleInWords = ({ verb, to }: ActRule) =>
  verb === "email.send"
    ? to
      ? `A mail to ${to.join(", ")}`
      : "Every mail"
    : verb.endsWith(".*")
      ? `Every call under ${verb.slice(0, -2)}`
      : `A call of ${verb}`;

/** The acts that wait: one group each, newest first. Empty when none waits. */
export function heldActs(gate: Gate): string {
  const held = gate.held.toSorted((a, b) => b.at - a.at);
  if (!held.length) return "";
  const groups = held
    .map((row) => {
      const act = actOfText(row.text);
      const caller =
        row.state === "approved"
          ? " Approved: it is being done now. If this stays, it is done when its caller asks again."
          : row.waited
            ? " Its caller waits for your answer now."
            : " Its caller stopped waiting. When you approve, it is done then, and the caller's context gets what came of it.";
      return `<fieldset id="act-${escaped(row.digest)}">
<legend><label><input type="checkbox" data-pick="${escaped(row.digest)}" disabled> ${escaped(act ? summaryOf(act) : "An act this page cannot read")}</label></legend>
<div data-parts></div>
<p class="muted">Waiting since ${new Date(row.at).toISOString()}.${caller}${row.from ? ` It says it came from ${escaped(row.from)}: a claim, not checked.` : ""}</p>
<details><summary>The exact text you sign for</summary><pre data-text></pre></details>
<p class="muted" data-check>Checking…</p></fieldset>`;
    })
    .join("");
  return `<section data-acts><h2>Mail and calls</h2>${groups}<p class="actions"><button type="button" data-approve>Approve the chosen</button> <button type="button" class="link" data-reject>Reject them</button></p></section>`;
}

/** The rules for acts, the rules an agent proposed, and the lock. */
export function actRules(gate: Gate): string {
  const rules = gate.rules
    .map(
      (rule, index) =>
        `<li>${escaped(ruleInWords(rule))} <span class="muted">(${escaped(rule.verb)})</span> <button type="button" class="link" data-drop-act-rule="${index}">Remove</button></li>`,
    )
    .join("");
  const proposed = gate.proposed
    .map(
      ({ id, rule, from }) =>
        `<li>${escaped(ruleInWords(rule))} <span class="muted">(${escaped(rule.verb)}${from ? `, asked for from ${escaped(from)}` : ""})</span> <button type="button" data-take-proposal="${escaped(id)}">Sign it into a rule</button></li>`,
    )
    .join("");
  return `<h2>Rules for mail and calls</h2>
<p>A mail, or a call of a verb, that a rule names waits here for a signed yes. Its caller waits five minutes. After that you can still approve it for a day, and it is done then.</p>
<p class="muted">A mail is held whatever sends it. A call of a verb is held when the mind's agents or its loaded code make it. It is not held if the mind's own Worker was changed to skip the rule, which the owner of a home lab can do.</p>
${rules ? `<ul>${rules}</ul>` : `<p class="muted">No rule for mail or calls yet.</p>`}
<form class="stack" data-act-rule>
<h3>A new rule</h3>
<label>What waits<br><input name="verb" value="email.send" size="44" required></label>
<label>For a mail: only to these recipients, or leave empty for every mail<br><input name="to" placeholder="*@example.com, jo@example.org" size="44"></label>
<p class="muted">email.send is a mail. itx.whatsapp.sendMessage is one verb, and itx.whatsapp.* every verb under it.</p>
<p class="actions"><button type="submit">Add the rule</button></p></form>
${proposed ? `<h3>Rules an agent asks for</h3><ul>${proposed}</ul>` : ""}
<h3>${gate.locked ? "These rules are locked" : "These rules are open"}</h3>
<p>${
    gate.locked
      ? "A rule that holds more saves at once. Anything that holds less is signed with your key, and the mind's agents can only ask for a rule."
      : "Any member, and the mind's own agents, can add, change and remove these rules with no signature. Lock them when you have the rules you want: from then on a change that holds less needs your key."
  }</p>
<p class="actions"><button type="button" class="link" data-lock="${gate.locked ? GATE_UNLOCKED : GATE_LOCKED}">${gate.locked ? "Unlock, signed" : "Lock, signed"}</button></p>`;
}

/** What the script reads beside the page's own data. */
export const actsData = (gate: Gate) => ({
  acts: gate.held.map(({ digest, text }) => ({ digest, text })),
  gate: { locked: gate.locked, rules: gate.rules, proposed: gate.proposed },
  actTypes: { approved: ACT_APPROVED, rejected: ACT_REJECTED, rules: RULE_SET },
  actsPath: APPROVALS_CONTEXT,
});

// Runs after the page's own script (./approvals-page.ts): `data`, `enc`, `sha256`, `hex`, `sign`,
// `fail`, `wanted` and `tickedAtOpen` are its.
export const ACTS_SCRIPT = `
const line = (label, value, strong) => {
  const p = document.createElement("p");
  const name = document.createElement(strong ? "strong" : "span");
  name.textContent = label + " ";
  p.append(name, value);
  return p;
};
for (const held of data.acts) {
  const row = document.getElementById("act-" + held.digest);
  const act = JSON.parse(held.text);
  const parts = row.querySelector("[data-parts]");
  if (act.act === "email.send") {
    // who it is from and where an answer goes come first: they are what a forged mail changes
    parts.append(line("From", act.from, true), line("Replies go to", act.replyTo || act.from, true), line("To", act.to.join(", ")));
    if (act.cc.length) parts.append(line("Copy to", act.cc.join(", ")));
    parts.append(line("Subject", act.subject));
    const body = document.createElement("pre");
    body.textContent = act.text || act.html || "(no text)";
    parts.append(body);
    if (!act.text && act.html) parts.append(line("", "This mail has no plain text: what you see is its HTML source."));
    for (const file of act.attachments) parts.append(line("Attached", file.filename + " (" + file.contentType + ", " + file.size + " bytes)"));
  } else {
    parts.append(line("Call", act.act, true));
    const args = document.createElement("pre");
    args.textContent = JSON.stringify(act.args, null, 2);
    parts.append(args);
  }
  row.querySelector("[data-text]").textContent = held.text;
  sha256(enc.encode(held.text)).then((digest) => {
    const good = hex(digest) === held.digest;
    row.querySelector("[data-check]").textContent = good ? "Checked: this is exactly what will be done. Act " + held.digest.slice(0, 12) + "." : "This is not the act that waits, so it cannot be approved here.";
    if (good) row.dataset.checked = held.digest;
    row.querySelector("[data-pick]").disabled = !good;
    row.querySelector("[data-pick]").checked = tickedAtOpen(held.digest, good, wanted);
  });
}

const acts = document.querySelector("[data-acts]");
if (acts) {
  const chosen = () => [...acts.querySelectorAll("[data-pick]:checked")].map((box) => box.dataset.pick);
  acts.querySelector("[data-approve]").addEventListener("click", () => {
    const about = chosen();
    if (about.length) sign({ path: data.actsPath, type: data.actTypes.approved, about }).catch(fail);
  });
  acts.querySelector("[data-reject]").addEventListener("click", () => {
    const about = chosen();
    const reason = about.length && prompt("Why do you reject it?");
    if (reason) sign({ path: data.actsPath, type: data.actTypes.rejected, about, payload: { reason } }).catch(fail);
  });
}

// A change of the rules goes with the session alone when the gate takes it so (open, or a rule
// that holds more), and is signed when the gate says it needs a signature.
async function setActRules(rules, proposal) {
  if (!proposal) {
    const answer = await fetch("${ACT_RULES_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rules }) });
    if (answer.ok) return location.reload();
    const { error, signed } = await answer.json();
    if (!signed) throw new Error(error);
  }
  await sign({ path: data.actsPath, type: data.actTypes.rules, payload: proposal ? { rules, proposal } : { rules } });
}
const actRule = document.querySelector("[data-act-rule]");
actRule.addEventListener("submit", (event) => {
  event.preventDefault();
  const to = actRule.elements.to.value.split(/[\\s,]+/).filter(Boolean);
  const rule = { verb: actRule.elements.verb.value.trim(), ...(to.length && { to }) };
  setActRules([...data.gate.rules.filter((old) => old.verb !== rule.verb), rule]).catch(fail);
});
for (const button of document.querySelectorAll("[data-drop-act-rule]"))
  button.addEventListener("click", () =>
    setActRules(data.gate.rules.filter((rule, index) => String(index) !== button.dataset.dropActRule)).catch(fail));
for (const button of document.querySelectorAll("[data-take-proposal]"))
  button.addEventListener("click", () => {
    const { rule, id } = data.gate.proposed.find((proposal) => proposal.id === button.dataset.takeProposal);
    setActRules([...data.gate.rules.filter((old) => old.verb !== rule.verb), rule], id).catch(fail);
  });
document.querySelector("[data-lock]").addEventListener("click", (event) =>
  sign({ path: data.actsPath, type: event.target.dataset.lock }).catch(fail));

if (wanted) document.getElementById("act-" + wanted)?.scrollIntoView({ block: "center" });
`;
