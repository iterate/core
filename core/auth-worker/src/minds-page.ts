// minds-page.ts — /minds: THE MINDS THIS MIND LETS IN, for a member. Each row is a `mind_melds`
// row (./minds.ts), the copy of the latest `events.iterate.com/mind-meld/configured` rule that a
// member signed. The list needs no script. The two presses do: a member's passkey here signs the
// rule (./signed-change.ts `signScript`), and the page posts it to `/statements` (./statements.ts),
// as any signed statement. Each rule is on `/minds/<the mind's id>` and names the hostname the
// member saw. To end a meld is the rule `{ append: [], name }`. To let a mind in is the one
// default rule, `{ append: ["/minds/<id>/"], name }`: a wider rule is an agent's proposal.
import { identityKeyIdOf } from "iterate/mind-identity";
import { publishedMindOf } from "iterate/mind-identity-log";
import { isMindControlPlaneHostname, STATEMENTS_PATH } from "iterate/signed";
import { z } from "zod";
import { sessionOf } from "./cookies.ts";
import { configOf, type Env } from "./env.ts";
import { isMember } from "./members.ts";
import { notMemberPage, page, text } from "./pages.ts";
import { minute } from "./sessions-page.ts";
import { signInHref } from "./sign-in.ts";
import { signScript } from "./signed-change.ts";

export const MINDS_PATH = "/minds";
const PUBLISHED_PATH = "/minds/published";

type MeldRow = {
  domain: string;
  mind: string | null;
  append: string;
  key: string | null;
  configured_at: number;
  pinned_at: number | null;
  refused: string | null;
  email: string | null;
};

export async function mindsPageResponse(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== MINDS_PATH && url.pathname !== PUBLISHED_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405 });
  const published = url.pathname === PUBLISHED_PATH;
  const session = await sessionOf(env, request);
  const member = session ? await isMember(env, session.email) : false;
  if (published) {
    if (!member) return Response.json({ why: "a member's session" }, { status: 403 });
    return publishedResponse(env, url.searchParams.get("domain") || "");
  }
  if (!session)
    return new Response(null, {
      status: 303,
      headers: { location: signInHref(MINDS_PATH), "cache-control": "no-store" },
    });
  const mind = configOf(env).controlPlaneHostname;
  if (!member) return notMemberPage({ mind, email: session.email });
  return mindsPage(env, mind);
}

/** What the identity log of the mind at `domain` lists, for the page to show before the press:
 *  the mind's id, and the ids and labels of the working keys that sign statements, never more,
 *  or why there are none. A key of another purpose signs no statement, so the page does not
 *  show it as one that a meld would follow. */
async function publishedResponse(env: Env, domain: string): Promise<Response> {
  if (!isMindControlPlaneHostname(domain) || domain === configOf(env).controlPlaneHostname)
    return Response.json({ why: "name another mind by its domain" }, { status: 400 });
  const published = await publishedMindOf(domain, (request) => fetch(request));
  if ("why" in published) return Response.json(published, { status: 502 });
  return Response.json({
    mind: published.expected,
    keys: await Promise.all(
      published.current.workingKeys
        .filter(({ purpose }) => purpose === "statements")
        .map(async ({ publicKey, label }) => ({ key: await identityKeyIdOf(publicKey), label })),
    ),
  });
}

async function mindsPage(env: Env, mind: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select m.domain, m.mind, m.append, m.key, m.configured_at, m.pinned_at, m.refused, u.email
       from mind_melds m left join users u on u.id = m.configured_by order by m.domain`,
  ).all<MeldRow>();
  const melds = results.filter((row) => row.append !== "[]");
  const ended = results.filter((row) => row.append === "[]");
  const meldItem = (row: MeldRow) => {
    const append = z.array(z.string()).parse(JSON.parse(row.append));
    const refused = row.refused ? Refused.safeParse(JSON.parse(row.refused)).data : undefined;
    return `<li><strong>${text(row.domain)}</strong> ${idWords(row)}
        <span>may add events under ${append.map((path) => `<code>${text(path)}</code>`).join(", ")}</span>
        <span class="muted">signed with ${row.key ? `the key ${text(row.key.slice(0, 8))}` : "its published keys"}. ${text(row.email || "A member")} let it in at ${minute(row.configured_at)}.</span>
        ${refused?.mind ? `<span><strong>At ${minute(refused.at)} ${text(row.domain)} served another mind</strong>, the id <code>${text(refused.mind)}</code>, which is refused here. If that mind is the one you mean, End this and let it in again.</span>` : ""}
        <button type="button" class="link" data-end="${text(row.domain)}" data-mind="${text(row.mind || "")}">End</button>
      </li>`;
  };
  return page({
    title: `Minds that ${mind} lets in`,
    wide: true,
    body: `<h1>Minds that ${text(mind)} lets in</h1>
      ${
        melds.length
          ? `<ul>${melds.map(meldItem).join("")}</ul>`
          : `<p class="muted">No mind is let in. A meld lets another mind add events to this one, under the contexts that a member's passkey names, and an agent of this mind can ask you for one.</p>`
      }
      ${
        ended.length
          ? `<h2>Melds that ended</h2>
      <ul>${ended.map((row) => `<li>${text(row.domain)} <span class="muted">ended at ${minute(row.configured_at)}.</span></li>`).join("")}</ul>`
          : ""
      }
      <h2>Let a mind in</h2>
      <form id="let-in" class="stack">
        <label>The other mind's domain <input name="domain" autocomplete="off" required placeholder="example.com"></label>
        <button type="submit">Read its keys</button>
      </form>
      <div id="found" hidden>
        <p><strong data-domain></strong> is the mind <code data-mind></code> and publishes the keys <span data-keys></span>.</p>
        <p data-rule></p>
        <button type="button">Let it in</button>
      </div>
      <p id="status" class="muted" role="status">Your passkey signs each change.</p>`,
    script: `${signScript(mind)}${MINDS_SCRIPT}`,
  });
}

/** WHICH MIND A ROW LETS IN, in words: the id a member's rule named; or, for a rule by hostname
 *  that named a hostname alone, the id that the hostname served at its first use (trust on first
 *  use, so the owner can see it and end it), or that none is pinned yet. */
function idWords(row: MeldRow) {
  if (!row.mind)
    return `<span class="muted">No id yet: the first statement it signs pins it to the id that ${text(row.domain)} serves then.</span>`;
  const id = `<code>${text(row.mind)}</code>`;
  return row.pinned_at
    ? `<span>the id ${id}, pinned to the id that this hostname served on ${minute(row.pinned_at)}.</span>`
    : `<span>the id ${id}</span>`;
}

const Refused = z.object({ mind: z.string().nullable(), at: z.number() });

const MINDS_SCRIPT = `
const status = document.getElementById("status");
const said = (error, fallback) => {
  statusFailed(status, error, fallback, "No passkey was used, so nothing was changed.");
};
async function published(domain) {
  const answer = await (await fetch("${PUBLISHED_PATH}?" + new URLSearchParams({ domain }))).json();
  if (answer.why) throw new Error(answer.why);
  return answer;
}
async function signedRule(mind, name, append) {
  statusSay(status, "Waiting for your passkey…");
  const signed = await signedStatement({ path: "/minds/" + mind, type: "events.iterate.com/mind-meld/configured", payload: { append, name } });
  const answer = await fetch("${STATEMENTS_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
  if (!answer.ok) throw new Error((await answer.json().catch(() => ({}))).refused || "The rule was not taken.");
  location.reload();
}
// a row by hostname with no id yet: the id that its hostname serves now is the one it ends
for (const end of document.querySelectorAll("button[data-end]"))
  end.addEventListener("click", () =>
    (async () => signedRule(end.dataset.mind || (await published(end.dataset.end)).mind, end.dataset.end, []))()
      .catch((error) => said(error, "The meld did not end.")));
const form = document.getElementById("let-in");
const found = document.getElementById("found");
let domain;
let mind;
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  found.hidden = true;
  const typed = form.domain.value.trim().toLowerCase();
  domain = typed;
  statusSay(status, "Reading the keys that " + domain + " publishes…");
  try {
    const answer = await published(domain);
    // a later submit asked for another mind: this answer is not for what the page now shows
    if (domain !== typed) return;
    mind = answer.mind;
    found.querySelector("[data-domain]").textContent = domain;
    found.querySelector("[data-mind]").textContent = mind;
    found.querySelector("[data-keys]").textContent = answer.keys.length ? answer.keys.map((key) => key.key.slice(0, 8)).join(", ") : "none that sign statements yet";
    found.querySelector("[data-rule]").textContent = domain + " may add events under /minds/" + mind + "/ of this mind, and nothing else.";
    found.hidden = false;
    statusSay(status, "Your passkey signs this.");
  } catch (error) {
    if (domain === typed) said(error, "The keys could not be read.");
  }
});
found.querySelector("button").addEventListener("click", () => signedRule(mind, domain, ["/minds/" + mind + "/"]).catch((error) => said(error, "The mind was not let in.")));`;
