// The default config's onboarding app (core/configs/default/apps/onboarding): the reduce of its
// four events, the step "Connect to iterate Cloud" against a double of its calls to iterate
// Cloud and the secrets (cloud-credit.ts), the agent's tool answers, the cards the page draws, and
// the real calls' reading of what the platform answers. The fake mind keeps logs in memory and
// takes what the real one takes: a key with another body is refused, one with the same body
// answers the event it has.
/// <reference path="../../configs/default/files.d.ts" />
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { ITERATE_MIND as ITERATE_ID } from "../../configs/default/cloud-deliveries.ts";
import { onboardingApp } from "../../configs/default/apps/onboarding/app.ts";
import {
  type CloudCredit,
  cloudCredit,
  ITERATE_PROXY,
  type SecretKind,
} from "../../configs/default/apps/onboarding/cloud-credit.ts";
import { CREDIT_OPEN } from "../../configs/default/apps/onboarding/steps/connect-iterate-cloud.ts";
import {
  initialState,
  type OnboardingEvent,
  reduce,
  reduceAll,
} from "../../configs/default/apps/onboarding/contract.ts";
import {
  connectWaitsForRule,
  type MindEvent,
  onboardingCards,
  onboardingEvent,
  type OnboardingItx,
  onboardingMindEvent,
  runStep,
  type StepContext,
  stepEvent,
  stepMindEvent,
} from "../../configs/default/apps/onboarding/steps.ts";
import { openCloud } from "../../configs/default/apps/onboarding/open-cloud.ts";
import {
  aiStatus,
  collectOpenAiKey,
  humanAiError,
  verifyAi,
  type VerifyAiItx,
} from "../../configs/default/apps/onboarding/verify-ai.ts";
import Config from "../../configs/default/worker.ts";
import { APP_DESCRIPTION_PATH, AppDescription } from "./app-description.ts";
import { auth } from "./sdk/auth.ts";

const STEP = "connect-iterate-cloud";
const MELD = `/minds/${ITERATE_ID}`;
const NOW = Date.parse("2026-11-18T22:00:00Z");
const BALANCE = { grantedUsd: 10, spentUsd: 0.42, remainingUsd: 9.58 };
const MIND_ID = "this-mind-id";
const OPEN_LINK = {
  label: "Open iterate Cloud",
  href: "https://onboarding.example.com/open-cloud",
};

// ── the reduce ──

test("the reduce folds each of the four events into the step's state, and an event folded before changes nothing", () => {
  const declined = reduce(initialState(), at(1, "step-declined", { step: STEP }));
  expect(declined.steps[STEP]).toEqual({
    declined: true,
    action: null,
    failure: null,
    facts: null,
  });
  // a request clears "not now" and names its own offset
  const asked = reduce(
    declined,
    at(2, "step-action-requested", {
      step: STEP,
      action: "connect",
      link: "https://mind.example.com/sign/1",
      expires: "2026-11-19T22:00:00.000Z",
    }),
  );
  expect(asked.steps[STEP]).toMatchObject({
    declined: false,
    action: {
      name: "connect",
      requestOffset: 2,
      link: "https://mind.example.com/sign/1",
      expires: "2026-11-19T22:00:00.000Z",
    },
  });
  // a settlement of another ask changes nothing; its own clears the ask and keeps the failure
  const other = reduce(
    asked,
    at(3, "step-action-settled", { step: STEP, requestOffset: 1, outcome: "succeeded" }),
  );
  expect(other.steps[STEP]?.action?.requestOffset).toBe(2);
  const failed = reduce(
    other,
    at(4, "step-action-settled", {
      step: STEP,
      requestOffset: 2,
      outcome: "failed",
      reason: "none-today",
    }),
  );
  expect(failed.steps[STEP]).toMatchObject({ action: null, failure: { reason: "none-today" } });
  const checked = reduce(failed, at(5, "step-checked", { step: STEP, facts: { meld: true } }));
  expect(checked.steps[STEP]?.facts).toEqual({ meld: true });
  // idempotent: the same event again, or an older one, leaves the state as it is
  expect(reduce(checked, at(5, "step-checked", { step: STEP, facts: { meld: false } }))).toBe(
    checked,
  );
  expect(reduce(checked, at(1, "step-declined", { step: STEP }))).toBe(checked);
  // a payload of another shape, and a type of another app, are no step's
  const ignored = reduceAll([
    at(1, "step-declined", { step: "Not A Step" }),
    { offset: 2, type: "docs/opened", payload: { step: STEP } },
  ]);
  expect(ignored).toEqual({ steps: {}, offset: 2 });
});

// ── the step ──

test("not asked: the card says what iterate sees and cannot see, and offers Connect and Not now; no request goes to iterate", async () => {
  const mind = fakeMind();
  const { credit, calls } = fakeCredit();
  const [card] = await onboardingCards(contextOf(mind, credit));
  expect(card).toMatchObject({
    step: STEP,
    status: "not-asked",
    title: "Connect to iterate Cloud",
    optional: true,
    buttons: [
      { label: "Connect", action: "connect", primary: true, opens: true },
      { label: "Not now", action: "decline" },
    ],
    footnote: "You can disconnect at any time.",
  });
  expect(card?.text).toEqual([
    "iterate, the company that made this software, gives your mind $10 of credit for AI: voice calls, web research, and your agents' model requests.",
    "A person at iterate approves each mind before its credit comes.",
    "Your agents already work without it, paid by your own Cloudflare account (its AI Gateway credit). After you connect, each agent request goes to iterate's credit first.",
  ]);
  expect(card?.points?.find((point) => point.title === "When the $10 is spent")?.text).toBe(
    "Your mind stops sending requests to iterate. Your agents go on with your ChatGPT plan if you connected one, else with your Cloudflare account; voice calls and web research stop until you add a key of your own. A key of your own always wins over the credit.",
  );
  const sees = card?.points?.find((point) => point.title === "What iterate sees")?.text;
  expect(sees).toMatch(
    /It stores the numbers \(which model, how much, the cost\), not the content\./,
  );
  expect(sees).toMatch(
    /iterate's proxy refuses a request that asks OpenAI to store it\. OpenAI and Exa still keep what their own policies keep, such as abuse logs, and OpenAI keeps the working files of a code tool it runs for up to 20 idle minutes\./,
  );
  expect(card?.points?.map((point) => point.title)).toEqual([
    "What iterate sees",
    "What iterate cannot see",
    "What iterate may send",
    "When the $10 is spent",
  ]);
  expect(calls).toEqual([]);
});

test("Not now: the card is one line with Connect, and the tool answers it as words", async () => {
  const mind = fakeMind();
  const { credit, calls } = fakeCredit();
  const answer = await runStep(contextOf(mind, credit), STEP, "decline");
  expect(answer).toEqual({
    status: "declined",
    words: "Not connected to iterate Cloud\n\nButtons: Connect",
  });
  expect(mind.onboarding()).toEqual(["step-checked", "step-declined"]);
  expect(calls).toEqual([]);
});

test("Not now after a signed rule: the card does not say 'not connected', says what the rule still lets iterate do, and offers to end it", async () => {
  const mind = fakeMind({ meld: "member" });
  const { credit } = fakeCredit();
  const context = contextOf(mind, credit);
  expect(await runStep(context, STEP, "decline")).toMatchObject({
    status: "declined",
    words:
      "No credit from iterate Cloud\n\nYour signed rule still lets iterate send help and updates to this mind. End it with your passkey to stop that.\n\nButtons: Connect · End the rule",
  });
  const [card] = await onboardingCards(context);
  // with the rule on, Connect acts at once and answers no page, so the page opens no tab for it
  expect(card?.buttons).toEqual([
    { label: "Connect", action: "connect" },
    { label: "End the rule", action: "disconnect", opens: true },
  ]);
});

test("a press opens a tab only where a page can come: Connect before the rule, Disconnect with it; Try again with the rule on opens none", async () => {
  const before = fakeMind();
  const fresh = await onboardingCards(contextOf(before, fakeCredit().credit));
  expect(fresh[0]?.buttons).toContainEqual({
    label: "Connect",
    action: "connect",
    primary: true,
    opens: true,
  });
  // the rule is on, and iterate has not approved the mind: Try again acts at once
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit({ connect: { ok: false, reason: "not-approved" } });
  const context = contextOf(mind, fake.credit);
  const refused = await runStep(context, STEP, "connect");
  expect(refused.link).toBeUndefined();
  const [card] = await onboardingCards(context);
  expect(card?.buttons).toEqual([
    { label: "Try again", action: "connect", primary: true },
    { label: "Not now", action: "decline" },
    OPEN_LINK,
    { label: "End the rule", action: "disconnect", opens: true },
  ]);
});

test("Connect: one link to sign the rule, and nothing at iterate or in the secrets before a member's signed rule lands; then the grant, both secrets and a note that starts the agent's turn", async () => {
  const mind = fakeMind();
  const { credit, calls, secrets } = fakeCredit();
  const context = contextOf(mind, credit);
  const answer = await runStep(context, STEP, "connect");
  expect(answer).toEqual({
    status: "connecting",
    words: "Connect to iterate Cloud\n\nWaiting for your passkey.\n\nButtons: Open the page again",
    link: "https://mind.example.com/sign/1",
  });
  // the exact rule: iterate may add events under one path, and the page brings the owner back
  expect(mind).toMatchObject({
    proposed: [
      {
        path: MELD,
        type: "events.iterate.com/mind-meld/configured",
        payload: { append: [`/minds/${ITERATE_ID}/`], name: "iterate.iterate.com" },
        next: "https://onboarding.example.com/",
      },
    ],
  });
  expect(calls).toEqual([]);
  // a second press while it waits answers the same link and asks for no second signature
  expect(await runStep(context, STEP, "connect")).toMatchObject({
    link: "https://mind.example.com/sign/1",
  });
  expect(mind.proposed).toHaveLength(1);

  // a rule that no member signed starts nothing
  await hook(mind, credit, mind.sign([`/minds/${ITERATE_ID}/`], false));
  expect(calls).toEqual([]);

  // the member's signed rule: the grant, then each secret
  await hook(mind, credit, mind.sign([`/minds/${ITERATE_ID}/`]));
  expect(calls).toEqual(["connect", "set /secrets/openai", "set /secrets/exa", "balance"]);
  expect(secrets).toEqual({ "/secrets/openai": "iterate-proxy", "/secrets/exa": "iterate-proxy" });
  const [card] = await onboardingCards(context);
  expect(card).toMatchObject({
    status: "connected",
    title: "Connected to iterate Cloud",
    text: ["$9.58 of $10 left."],
    buttons: [
      {
        label: "Try a voice call",
        href: "https://dash.example.com/agents/agents/onboarding",
      },
      OPEN_LINK,
      { label: "Disconnect", action: "disconnect", opens: true },
    ],
  });
  const [note] = mind.chat();
  expect(note).toMatchObject({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "developer" },
  });
  expect(JSON.stringify(note?.payload)).toMatch(/\$9\.58 of iterate's credit/);

  // the rule arrives again (at least once): no second grant call, no second note
  const before = calls.length;
  await hook(mind, credit, mind.logs.get(MELD)!.at(-1)!);
  expect(calls.slice(before)).not.toContain("connect");
  expect(mind.chat()).toHaveLength(1);
  // a second connect sets nothing
  await runStep(context, STEP, "connect");
  expect(calls.filter((call) => call.startsWith("set "))).toHaveLength(2);
});

test("an owner's own OpenAI key is never written: the credit takes Exa alone, and the card says the key stays", async () => {
  const mind = fakeMind({ meld: "member" });
  const { credit, calls, secrets } = fakeCredit({ secrets: { "/secrets/openai": "own" } });
  // the rule was signed before: Connect needs no page and acts at once
  const answer = await runStep(contextOf(mind, credit), STEP, "connect");
  expect(mind).toMatchObject({ proposed: [] });
  expect(calls).not.toContain("set /secrets/openai");
  expect(secrets["/secrets/openai"]).toBe("own");
  expect(secrets["/secrets/exa"]).toBe("iterate-proxy");
  expect(answer).toMatchObject({ status: "connected" });
  expect(answer.words).toMatch(
    /Your own OpenAI key stays in use\. The credit pays for web research\./,
  );
});

test.for([
  [
    "none-today",
    "failed",
    "iterate made all its new grants for today. Try again tomorrow (UTC).",
    "Try again · Not now · End the rule",
  ],
  [
    "paused",
    "failed",
    "iterate's credit is paused until tomorrow (UTC).",
    "Try again · Not now · End the rule",
  ],
  [
    "not-approved",
    "waiting",
    "iterate has your request. A person at iterate approves each mind. You get the credit when they have.",
    "Try again · Not now · Open iterate Cloud · End the rule",
  ],
  [
    "ended",
    "ended",
    "A person at iterate ended this mind's credit. Your mind goes on with its own keys.",
    "Open iterate Cloud · End the rule",
  ],
  [
    "hostname-enrolled",
    "failed",
    "Another mind at this hostname has iterate's credit. A person at iterate ends it first; then try again.",
    "Try again · Not now · End the rule",
  ],
  [
    "not-recognised",
    "failed",
    "iterate Cloud did not recognise this mind's signature. Update your mind on your computer, then try again.",
    "Try again · Not now · End the rule",
  ],
  [
    "cloud-unreachable",
    "failed",
    "iterate Cloud did not answer. Try again in a minute.",
    "Try again · Not now · End the rule",
  ],
] as const)(
  "a grant refused as %s sets no secret and deletes none, and the card says why",
  async ([reason, status, words, buttons]) => {
    const mind = fakeMind({ meld: "member" });
    const { credit, calls, secrets } = fakeCredit({ connect: { ok: false, reason } });
    const answer = await runStep(contextOf(mind, credit), STEP, "connect");
    expect(calls.filter((call) => /^(set|delete) /.test(call))).toEqual([]);
    expect(secrets).toEqual({ "/secrets/openai": "unset", "/secrets/exa": "unset" });
    expect(answer).toMatchObject({ status });
    // the first line, outside the fold, then the rule that stands, then the buttons (an update's
    // command between them has a test of its own)
    const lines = answer.words.split("\n\n").slice(1);
    expect(lines.filter((line) => !line.startsWith("Command: "))).toEqual([
      words,
      "Your signed rule still lets iterate send help and updates to this mind. End it with your passkey to stop that.",
      `Buttons: ${buttons}`,
    ]);
  },
);

test("the 200 at the connect: both secrets by iterate's proxy where none is set, the card connected, none deleted", async () => {
  const mind = fakeMind({ meld: "member" });
  const { credit, calls, secrets } = fakeCredit({ secrets: { "/secrets/openai": "own" } });
  const answer = await runStep(contextOf(mind, credit), STEP, "connect");
  expect(answer).toMatchObject({ status: "connected" });
  expect(secrets).toEqual({ "/secrets/openai": "own", "/secrets/exa": "iterate-proxy" });
  expect(calls.filter((call) => /^(set|delete) /.test(call))).toEqual(["set /secrets/exa"]);
});

test("not approved yet: no secret by proxy, the rule stands, and a press once iterate approved the mind connects with no new passkey", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit({ connect: { ok: false, reason: "not-approved" } });
  const context = contextOf(mind, fake.credit);
  const refused = await runStep(context, STEP, "connect");
  expect(refused).toMatchObject({ status: "waiting" });
  expect(fake).toMatchObject({ secrets: { "/secrets/openai": "unset", "/secrets/exa": "unset" } });
  expect(refused.words).toMatch(/Your signed rule still lets iterate send help and updates/);
  expect(refused.words).toMatch(/Buttons: Try again · Not now · Open iterate Cloud · End the rule/);
  // a person at iterate approved the mind: the Cloud grants
  fake.state.connect = { ok: true, balance: BALANCE };
  await nextMs();
  const connected = await runStep(context, STEP, "connect");
  expect(connected).toMatchObject({ status: "connected" });
  expect(mind).toMatchObject({ proposed: [] });
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": "iterate-proxy", "/secrets/exa": "iterate-proxy" },
  });
});

test.for([
  "none-today",
  "paused",
  "not-approved",
  "not-recognised",
  "no-working-key",
  "cloud-unreachable",
  "stack-without-proxy",
] as const)(
  "after the signed rule, a connect that failed as %s says that the rule stands and how to end it, in the card and in the agent's note; only an outage says to try again in a minute",
  async (reason) => {
    const mind = fakeMind();
    const { credit } = fakeCredit(
      reason === "stack-without-proxy" ? { proxyLayer: false } : { connect: { ok: false, reason } },
    );
    const context = contextOf(mind, credit);
    await runStep(context, STEP, "connect");
    await hook(mind, credit, mind.sign([`/minds/${ITERATE_ID}/`]));
    const note = mind.chat().map((event) => JSON.stringify(event.payload));
    expect(note).toHaveLength(1);
    expect(note[0]).toMatch(/The rule stands until the owner ends it with their passkey/);
    const card = await runStep(context, STEP, "check");
    expect(card).toMatchObject({ status: reason === "not-approved" ? "waiting" : "failed" });
    expect(card.words).toMatch(
      /Your signed rule still lets iterate send help and updates to this mind\. End it with your passkey to stop that\./,
    );
    expect(card.words).toMatch(
      reason === "not-approved"
        ? /Try again · Not now · Open iterate Cloud · End the rule/
        : /Try again · Not now · End the rule/,
    );
    for (const words of [card.words, note[0]]) {
      expect(words).not.toMatch(/Nothing was set up/);
      expect(/Try again in a minute/.test(words!)).toBe(reason === "cloud-unreachable");
    }
  },
);

test("an own OpenAI key and no Exa key: the offer, then at the signed rule Exa alone by proxy, and the note says the credit pays for Exa", async () => {
  const mind = fakeMind();
  const fake = fakeCredit({ secrets: { "/secrets/openai": "own" } });
  const context = contextOf(mind, fake.credit);
  expect(await runStep(context, STEP, "check")).toMatchObject({ status: "not-asked" });
  await runStep(context, STEP, "connect");
  await hook(mind, fake.credit, mind.sign([`/minds/${ITERATE_ID}/`]));
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": "own", "/secrets/exa": "iterate-proxy" },
  });
  const [note] = mind.chat().map((event) => JSON.stringify(event.payload));
  expect(note).toMatch(/\$9\.58 of iterate's credit for Exa \(by iterate's proxy/);
  const card = await runStep(context, STEP, "check");
  expect(card).toMatchObject({ status: "connected" });
  expect(card.words).toMatch(
    /Your own OpenAI key stays in use\. The credit pays for web research\./,
  );
  expect(mind).toMatchObject({ mailed: [] });
});

test("both keys the owner's: no offer, a press asks nothing, and with the rule signed the card says it stands; no mail even at a spent balance", async () => {
  const own = { "/secrets/openai": "own", "/secrets/exa": "own" } as const;
  const fresh = fakeMind();
  const first = fakeCredit({ secrets: own });
  const context = contextOf(fresh, first.credit);
  const card = await runStep(context, STEP, "check");
  expect(card).toMatchObject({ status: "own-keys" });
  expect(card.words).toMatch(/Your mind uses your own keys for OpenAI and Exa/);
  expect(card.words).not.toMatch(/Buttons:/);
  await runStep(context, STEP, "connect");
  expect(first).toMatchObject({ calls: [] });
  expect(fresh).toMatchObject({ proposed: [] });

  const melded = fakeMind({ meld: "member" });
  const second = fakeCredit({ secrets: own });
  second.state.balance = {
    ok: true,
    balance: { grantedUsd: 10, spentUsd: 10, remainingUsd: 0, pendingUsd: 0 },
  };
  const signed = await runStep(contextOf(melded, second.credit), STEP, "check");
  expect(signed).toMatchObject({ status: "own-keys" });
  expect(signed.words).toMatch(/Your signed rule still lets iterate send help/);
  expect(signed.words).toMatch(/Buttons: End the rule/);
  expect(melded).toMatchObject({ mailed: [] });
  expect(melded.chat()).toEqual([]);
});

test("declined, then both keys the owner's: the own-keys card wins over declined, with End the rule when a rule stands, and a press asks iterate nothing", async () => {
  for (const meld of [undefined, "member"] as const) {
    const mind = fakeMind(meld ? { meld } : {});
    const fake = fakeCredit();
    const context = contextOf(mind, fake.credit);
    expect(await runStep(context, STEP, "decline")).toMatchObject({ status: "declined" });
    fake.secrets["/secrets/openai"] = "own";
    fake.secrets["/secrets/exa"] = "own";
    // the checks before, with the keys unset, read the balance: count from here
    fake.calls.length = 0;
    const card = await runStep(context, STEP, "check");
    expect(card).toMatchObject({ status: "own-keys" });
    expect(card.words).not.toMatch(/Buttons:.*Connect/);
    if (meld) expect(card.words).toMatch(/Buttons: End the rule/);
    else expect(card.words).not.toMatch(/Buttons:/);
    expect(await runStep(context, STEP, "connect")).toMatchObject({ status: "own-keys" });
    // nothing asks iterate: no grant, no secret, and no balance read for a mind with its own keys
    expect(fake).toMatchObject({ calls: [] });
    expect(mind).toMatchObject({ proposed: [] });
  }
});

test("a connect that throws on the press path settles as failed: Try again and End the rule, never Connecting for ever", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit({ setThrows: { "/secrets/openai": "RPC: the connection was lost" } });
  const answer = await runStep(contextOf(mind, fake.credit), STEP, "connect");
  expect(answer).toMatchObject({ status: "failed" });
  expect(answer.words).toMatch(/The connect stopped before it finished\./);
  expect(answer.words).not.toMatch(/already pays/);
  expect(answer.words).toMatch(/Try again · Not now · End the rule/);
});

test("OpenAI set by proxy, then Exa's set throws: the card says what stands, and a second press finishes it with no second grant", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit({ setThrows: { "/secrets/exa": "RPC: the connection was lost" } });
  const context = contextOf(mind, fake.credit);
  const half = await runStep(context, STEP, "connect");
  expect(half).toMatchObject({ status: "connected" });
  expect(half.words).toMatch(
    /Buttons: Try again · Try a voice call · Open iterate Cloud · Disconnect/,
  );
  expect(half.words).toMatch(
    /The connect stopped before it finished\. iterate's credit already pays for OpenAI\. Try again sets up the rest\./,
  );
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": "iterate-proxy", "/secrets/exa": "unset" },
  });
  // the proxy gives one grant for each mind id: a second connect answers the same balance
  delete fake.setThrows["/secrets/exa"];
  const whole = await runStep(context, STEP, "connect");
  expect(whole).toMatchObject({ status: "connected" });
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": "iterate-proxy", "/secrets/exa": "iterate-proxy" },
  });
  expect(fake.calls.filter((call) => call.startsWith("set "))).toEqual([
    "set /secrets/openai",
    "set /secrets/exa",
    "set /secrets/exa",
  ]);
});

test("Connect pressed with the keys unset, then both keys set by the owner, then the rule signed: no grant is asked, the note says no credit is taken, the card is own-keys", async () => {
  const mind = fakeMind();
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.secrets["/secrets/openai"] = "own";
  fake.secrets["/secrets/exa"] = "own";
  await hook(mind, fake.credit, mind.sign([`/minds/${ITERATE_ID}/`]));
  const [note] = mind.chat().map((event) => JSON.stringify(event.payload));
  expect(note).toMatch(
    /The mind takes no credit: the owner's own keys for OpenAI and Exa stay in use\./,
  );
  expect(await runStep(context, STEP, "check")).toMatchObject({ status: "own-keys" });
  expect(fake).toMatchObject({ calls: [] });
});

test("the offer says the passkey page comes only when no rule is signed yet", async () => {
  const sendsOf = async (mind: ReturnType<typeof fakeMind>) => {
    const [card] = await onboardingCards(contextOf(mind, fakeCredit().credit));
    return card?.points?.find((point) => point.title === "What iterate may send")?.text;
  };
  expect(await sendsOf(fakeMind())).toMatch(/You allow that with your passkey on the next page,/);
  expect(await sendsOf(fakeMind({ meld: "member" }))).toMatch(
    /You allowed that with your passkey already, and you can end it at any time\./,
  );
});

test("a rule by hostname, on /minds/iterate.iterate.com, still counts; an end signed by id after it ends it", async () => {
  const sendsOf = async (rules: [string[], string, string][]) => {
    const mind = fakeMind();
    for (const [append, path, createdAt] of rules)
      await mind.itx.cd(path).append({
        type: "events.iterate.com/mind-meld/configured",
        payload: { append },
        createdAt,
        source: { signer: { principal: { email: "owner@example.org" }, member: true } },
      } as never);
    const [card] = await onboardingCards(contextOf(mind, fakeCredit().credit));
    return card?.points?.find((point) => point.title === "What iterate may send")?.text;
  };
  const before: [string[], string, string] = [
    ["/minds/iterate.iterate.com/"],
    "/minds/iterate.iterate.com",
    "2026-11-18T10:00:00.000Z",
  ];
  expect(await sendsOf([before])).toMatch(/You allowed that with your passkey already/);
  expect(await sendsOf([before, [[], MELD, "2026-11-20T10:00:00.000Z"]])).toMatch(
    /You allow that with your passkey on the next page,/,
  );
});

test.for([
  ["/secrets/openai", "own", "Your agents and voice calls run on your own OpenAI key."],
  [
    "/secrets/openai",
    "other-proxy",
    "Your agents and voice calls run through the proxy your mind set for OpenAI.",
  ],
  [
    "/secrets/openai",
    "unset",
    "Your agents go on with your ChatGPT plan if you connected one, else with your Cloudflare account. Voice calls need a key of your own.",
  ],
  ["/secrets/exa", "own", "Web research runs on your own Exa key."],
  ["/secrets/exa", "other-proxy", "Web research runs through the proxy your mind set for Exa."],
  ["/secrets/exa", "unset", "Web research needs a key of your own."],
] as const)(
  "spent with %s %s: only the other path's proxy is deleted, this one stays, and the card and the mail say what it runs on",
  async ([path, kind, line]) => {
    const other = path === "/secrets/openai" ? "/secrets/exa" : "/secrets/openai";
    const mind = fakeMind({ meld: "member" });
    const fake = fakeCredit({
      secrets: { [path]: kind, [other]: "iterate-proxy" },
      balance: {
        ok: true,
        balance: { grantedUsd: 10, spentUsd: 10, remainingUsd: 0, pendingUsd: 0 },
      },
    });
    const card = await runStep(contextOf(mind, fake.credit), STEP, "check");
    expect(fake).toMatchObject({ secrets: { [path]: kind, [other]: "unset" } });
    expect(fake.calls.filter((call) => call.startsWith("delete "))).toEqual([`delete ${other}`]);
    expect(card).toMatchObject({ status: "spent" });
    expect(card.words).toContain(line);
    expect(mind.mailed[0]?.text).toContain(line);
  },
);

test("paused (iterate's total for the day) deletes nothing: the card stays connected, with the pause", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.balance = { ok: false, reason: "paused" };
  const card = await runStep(context, STEP, "check");
  expect(fake.calls.filter((call) => call.startsWith("delete "))).toEqual([]);
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": "iterate-proxy", "/secrets/exa": "iterate-proxy" },
  });
  expect(card).toMatchObject({ status: "connected" });
  expect(card.words).toMatch(/iterate's credit is paused until tomorrow \(UTC\)\./);
});

test.for([
  [
    "under zero with an estimate iterate may still replace",
    { pendingUsd: 1.5 },
    "iterate is still counting an interrupted request. Until it has, it refuses your mind's requests; this ends within 15 minutes.",
  ],
  [
    "under zero from a proxy that says nothing of pending estimates",
    {},
    "Your balance is at or under zero, so iterate refuses your mind's requests for now.",
  ],
] as const)(
  "%s: nothing is deleted, no mail, and the connected card says why requests are refused",
  async ([, pending, line]) => {
    const mind = fakeMind({ meld: "member" });
    const fake = fakeCredit();
    const context = contextOf(mind, fake.credit);
    await runStep(context, STEP, "connect");
    fake.state.balance = {
      ok: true,
      balance: { grantedUsd: 10, spentUsd: 10.4, remainingUsd: -0.4, ...pending },
    };
    const card = await runStep(context, STEP, "check");
    expect(fake.calls.filter((call) => call.startsWith("delete "))).toEqual([]);
    expect(fake).toMatchObject({
      secrets: { "/secrets/openai": "iterate-proxy", "/secrets/exa": "iterate-proxy" },
    });
    expect(mind).toMatchObject({ mailed: [] });
    expect(card).toMatchObject({ status: "connected" });
    expect(card.words).toContain("-$0.40 of $10 left.");
    expect(card.words).toContain(line);
  },
);

test("the mail goes at the true end: under zero while iterate counts, then certainly spent", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.balance = {
    ok: true,
    balance: { grantedUsd: 10, spentUsd: 10.4, remainingUsd: -0.4, pendingUsd: 1.5 },
  };
  await runStep(context, STEP, "check");
  expect(mind).toMatchObject({ mailed: [] });
  // the real cost replaced the estimate, and the rest of the grant was used after it
  await nextMs();
  fake.state.balance = {
    ok: true,
    balance: { grantedUsd: 10, spentUsd: 10.1, remainingUsd: -0.1, pendingUsd: 0 },
  };
  expect(await runStep(context, STEP, "check")).toMatchObject({ status: "spent" });
  expect(mind.mailed).toHaveLength(1);
  expect(fake).toMatchObject({ secrets: { "/secrets/openai": "unset", "/secrets/exa": "unset" } });
});

test.for([
  ["no answer", { ok: false, reason: "cloud-unreachable" }],
  ["paused", { ok: false, reason: "paused" }],
] as const)(
  "%s while the last known balance was spent: nothing is deleted on a remembered number",
  async ([, answer]) => {
    const mind = fakeMind({ meld: "member" });
    // a mind spent while a proxy without `pendingUsd` answered: its secrets by proxy still stand
    const fake = fakeCredit();
    const context = contextOf(mind, fake.credit);
    await runStep(context, STEP, "connect");
    fake.state.balance = { ok: true, balance: { grantedUsd: 10, spentUsd: 10, remainingUsd: 0 } };
    await runStep(context, STEP, "check");
    await nextMs();
    fake.state.balance = answer;
    await runStep(context, STEP, "check");
    expect(fake.calls.filter((call) => call.startsWith("delete "))).toEqual([]);
    expect(mind).toMatchObject({ mailed: [] });
  },
);

test("a delete that throws at the spent moment: every card still answers, the card names what still goes to iterate, and the next check deletes it", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.deleteThrows.add("/secrets/exa");
  fake.state.balance = {
    ok: true,
    balance: { grantedUsd: 10, spentUsd: 10, remainingUsd: 0, pendingUsd: 0 },
  };
  const cards = await onboardingCards(context);
  const card = cards.find((one) => one.step === STEP);
  expect(card).toMatchObject({ status: "spent" });
  expect(card?.text).toContain(
    "Your mind's requests to Exa still go to iterate and are refused there, until the next check switches them off.",
  );
  expect(card?.text).not.toContain("Your mind's requests no longer go to iterate.");
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": "unset", "/secrets/exa": "iterate-proxy" },
  });
  fake.state.deleteThrows.clear();
  await nextMs();
  const after = await runStep(context, STEP, "check");
  expect(fake).toMatchObject({ secrets: { "/secrets/exa": "unset" } });
  expect(after.words).toContain("Your mind's requests no longer go to iterate.");
  expect(mind.mailed).toHaveLength(1);
});

test("a balance that comes back above zero (an estimate settled lower): the card offers Connect again, and a press sets the secrets on the same grant", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.balance = {
    ok: true,
    balance: { grantedUsd: 10, spentUsd: 10, remainingUsd: 0, pendingUsd: 0 },
  };
  fake.state.connect = fake.state.balance;
  expect(await runStep(context, STEP, "check")).toMatchObject({ status: "spent" });
  // a press while spent sets nothing: the grant answers zero
  expect(await runStep(context, STEP, "connect")).toMatchObject({ status: "spent" });
  expect(fake).toMatchObject({ secrets: { "/secrets/openai": "unset", "/secrets/exa": "unset" } });
  // the estimate settles: the same grant has money again
  await nextMs();
  const back = { ok: true as const, balance: { grantedUsd: 10, spentUsd: 9.9, remainingUsd: 0.1 } };
  fake.state.balance = back;
  fake.state.connect = back;
  const offer = await runStep(context, STEP, "check");
  expect(offer).toMatchObject({ status: "not-asked" });
  expect(offer.words).toMatch(/Buttons: Connect · Not now/);
  // the offer says what is left of this mind's grant, not a new $10
  expect(offer.words).toContain(
    "Your mind has $0.10 of iterate's credit for AI left: voice calls, web research, and your agents' model requests.",
  );
  expect(offer.words).toContain("When the $0.10 is spent");
  expect(offer.words).not.toMatch(/gives your mind \$10|approves each mind/);
  const again = await runStep(context, STEP, "connect");
  expect(again).toMatchObject({ status: "connected" });
  expect(again.words).toMatch(/\$0\.10 of \$10 left\./);
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": "iterate-proxy", "/secrets/exa": "iterate-proxy" },
  });
  // one mail and one message for the grant, also after it is spent a second time
  await nextMs();
  fake.state.balance = {
    ok: true,
    balance: { grantedUsd: 10, spentUsd: 10, remainingUsd: 0, pendingUsd: 0 },
  };
  await runStep(context, STEP, "check");
  expect(mind.mailed).toHaveLength(1);
});

test("the guides say who pays, and the spoken offer does not claim the agents need the credit", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../../configs/default/${path}`, import.meta.url), "utf8").replaceAll(
      /\s+/g,
      " ",
    );
  const guide = read("onboarding/connect-iterate-cloud.md");
  expect(guide).toContain(
    "A person at iterate approves each mind before its credit comes: until then the connect answers `not-approved`, nothing is set, the owner's rule stays, and a later `connect` gets the credit.",
  );
  expect(guide).toContain(
    "before the connect, the mind's agents already work, paid by the owner's own Cloudflare account",
  );
  expect(guide).toContain(
    "When the credit is spent, the step deletes its two secrets by iterate's proxy (the rule stays), so the mind's requests no longer go to iterate: the agents go on with the owner's ChatGPT plan if they connected one, else with their Cloudflare account, and voice calls and web research stop until the owner sets a key of their own.",
  );
  for (const text of [guide, read("onboarding.md")])
    expect(text).not.toMatch(/still goes to iterate first|first and is refused/);
  const offer =
    "iterate gives your mind $10 of credit for AI: voice calls, web research, and your agents' requests, which your Cloudflare credit pays for today. Want it?";
  for (const text of [guide, read("onboarding.md")]) {
    expect(text).toContain(offer);
    expect(text).not.toContain("so agents and voice calls work at once");
  }
});

test("a connect whose invocation died before its settle waits 60 s at most: then stopped, with Try again, and a press connects", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  // the press logs its ask, then its invocation dies: the grant's call never answers
  const answer = fake.credit.connect;
  fake.credit.connect = () => new Promise(() => {});
  void runStep(context, STEP, "connect");
  await vi.waitFor(async () =>
    expect(await runStep({ ...context, now: NOW + 30_000 }, STEP, "check")).toMatchObject({
      status: "connecting",
    }),
  );
  fake.credit.connect = answer;
  const later = { ...context, now: NOW + 61_000 };
  const card = await runStep(later, STEP, "check");
  expect(card).toMatchObject({ status: "failed" });
  expect(card.words).toMatch(/The connect stopped before it finished\./);
  expect(card.words).toMatch(/Try again · Not now · End the rule/);
  expect(await runStep(later, STEP, "connect")).toMatchObject({ status: "connected" });
});

test("a concurrent connect won the write: the vault refuses the second set, the path is iterate's proxy, and the ask settles as connected with no failure", async () => {
  const mind = fakeMind({ meld: "member" });
  const { credit } = realCredit({
    stackKey: { listed: true },
    setThrows: "secrets.set with proxy: /secrets/openai is set or being set; delete it first",
    raced: {
      "/secrets/openai": { set: true, proxy: ITERATE_PROXY },
      "/secrets/exa": { set: true, proxy: ITERATE_PROXY },
    },
  });
  const card = await runStep(contextOf(mind, credit), STEP, "connect");
  expect(card).toMatchObject({ status: "connected" });
  expect(card.words).not.toMatch(/stopped|being changed|Try again/);
  const [settled] = mind.logs
    .get("/apps/onboarding")!
    .filter((event) => event.type === "onboarding/step-action-settled");
  expect(settled?.payload).toMatchObject({ outcome: "succeeded" });
  expect(settled?.payload).not.toHaveProperty("words");
});

test("a stack without the secret by proxy settles stack-without-proxy, and the card names the update", async () => {
  const mind = fakeMind({ meld: "member" });
  const { credit } = fakeCredit({ proxyLayer: false });
  const answer = await runStep(contextOf(mind, credit), STEP, "connect");
  expect(answer).toMatchObject({ status: "failed" });
  expect(answer.words).toMatch(/cannot use the credit yet/);
  expect(answer.words).toMatch(/Command: npx iterate@latest deploy/);
});

test("a stack that does not sign as the mind is offered nothing that cannot work: no Connect, the update command, and no request anywhere", async () => {
  const mind = fakeMind();
  const { credit, calls } = fakeCredit({ canSign: false });
  const [card] = await onboardingCards(contextOf(mind, credit));
  expect(card).toMatchObject({
    status: "unavailable",
    command: "npx iterate@latest deploy",
    buttons: [
      { label: "Check again", action: "check" },
      { label: "Not now", action: "decline" },
    ],
  });
  // the tool's connect answers the same card, and asks for no signature
  expect(await runStep(contextOf(mind, credit), STEP, "connect")).toMatchObject({
    status: "unavailable",
  });
  expect(mind).toMatchObject({ proposed: [] });
  expect(calls).toEqual([]);
});

test("the onboarding agent names no credit on such a stack, nor while the credit is closed: its check answers what onboarding.md tells it to fall back on", async () => {
  const { credit } = fakeCredit({ canSign: false });
  const { status } = await runStep(contextOf(fakeMind(), credit), STEP, "check");
  const closed = runStep({ ...contextOf(fakeMind(), credit), creditOpen: false }, STEP, "check");
  await expect(closed).rejects.toThrow(`no step "${STEP}" on this mind`);
  const guide = readFileSync(
    new URL("../../configs/default/onboarding.md", import.meta.url),
    "utf8",
  ).replaceAll(/\s+/g, " ");
  expect(guide).toContain(
    `Call \`check\` first. When it answers that this mind has no step "${STEP}" (iterate Cloud's credit is not open yet), or its \`status\` is \`${status}\` or \`own-keys\`, ask the "let iterate in" question as before`,
  );
});

test("the credit is open as shipped; closed (creditOpen false): no card, no press, and at the owner's signed rule nothing asks iterate or the secrets", async () => {
  expect(CREDIT_OPEN).toBe(true);
  const mind = fakeMind();
  const { credit, calls } = fakeCredit();
  const context = { ...contextOf(mind, credit), creditOpen: false };
  expect(stepsOf(await onboardingCards(context))).toEqual(["connect-cloudflare"]);
  await expect(runStep(context, STEP, "connect")).rejects.toThrow("its steps: connect-cloudflare");
  await stepEvent(context, mind.sign([`/minds/${ITERATE_ID}/`]));
  expect(calls).toEqual([]);
  expect(mind).toMatchObject({ proposed: [] });
  expect(mind.chat()).toEqual([]);
});

test("a passkey page that expired unsigned settles as not-signed", async () => {
  const mind = fakeMind();
  const { credit } = fakeCredit();
  await runStep(contextOf(mind, credit), STEP, "connect");
  const later = { ...contextOf(mind, credit), now: NOW + 86_400_001 };
  const answer = await runStep(later, STEP, "check");
  expect(answer).toMatchObject({ status: "failed" });
  expect(answer.words).toMatch(/expired before it was signed/);
});

test("Disconnect deletes only iterate's secrets by proxy at once, then one link ends the rule; the end of the rule ends the credit by itself too", async () => {
  const mind = fakeMind({ meld: "member" });
  const { credit, calls, secrets } = fakeCredit({ secrets: { "/secrets/openai": "own" } });
  const context = contextOf(mind, credit);
  await runStep(context, STEP, "connect");
  const answer = await runStep(context, STEP, "disconnect");
  expect(calls).toContain("delete /secrets/exa");
  expect(calls).not.toContain("delete /secrets/openai");
  expect(secrets).toEqual({ "/secrets/openai": "own", "/secrets/exa": "unset" });
  expect(mind.proposed.at(-1)?.payload).toEqual({ append: [], name: "iterate.iterate.com" });
  expect(answer).toMatchObject({
    status: "disconnecting",
    link: "https://mind.example.com/sign/1",
  });
  expect(answer.words).toMatch(/iterate may still send messages here until you end the rule/);
  // the owner signs the end: the ask settles
  await hook(mind, credit, mind.sign([]));
  expect(await runStep(context, STEP, "check")).not.toMatchObject({ status: "disconnecting" });

  // the owner ends the rule on the /minds page, with no Disconnect: the proxy secrets go too
  const again = fakeMind({ meld: "member" });
  const other = fakeCredit();
  await runStep(contextOf(again, other.credit), STEP, "connect");
  await hook(again, other.credit, again.sign([]));
  expect(other).toMatchObject({
    secrets: { "/secrets/openai": "unset", "/secrets/exa": "unset" },
  });
});

test("a Disconnect whose OpenAI proxy the vault keeps (a key form is open): the card names it, the rule's end goes on, and a check after the form closed deletes it", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.deleteKept.add("/secrets/openai");
  const still =
    "Your mind's requests to OpenAI still go to iterate, because a form or a sign-in for that key is open. Press Disconnect again when it is closed.";
  const answer = await runStep(context, STEP, "disconnect");
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": "iterate-proxy", "/secrets/exa": "unset" },
  });
  // the rule's end is not held up: its page is the answer
  expect(answer).toMatchObject({
    status: "disconnecting",
    link: "https://mind.example.com/sign/1",
  });
  expect(answer.words).toContain(still);
  expect(answer.words).not.toContain("No request goes through iterate any more.");
  // the owner signs the end; the form is still open: the card says so, with Disconnect again
  await hook(mind, fake.credit, mind.sign([]));
  await nextMs();
  const after = await runStep(context, STEP, "check");
  expect(after).toMatchObject({ status: "disconnecting" });
  expect(after.words).toContain(still);
  expect(after.words).toMatch(/Buttons: Disconnect again/);
  // the form closed (lapsed or used): the next check deletes the proxy
  fake.state.deleteKept.clear();
  await nextMs();
  expect(await runStep(context, STEP, "check")).toMatchObject({ status: "not-asked" });
  expect(fake).toMatchObject({ secrets: { "/secrets/openai": "unset" } });
});

test.for([
  ["a connected mind whose rule is missing from the catalog's page", "member", "iterate-proxy"],
  ["a mind that never had a rule, with a proxy its own code set", null, "iterate-proxy"],
] as const)("%s: a check deletes nothing, and asks nothing of iterate", async ([, meld, kind]) => {
  const mind = fakeMind({ meld, unlisted: [MELD] });
  const fake = fakeCredit({
    secrets: { "/secrets/openai": kind, "/secrets/exa": "iterate-proxy" },
  });
  await runStep(contextOf(mind, fake.credit), STEP, "check");
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": kind, "/secrets/exa": "iterate-proxy" },
  });
  expect(fake.calls.filter((call) => call.startsWith("delete ") || call === "balance")).toEqual([]);
});

test("the credit used: iterate's proxy is switched off once, the card says what runs now, and the chat and the owner's mail say it once", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.balance = {
    ok: true,
    balance: { grantedUsd: 10, spentUsd: 10.2, remainingUsd: -0.2, pendingUsd: 0 },
  };
  const answer = await runStep(context, STEP, "check");
  // switched off: both secrets by iterate's proxy deleted, once; the rule stays
  expect(fake).toMatchObject({ secrets: { "/secrets/openai": "unset", "/secrets/exa": "unset" } });
  expect(fake.calls.filter((call) => call.startsWith("delete "))).toEqual([
    "delete /secrets/openai",
    "delete /secrets/exa",
  ]);
  expect(mind).toMatchObject({ proposed: [] });
  expect(answer).toMatchObject({ status: "spent" });
  const spentText = [
    "Your $10 of credit is used.",
    "Your mind's requests no longer go to iterate.",
    "Your agents go on with your ChatGPT plan if you connected one, else with your Cloudflare account. Voice calls need a key of your own.",
    "Web research needs a key of your own.",
  ];
  for (const line of spentText) expect(answer.words).toContain(line);
  expect(answer.words).not.toMatch(/iterate first|Connect ·|· Connect/);
  expect(answer.words).toMatch(/Command: npx iterate@latest chatgpt connect mind\.example\.com/);
  expect(answer.words).toMatch(
    /Buttons: Add my OpenAI key · Add Cloudflare credit · Open iterate Cloud · End the rule/,
  );
  expect(mind.mailed[0]?.text).toContain(
    "Your $10 of iterate credit is used.\nYour mind's requests no longer go to iterate.\nYour agents go on with your ChatGPT plan if you connected one, else with your Cloudflare account. Voice calls need a key of your own.\nWeb research needs a key of your own.\nChoose what pays now:",
  );
  const drawn = () =>
    mind.chat().filter((event) => event.type === "events.iterate.com/agent/web-message-sent");
  expect(drawn()).toHaveLength(1);
  expect(mind).toMatchObject({
    mailed: [{ from: "onboarding@example.com", to: "owner@example.org" }],
  });
  // checked again, and the page opened again: nothing more is said or deleted
  await runStep(context, STEP, "check");
  await onboardingCards(context);
  expect(drawn()).toHaveLength(1);
  expect(mind.mailed).toHaveLength(1);
  expect(fake.calls.filter((call) => call.startsWith("delete "))).toHaveLength(2);
  // the key's form is the mind's own: the answer is its link, and the agent sees no value
  expect(await runStep(context, STEP, "add-openai-key")).toMatchObject({
    link: "https://mind.example.com/secrets/collect/1",
  });
});

test("a request that iterate's proxy refused for storage starts a check and changes nothing: the card stays, no chat message, no mail", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  const before = await runStep(context, STEP, "check");
  expect(before).toMatchObject({ status: "connected" });
  fake.calls.length = 0;
  for (const code of ["iterate_credit_store_not_off", "iterate_credit_nothing_stored"])
    await hook(mind, fake.credit, {
      type: "events.iterate.com/agent/llm-request-settled",
      path: "/agents/a",
      offset: 900,
      payload: { failedKeys: [{ key: 1, error: `400 ${code}: storage at OpenAI must be off` }] },
    });
  // each event read the balance again, and set or deleted nothing
  expect(fake).toMatchObject({ calls: ["balance", "balance"] });
  expect(await runStep(context, STEP, "check")).toEqual(before);
  expect(mind.chat()).toEqual([]);
  expect(mind).toMatchObject({ mailed: [] });
});

test("a balance read answered ended: the ended card with no press, the secret by iterate's proxy deleted, the owner's own key kept", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit({ secrets: { "/secrets/openai": "own" } });
  const context = contextOf(mind, fake.credit);
  expect(await runStep(context, STEP, "connect")).toMatchObject({ status: "connected" });
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": "own", "/secrets/exa": "iterate-proxy" },
  });
  // a person at iterate ended the credit: the next check reads 403 iterate_credit_ended
  fake.state.balance = { ok: false, reason: "ended" };
  fake.calls.length = 0;
  await nextMs();
  const [card] = await onboardingCards({ ...context, now: NOW + 1 });
  expect(card).toMatchObject({
    status: "ended",
    text: [
      "A person at iterate ended this mind's credit. Your mind goes on with its own keys.",
      "Your signed rule still lets iterate send help and updates to this mind. End it with your passkey to stop that.",
    ],
    buttons: [OPEN_LINK, { label: "End the rule", action: "disconnect", opens: true }],
  });
  expect(fake).toMatchObject({
    calls: ["balance", "delete /secrets/exa"],
    secrets: { "/secrets/openai": "own", "/secrets/exa": "unset" },
  });
  // the end is for good: a later outage, pause or old answer keeps the ended card, asks iterate
  // nothing, and sets and deletes nothing
  for (const reason of ["cloud-unreachable", "paused", "not-connected"] as const) {
    fake.state.balance = { ok: false, reason };
    fake.calls.length = 0;
    await nextMs();
    expect(await runStep(context, STEP, "check")).toMatchObject({ status: "ended" });
    expect(fake).toMatchObject({
      calls: [],
      secrets: { "/secrets/openai": "own", "/secrets/exa": "unset" },
    });
  }
});

test("a balance read answered ended while the vault keeps a path (a form is open): the card says which path still goes to iterate, and the next check deletes it", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.balance = { ok: false, reason: "ended" };
  fake.state.deleteKept.add("/secrets/openai");
  await nextMs();
  const kept = await runStep(context, STEP, "check");
  expect(kept).toMatchObject({ status: "ended" });
  expect(kept.words).toMatch(/Your mind's requests to OpenAI still go to iterate/);
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": "iterate-proxy", "/secrets/exa": "unset" },
  });
  fake.state.deleteKept.clear();
  await nextMs();
  const done = await runStep(context, STEP, "check");
  expect(done).toMatchObject({ status: "ended" });
  expect(done.words).not.toMatch(/still go to iterate/);
  expect(fake).toMatchObject({ secrets: { "/secrets/openai": "unset", "/secrets/exa": "unset" } });
});

test("an older proxy's answer for an ended mind (402 not-connected) keeps today's card and deletes nothing", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.balance = { ok: false, reason: "not-connected" };
  fake.calls.length = 0;
  await nextMs();
  expect(await runStep(context, STEP, "check")).not.toMatchObject({ status: "ended" });
  expect(fake.calls.filter((call) => call.startsWith("delete "))).toEqual([]);
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": "iterate-proxy", "/secrets/exa": "iterate-proxy" },
  });
});

test("iterate's limit at the provider on a forwarded answer deletes no secret by iterate's proxy: the card stays connected", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  const before = await runStep(context, STEP, "check");
  fake.calls.length = 0;
  await hook(mind, fake.credit, {
    type: "events.iterate.com/agent/llm-request-settled",
    path: "/agents/a",
    offset: 901,
    payload: {
      failedKeys: [{ key: 1, error: "503 iterate_credit_provider_limit: iterate's limit" }],
    },
  });
  expect(fake).toMatchObject({
    calls: ["balance"],
    secrets: { "/secrets/openai": "iterate-proxy", "/secrets/exa": "iterate-proxy" },
  });
  expect(await runStep(context, STEP, "check")).toEqual(before);
});

test("enrolment-open from iterate.iterate.com connects a waiting step once: a second delivery connects no second time, and the agent is told once", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit({ connect: { ok: false, reason: "not-approved" } });
  const context = contextOf(mind, fake.credit);
  expect(await runStep(context, STEP, "connect")).toMatchObject({ status: "waiting" });
  // a person at iterate let the hostname in
  fake.state.connect = { ok: true, balance: BALANCE };
  fake.calls.length = 0;
  const open = fromIterate("events.iterate.com/cloud/enrolment-open", {
    hostname: "mind.example.com",
  });
  await mindHook(mind, fake.credit, open);
  await mindHook(mind, fake.credit, open);
  expect(fake.calls.filter((call) => call === "connect")).toEqual(["connect"]);
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": "iterate-proxy", "/secrets/exa": "iterate-proxy" },
  });
  expect(await runStep(context, STEP, "check")).toMatchObject({ status: "connected" });
  expect(mind.chat().map((event) => JSON.stringify(event.payload))).toEqual([
    expect.stringMatching(/iterate approved this mind just now, and the mind has \$9\.58/),
  ]);
  expect(mind).toMatchObject({ proposed: [] });
});

test("enrolment-open at iterate's hostname path (its mind in the hostname form, under a rule by hostname) connects a waiting step too", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit({ connect: { ok: false, reason: "not-approved" } });
  const context = contextOf(mind, fake.credit);
  expect(await runStep(context, STEP, "connect")).toMatchObject({ status: "waiting" });
  fake.state.connect = { ok: true, balance: BALANCE };
  fake.calls.length = 0;
  await mindHook(mind, fake.credit, {
    ...fromIterate("events.iterate.com/cloud/enrolment-open", { hostname: "mind.example.com" }),
    path: "/minds/iterate.iterate.com/cloud",
  });
  expect(fake.calls.filter((call) => call === "connect")).toEqual(["connect"]);
  expect(await runStep(context, STEP, "check")).toMatchObject({ status: "connected" });
});

test("enrolment-open does nothing on a declined step, on one with no rule, and from any other signer or path", async () => {
  const declined = fakeMind({ meld: "member" });
  const fake = fakeCredit({ connect: { ok: false, reason: "not-approved" } });
  const context = contextOf(declined, fake.credit);
  await runStep(context, STEP, "connect");
  await nextMs();
  await runStep(context, STEP, "decline");
  fake.state.connect = { ok: true, balance: BALANCE };
  fake.calls.length = 0;
  const open = fromIterate("events.iterate.com/cloud/enrolment-open", {
    hostname: "mind.example.com",
  });
  await mindHook(declined, fake.credit, open);
  expect(fake.calls).not.toContain("connect");
  expect(await runStep(context, STEP, "check")).toMatchObject({ status: "declined" });

  // no rule: no connect, and no passkey page from an event
  const unsigned = fakeMind();
  const quiet = fakeCredit();
  await mindHook(unsigned, quiet.credit, open);
  expect(quiet).toMatchObject({ calls: [] });
  expect(unsigned).toMatchObject({ proposed: [] });

  // another signer, or another path: returns before anything is read
  let reads = 0;
  const itx = new Proxy(
    {},
    {
      get: () => {
        reads += 1;
        throw new Error("read");
      },
    },
  ) as OnboardingItx;
  for (const event of [
    { ...open, source: { signer: { principal: { kind: "mind", actor: "other.example.com" } } } },
    { ...open, source: { signer: { principal: { actor: ITERATE_ID } } } },
    { ...open, source: undefined },
    { ...open, path: `/minds/${ITERATE_ID}/other` },
    { ...open, path: "/minds/iterate.iterate.com/other" },
    { ...open, path: "/minds/iterate.example.com/cloud" },
  ])
    await onboardingMindEvent(itx, event);
  expect(reads).toBe(0);
});

test("enrolled for THIS mind's id settles the step connected, with the secrets, as a 200 does; for another id nothing; a failure throws nothing", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit({ connect: { ok: false, reason: "not-approved" } });
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.connect = { ok: true, balance: BALANCE };
  fake.calls.length = 0;
  const grant = { hostname: "mind.example.com", grantedUsd: 10, remainingUsd: 10 };
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  await mindHook(
    mind,
    fake.credit,
    fromIterate("events.iterate.com/cloud/enrolled", { ...grant, mind: "other-mind-id" }),
  );
  expect(info).toHaveBeenCalledTimes(1);
  info.mockRestore();
  expect(fake.calls).not.toContain("connect");
  expect(await runStep(context, STEP, "check")).toMatchObject({ status: "waiting" });

  await mindHook(
    mind,
    fake.credit,
    fromIterate("events.iterate.com/cloud/enrolled", { ...grant, mind: MIND_ID }),
  );
  expect(fake.calls.filter((call) => call === "connect")).toEqual(["connect"]);
  expect(fake).toMatchObject({
    secrets: { "/secrets/openai": "iterate-proxy", "/secrets/exa": "iterate-proxy" },
  });
  expect(await runStep(context, STEP, "check")).toMatchObject({ status: "connected" });
  expect(mind.chat()).toHaveLength(1);

  // the hook's own failure: one log line, no throw, and the card keeps its state
  const broken = fakeMind({ meld: "member" });
  const failing = fakeCredit({ connect: { ok: false, reason: "not-approved" } });
  await runStep(contextOf(broken, failing.credit), STEP, "connect");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const itx = { ...broken.itx, url: async () => Promise.reject(new Error("no url")) };
  await expect(
    onboardingMindEvent(
      itx as OnboardingItx,
      fromIterate("events.iterate.com/cloud/enrolment-open", { hostname: "mind.example.com" }),
    ),
  ).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
  await nextMs();
  expect(await runStep(contextOf(broken, failing.credit), STEP, "check")).toMatchObject({
    status: "waiting",
  });
});

test("GET /open-cloud for a member: a 303 to this mind's own /sign-in/open, on to its page on iterate Cloud, with no call to iterate.com", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  const connected = await runStep(context, STEP, "connect");
  expect(connected.words).toMatch(/Buttons: Try a voice call · Open iterate Cloud · Disconnect/);
  const [card] = await onboardingCards(context);
  // a plain link to the app's own route
  expect(card?.buttons).toContainEqual(OPEN_LINK);
  fake.calls.length = 0;

  const fetches = vi.spyOn(globalThis, "fetch");
  const config = Object.create(Config.prototype, {
    auth: { value: auth },
    getItx: {
      value: () => ({
        whoami: async () => ({ mindSlug: "mind.example.com" }),
        [Symbol.dispose]: () => {},
      }),
    },
  }) as { fetch(request: Request): Promise<Response> };
  const answer = await config.fetch(
    new Request("https://onboarding.example.com/open-cloud", {
      headers: {
        "x-itx-principal": JSON.stringify({ actor: "user-1", email: "owner@example.org" }),
      },
    }),
  );
  expect(answer).toMatchObject({ status: 303 });
  const location = answer.headers.get("location")!;
  expect(location).toBe(
    "https://mind.example.com/sign-in/open?to=https%3A%2F%2Fcloud.iterate.com%2Fmind%3Fmind%3Dmind.example.com",
  );
  expect(new URL(location).searchParams.get("to")).toBe(
    "https://cloud.iterate.com/mind?mind=mind.example.com",
  );
  expect(answer.headers.get("cache-control")).toBe("no-store");
  expect(answer.headers.get("referrer-policy")).toBe("no-referrer");
  expect(fetches).not.toHaveBeenCalled();
  expect(fake).toMatchObject({ calls: [] });
  fetches.mockRestore();
});

test("GET /open-cloud with no hostname from the mind: a 503 with words, and no redirect", async () => {
  const answer = openCloud(undefined);
  expect(answer).toMatchObject({ status: 503 });
  expect(answer.headers.get("location")).toBeNull();
  expect(await answer.text()).toBe("This mind did not say its own hostname. Try again.");
});

test("Open iterate Cloud is on every card with a rule (connected, waiting, spent, ended), and on none without one", async () => {
  const waiting = fakeMind({ meld: "member" });
  const notYet = fakeCredit({ connect: { ok: false, reason: "not-approved" } });
  expect(await runStep(contextOf(waiting, notYet.credit), STEP, "connect")).toMatchObject({
    status: "waiting",
    words: expect.stringMatching(/Open iterate Cloud/),
  });
  const ended = fakeMind({ meld: "member" });
  const over = fakeCredit({ connect: { ok: false, reason: "ended" } });
  expect(await runStep(contextOf(ended, over.credit), STEP, "connect")).toMatchObject({
    status: "ended",
    words: expect.stringMatching(/Open iterate Cloud/),
  });
  const spent = fakeMind({ meld: "member" });
  const used = fakeCredit({
    balance: {
      ok: true,
      balance: { grantedUsd: 10, spentUsd: 10, remainingUsd: 0, pendingUsd: 0 },
    },
  });
  expect(await runStep(contextOf(spent, used.credit), STEP, "check")).toMatchObject({
    status: "spent",
    words: expect.stringMatching(/Open iterate Cloud/),
  });

  // no rule: no link
  const fresh = fakeMind();
  const [offer] = await onboardingCards(contextOf(fresh, fakeCredit().credit));
  expect(offer?.buttons.map((button) => button.label)).not.toContain("Open iterate Cloud");
});

test("the tool refuses a step or an action it does not have, with the ones it has", async () => {
  const mind = fakeMind();
  const { credit } = fakeCredit();
  await expect(runStep(contextOf(mind, credit), "nope", "connect")).rejects.toThrow(
    'onboarding: no step "nope" on this mind; its steps: connect-iterate-cloud',
  );
  await expect(runStep(contextOf(mind, credit), STEP, "explode")).rejects.toThrow(
    "its actions: check, decline, connect, disconnect, add-openai-key",
  );
  // iterate Cloud's own mind is offered no credit: no card, and the tool has no such step
  const cloud = { ...contextOf(mind, credit), mind: "iterate.iterate.com" };
  expect(stepsOf(await onboardingCards(cloud))).toEqual(["connect-cloudflare"]);
  await expect(runStep(cloud, STEP, "check")).rejects.toThrow(`no step "${STEP}" on this mind`);
});

test("Connect Cloudflare: offered with Not now, a press answers the MCP server's consent link that comes back here, and a set grant connects the card", async () => {
  const mind = fakeMind();
  const begun: { path: string; options: { next?: string } }[] = [];
  let set = false;
  const itx = {
    ...mind.itx,
    secrets: {
      ...mind.itx.secrets,
      describe: async (path: string) => ({ path, set: path === "/secrets/cloudflare" && set }),
      beginOAuth: async (path: string, options: { next?: string }) => {
        begun.push({ path, options });
        return { authorizationUrl: "https://mind.example.com/secrets/oauth/start?n=1", nonce: "n" };
      },
    },
  } as unknown as OnboardingItx;
  const context = { ...contextOf(mind, fakeCredit().credit), itx };
  const cardOf = async () =>
    (await onboardingCards(context)).find((card) => card.step === "connect-cloudflare");

  expect(await cardOf()).toMatchObject({
    status: "not-asked",
    buttons: [
      { label: "Connect Cloudflare", action: "connect", primary: true, opens: true },
      { label: "Not now", action: "decline" },
    ],
  });
  expect(await runStep(context, "connect-cloudflare", "connect")).toMatchObject({
    link: "https://mind.example.com/secrets/oauth/start?n=1",
  });
  expect(begun).toMatchObject([
    {
      path: "/secrets/cloudflare",
      options: {
        authorizationEndpoint: "https://mcp.cloudflare.com/authorize",
        next: "https://onboarding.example.com/",
      },
    },
  ]);
  set = true;
  await stepEvent(context, {
    type: "events.iterate.com/secret/set",
    path: "/secrets/cloudflare",
    offset: 99,
  });
  expect(await cardOf()).toMatchObject({ status: "connected", buttons: [] });
});

test("the hook reads nothing for an event no step hears", async () => {
  let reads = 0;
  const itx = new Proxy(
    {},
    {
      get: () => {
        reads += 1;
        throw new Error("read");
      },
    },
  ) as OnboardingItx;
  for (const event of [
    { type: "events.iterate.com/itx/woken", path: "/", offset: 1 },
    { type: "events.iterate.com/secret/set", path: "/secrets/google", offset: 2 },
    { type: "events.iterate.com/mind-meld/configured", path: "/minds/other.example", offset: 3 },
    {
      type: "events.iterate.com/agent/llm-request-settled",
      path: "/agents/a",
      offset: 4,
      payload: { failedKeys: [{ key: 1, error: "429 rate limited" }] },
    },
  ])
    await onboardingEvent(itx, event);
  expect(reads).toBe(0);
});

// ── the real calls, against what the platform answers ──

test("the real set names iterate's proxy and null material, and reads the platform's refusals: an older stack, and the owner's own key", async () => {
  const fresh = realCredit({});
  expect(await fresh.credit.setByProxy("/secrets/exa", ["https://api.exa.ai"])).toBe("set");
  expect(fresh).toMatchObject({
    sets: [
      [
        "/secrets/exa",
        null,
        {
          urls: ["https://api.exa.ai"],
          proxy: { mind: ITERATE_ID, url: "https://cloud.iterate.com/secret-proxy" },
        },
      ],
    ],
  });
  // a stack without the secret by proxy refuses null before it reads any option
  const older = realCredit({ setThrows: "secrets: material is a string or a JSON object" });
  expect(await older.credit.setByProxy("/secrets/exa", ["https://api.exa.ai"])).toBe(
    "no-proxy-layer",
  );
  // a key the owner set: never set over, and the platform's own refusal reads the same
  const own = realCredit({ describe: { "/secrets/openai": { set: true } } });
  expect(await own.credit.setByProxy("/secrets/openai", ["https://api.openai.com"])).toBe("own");
  expect(own).toMatchObject({ sets: [] });
  // the vault's own two refusals of a proxy (core/secrets-worker/src/secret/durable-object.ts)
  const ruled = realCredit({
    setThrows:
      "secrets.set with proxy: /secrets/openai has an approval rule, which no use by proxy can pass; clear the rule first",
  });
  expect(await ruled.credit.setByProxy("/secrets/openai", ["https://api.openai.com"])).toBe(
    "approval-rule",
  );
  const inFlight = realCredit({
    setThrows: "secrets.set with proxy: /secrets/openai is set or being set; delete it first",
  });
  expect(await inFlight.credit.setByProxy("/secrets/openai", ["https://api.openai.com"])).toBe(
    "being-set",
  );
  // the path was set since the read: say what it holds now
  for (const [now, answer] of [
    [{ set: true, proxy: ITERATE_PROXY }, "set"],
    [{ set: true }, "own"],
    [{ set: true, proxy: { mind: "x.example", url: "https://x.example/p" } }, "other-proxy"],
  ] as const) {
    const raced = realCredit({
      setThrows: "secrets.set with proxy: /secrets/exa is set or being set; delete it first",
      raced: { "/secrets/exa": now },
    });
    expect(await raced.credit.setByProxy("/secrets/exa", ["https://api.exa.ai"])).toBe(answer);
  }
  // any other refusal is the step's to read (it settles as stopped)
  const other = realCredit({ setThrows: "RPC: the connection was lost" });
  await expect(other.credit.setByProxy("/secrets/exa", ["https://api.exa.ai"])).rejects.toThrow(
    "the connection was lost",
  );
});

test.for([
  [
    "approval-rule",
    /has an approval rule on the mind's Secrets page, and iterate's proxy cannot pass one\. Remove the rule, then try again\./,
  ],
  ["being-set", /was being changed while the credit connected\. Try again\./],
] as const)(
  "the vault's refusal %s settles as a failure with its own words",
  async ([answer, words]) => {
    const mind = fakeMind({ meld: "member" });
    const fake = fakeCredit();
    fake.credit.setByProxy = async () => answer;
    const card = await runStep(contextOf(mind, fake.credit), STEP, "connect");
    expect(card).toMatchObject({ status: "failed" });
    expect(card.words).toMatch(words);
    expect(card.words).toMatch(/Try again · Not now · End the rule/);
  },
);

test("the real describe tells the owner's key, iterate's proxy and another proxy apart; a delete takes iterate's alone", async () => {
  const { credit, deleted } = realCredit({
    describe: {
      "/secrets/openai": { set: true },
      "/secrets/exa": { set: true, proxy: ITERATE_PROXY },
      "/secrets/other": { set: true, proxy: { mind: "x.example", url: "https://x.example/p" } },
    },
  });
  expect(
    await Promise.all(
      ["/secrets/none", "/secrets/openai", "/secrets/exa", "/secrets/other"].map(credit.secret),
    ),
  ).toEqual(["unset", "own", "iterate-proxy", "other-proxy"]);
  for (const path of ["/secrets/openai", "/secrets/exa", "/secrets/other"])
    await credit.deleteProxy(path);
  // by the vault's conditional delete, never the plain one
  expect(deleted).toEqual(["if-proxy /secrets/exa"]);
});

test("the real deleteProxy: an owner's key that lands after the describe stays, and the answer is false", async () => {
  const { credit, deleted } = realCredit({
    describe: { "/secrets/openai": { set: true, proxy: ITERATE_PROXY } },
    beforeDelete: { "/secrets/openai": { set: true } },
  });
  expect(await credit.deleteProxy("/secrets/openai")).toBe(false);
  expect(deleted).toEqual([]);
});

test.for([
  ['NOT_A_METHOD: "deleteIfProxy" is not a method at step 2 of secrets.deleteIfProxy'],
  ['The RPC receiver does not implement the method "deleteIfProxy".'],
  ['secrets: "deleteIfProxy" is no verb of a secret'],
] as const)(
  "the real deleteProxy on an older stack (%s) falls back to describe, then delete",
  async ([message]) => {
    const { credit, deleted } = realCredit({
      describe: { "/secrets/openai": { set: true, proxy: ITERATE_PROXY } },
      deleteIfProxyThrows: new Error(message),
    });
    expect(await credit.deleteProxy("/secrets/openai")).toBe(true);
    expect(deleted).toEqual(["/secrets/openai"]);
  },
);

test("the real deleteProxy throws any other error of the verb, and the fallback deletes nothing", async () => {
  const { credit, deleted } = realCredit({
    describe: { "/secrets/openai": { set: true, proxy: ITERATE_PROXY } },
    deleteIfProxyThrows: new Error("the vault did not answer"),
  });
  await expect(credit.deleteProxy("/secrets/openai")).rejects.toThrow("the vault did not answer");
  expect(deleted).toEqual([]);
});

test.for([
  [
    402,
    { error: { code: "iterate_credit_none_today", message: "No new grant today." } },
    "none-today",
  ],
  [402, { error: { code: "iterate_credit_paused" } }, "paused"],
  [
    403,
    {
      error: {
        code: "iterate_credit_not_approved",
        message:
          "iterate has not approved this mind yet. A person at iterate lets a mind in with their passkey; then connect again.",
        remainingUsd: 0,
      },
    },
    "not-approved",
  ],
  [403, { error: { code: "iterate_credit_ended" } }, "ended"],
  [409, { error: { code: "iterate_credit_hostname_enrolled" } }, "hostname-enrolled"],
  [401, {}, "not-recognised"],
  [502, {}, "no-working-key"],
  [500, {}, "cloud-unreachable"],
] as const)(
  "the Cloud's %i answer is read as its reason, at the connect and at the balance",
  async ([status, body, reason]) => {
    const { credit } = realCredit({ cloud: async () => Response.json(body, { status }) });
    expect(await credit.connect()).toMatchObject({ ok: false, reason });
    expect(await credit.balance()).toMatchObject({ ok: false, reason });
  },
);

test("the real grant answers the balance; a call that throws is cloud-unreachable; the key document says whether the mind signs", async () => {
  expect(await realCredit({}).credit.connect()).toEqual({ ok: true, balance: BALANCE });
  const thrown = realCredit({
    cloud: async () => {
      throw new Error("network connection lost");
    },
  });
  expect(await thrown.credit.balance()).toMatchObject({
    ok: false,
    reason: "cloud-unreachable",
    message: "network connection lost",
  });
  expect(await realCredit({ stackKey: { listed: true } }).credit.canSign()).toBe(true);
  expect(await realCredit({ stackKey: { listed: false } }).credit.canSign()).toBe(false);
  // today's document, before the identity's working key: no `listed`
  expect(await realCredit({ stackKey: { mind: "mind.example.com" } }).credit.canSign()).toBe(false);
});

// ── the app ──

test("the app is for members: its description names no other way in, and its two paths answer the cards and a press", async () => {
  const app = onboardingApp();
  const described = await app.open(
    new Request(`https://onboarding.example.com${APP_DESCRIPTION_PATH}`),
  );
  expect(AppDescription.parse(await described!.json())).toEqual({
    name: "Onboarding",
    icon: "/icon.svg",
    for: "members",
  });
  // only the description and the icon are open: the page and the steps are behind worker.ts's guard
  expect(app.open(new Request("https://onboarding.example.com/steps.json"))).toBeNull();
  expect(app.open(new Request("https://onboarding.example.com/"))).toBeNull();
});

test("the two paths keep the mind's handle until their answer is made: a handle used after its release fails, as the platform's does", async () => {
  const { itx } = fakeMind();
  // the real calls of cloud-credit.ts run here: no secret is set, and no key document answers
  const mind = { ...itx, secrets: { ...itx.secrets, describe: async () => ({ set: false }) } };
  const app = onboardingApp();
  const host = {
    auth: { memberPage: () => null },
    getItx: () => {
      let released = false;
      return new Proxy(mind, {
        get: (target, key) => {
          if (key === Symbol.dispose) return () => (released = true);
          if (released) throw new Error("RPC promise used after being disposed.");
          return Reflect.get(target, key);
        },
      });
    },
  } as unknown as Parameters<typeof app.fetch>[1];
  const cards = await app.fetch(new Request("https://onboarding.example.com/steps.json"), host);
  // as shipped (CREDIT_OPEN true) the page gets iterate Cloud's card, then Cloudflare's
  expect(cards).toMatchObject({ status: 200 });
  expect(stepsOf(await cards.json())).toEqual([STEP, "connect-cloudflare"]);
  const press = await app.fetch(
    new Request(`https://onboarding.example.com/steps/${STEP}/check`, { method: "POST" }),
    host,
  );
  // no key document answers, so the stack cannot sign: the card says to update, and asks nothing
  expect({ status: press.status, body: await press.json() }).toMatchObject({
    status: 200,
    body: { status: "unavailable" },
  });
  const statusRes = await app.fetch(
    new Request("https://onboarding.example.com/ai-status.json"),
    host,
  );
  expect({ status: statusRes.status, body: await statusRes.json() }).toEqual({
    status: 200,
    body: { chatgpt: false, openai: "unset", mind: "mind.example.com", zone: "example.com" },
  });
  const collectRes = await app.fetch(
    new Request("https://onboarding.example.com/collect-openai-key", { method: "POST" }),
    host,
  );
  expect({ status: collectRes.status, body: await collectRes.json() }).toEqual({
    status: 200,
    body: { link: "https://mind.example.com/secrets/collect/1" },
  });
  const verifyRes = await app.fetch(
    new Request("https://onboarding.example.com/verify-ai", { method: "POST" }),
    host,
  );
  expect(verifyRes).toMatchObject({ status: 200 });
  expect(await verifyRes.json()).toEqual({
    ok: true,
    provider: "ai-gateway",
    model: "gpt-6.2-sol",
  });
});

// ── verify-ai & centered no-AI wizard ──

test("verifyAi tests providers in agent priority order (ChatGPT -> /secrets/openai -> Cloudflare AI Gateway)", async () => {
  const sseOk =
    'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":18,"output_tokens":3}}}\n\n';
  const calls: string[] = [];

  // 1. ChatGPT plan set -> uses /secrets/chatgpt first and omits max_output_tokens (plan tokens refuse it)
  let chatgptBody: Record<string, unknown> = {};
  const chatgptItx = fakeVerifyItx({
    secrets: { "/secrets/chatgpt": { set: true }, "/secrets/openai": { set: true } },
    fetch: async (request) => {
      calls.push(request.headers.get("authorization") || "");
      chatgptBody = (await request.json()) as Record<string, unknown>;
      return new Response(sseOk, { status: 200 });
    },
  });
  expect(await verifyAi(chatgptItx)).toEqual({
    ok: true,
    provider: "chatgpt",
    model: "gpt-6.2-sol",
    reply: "ok",
    usage: { inputTokens: 18, outputTokens: 3 },
  });
  expect(calls).toEqual(['Bearer getSecret("/secrets/chatgpt", { field: "accessToken" })']);
  expect(chatgptBody).not.toHaveProperty("max_output_tokens");

  // 2. iterate Cloud proxy set -> reports iterate-cloud and caps max_output_tokens to 256
  let proxyBody: Record<string, unknown> = {};
  const cloudItx = fakeVerifyItx({
    secrets: { "/secrets/openai": { set: true, proxy: ITERATE_PROXY } },
    fetch: async (request) => {
      proxyBody = (await request.json()) as Record<string, unknown>;
      return new Response(sseOk, { status: 200 });
    },
  });
  expect(await verifyAi(cloudItx)).toEqual({
    ok: true,
    provider: "iterate-cloud",
    model: "gpt-6.2-sol",
    reply: "ok",
    usage: { inputTokens: 18, outputTokens: 3 },
  });
  expect(proxyBody).toMatchObject({ max_output_tokens: 256, store: false });

  // 3. Own OpenAI key set -> reports openai and accepts response.incomplete (when capped by max_output_tokens)
  const ownItx = fakeVerifyItx({
    secrets: { "/secrets/openai": { set: true } },
    fetch: async () =>
      new Response(
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.incomplete"}\n\n',
        { status: 200 },
      ),
  });
  expect(await verifyAi(ownItx)).toEqual({
    ok: true,
    provider: "openai",
    model: "gpt-6.2-sol",
    reply: "ok",
  });

  // 4. No keys set -> tests Cloudflare AI Gateway
  const gwItx = fakeVerifyItx({
    aiRun: async () => new Response(sseOk, { status: 200 }),
  });
  expect(await verifyAi(gwItx)).toEqual({
    ok: true,
    provider: "ai-gateway",
    model: "gpt-6.2-sol",
    reply: "ok",
    usage: { inputTokens: 18, outputTokens: 3 },
  });
});

test("verifyAi rejects truncated SSE streams without completion and bounds stalled response body reads", async () => {
  // Truncated stream: one text delta with no response.completed/incomplete must fail
  const truncatedItx = fakeVerifyItx({
    secrets: { "/secrets/openai": { set: true } },
    fetch: async () =>
      new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
        status: 200,
      }),
    aiRun: async () => new Response("payment required", { status: 402 }),
  });
  expect(await verifyAi(truncatedItx)).toMatchObject({ ok: false });

  // Stalled body stream after 200 headers must fail within timeoutMs and cancel the body
  let cancelled = false;
  const stalledItx = fakeVerifyItx({
    secrets: { "/secrets/openai": { set: true } },
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      ),
    aiRun: async () => new Response("payment required", { status: 402 }),
  });
  expect(await verifyAi(stalledItx, { timeoutMs: 30 })).toMatchObject({ ok: false });
  expect(cancelled).toBe(true);
});

test("verifyAi translates 402/401/429 and SSE failures into clean human-readable errors, never raw JSON", async () => {
  // Raw JSON 402 from Cloudflare AI Gateway
  const noCreditGw = fakeVerifyItx({
    aiRun: async () =>
      Response.json(
        { success: false, errors: [{ code: 2010, message: "Insufficient AI Gateway credits" }] },
        { status: 402 },
      ),
  });
  const gwFailed = await verifyAi(noCreditGw);
  expect(gwFailed).toMatchObject({ ok: false });
  if (gwFailed.ok) throw new Error("expected failure");
  expect(gwFailed.error).toContain("Cloudflare AI Gateway has no credit yet");
  expect(gwFailed.error).not.toContain("{");

  // Configured invalid OpenAI key takes precedence over fallback AI Gateway error
  const badKey = fakeVerifyItx({
    secrets: { "/secrets/openai": { set: true } },
    fetch: async () =>
      Response.json(
        { error: { code: "invalid_api_key", message: "Incorrect API key provided" } },
        { status: 401 },
      ),
    aiRun: async () =>
      Response.json({ errors: [{ message: "payment required" }] }, { status: 402 }),
  });
  const keyFailed = await verifyAi(badKey);
  expect(keyFailed).toEqual({
    ok: false,
    error: expect.stringContaining("Your OpenAI API key was rejected"),
  });

  // iterate Cloud not-approved 403
  expect(
    humanAiError(
      "iterate-cloud",
      403,
      JSON.stringify({ error: { code: "iterate_credit_not_approved", message: "Not approved" } }),
    ),
  ).toContain("iterate Cloud has not approved this mind yet");

  // iterate's own limit at the provider, on a forwarded answer: for each provider, the same words
  for (const provider of ["iterate-cloud", "openai"] as const)
    expect(
      humanAiError(
        provider,
        503,
        JSON.stringify({ error: { code: "iterate_credit_provider_limit", message: "Limit" } }),
      ),
    ).toBe(
      "iterate's account at the provider reached its spend limit, and iterate is told. Your mind goes on with its own keys.",
    );

  // iterate_credit_ended on a forwarded answer
  expect(
    humanAiError(
      "iterate-cloud",
      403,
      JSON.stringify({ error: { code: "iterate_credit_ended", message: "Ended" } }),
    ),
  ).toBe(
    "A person at iterate ended this mind's credit. Add your own OpenAI key, ChatGPT plan, or Cloudflare AI Gateway credit.",
  );

  // SSE 200 with response.failed event must fail, not pass
  const failedSse = fakeVerifyItx({
    secrets: { "/secrets/openai": { set: true } },
    fetch: async () =>
      new Response(
        'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"insufficient_quota"}}}\n\n',
        { status: 200 },
      ),
    aiRun: async () => new Response("payment required", { status: 402 }),
  });
  const sseResult = await verifyAi(failedSse);
  expect(sseResult).toMatchObject({ ok: false });
  if (sseResult.ok) throw new Error("expected failure");
  expect(sseResult.error).toContain("no available credit or billing is not set up");
});

test("aiStatus and collectOpenAiKey read credentials and create a secret-collection link", async () => {
  const { itx } = fakeMind();
  expect(await aiStatus(itx)).toEqual({
    chatgpt: false,
    openai: "unset",
    mind: "mind.example.com",
    zone: "example.com",
  });
  expect(await collectOpenAiKey(itx)).toEqual({
    link: "https://mind.example.com/secrets/collect/1",
  });
});

test("onboarding page is a centered no-AI wizard with no AgentChat, the optional Connect Cloudflare card on Configure AI, visible approval line, and model-authored reply gate", () => {
  const pageJs = readFileSync(
    new URL("../../configs/default/apps/onboarding/public/app.js", import.meta.url),
    "utf8",
  );
  expect(pageJs).not.toContain("AgentChat");
  expect(pageJs).toContain('const CLOUDFLARE_STEP = "connect-cloudflare";');
  expect(pageJs).toContain("pressStep(CLOUDFLARE_STEP, button)");
  // a failed press on the optional card shows on that card, not on Configure AI below it
  expect(pageJs).toContain("error=${optionalError}");
  expect(pageJs).toContain("/verify-ai");
  expect(pageJs).toContain("https://dash.${zone}/agents${AGENT}");
  expect(pageJs).toContain("approves each mind");
  expect(pageJs).toContain("llmRequestOffset");
  expect(pageJs).toContain('status === "disconnecting"');
  expect(pageJs).toContain("Done: your mind is set up");
  expect(pageJs).toContain('data-action="open-dash"');
  expect(pageJs).toContain("AI check passed");
  expect(pageJs).not.toContain("window.location.assign(dashOnboardingUrl)");
});

test("one note at the owner's signed rule, which starts the agent's turn: with the balance when the credit came, and with the reason when it did not", async () => {
  const mind = fakeMind();
  const { credit } = fakeCredit();
  await runStep(contextOf(mind, credit), STEP, "connect");
  await hook(mind, credit, mind.sign([`/minds/${ITERATE_ID}/`]));
  const notes = () => mind.chat().map((event) => JSON.stringify(event.payload));
  expect(notes()).toHaveLength(1);
  expect(notes()[0]).toMatch(/iterate\.iterate\.com can now send messages/);
  expect(notes()[0]).toMatch(/\$9\.58 of iterate's credit/);

  const refused = fakeMind();
  const none = fakeCredit({ connect: { ok: false, reason: "none-today" } });
  await runStep(contextOf(refused, none.credit), STEP, "connect");
  await hook(refused, none.credit, refused.sign([`/minds/${ITERATE_ID}/`]));
  const [note] = refused.chat();
  expect(refused.chat()).toHaveLength(1);
  expect(JSON.stringify(note?.payload)).toMatch(
    /The credit did not come: iterate made all its new grants for today/,
  );
  // a connect on a mind whose rule was signed before writes no note: the press shows the outcome
  const before = fakeMind({ meld: "member" });
  await runStep(contextOf(before, fakeCredit().credit), STEP, "connect");
  expect(before.chat()).toEqual([]);
});

test("a note that fails at the signed rule leaves the connect waiting: the retry writes the one credit note, and cloud-handover.ts still writes none", async () => {
  const mind = fakeMind();
  const { credit } = fakeCredit();
  await runStep(contextOf(mind, credit), STEP, "connect");
  let fail = true;
  const itx = {
    ...mind.itx,
    cd: (path: string) => {
      const at = mind.itx.cd(path);
      if (path !== "/agents/onboarding" || !fail) return at;
      fail = false;
      return { ...at, append: async () => Promise.reject(new Error("the append failed")) };
    },
  } as OnboardingItx;
  const rule = mind.sign([`/minds/${ITERATE_ID}/`]);
  await expect(stepEvent({ ...contextOf(mind, credit), itx }, rule)).rejects.toThrow(
    "the append failed",
  );
  expect(await connectWaitsForRule(mind.itx)).toBe(true);
  await hook(mind, credit, rule);
  expect(await connectWaitsForRule(mind.itx)).toBe(false);
  expect(mind.chat().map((event) => JSON.stringify(event.payload))).toEqual([
    expect.stringMatching(/\$9\.58 of iterate's credit/),
  ]);
});

test("at iterate's enrolment-open, a note that fails is one log line: the connect still settles connected, with no ask left waiting", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit({ connect: { ok: false, reason: "not-approved" } });
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.connect = { ok: true, balance: BALANCE };
  const itx = {
    ...mind.itx,
    cd: (path: string) => {
      const at = mind.itx.cd(path);
      if (path !== "/agents/onboarding") return at;
      return { ...at, append: async () => Promise.reject(new Error("the append failed")) };
    },
  } as OnboardingItx;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await stepMindEvent(
    async () => ({ ...context, itx }),
    fromIterate("events.iterate.com/cloud/enrolment-open", { hostname: "mind.example.com" }),
  );
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ event: "onboarding.approved-note-failed" }),
  );
  warn.mockRestore();
  await nextMs();
  expect(await runStep(context, STEP, "check")).toMatchObject({ status: "connected" });
  expect(mind.chat()).toEqual([]);
});

test("at iterate's enrolment-open, a settle that throws once ends the ask as stopped at once: Try again, and a later event of iterate's connects", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit({ connect: { ok: false, reason: "not-approved" } });
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.connect = { ok: true, balance: BALANCE };
  let fail = true;
  const itx = {
    ...mind.itx,
    cd: (path: string) => {
      const at = mind.itx.cd(path);
      if (path !== "/apps/onboarding") return at;
      return {
        ...at,
        append: async (...events: { type: string }[]) => {
          if (fail && events[0]?.type === "onboarding/step-action-settled") {
            fail = false;
            throw new Error("the settle failed");
          }
          return at.append(...(events as Parameters<typeof at.append>));
        },
      };
    },
  } as OnboardingItx;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await stepMindEvent(
    async () => ({ ...context, itx }),
    fromIterate("events.iterate.com/cloud/enrolment-open", { hostname: "mind.example.com" }),
  );
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ event: "onboarding.mind-event-failed" }),
  );
  warn.mockRestore();
  await nextMs();
  // the secrets were set before the settle failed: the credit pays, and the card says the connect
  // stopped, with Try again, at once and not after the ask's expiry
  const stopped = await runStep(context, STEP, "check");
  expect(stopped).toMatchObject({ status: "connected" });
  expect(stopped.words).toMatch(/The connect stopped before it finished\./);
  expect(stopped.words).toMatch(/Buttons: Try again/);
  await nextMs();
  const again = await runStep(context, STEP, "connect");
  expect(again).toMatchObject({ status: "connected" });
  expect(again.words).not.toMatch(/stopped/);
});

test("the credit-used mail goes once for each grant: two checks at the same moment, and a balance that passes zero again, send no second one", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.balance = {
    ok: true,
    balance: { grantedUsd: 10, spentUsd: 10.2, remainingUsd: -0.2, pendingUsd: 0 },
  };
  // a page open and the hook at once: both see the change from the same facts
  await Promise.all([runStep(context, STEP, "check"), onboardingCards(context)]);
  expect(mind).toMatchObject({ mailed: [{ to: "owner@example.org" }] });
  // and one delete of each path: the second check finds it unset
  expect(fake.calls.filter((call) => call.startsWith("delete "))).toEqual([
    "delete /secrets/openai",
    "delete /secrets/exa",
  ]);
  // a reservation settles below its estimate: the balance goes up, then down again
  fake.state.balance = { ok: true, balance: { grantedUsd: 10, spentUsd: 9.9, remainingUsd: 0.1 } };
  await runStep(context, STEP, "check");
  fake.state.balance = {
    ok: true,
    balance: { grantedUsd: 10, spentUsd: 10.3, remainingUsd: -0.3, pendingUsd: 0 },
  };
  await runStep(context, STEP, "check");
  expect(mind.mailed).toHaveLength(1);
  const drawn = mind
    .chat()
    .filter((event) => event.type === "events.iterate.com/agent/web-message-sent");
  expect(drawn).toHaveLength(1);
});

test.for([
  ["signed out", {}],
  [
    "a guest's session",
    { "x-itx-person": JSON.stringify({ userId: "u-1", email: "", name: "Ada", method: "guest" }) },
  ],
] as const)(
  "%s gets no cards, no press and no socket on the onboarding host: the guard answers before the app",
  async ([, headers]) => {
    // a bare instance with the SDK's own guard, and a mind that fails at any touch
    const config = Object.create(Config.prototype, {
      auth: { value: auth },
      getItx: {
        value: () => {
          throw new Error("the guard let a request through to the mind");
        },
      },
    }) as { fetch(request: Request): Promise<Response> };
    const at = (path: string, init: RequestInit = {}) =>
      config.fetch(
        new Request(`https://onboarding.example.com${path}`, {
          ...init,
          headers: { ...headers, ...init.headers },
        }),
      );
    for (const answer of [
      await at("/steps.json"),
      await at("/ai-status.json"),
      await at("/collect-openai-key", { method: "POST" }),
      await at("/verify-ai", { method: "POST" }),
      await at(`/steps/${STEP}/disconnect`, { method: "POST" }),
      await at("/open-cloud"),
      await at("/itx", { headers: { upgrade: "websocket" } }),
      await at("/"),
    ])
      expect(answer).toMatchObject({ status: 401 });
  },
);

test("a press from another origin is refused even with a member's session: no cross-site disconnect", async () => {
  const config = Object.create(Config.prototype, {
    auth: { value: auth },
    getItx: {
      value: () => {
        throw new Error("the guard let a request through to the mind");
      },
    },
  }) as { fetch(request: Request): Promise<Response> };
  const answer = await config.fetch(
    new Request(`https://onboarding.example.com/steps/${STEP}/disconnect`, {
      method: "POST",
      headers: {
        origin: "https://blog.example.com",
        "sec-fetch-site": "same-site",
        "x-itx-principal": JSON.stringify({ actor: "user-1", email: "owner@example.org" }),
      },
    }),
  );
  expect(answer).toMatchObject({ status: 403 });
});

// ── helpers ──

const at = (offset: number, type: string, payload: Record<string, unknown>): OnboardingEvent => ({
  offset,
  type: `onboarding/${type}`,
  payload,
});

type Logged = MindEvent & { idempotencyKey?: string; metadata?: unknown };

function fakeMind(
  options: {
    canSign?: boolean;
    meld?: "member" | "other" | null;
    /** The catalog's page leaves out these contexts (more active ones fill it, or no row yet). */
    unlisted?: string[];
  } = {},
) {
  const outside: string[] = [];
  const kv = new Map<string, string>();
  const logs = new Map<string, Logged[]>();
  let offset = 0;
  const logOf = (path: string) => logs.get(path) || (logs.set(path, []), logs.get(path)!);
  const appendAt = (path: string, input: Omit<Logged, "path" | "offset">) => {
    const log = logOf(path);
    const same = input.idempotencyKey && log.find((e) => e.idempotencyKey === input.idempotencyKey);
    if (same) {
      const body = (event: { payload?: unknown; metadata?: unknown }) =>
        JSON.stringify([event.payload, event.metadata]);
      if (body(same) !== body(input))
        throw Object.assign(new Error("taken"), { code: "IDEMPOTENCY_CONFLICT" });
      return same;
    }
    const event = { ...input, path, offset: ++offset };
    log.push(event);
    return event;
  };
  const proposed: { payload: unknown; next?: string }[] = [];
  const mailed: { from: string; to: unknown; text?: string }[] = [];
  const itx = {
    whoami: async () => ({ path: "/", mindSlug: "mind.example.com", mindId: MIND_ID }),
    url: async () => "https://example.com/",
    cd: (path: string) => ({
      readEvents: async (after = 0) => ({
        events: logOf(path).filter((e) => e.offset > after),
        scannedThroughOffset: offset,
        atHead: true,
      }),
      append: async (...events: Omit<Logged, "path" | "offset">[]) =>
        events.map((event) => appendAt(path, event)),
    }),
    fetch: async (request: Request) => {
      outside.push(`fetch ${request.url}`);
      return new Response(null, { status: 500 });
    },
    ai: {
      run: async () =>
        new Response('data: {"type":"response.completed"}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    },
    kv: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    },
    contexts: {
      list: async ({ under }: { under: string }) =>
        [...logs.keys()]
          .filter((path) => path === under || path.startsWith(`${under}/`))
          .filter((path) => !options.unlisted?.includes(path))
          .map((path) => ({ path })),
    },
    approvals: {
      proposeStatement: async (input: { payload: unknown; next?: string }) => {
        proposed.push(input);
        return {
          draft: "d",
          signAt: `https://mind.example.com/sign/${proposed.length}`,
          expires: NOW + 86_400_000,
        };
      },
    },
    secrets: {
      collectFromUser: async () => {
        outside.push("collectFromUser");
        return { url: "https://mind.example.com/secrets/collect/1" };
      },
      describe: async (path: string) => ({
        path,
        set: false,
      }),
    },
    email: {
      send: async (mail: { from: string; to: unknown; text?: string }) => {
        mailed.push(mail);
      },
    },
  };
  /** The owner's signed rule, as the platform lands it on `/minds/${ITERATE_ID}`. */
  const sign = (append: string[], member = true): MindEvent =>
    appendAt(MELD, {
      type: "events.iterate.com/mind-meld/configured",
      payload: { append },
      source: { signer: { principal: { email: "owner@example.org" }, member } },
    });
  if (options.meld) sign([`/minds/${ITERATE_ID}/`], options.meld === "member");
  return {
    // the fake has what the step reads, and the step's type names the whole root
    itx: itx as unknown as OnboardingItx,
    outside,
    logs,
    proposed,
    mailed,
    sign,
    onboarding: () => logOf("/apps/onboarding").map((e) => e.type.split("/").at(-1)),
    chat: () => logOf("/agents/onboarding"),
  };
}

function fakeVerifyItx(options: {
  secrets?: Record<string, { set: boolean; proxy?: { mind: string; url: string } }>;
  fetch?: (request: Request) => Promise<Response>;
  aiRun?: () => Promise<Response>;
}): VerifyAiItx {
  return {
    whoami: async () => ({ path: "/", mindSlug: "mind.example.com" }),
    url: async () => "https://example.com/",
    fetch: options.fetch || (async () => new Response("unexpected", { status: 500 })),
    ai: {
      run: options.aiRun || (async () => new Response('{"error":"no credit"}', { status: 402 })),
    },
    secrets: {
      describe: async (path: string) => ({
        path,
        set: false,
        ...options.secrets?.[path],
      }),
    },
  } as unknown as VerifyAiItx;
}

/** A press's check is keyed by the millisecond (steps.ts `runStep`): two in one write once. */
function nextMs() {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

/** A double of the step's calls outside its log: what the Cloud and the secrets answer, and every
 *  call made. */
function fakeCredit(
  init: {
    canSign?: boolean;
    secrets?: Record<string, SecretKind>;
    connect?: Awaited<ReturnType<CloudCredit["connect"]>>;
    balance?: Awaited<ReturnType<CloudCredit["balance"]>>;
    proxyLayer?: boolean;
    /** A set that throws this, for each path, until the test deletes it. */
    setThrows?: Record<string, string>;
  } = {},
) {
  const calls: string[] = [];
  const setThrows = { ...init.setThrows };
  const secrets: Record<string, SecretKind> = {
    "/secrets/openai": "unset",
    "/secrets/exa": "unset",
    ...init.secrets,
  };
  type Answer = Awaited<ReturnType<CloudCredit["balance"]>>;
  const state = {
    connect: init.connect || ({ ok: true, balance: BALANCE } as Answer),
    balance: init.balance || ({ ok: true, balance: BALANCE } as Answer),
    /** A delete of each path named here throws, until the test removes it. */
    deleteThrows: new Set<string>(),
    /** The vault keeps each path named here (a key form or a sign-in on it is open). */
    deleteKept: new Set<string>(),
  };
  const credit: CloudCredit = {
    canSign: async () => init.canSign ?? true,
    connect: async () => {
      calls.push("connect");
      return state.connect;
    },
    balance: async () => {
      calls.push("balance");
      return state.balance;
    },
    secret: async (path) => secrets[path] || "unset",
    setByProxy: async (path) => {
      calls.push(`set ${path}`);
      if (setThrows[path]) throw new Error(setThrows[path]);
      if (init.proxyLayer === false) return "no-proxy-layer";
      if (secrets[path] === "own") return "own";
      secrets[path] = "iterate-proxy";
      return "set";
    },
    deleteProxy: async (path) => {
      if (state.deleteThrows.has(path)) throw new Error("the vault did not answer");
      if (secrets[path] !== "iterate-proxy" || state.deleteKept.has(path)) return false;
      calls.push(`delete ${path}`);
      secrets[path] = "unset";
      return true;
    },
  };
  return { credit, calls, secrets, state, setThrows };
}

/** The steps of the cards, in the page's order. */
const stepsOf = (cards: { step: string }[]) => cards.map((card) => card.step);

const contextOf = (mind: ReturnType<typeof fakeMind>, credit: CloudCredit): StepContext => ({
  itx: mind.itx,
  credit,
  mind: "mind.example.com",
  zone: "example.com",
  now: NOW,
  creditOpen: true,
});

/** The hook, as worker.ts calls it, with the double in place of the real calls. */
const hook = (mind: ReturnType<typeof fakeMind>, credit: CloudCredit, event: MindEvent) =>
  stepEvent(contextOf(mind, credit), event);

/** The hook for another mind's event (worker.ts `processMindEvent`), with the double. */
const mindHook = (mind: ReturnType<typeof fakeMind>, credit: CloudCredit, event: MindEvent) =>
  stepMindEvent(async () => contextOf(mind, credit), event);

/** An event iterate.iterate.com signed on the mind's `/minds/<iterate's id>/cloud`. */
let delivered = 5000;
const fromIterate = (type: string, payload: Record<string, unknown>): MindEvent => ({
  type,
  path: `/minds/${ITERATE_ID}/cloud`,
  offset: ++delivered,
  payload,
  source: { signer: { principal: { kind: "mind", actor: ITERATE_ID } } },
});

function realCredit(answers: {
  describe?: Record<string, unknown>;
  setThrows?: string;
  /** What a concurrent write made of a path, landed just before the set's refusal. */
  raced?: Record<string, unknown>;
  stackKey?: unknown;
  cloud?: () => Promise<Response>;
  /** What lands on a path after its describe and before `deleteIfProxy` (an owner's key). */
  beforeDelete?: Record<string, unknown>;
  /** What `deleteIfProxy` throws: an older stack's refusal, or any other error. */
  deleteIfProxyThrows?: Error;
}) {
  const sets: unknown[][] = [];
  const deleted: string[] = [];
  const cloudRequests: string[] = [];
  const described: Record<string, unknown> = { ...answers.describe };
  const itx = {
    whoami: async () => ({ path: "/", mindSlug: "mind.example.com" }),
    fetch: async (request: Request) => {
      expect(request).toMatchObject({ url: "https://mind.example.com/keys/stack.json" });
      return Response.json(answers.stackKey ?? {});
    },
    minds: {
      get: (mind: string) => {
        expect(mind).toBe(ITERATE_ID);
        return {
          fetch: (request: Request) => {
            expect(request.url.startsWith("https://cloud.iterate.com/secret-proxy/")).toBe(true);
            cloudRequests.push(`${request.method} ${request.url}`);
            return answers.cloud ? answers.cloud() : Promise.resolve(Response.json(BALANCE));
          },
        };
      },
    },
    secrets: {
      describe: async (path: string) => ({ path, set: false, ...(described[path] as object) }),
      set: async (...args: unknown[]) => {
        sets.push(args);
        if (answers.setThrows) {
          Object.assign(described, answers.raced);
          throw new Error(answers.setThrows);
        }
        described[args[0] as string] = { set: true, proxy: ITERATE_PROXY };
      },
      delete: async (path: string) => {
        deleted.push(path);
      },
      // the vault's condition, as it decides it: a secret by proxy and nothing else
      deleteIfProxy: async (path: string) => {
        if (answers.deleteIfProxyThrows) throw answers.deleteIfProxyThrows;
        Object.assign(described, answers.beforeDelete);
        const byProxy = Boolean((described[path] as { proxy?: unknown } | undefined)?.proxy);
        if (byProxy) deleted.push(`if-proxy ${path}`);
        return { path, deleted: byProxy };
      },
    },
  };
  return { credit: cloudCredit(itx as unknown as OnboardingItx), sets, deleted, cloudRequests };
}
