import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { base64url, challengeOf, keyIdOf, statementText } from "iterate/signed";
import { expect, test } from "vitest";
import type { Env } from "./env.ts";
import { text } from "./pages.ts";
import { configVars } from "./test-support.ts";
import { proposeStatement, statementDraftsResponse } from "./statement-drafts.ts";
import { OUTSIDER_STATEMENTS_AN_HOUR, statementsResponse } from "./statements.ts";

const MIND = "iterate.example.com";
const ISSUER = `https://${MIND}`;
const MEMBER = "owner@example.net";
const STRANGER = "stranger@example.net";
const TYPE = "demo/statement-asked";
const PAYLOAD = { append: ["/minds/example.org/"], note: "<b>bold</b>" };
/** The help of the row "Asked by" for a person or a mind, and for code. */
const RECORDED = "Who asked for this signature, as the platform recorded it.";
const CODE_HELP =
  "The platform recorded the context that this code ran in. It cannot tell whether a person asked for it.";

test("a proposed draft is shown on its page, every value as text", async () => {
  const { env } = await stack();
  const { draft, signAt } = await proposed(env, { from: "/agents/<onboarding>" });
  expect(signAt).toBe(`${ISSUER}/statements/sign?draft=${draft}`);
  const page = await statementDraftsResponse(env, new Request(signAt));
  const html = await page!.text();
  expect(page!).toMatchObject({ status: 200 });
  expect(html).toContain(
    `<p>Code wants to add this event to ${MIND}, with you as its signer. It needs your signature.</p>`,
  );
  expect(html).toContain(row("Context", "<code>/minds/example.com</code>"));
  expect(html).toContain(row("Event type", `<code>${TYPE}</code>`));
  expect(html).toContain(
    row("Asked by", "Code running in <code>/agents/&#60;onboarding&#62;</code>", CODE_HELP),
  );
  expect(html).toContain("<dt>Field note</dt><dd>&#60;b&#62;bold&#60;/b&#62;</dd>");
  expect(html).not.toContain("<b>bold");
});

test("a member's press lands the event with the member as its signer, and the draft is gone", async () => {
  const { env, passkeys } = await stack();
  const { draft } = await proposed(env, { next: "https://dash.example.com/" });
  const answer = await pressed(env, draft, passkeys[MEMBER]);
  expect(answer).toMatchObject({ status: 200 });
  expect(await answer.json()).toMatchObject({
    path: "/minds/example.com",
    type: TYPE,
    next: "https://dash.example.com/",
  });
  expect(decodeFacts(answer.headers.get(FACTS_HEADER) || "")).toMatchObject([
    {
      path: "/minds/example.com",
      storeFirst: true,
      events: [
        {
          type: TYPE,
          payload: PAYLOAD,
          source: {
            signer: { principal: { email: MEMBER }, key: passkeys[MEMBER].id, member: true },
          },
        },
      ],
    },
  ]);
  // a second press finds no draft, and adds nothing
  const again = await pressed(env, draft, passkeys[MEMBER]);
  expect({ status: again.status, facts: again.headers.get(FACTS_HEADER) }).toEqual({
    status: 404,
    facts: null,
  });
  const page = await statementDraftsResponse(
    env,
    new Request(`${ISSUER}/statements/sign?draft=${draft}`),
  );
  expect(page!).toMatchObject({ status: 404 });
});

test("a statement that differs from the draft is refused", async () => {
  const { env, passkeys } = await stack();
  const { draft } = await proposed(env);
  const answer = await pressed(env, draft, passkeys[MEMBER], { payload: { append: ["/"] } });
  expect({ status: answer.status, body: await answer.json() }).toEqual({
    status: 403,
    body: { refused: "the statement is not the one this link shows" },
  });
});

test("a non-member's passkey adds nothing, and the draft waits on", async () => {
  const { env, passkeys } = await stack();
  const { draft } = await proposed(env);
  const answer = await pressed(env, draft, passkeys[STRANGER]);
  expect({ status: answer.status, body: await answer.json() }).toEqual({
    status: 403,
    body: {
      refused: `${STRANGER} is not a member here, so its key signs only at its own context, /people/${STRANGER}`,
    },
  });
  expect(await pressed(env, draft, passkeys[MEMBER])).toMatchObject({ status: 200 });
});

// ./keys.ts `personKeyRefusal`: someone who is no member signs a statement about themselves alone.
test("someone who is no member signs at their own context, and at another person's is refused", async () => {
  const { env, passkeys } = await stack();
  const at = async (path: string) => {
    const { draft } = await proposed(env, { path });
    const answer = await pressed(env, draft, passkeys[STRANGER], { path });
    return { status: answer.status, facts: decodeFacts(answer.headers.get(FACTS_HEADER) || "") };
  };
  expect(await at(`/people/${STRANGER}`)).toMatchObject({
    status: 200,
    facts: [
      {
        path: `/people/${STRANGER}`,
        events: [
          // the stamp says that no member signed: a reader cannot take this for a member's word
          { type: TYPE, source: { signer: { principal: { email: STRANGER }, member: false } } },
        ],
      },
    ],
  });
  expect(await at(`/people/${MEMBER}`)).toEqual({ status: 403, facts: [] });
  expect(await at(`/people/${STRANGER}/inbox`)).toEqual({ status: 403, facts: [] });
});

// The stranger here holds a passkey from when the address was a member's, as a removed member
// does: on every mind, such a key signs at its own context alone, like any non-member's.
const OWN = `/people/${STRANGER}`;

test.for([
  ["another context", "/agents/one", TYPE],
  ["their address in capitals", `/people/${STRANGER.toUpperCase()}`, TYPE],
  ["their context with a slash after it", `${OWN}/`, TYPE],
  ["their address with %40", `/people/${STRANGER.replace("@", "%40")}`, TYPE],
  [
    "a type of the platform's, at their own context",
    OWN,
    "events.iterate.com/account/member-added",
  ],
] as const)(
  "someone who is no member, with no draft, adds nothing at %s",
  async ([, path, type]) => {
    const { env, passkeys } = await stack();
    expect(await sent(env, passkeys[STRANGER], { path, type })).toMatchObject({
      status: 403,
      facts: [],
    });
    expect(await sent(env, passkeys[STRANGER], { path: OWN })).toMatchObject({ status: 200 });
  },
);

test("a blocked person's passkey signs nothing, with a draft or without, until an owner unblocks them", async () => {
  const { env, db, passkeys } = await stack();
  db.prepare("insert into blocked (email, blocked_by, blocked_at) values (?, ?, ?)").run(
    STRANGER,
    MEMBER,
    Date.now(),
  );
  const refusal = { refused: `${STRANGER} is blocked here, so its key signs nothing` };
  const { draft } = await proposed(env, { path: OWN });
  const press = await pressed(env, draft, passkeys[STRANGER], { path: OWN });
  expect({
    pressed: [press.status, await press.json()],
    sent: await sent(env, passkeys[STRANGER], { path: OWN }),
  }).toEqual({ pressed: [403, refusal], sent: { status: 403, body: refusal, facts: [] } });
  db.prepare("delete from blocked").run();
  expect(await sent(env, passkeys[STRANGER], { path: OWN })).toMatchObject({ status: 200 });
});

test("what someone who is no member signs is at most 64 KiB, and a member's is not bounded here", async () => {
  const { env, passkeys } = await stack();
  const big = { path: OWN, payload: { text: "x".repeat(64 * 1024) } };
  expect(await sent(env, passkeys[STRANGER], big)).toEqual({
    status: 413,
    body: {
      refused:
        "a statement of someone who is no member here holds a payload of at most 64 KiB of JSON",
    },
    facts: [],
  });
  expect(await sent(env, passkeys[MEMBER], big)).toMatchObject({ status: 200 });
});

test("one key of someone who is no member signs a bounded number of statements an hour; the same one again is taken", async () => {
  const { env, passkeys } = await stack();
  const numbered = (n: number) => sent(env, passkeys[STRANGER], { path: OWN, payload: { n } });
  const first = await signedBy(passkeys[STRANGER], { path: OWN });
  const envelope = {
    statement: first.statement,
    signature: { format: "webauthn", key: passkeys[STRANGER].id, ...first.signature },
  };
  const statuses = [(await posted(env, envelope)).status];
  for (let n = 1; n < OUTSIDER_STATEMENTS_AN_HOUR; n++) statuses.push((await numbered(n)).status);
  expect(new Set(statuses)).toEqual(new Set([200]));
  // at the bound, a statement that came before is taken again: a sender that got no 200 sends it
  // again, and the log keeps its event once
  expect(await posted(env, envelope)).toMatchObject({ status: 200 });
  expect(await numbered(OUTSIDER_STATEMENTS_AN_HOUR)).toEqual({
    status: 429,
    body: {
      refused: `this key signed ${OUTSIDER_STATEMENTS_AN_HOUR} statements in the last hour, the most for someone who is no member here. Try again later`,
    },
    facts: [],
  });
  // a member's key is not counted
  for (let n = 0; n <= OUTSIDER_STATEMENTS_AN_HOUR; n++)
    await sent(env, passkeys[MEMBER], { path: OWN, payload: { n } });
  expect(await sent(env, passkeys[MEMBER], { path: OWN })).toMatchObject({ status: 200 });
});

test("a member signs at someone else's own context too", async () => {
  const { env, passkeys } = await stack();
  const path = `/people/${STRANGER}`;
  const { draft } = await proposed(env, { path });
  expect(await pressed(env, draft, passkeys[MEMBER], { path })).toMatchObject({ status: 200 });
});

test("a mind meld is a member's alone, at a non-member's own context too", async () => {
  const { env, passkeys } = await stack();
  const changed = { path: `/people/${STRANGER}`, type: "events.iterate.com/mind-meld/configured" };
  const { draft } = await proposed(env, changed);
  const answer = await pressed(env, draft, passkeys[STRANGER], changed);
  expect({ status: answer.status, body: await answer.json() }).toEqual({
    status: 403,
    body: { refused: "only a member's passkey sets a mind meld" },
  });
});

test("a draft that names its signer shows them, and takes their passkey alone", async () => {
  const { env, passkeys } = await stack();
  const path = `/people/${STRANGER}`;
  // the agent may write the address as the mail did: the draft keeps the one path that signs
  const { draft, signAt } = await proposed(env, {
    path: `/people/${STRANGER.toUpperCase()}`,
    signerEmail: ` ${STRANGER.toUpperCase()}`,
  });
  const html = await (await statementDraftsResponse(env, new Request(signAt)))!.text();
  expect(html).toContain(
    row(
      "Signer",
      `<strong>${STRANGER}</strong>`,
      "Only a passkey of this person can sign this statement.",
    ),
  );
  // no page lets a person who is no member add a first passkey (./enrolment.ts is for members), so the draft links to none
  expect(html).not.toContain("add one");
  const byMember = await pressed(env, draft, passkeys[MEMBER], { path });
  expect({ status: byMember.status, body: await byMember.json() }).toEqual({
    status: 403,
    body: {
      refused: `only ${STRANGER} signs this statement`,
      say: `That passkey is ${MEMBER}'s. This statement is for ${STRANGER}: sign again with that passkey.`,
    },
  });
  expect(await pressed(env, draft, passkeys[STRANGER], { path })).toMatchObject({ status: 200 });
});

test("a press that names a passkey it cannot prove it holds is told no address but the signer's", async () => {
  const { env, passkeys } = await stack();
  const path = `/people/${STRANGER}`;
  const { draft } = await proposed(env, { path, signerEmail: STRANGER });
  // the member's credential id, with a signature that the member's key did not make
  const forged = { ...passkeys[MEMBER], privateKey: passkeys[STRANGER].privateKey };
  const answer = await pressed(env, draft, forged, { path });
  expect(await answer.json()).toEqual({
    refused: `only ${STRANGER} signs this statement`,
    say: `That passkey cannot sign this. This statement is for ${STRANGER}: sign again with that passkey.`,
  });
});

test("a press on a link that is closed says so, and what to do next", async () => {
  const { env, passkeys } = await stack();
  const answer = await pressed(env, "no-such-draft", passkeys[MEMBER]);
  expect({ status: answer.status, body: await answer.json() }).toEqual({
    status: 404,
    body: {
      refused: "this link has ended",
      say: "Not signed: this link was used, or its 24 hours are over. Ask for a new link.",
    },
  });
});

test("a meld rule of this mind with itself is not explained as a grant, and its press is refused", async () => {
  const { env, passkeys } = await stack();
  const changed = {
    path: `/minds/${"a".repeat(64)}`,
    type: MELD,
    payload: { append: ["/"], name: "peer.example.org" },
  };
  const html = await pageOf(env, changed);
  expect(html).not.toContain("Let the mind");
  expect(html).toContain(
    "<p><strong>Your signature would be refused:</strong> a mind does not meld with itself.</p>",
  );
  // not explained, so the page shows the type and each field as a row
  expect(html).toContain(row("Event type", `<code>${MELD}</code>`));
  expect(html).toContain("<dt>Field append</dt><dd><pre>[\n  &#34;/&#34;\n]</pre></dd>");
  expect(html).toContain("<dt>Field name</dt><dd>peer.example.org</dd>");
  const { draft } = await proposed(env, changed);
  const answer = await pressed(env, draft, passkeys[MEMBER], changed);
  expect({ status: answer.status, body: await answer.json() }).toEqual({
    status: 403,
    body: { refused: "a mind does not meld with itself" },
  });
});

test("an expired draft has ended", async () => {
  const { env, db, passkeys } = await stack();
  const { draft } = await proposed(env);
  db.prepare("update statement_drafts set expires = ?").run(Date.now() - 1);
  const page = await statementDraftsResponse(
    env,
    new Request(`${ISSUER}/statements/sign?draft=${draft}`),
  );
  expect(page!).toMatchObject({ status: 404 });
  expect(await page!.text()).toContain(
    "It was used, or its 24 hours are over. If you signed with it, your signature counted. To sign again, ask for a new link.",
  );
  expect(await pressed(env, draft, passkeys[MEMBER])).toMatchObject({ status: 404 });
});

test.for([
  ["a platform type", { type: "events.iterate.com/account/member-added" }],
  ["a path with a dot segment", { path: "/integrations/../secrets" }],
  ["a payload that is a list", { payload: [] as unknown as Record<string, unknown> }],
  ["a next on another host", { next: "https://evil.example/" }],
  ["a next that is no https URL", { next: "http://dash.example.com/" }],
] as const)("a draft with %s is refused", async ([, input]) => {
  const { env } = await stack();
  await expect(proposed(env, input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

const MELD = "events.iterate.com/mind-meld/configured";
/** Another mind's id, an obvious fake. */
const PEER = "b".repeat(64);

test("a meld rule is said in words, each context on its own line, and the exact text is closed under them", async () => {
  const { env } = await stack();
  const html = await pageOf(env, {
    path: `/minds/${PEER}`,
    type: MELD,
    payload: { append: [`/minds/${PEER}/`, "/"], name: "peer.example.org" },
  });
  expect(html).toContain(
    `<p>Let the mind <strong>peer.example.org</strong> (id <code>${PEER.slice(0, 12)}…</code>) add events to iterate.example.com, in these contexts and below:</p>`,
  );
  expect(html).toContain(
    `<ul><li><code>/minds/${PEER}/</code></li><li><code>/</code> (everything in the mind)</li></ul>`,
  );
  expect(html).toContain("It signs each event with any key that it publishes.");
  expect(html).toContain(row("Event type", `<code>${MELD}</code>`));
  expect(html).toContain("<details>\n        <summary>The exact text</summary>");
});

test("an empty meld rule is said as the end of the meld", async () => {
  const { env } = await stack();
  const html = await pageOf(env, {
    path: `/minds/${PEER}`,
    type: MELD,
    payload: { append: [], name: "peer.example.org" },
  });
  expect(html).toContain(
    `<p>Stop the mind <strong>peer.example.org</strong> (id <code>${PEER.slice(0, 12)}…</code>) from adding events to iterate.example.com.</p>`,
  );
});

test("a type that the page does not know is said as an event of that type, each of its fields is a row, and the exact text is under them", async () => {
  const { env } = await stack();
  const html = await pageOf(env, { path: "/", type: TYPE });
  expect(html).toContain(
    `<p>Code wants to add this event to ${MIND}, with you as its signer. It needs your signature.</p>`,
  );
  expect(html).toContain(row("Context", "<code>/</code>"));
  expect(html).toContain(row("Event type", `<code>${TYPE}</code>`));
  // every field of the payload, its value escaped
  expect(html).toContain(
    "<dt>Field append</dt><dd><pre>[\n  &#34;/minds/example.org/&#34;\n]</pre></dd>",
  );
  expect(html).toContain("<dt>Field note</dt><dd>&#60;b&#62;bold&#60;/b&#62;</dd>");
  // the text that the passkey signs is still on the page, closed under the table
  const exact = html.indexOf("<details>\n        <summary>The exact text</summary>");
  expect(exact).toBeGreaterThan(html.indexOf('<dl class="facts">'));
  expect(html.indexOf(`<pre>${text(JSON.stringify(PAYLOAD, null, 2))}</pre>`)).toBeGreaterThan(
    exact,
  );
  expect(html).not.toContain("<details open>");
});

test("a field whose name or value is markup is shown as its characters", async () => {
  const { env } = await stack();
  const html = await pageOf(env, {
    path: "/",
    type: TYPE,
    payload: { "<i>who</i>": '<img src=x onerror="alert(1)">' },
  });
  expect(html).toContain(
    "<dt>Field &#60;i&#62;who&#60;/i&#62;</dt><dd>&#60;img src=x onerror=&#34;alert(1)&#34;&#62;</dd>",
  );
  expect(html).not.toContain("<i>who");
  expect(html).not.toContain("<img");
});

test("a field that is no string is shown as its JSON: a list or an object in a pre", async () => {
  const { env } = await stack();
  const html = await pageOf(env, {
    path: "/",
    type: TYPE,
    payload: { count: 3, on: true, nothing: null, list: [1, "a"], nested: { tag: "<b>" } },
  });
  expect(html).toContain("<dt>Field count</dt><dd><code>3</code></dd>");
  expect(html).toContain("<dt>Field on</dt><dd><code>true</code></dd>");
  expect(html).toContain("<dt>Field nothing</dt><dd><code>null</code></dd>");
  expect(html).toContain("<dt>Field list</dt><dd><pre>[\n  1,\n  &#34;a&#34;\n]</pre></dd>");
  expect(html).toContain(
    "<dt>Field nested</dt><dd><pre>{\n  &#34;tag&#34;: &#34;&#60;b&#62;&#34;\n}</pre></dd>",
  );
});

test("an empty payload says that it has no fields", async () => {
  const { env } = await stack();
  const html = await pageOf(env, { path: "/", type: TYPE, payload: {} });
  expect(html).toContain('<dt>Fields</dt><dd><span class="muted">none</span></dd>');
  expect(html).not.toContain("<dt>Field ");
});

test.for([
  [
    "the mind's own code at its root",
    { from: "/", by: { kind: "code" } },
    "Code running in <code>/</code>",
    CODE_HELP,
  ],
  [
    "a member through an agent",
    { from: "/agents/onboarding", by: { kind: "member", email: MEMBER } },
    `<strong>${MEMBER}</strong>, a member, through the agent <code>/agents/onboarding</code>`,
    RECORDED,
  ],
  [
    "a member at the root",
    { from: "/", by: { kind: "member", email: MEMBER } },
    `<strong>${MEMBER}</strong>, a member, at the root (<code>/</code>)`,
    RECORDED,
  ],
  [
    "someone who is no member",
    { from: "/", by: { kind: "person", email: STRANGER } },
    `<strong>${STRANGER}</strong>, who is not a member, at the root (<code>/</code>)`,
    RECORDED,
  ],
  [
    "a guest, by the name they typed",
    { from: "/", by: { kind: "guest", name: "<Cy>" } },
    "a guest who gave the name &ldquo;&#60;Cy&#62;&rdquo;, at the root (<code>/</code>)",
    `${RECORDED} A guest's name is the guest's own word.`,
  ],
] as const)("a draft that %s proposed names who asked", async ([, input, words, help]) => {
  const { env } = await stack();
  expect(await pageOf(env, input)).toContain(row("Asked by", words, help));
});

test("a draft that the mind's own code proposed names the context that the code ran in, adds no caveat, and its help says the platform cannot tell whether a person asked", async () => {
  const { env } = await stack();
  const html = await pageOf(env, { from: "/agents/onboarding", by: { kind: "code" } });
  expect(html).toContain(
    row("Asked by", "Code running in <code>/agents/onboarding</code>", CODE_HELP),
  );
  expect(html).not.toContain("Maybe no person");
  // with no context recorded, the code is this mind's
  expect(await pageOf(env, { by: { kind: "code" } })).toContain(
    row("Asked by", "Code running in this mind", CODE_HELP),
  );
});

test.for([
  ["code", { by: { kind: "code" } }, "Code"],
  ["code, for a call that names nobody", {}, "Code"],
  ["a member", { by: { kind: "member", email: MEMBER } }, "A member"],
  [
    "a person who is no member",
    { by: { kind: "person", email: STRANGER } },
    "A person who is not a member",
  ],
  ["a guest", { by: { kind: "guest", name: "Cy" } }, "A guest"],
  ["another mind", { by: { kind: "mind", hostname: "peer.example.org" } }, "Another mind"],
] as const)(
  "the page's first sentence names %s as who wants the event, and says that it needs a signature",
  async ([, input, subject]) => {
    const { env } = await stack();
    expect((await pageOf(env, input)).replaceAll(/\s+/g, " ")).toContain(
      `<h1>Sign this statement</h1> <p>${subject} wants to add this event to ${MIND}, with you as its signer. It needs your signature.</p>`,
    );
  },
);

/** A row of the page's table as ./pages.ts `factsTable` draws it: its name, the "?" of its help
 *  beside the name when it has one, and its value. */
function row(label: string, value: string, help?: string) {
  const mark = help
    ? ` <details class="help"><summary aria-label="About ${label}">?</summary><p>${help}</p></details>`
    : "";
  return `<div><dt>${label}${mark}</dt><dd>${value}</dd></div>`;
}

async function pageOf(env: Env, input: Partial<Parameters<typeof proposeStatement>[1]>) {
  const { signAt } = await proposed(env, input);
  return (await statementDraftsResponse(env, new Request(signAt)))!.text();
}

function proposed(env: Env, input: Partial<Parameters<typeof proposeStatement>[1]> = {}) {
  return proposeStatement(env, {
    path: "/minds/example.com",
    type: TYPE,
    payload: PAYLOAD,
    ...input,
  });
}

/** The page's press, as its script sends it: a statement of the draft's values, which `changed`
 *  may spoil or must match when the draft has its own, signed by `passkey` as an authenticator
 *  that checked the person. */
async function pressed(
  env: Env,
  draft: string,
  passkey: Passkey,
  changed: Changed = {},
): Promise<Response> {
  const { statement, signature } = await signedBy(passkey, changed);
  const answer = await statementDraftsResponse(
    env,
    new Request(`${ISSUER}/statements/sign`, {
      method: "POST",
      headers: { origin: ISSUER, "content-type": "application/json" },
      body: JSON.stringify({ draft, statement, credentialId: passkey.credentialId, ...signature }),
    }),
  );
  return answer!;
}

/** What `POST /statements` answers to a statement that `passkey` signed, with no draft: the status,
 *  the body and the facts. */
async function sent(env: Env, passkey: Passkey, changed: Changed = {}) {
  const { statement, signature } = await signedBy(passkey, changed);
  return posted(env, {
    statement,
    signature: { format: "webauthn", key: passkey.id, ...signature },
  });
}

/** What `POST /statements` answers to `envelope`, which a test may send twice. */
async function posted(env: Env, envelope: unknown) {
  const answer = await statementsResponse(
    env,
    new Request(`${ISSUER}/statements`, { method: "POST", body: JSON.stringify(envelope) }),
  );
  return {
    status: answer.status,
    body: await answer.json(),
    facts: decodeFacts(answer.headers.get(FACTS_HEADER) || ""),
  };
}

type Changed = { payload?: Record<string, unknown>; path?: string; type?: string };

/** A statement of the draft's values, which `changed` replaces, and `passkey`'s signature of it. */
async function signedBy(passkey: Passkey, changed: Changed) {
  const now = Date.now();
  const statement = statementText({
    mind: MIND,
    path: "/minds/example.com",
    type: TYPE,
    payload: PAYLOAD,
    ...changed,
    at: now,
    expires: now + 5 * 60_000,
  });
  const encoder = new TextEncoder();
  const clientDataJSON = encoder.encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: await challengeOf(statement),
      origin: ISSUER,
    }),
  );
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(new URL(ISSUER).hostname)),
  );
  // user present and user verified
  const authenticatorData = new Uint8Array([...rpIdHash, 0x05, 0, 0, 0, 1]);
  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      passkey.privateKey,
      new Uint8Array([...authenticatorData, ...clientDataHash]),
    ),
  );
  return {
    statement,
    signature: {
      sig: base64url(derOf(raw)),
      authenticatorData: base64url(authenticatorData),
      clientDataJSON: base64url(clientDataJSON),
    },
  };
}

function derOf(raw: Uint8Array): Uint8Array {
  const integer = (half: Uint8Array) => {
    let at = 0;
    while (at < half.length - 1 && half[at] === 0) at++;
    const bytes = half.subarray(at);
    const positive = bytes[0]! & 0x80 ? [0, ...bytes] : [...bytes];
    return [0x02, positive.length, ...positive];
  };
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

type Passkey = { id: string; credentialId: string; privateKey: CryptoKey };

/** A stack in SQLite in memory, made by the Worker's own migrations. The config makes one address
 *  a member; each address holds a passkey. */
async function stack() {
  const db = new DatabaseSync(":memory:");
  const folder = new URL("../migrations/", import.meta.url).pathname;
  for (const name of readdirSync(folder).sort()) db.exec(readFileSync(`${folder}${name}`, "utf8"));
  const passkeys = {} as Record<typeof MEMBER | typeof STRANGER, Passkey>;
  for (const email of [MEMBER, STRANGER] as const) {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = base64url(
      new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer),
    );
    const passkey = {
      id: await keyIdOf(publicKey),
      credentialId: `credential-of-${email}`,
      privateKey: pair.privateKey,
    };
    db.prepare("insert into users (id, email) values (?, ?)").run(`user-${email}`, email);
    db.prepare(
      `insert into keys (id, user_id, public_key, format, credential_id, label, added_via, added_by, added_at)
       values (?, ?, ?, 'webauthn', ?, 'a passkey', 'test', ?, ?)`,
    ).run(
      passkey.id,
      `user-${email}`,
      publicKey,
      passkey.credentialId,
      `user-${email}`,
      Date.now(),
    );
    passkeys[email] = passkey;
  }
  const statementOf = (sql: string, bound: SQLInputValue[] = []) => {
    const execute = () => {
      const prepared = db.prepare(sql);
      if (prepared.columns().length) return { results: prepared.all(...bound), meta: {} };
      return { results: [], meta: { changes: Number(prepared.run(...bound).changes) } };
    };
    return {
      bind: (...values: SQLInputValue[]) => statementOf(sql, values),
      first: async () => execute().results[0] ?? null,
      all: async () => execute(),
      run: async () => execute(),
      execute,
    };
  };
  const env = {
    ...configVars({ ownerEmails: [MEMBER] }),
    DB: {
      prepare: (sql: string) => statementOf(sql),
      batch: async (statements: ReturnType<typeof statementOf>[]) =>
        statements.map((statement) => statement.execute()),
    },
    // the cast: of D1, the drafts call only these members
  } as unknown as Env;
  return { env, db, passkeys };
}
