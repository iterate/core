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
  rulesTighten,
  RULE_SET,
} from "iterate/acts";
import {
  type HeldAct,
  isSecretRule,
  type ProposedRule,
  type ProposedSecretRule,
} from "./acts-gate.ts";
import { summaryOf } from "./acts-gate.ts";
import { type ApprovalRule, isTightening } from "./approval.ts";
import { escaped } from "./callback-page.ts";

export const ACT_RULES_PATH = "/secrets/approvals/act-rules";
/** A member's no to a proposed rule, by the page's own post with the session. */
export const PROPOSALS_PATH = "/secrets/approvals/proposals";

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

/** What a proposed rule for a request with a secret holds, and what stays free, in words. */
export function secretRuleInWords({
  secret,
  methods,
  hosts,
  jsonStrings,
  freePaths,
}: ProposedSecretRule) {
  const which = `A request with ${secret} waits when it is ${methods.join(" or ")} to ${hosts.join(" or ")}`;
  const body = jsonStrings?.length
    ? ` and its JSON body holds ${jsonStrings.join(" or ")} (a body that is no JSON waits too)`
    : "";
  const free = [
    jsonStrings?.length ? "a request whose JSON body holds none of them" : "",
    freePaths?.length ? `a request to ${freePaths.join(" or ")}, whatever its body` : "",
    "every other method and host",
  ].filter(Boolean);
  return `${which}${body}. What stays free: ${free.join("; ")}.`;
}

/** The acts that wait: one group each, newest first. Empty when none waits. */
export function heldActs(gate: Gate): string {
  const held = gate.held.toSorted((a, b) => b.at - a.at);
  if (!held.length) return "";
  const groups = held
    .map((row) => {
      const act = actOfText(row.text);
      const caller =
        row.state === "approved"
          ? " Approved: it is being done now. If it stays here, it is done when it is asked for again."
          : row.waited
            ? " Whoever asked waits for your answer now."
            : " Whoever asked stopped waiting. If you approve, it is done then, and they get the result.";
      return `<fieldset id="act-${escaped(row.digest)}">
<legend><label><input type="checkbox" data-pick="${escaped(row.digest)}" disabled> ${escaped(act ? summaryOf(act) : "An act this page cannot read")}</label></legend>
<dl class="facts" data-parts></dl>
<p class="muted">Waiting since ${new Date(row.at).toISOString().slice(0, 16).replace("T", " ")} UTC.${caller}${row.from ? ` It says it came from ${escaped(row.from)}: a claim, not checked.` : ""}</p>
<details><summary>The exact text you sign for</summary><pre data-text></pre></details>
<p class="muted" data-check>Checking…</p></fieldset>`;
    })
    .join("");
  return `<section data-acts><h2>Mail and calls</h2>${groups}<p class="actions"><button type="button" data-approve>Approve with passkey</button> <button type="button" class="link" data-reject>Reject with passkey</button></p></section>`;
}

/** THE RULES THAT WAIT FOR A MEMBER'S YES: what an agent or the mind's code proposed. Each is a
 *  row as a held act's is, in the same place: tick it, read it, approve or reject. A proposal is
 *  no rule and holds nothing until a member approves it with a key. The row has the rule in
 *  words and its exact text, who asked and when. `ruleNowOf` answers the rule that a secret has
 *  now: an approved rule for a secret takes that rule's place, so the row says it, in the same
 *  words, and a signature never makes a rule hold less unseen. */
export function proposedRules(
  gate: Gate,
  ruleNowOf: (secret: string) => ApprovalRule | null | undefined = () => null,
): string {
  if (!gate.proposed.length) return "";
  const rows = gate.proposed
    .map(({ id, rule, from, at }) => {
      const when = `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
      const { replaces, holdsLess } = isSecretRule(rule)
        ? whatASecretRuleReplaces(rule, ruleNowOf(rule.secret))
        : whatAnActRuleReplaces(rule, gate.rules);
      return `<fieldset id="proposal-${escaped(id)}" data-proposal="${escaped(id)}">
<legend><label><input type="checkbox" data-pick="${escaped(id)}"> ${escaped(isSecretRule(rule) ? secretRuleInWords(rule) : ruleInWords(rule))}</label></legend>
${replaces ? `<p data-replaces>${escaped(replaces)}</p>` : ""}
${holdsLess ? `<p data-holds-less><strong>After this, less waits than now.</strong> Read both rules before you approve.</p>` : ""}
<p class="muted">A proposed rule, asked for ${from ? `from ${escaped(from)} ` : ""}at ${when}. It holds nothing until you approve it.</p>
<details open><summary>The exact rule you sign for</summary><pre>${escaped(JSON.stringify(rule, null, 1))}</pre></details></fieldset>`;
    })
    .join("");
  return `<section data-proposals id="proposed"><h2>Proposed rules</h2>${rows}<p class="actions"><button type="button" data-approve>Approve with passkey</button> <button type="button" class="link" data-reject>Reject</button></p></section>`;
}

/** WHAT AN APPROVED PROPOSAL TAKES AWAY. A proposed rule comes in the place of the rule that is
 *  there for the same thing: a secret has one rule, and the rules for acts have one for each
 *  verb (the page's script signs the present rules with this one in that verb's place). So a
 *  proposal can make less wait than now, and its row says so before a member signs it. */
function whatASecretRuleReplaces(rule: ProposedSecretRule, now: ApprovalRule | null | undefined) {
  return now
    ? {
        replaces: `It takes the place of the rule that ${rule.secret} has now: ${secretRuleInWords({ ...now, secret: rule.secret })}`,
        holdsLess: !isTightening(now, rule),
      }
    : { replaces: `${rule.secret} has no rule now.`, holdsLess: false };
}
function whatAnActRuleReplaces(rule: ActRule, rules: ActRule[]) {
  const now = rules.find((old) => old.verb === rule.verb);
  const after = [...rules.filter((old) => old.verb !== rule.verb), rule];
  return {
    replaces: now
      ? `It takes the place of the rule that ${rule.verb} has now: ${ruleInWords(now)}.`
      : "",
    holdsLess: !rulesTighten(rules, after),
  };
}

/** The rules for acts, and the lock. */
export function actRules(gate: Gate): string {
  const rules = gate.rules
    .map(
      (rule, index) =>
        `<li>${escaped(ruleInWords(rule))} <span class="muted">(${escaped(rule.verb)})</span> <button type="button" class="link" data-drop-act-rule="${index}">Remove</button></li>`,
    )
    .join("");
  return `<h2>Rules for mail and calls</h2>
${lock(gate.locked)}
<p>Mail and calls that match a rule wait on this page until a member approves them with a passkey. Everything else goes at once. Whoever asked waits five minutes; after that you can still approve for a day, and it is done then.</p>
${rules ? `<ul>${rules}</ul>` : `<p><strong>No rules:</strong> every mail and every call goes without approval.</p>`}
<p class="muted">A rule holds mail whatever sends it, and a call when this mind's agents or its loaded code make it. It holds nothing if the mind's own Worker was changed to skip it, which the owner of a home lab can do.</p>
<form class="stack" data-act-rule>
<h3>A new rule</h3>
<label>What needs approval <input name="verb" value="email.send" size="44" required></label>
<label>Mail only: to these recipients (empty for all mail) <input name="to" placeholder="*@example.com, jo@example.org" size="44"></label>
<p class="muted">email.send is mail. itx.whatsapp.sendMessage is one call, and itx.whatsapp.* is every call under it.</p>
<p class="actions"><button type="submit">Add the rule</button></p></form>`;
}

/** THE LOCK OF THE RULES FOR MAIL AND CALLS: how they stand in one line, a button beside it, and
 *  the dialog that the button opens. The dialog says what the press means before the passkey
 *  asks, and its own button signs: so Lock and Unlock each take two deliberate presses, and a
 *  second press where the first was undoes nothing. The dialog is in the page's HTML from the
 *  start (the browser's own <dialog>), closed. One lock button on the page: the one for how
 *  the rules stand now. */
function lock(locked: boolean): string {
  const state = locked
    ? `<p><strong>These rules are locked.</strong> This mind's agents and code can only propose a rule. A change that lets more through takes a passkey.</p><button type="button" class="outline" data-opens="lock-dialog">Unlock these rules</button>`
    : `<p><strong>These rules are open.</strong> Any member, and this mind's agents and code, can add, change and remove them with no passkey.</p><button type="button" data-opens="lock-dialog">Lock these rules</button>`;
  const means = locked
    ? [
        "Any member, and this mind's agents and code, can then add, change and remove these rules with no passkey.",
        "So an agent can remove the rule that holds its own mail or call.",
        "You can lock the rules again at any time.",
      ]
    : [
        "This mind's agents and code can no longer add, change or remove these rules. They can only propose a rule, and a member approves it here.",
        "A member can still make the rules stricter with no passkey. A change that lets more through takes a passkey.",
        "To unlock, a member presses Unlock here and signs with a passkey.",
      ];
  return `<div class="state">${state}</div>
<dialog id="lock-dialog" aria-labelledby="lock-dialog-title">
<h2 id="lock-dialog-title">${locked ? "Unlock" : "Lock"} the rules for mail and calls?</h2>
<ul>${means.map((line) => `<li>${escaped(line)}</li>`).join("")}</ul>
<p role="alert" data-type="error" data-dialog-failure hidden></p>
<p class="actions"><button type="button" class="outline" data-close>Cancel</button> <button type="button" data-lock="${locked ? GATE_UNLOCKED : GATE_LOCKED}">${locked ? "Unlock" : "Lock"} with passkey</button></p>
</dialog>`;
}

/** What the script reads beside the page's own data. */
export const actsData = (gate: Gate) => ({
  acts: gate.held.map(({ digest, text }) => ({ digest, text })),
  gate: { locked: gate.locked, rules: gate.rules, proposed: gate.proposed },
  actTypes: { approved: ACT_APPROVED, rejected: ACT_REJECTED, rules: RULE_SET },
  actsPath: APPROVALS_CONTEXT,
});

/** WHAT THE APPROVER READS OF A MAIL'S BODY: each part that goes, the text and the HTML. Most
 *  mail programs show the HTML part when there is one, so a mail with a harmless text and another
 *  HTML would be read as one thing here and as another by its recipient. It runs in the page: the
 *  script below carries its source. */
export const mailBodiesOf = (act: { text: string | null; html: string | null }) => [
  ...(act.text ? [{ label: act.html ? "Text part" : "", body: act.text }] : []),
  ...(act.html
    ? [
        {
          label: act.text
            ? "HTML part, which most mail programs show in place of the text. Its source:"
            : "This mail has no plain text. Its HTML source:",
          body: act.html,
        },
      ]
    : []),
  ...(act.text || act.html ? [] : [{ label: "", body: "(no text)" }]),
];

// Runs after the page's own script (./approvals-page.ts): `data`, `enc`, `sha256`, `hex`, `sign`,
// `fail`, `wanted`, `tickedAtOpen`, `factRow` and `noneChosen` are its.
export const ACTS_SCRIPT = `
const mailBodiesOf = ${mailBodiesOf.toString()};
for (const held of data.acts) {
  const row = document.getElementById("act-" + held.digest);
  const act = JSON.parse(held.text);
  const parts = row.querySelector("[data-parts]");
  if (act.act === "email.send") {
    // who it is from and where an answer goes come first: they are what a forged mail changes
    parts.append(factRow("From", act.from), factRow("Replies go to", act.replyTo || act.from), factRow("To", act.to.join(", ")));
    if (act.cc.length) parts.append(factRow("Copy to", act.cc.join(", ")));
    parts.append(factRow("Subject", act.subject));
    // a part's own words (which part it is, and what a mail program shows) stay over its text
    for (const part of mailBodiesOf(act)) parts.append(factRow("Body", part.body, { block: true, note: part.label }));
    for (const file of act.attachments) parts.append(factRow("Attached", file.filename + " (" + file.contentType + ", " + file.size + " bytes)"));
  } else {
    parts.append(factRow("Call", act.act));
    // the context whose table says what that name is: one name may be two functions in two contexts
    if (act.at) parts.append(factRow("In context", act.at));
    parts.append(factRow("Arguments", JSON.stringify(act.args, null, 2), { block: true }));
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
    if (!about.length) return noneChosen();
    sign({ path: data.actsPath, type: data.actTypes.approved, about }).catch(fail);
  });
  acts.querySelector("[data-reject]").addEventListener("click", () => {
    const about = chosen();
    if (!about.length) return noneChosen();
    const reason = prompt("Why do you reject it?");
    if (reason) sign({ path: data.actsPath, type: data.actTypes.rejected, about, payload: { reason } }).catch(fail);
  });
}

// A change of the rules goes with the session alone when the gate takes it so (open, or a rule
// that holds more), and is signed when the gate says it needs a signature.
async function setActRules(rules) {
  const answer = await fetch("${ACT_RULES_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rules }) });
  if (answer.ok) return location.reload();
  const { error, signed } = await answer.json();
  if (!signed) throw new Error(error);
  await sign({ path: data.actsPath, type: data.actTypes.rules, payload: { rules } });
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
// A proposed rule is approved as a held act is: ticked, read, approved. Each rule is a signed
// statement of its own, so each chosen rule asks for the key once. A rule for a request with a
// secret is signed as that secret's own rule, and a rule for an act as the new list of rules;
// either statement names the proposal, so the gate knows it is done.
const proposals = document.querySelector("[data-proposals]");
if (proposals) {
  const chosen = () => [...proposals.querySelectorAll("[data-pick]:checked")].map((box) => data.gate.proposed.find((proposal) => proposal.id === box.dataset.pick));
  proposals.querySelector("[data-approve]").addEventListener("click", async () => {
    if (!chosen().length) return noneChosen();
    let rules = data.gate.rules;
    let approved = 0;
    try {
      for (const { id, rule } of chosen()) {
        if ("secret" in rule) {
          const { secret, ...words } = rule;
          await sign({ path: secret, type: data.types.rule, payload: { rule: words, proposal: id } }, true);
        } else {
          rules = [...rules.filter((old) => old.verb !== rule.verb), rule];
          await sign({ path: data.actsPath, type: data.actTypes.rules, payload: { rules, proposal: id } }, true);
        }
        approved += 1;
      }
      if (approved) location.reload();
    } catch (error) {
      fail(approved ? new Error(approved + " approved, and then: " + (error && error.message || error) + " Load the page again to see what waits.") : error);
    }
  });
  // A no takes the session alone: a proposal holds nothing, so nothing is let through.
  proposals.querySelector("[data-reject]").addEventListener("click", async () => {
    try {
      const ids = chosen().map((proposal) => proposal.id);
      if (!ids.length) return noneChosen();
      for (const id of ids) {
        const answer = await fetch("${PROPOSALS_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reject: id }) });
        if (!answer.ok) throw new Error((await answer.json()).error);
      }
      location.reload();
    } catch (error) {
      fail(error);
    }
  });
}
// THE LOCK IS CONFIRMED IN A DIALOG that says what the press means. The button beside the state
// opens it; Cancel and Escape close it; its own button signs. What goes wrong is said in the
// dialog, which stays open: the page's own failure line is behind it.
for (const opener of document.querySelectorAll("[data-opens]"))
  opener.addEventListener("click", () => document.getElementById(opener.dataset.opens).showModal());
for (const dialog of document.querySelectorAll("dialog")) {
  const said = dialog.querySelector("[data-dialog-failure]");
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-lock]").addEventListener("click", (event) =>
    sign({ path: data.actsPath, type: event.target.dataset.lock }).catch((error) => {
      said.textContent = String(error && error.message || error);
      said.hidden = false;
    }));
}

if (wanted) document.getElementById("act-" + wanted)?.scrollIntoView({ block: "center" });
`;
