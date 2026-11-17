// minds-page.ts — /minds: THE MINDS THIS MIND LETS IN, for a member. Each row is a `mind_melds`
// row (./minds.ts), the copy of the latest `events.iterate.com/mind-meld/configured` rule that a
// member signed. The list needs no script. The two presses do: a member's passkey here signs the
// rule (./signed-change.ts `signScript`), and the page posts it to `/statements` (./statements.ts),
// as any signed statement. To end a meld is the rule `{ append: [] }`. To let a mind in is the one
// default rule, `{ append: ["/minds/<domain>/"] }`: a wider rule is an agent's proposal.
import { isMindDomain, publishedMindOf, STATEMENTS_PATH } from "iterate/signed";
import { z } from "zod";
import { sessionOf } from "./cookies.ts";
import { type Env, iterateConfigOf } from "./env.ts";
import { passkeyOwedResponse, standingOf } from "./members.ts";
import { notMemberPage, page, text } from "./pages.ts";
import { minute } from "./sessions-page.ts";
import { signInHref } from "./sign-in.ts";
import { signScript } from "./signed-change.ts";

export const MINDS_PATH = "/minds";
const PUBLISHED_PATH = "/minds/published";

type MeldRow = {
  domain: string;
  append: string;
  key: string | null;
  configured_at: number;
  email: string | null;
};

export async function mindsPageResponse(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== MINDS_PATH && url.pathname !== PUBLISHED_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405 });
  const published = url.pathname === PUBLISHED_PATH;
  const session = await sessionOf(env, request);
  const standing = session ? await standingOf(env, session) : "not-member";
  if (published) {
    if (standing !== "member") return Response.json({ why: "a member's session" }, { status: 403 });
    return publishedResponse(env, url.searchParams.get("domain") || "");
  }
  if (!session)
    return new Response(null, {
      status: 303,
      headers: { location: signInHref(MINDS_PATH), "cache-control": "no-store" },
    });
  const { domain } = iterateConfigOf(env);
  if (standing === "not-member") return notMemberPage({ domain, email: session.email });
  if (standing === "passkey-owed") return passkeyOwedResponse(MINDS_PATH);
  return mindsPage(env, domain);
}

/** What the mind at `domain` publishes, for the page to show before the press: its keys' ids and
 *  labels, never more, or why there are none. */
async function publishedResponse(env: Env, domain: string): Promise<Response> {
  if (!isMindDomain(domain) || domain === iterateConfigOf(env).domain)
    return Response.json({ why: "name another mind by its domain" }, { status: 400 });
  const document = await publishedMindOf(domain, (request) => fetch(request));
  if ("why" in document) return Response.json(document, { status: 502 });
  return Response.json({
    mind: document.mind,
    keys: document.keys.map(({ key, label }) => ({ key, label })),
  });
}

async function mindsPage(env: Env, domain: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select m.domain, m.append, m.key, m.configured_at, u.email
       from mind_melds m left join users u on u.id = m.configured_by order by m.domain`,
  ).all<MeldRow>();
  const melds = results.filter((row) => row.append !== "[]");
  const ended = results.filter((row) => row.append === "[]");
  const meldItem = (row: MeldRow) => {
    const append = z.array(z.string()).parse(JSON.parse(row.append));
    return `<li><strong>${text(row.domain)}</strong>
        <span>may add events under ${append.map((path) => `<code>${text(path)}</code>`).join(", ")}</span>
        <span class="muted">signed with ${row.key ? `the key ${text(row.key.slice(0, 8))}` : "its published keys"}. ${text(row.email || "A member")} let it in at ${minute(row.configured_at)}.</span>
        <button type="button" class="link" data-end="${text(row.domain)}">End</button>
      </li>`;
  };
  return page({
    title: `Minds that ${domain} lets in`,
    wide: true,
    body: `<h1>Minds that ${text(domain)} lets in</h1>
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
        <p><strong data-domain></strong> publishes the keys <span data-keys></span>.</p>
        <p data-rule></p>
        <button type="button">Let it in</button>
      </div>
      <p id="status" class="muted" role="status">Your passkey signs each change.</p>`,
    script: `${signScript(domain)}${MINDS_SCRIPT}`,
  });
}

const MINDS_SCRIPT = `
const status = document.getElementById("status");
const said = (error, fallback) => {
  status.textContent = error.name === "NotAllowedError" ? "No passkey was used, so nothing was changed." : error.message || fallback;
};
async function signedRule(domain, append) {
  status.textContent = "Waiting for your passkey…";
  const signed = await signedStatement({ path: "/minds/" + domain, type: "events.iterate.com/mind-meld/configured", payload: { append } });
  const answer = await fetch("${STATEMENTS_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
  if (!answer.ok) throw new Error((await answer.json().catch(() => ({}))).refused || "The rule was not taken.");
  location.reload();
}
for (const end of document.querySelectorAll("button[data-end]"))
  end.addEventListener("click", () => signedRule(end.dataset.end, []).catch((error) => said(error, "The meld did not end.")));
const form = document.getElementById("let-in");
const found = document.getElementById("found");
let domain;
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  found.hidden = true;
  const typed = form.domain.value.trim().toLowerCase();
  domain = typed;
  status.textContent = "Reading the keys that " + domain + " publishes…";
  try {
    const answer = await (await fetch("${PUBLISHED_PATH}?" + new URLSearchParams({ domain }))).json();
    // a later submit asked for another mind: this answer is not for what the page now shows
    if (domain !== typed) return;
    if (answer.why) throw new Error(answer.why);
    found.querySelector("[data-domain]").textContent = domain;
    found.querySelector("[data-keys]").textContent = answer.keys.map((key) => key.key.slice(0, 8)).join(", ");
    found.querySelector("[data-rule]").textContent = domain + " may add events under /minds/" + domain + "/ of this mind, and nothing else.";
    found.hidden = false;
    status.textContent = "Your passkey signs this.";
  } catch (error) {
    if (domain === typed) said(error, "The keys could not be read.");
  }
});
found.querySelector("button").addEventListener("click", () => signedRule(domain, ["/minds/" + domain + "/"]).catch((error) => said(error, "The mind was not let in.")));`;
