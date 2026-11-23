// minds-page.ts — /minds: THE MINDS THIS MIND LETS IN, for a member. Each row is a `mind_melds`
// row (./minds.ts), the copy of the latest `events.iterate.com/mind-meld/configured` rule that a
// member signed. The list needs no script. The two presses do: a member's passkey here signs the
// rule (./signed-change.ts `signScript`), and the page posts it to `/statements` (./statements.ts),
// as any signed statement. Each rule is on `/minds/<the mind's id>` and names the hostname the
// member saw. To end a meld is the rule `{ append: [], name }`. To let a mind in is the one
// default rule, `{ append: ["/minds/<id>/"], name }`: a wider rule is an agent's proposal.
import { identityKeyIdOf } from "iterate/mind-identity";
import { publishedMindOf } from "iterate/mind-identity-log";
import { isMindControlPlaneHostname, isMindId, STATEMENTS_PATH } from "iterate/signed";
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
  const domain = url.searchParams.get("domain") || "";
  const expectedMind = url.searchParams.get("mind") ?? "";
  const prefill =
    isMindControlPlaneHostname(domain) && (!url.searchParams.has("mind") || isMindId(expectedMind))
      ? { domain, expectedMind }
      : { domain: "", expectedMind: "" };
  if (!session) {
    const query = new URLSearchParams();
    if (prefill.domain) query.set("domain", prefill.domain);
    if (prefill.expectedMind) query.set("mind", prefill.expectedMind);
    return new Response(null, {
      status: 303,
      headers: {
        location: signInHref(query.size ? `${MINDS_PATH}?${query}` : MINDS_PATH),
        "cache-control": "no-store",
      },
    });
  }
  const mind = configOf(env).controlPlaneHostname;
  if (!member) return notMemberPage({ mind, email: session.email });
  return mindsPage(env, mind, prefill);
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

async function mindsPage(
  env: Env,
  mind: string,
  prefill: { domain: string; expectedMind: string },
): Promise<Response> {
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
        <span class="muted">signed with ${row.key ? `the key ${text(row.key.slice(0, 8))}` : "its published keys"}. Let in by ${text(row.email || "a member")}, ${minute(row.configured_at)}.</span>
        ${refused?.mind ? `<span><strong>At ${minute(refused.at)} this domain served another mind</strong>, id <code>${text(refused.mind)}</code>, which was refused. If you mean that mind, press End and let it in again.</span>` : ""}
        <button type="button" class="link" data-end="${text(row.domain)}" data-mind="${text(row.mind || "")}">End</button>
      </li>`;
  };
  const letIn = `<h2>Let a mind in</h2>
      <form id="let-in" class="stack" data-expected-mind="${text(prefill.expectedMind)}">
        <label>The other mind's domain <input name="domain" autocomplete="off" required placeholder="example.com" value="${text(prefill.domain)}"></label>
        <button type="submit">Look it up</button>
      </form>
      <div id="found" hidden>
        <p>Allow <strong data-domain></strong> to append events under <code data-path></code> in this mind?</p>
        <p>Mind ID <code data-mind></code>. Its keys: <span data-keys></span>.</p>
        <button type="button">Allow with passkey</button>
      </div>
      <p id="status" class="muted" role="status">Each change asks for your passkey.</p>`;
  return page({
    title: `Minds that ${mind} lets in`,
    wide: true,
    body: `<h1>Minds that ${text(mind)} lets in</h1>
      ${prefill.domain ? letIn : ""}
      ${
        melds.length
          ? `<ul>${melds.map(meldItem).join("")}</ul>`
          : `<p class="muted">None yet. A mind that you let in can add events to this one, only where you sign for.</p>`
      }
      ${
        ended.length
          ? `<h2>Ended</h2>
      <ul>${ended.map((row) => `<li>${text(row.domain)} <span class="muted">ended ${minute(row.configured_at)}.</span></li>`).join("")}</ul>`
          : ""
      }
      ${prefill.domain ? "" : letIn}`,
    script: `${signScript(mind)}${MINDS_SCRIPT}`,
  });
}

/** WHICH MIND A ROW LETS IN, in words: the id a member's rule named; or, for a rule by hostname
 *  that named a hostname alone, the id that the hostname served at its first use (trust on first
 *  use, so the owner can see it and end it), or that none is pinned yet. */
function idWords(row: MeldRow) {
  if (!row.mind) return `<span class="muted">No id yet: its first signed event fixes it.</span>`;
  const id = `<code>${text(row.mind)}</code>`;
  return row.pinned_at
    ? `<span>id ${id}, fixed when it first signed, ${minute(row.pinned_at)}.</span>`
    : `<span>id ${id}</span>`;
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
  location.replace("${MINDS_PATH}");
}
// a row by hostname with no id yet: the id that its hostname serves now is the one it ends
for (const end of document.querySelectorAll("button[data-end]"))
  end.addEventListener("click", () =>
    (async () => signedRule(end.dataset.mind || (await published(end.dataset.end)).mind, end.dataset.end, []))()
      .catch((error) => said(error, "The meld did not end.")));
const form = document.getElementById("let-in");
const found = document.getElementById("found");
const requestedDomain = form.domain.defaultValue;
const expectedMind = form.dataset.expectedMind;
let lookup = 0;
let review;
function clearReview() {
  review = undefined;
  found.hidden = true;
  return ++lookup;
}
form.addEventListener("input", clearReview);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const current = clearReview();
  const domain = form.domain.value.trim().toLowerCase();
  statusSay(status, "Reading the keys that " + domain + " publishes…");
  try {
    const answer = await published(domain);
    if (current !== lookup) return;
    const mind = answer.mind;
    if (domain === requestedDomain && expectedMind && mind !== expectedMind)
      throw new Error("This domain publishes a different mind ID from the one in the link.");
    const path = "/minds/" + mind + "/";
    found.querySelector("[data-domain]").textContent = domain;
    found.querySelector("[data-mind]").textContent = mind;
    found.querySelector("[data-keys]").textContent = answer.keys.length ? answer.keys.map((key) => key.key.slice(0, 8)).join(", ") : "none that sign statements yet";
    found.querySelector("[data-path]").textContent = path;
    review = { domain, mind, path };
    found.hidden = false;
    statusSay(status, "Letting it in asks for your passkey.");
  } catch (error) {
    if (current === lookup) said(error, "The keys could not be read.");
  }
});
found.querySelector("button").addEventListener("click", () => {
  if (!review) return;
  return signedRule(review.mind, review.domain, [review.path]).catch((error) => said(error, "The mind was not let in."));
});
if (requestedDomain) form.requestSubmit();`;
