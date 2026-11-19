// The default config's onboarding app (core/configs/default/apps/onboarding): the reduce of its
// four events, the step "Connect to iterate Cloud" against a double of its calls to iterate
// Cloud and the secrets (cloud-credit.ts), the agent's tool answers, the cards the page draws, and
// the real calls' reading of what the platform answers. The fake mind keeps logs in memory and
// takes what the real one takes: a key with another body is refused, one with the same body
// answers the event it has.
/// <reference path="../../configs/default/files.d.ts" />
import { readFileSync } from "node:fs";
import { expect, onTestFinished, test, vi } from "vitest";
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
  runStep,
  type StepContext,
  stepEvent,
} from "../../configs/default/apps/onboarding/steps.ts";
import Config from "../../configs/default/worker.ts";
import { APP_DESCRIPTION_PATH, AppDescription } from "./app-description.ts";
import { auth } from "./sdk/auth.ts";

const STEP = "connect-iterate-cloud";
const CLOUDFLARE = "connect-cloudflare";
const MELD = "/minds/iterate.iterate.com";
const NOW = Date.parse("2026-11-18T22:00:00Z");
/** The consent page of the stack's own client at Cloudflare, as the fake vault begins it. */
const CONSENT = "https://dash.cloudflare.com/oauth2/auth?client_id=stack-client";
const BALANCE = { grantedUsd: 10, spentUsd: 0.42, remainingUsd: 9.58 };

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
    "Your agents already work without it, paid by your own Cloudflare account (its AI Gateway credit). After you connect, each agent request goes to iterate's credit first.",
  ]);
  expect(card?.points?.find((point) => point.title === "When the $10 is spent")?.text).toBe(
    "Your agents go on through your own Cloudflare account, but each of their requests still goes to iterate first and is refused there, until you disconnect or add a key of your own. Voice calls and web research stop until you add a key of your own. A key of your own always wins over the credit.",
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
  expect(card).toMatchObject({
    buttons: [
      { label: "Connect", action: "connect", opens: true },
      { label: "End the rule", action: "disconnect", opens: true },
    ],
  });
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
        payload: { append: ["/minds/iterate.iterate.com/"] },
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
  await hook(mind, credit, mind.sign(["/minds/iterate.iterate.com/"], false));
  expect(calls).toEqual([]);

  // the member's signed rule: the grant, then each secret
  await hook(mind, credit, mind.sign(["/minds/iterate.iterate.com/"]));
  expect(calls).toEqual(["connect", "set /secrets/openai", "set /secrets/exa", "balance"]);
  expect(secrets).toEqual({ "/secrets/openai": "iterate-proxy", "/secrets/exa": "iterate-proxy" });
  const [card] = await onboardingCards(context);
  expect(card).toMatchObject({
    status: "connected",
    title: "Connected to iterate Cloud",
    text: ["$9.58 of $10 left."],
    buttons: [
      { label: "Try a voice call", href: "https://voice.example.com/" },
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
  ["none-today", /today's are gone\. Try again tomorrow \(UTC\)\./],
  ["paused", /iterate's credit is paused until tomorrow \(UTC\)\./],
  ["not-recognised", /did not recognise this mind's signature/],
  ["cloud-unreachable", /iterate Cloud did not answer\. Try again in a minute\./],
] as const)(
  "a grant refused as %s sets no secret, and the card says why",
  async ([reason, words]) => {
    const mind = fakeMind({ meld: "member" });
    const { credit, calls, secrets } = fakeCredit({ connect: { ok: false, reason } });
    const answer = await runStep(contextOf(mind, credit), STEP, "connect");
    expect(calls.filter((call) => call.startsWith("set "))).toEqual([]);
    expect(secrets).toEqual({ "/secrets/openai": "unset", "/secrets/exa": "unset" });
    expect(answer).toMatchObject({ status: "failed" });
    expect(answer.words).toMatch(words);
  },
);

test.for([
  "none-today",
  "paused",
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
    await hook(mind, credit, mind.sign(["/minds/iterate.iterate.com/"]));
    const note = mind.chat().map((event) => JSON.stringify(event.payload));
    expect(note).toHaveLength(1);
    expect(note[0]).toMatch(/The rule stands until the owner ends it with their passkey/);
    const card = await runStep(context, STEP, "check");
    expect(card).toMatchObject({ status: "failed" });
    expect(card.words).toMatch(
      /Your signed rule still lets iterate send help and updates to this mind\. End it with your passkey to stop that\./,
    );
    expect(card.words).toMatch(/Try again · Not now · End the rule/);
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
  await hook(mind, fake.credit, mind.sign(["/minds/iterate.iterate.com/"]));
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
  second.state.balance = { ok: true, balance: { grantedUsd: 10, spentUsd: 10, remainingUsd: 0 } };
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
  expect(half.words).toMatch(/Buttons: Try again · Try a voice call · Disconnect/);
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
  await hook(mind, fake.credit, mind.sign(["/minds/iterate.iterate.com/"]));
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

test("the spent card with an own OpenAI key names only what stopped: web research", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit({
    secrets: { "/secrets/openai": "own", "/secrets/exa": "iterate-proxy" },
    balance: { ok: true, balance: { grantedUsd: 10, spentUsd: 10, remainingUsd: 0 } },
  });
  const card = await runStep(contextOf(mind, fake.credit), STEP, "check");
  expect(card).toMatchObject({ status: "spent" });
  expect(card.words).toMatch(/Web research stops until you add a key of your own\./);
  expect(card.words).not.toMatch(/Your agents go on/);
});

test("the guides say who pays, and the spoken offer does not claim the agents need the credit", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../../configs/default/${path}`, import.meta.url), "utf8").replaceAll(
      /\s+/g,
      " ",
    );
  const guide = read("onboarding/connect-iterate-cloud.md");
  expect(guide).toContain(
    "before the connect, the mind's agents already work, paid by the owner's own Cloudflare account",
  );
  expect(guide).toContain(
    "When the credit is spent, the agents go on through the owner's Cloudflare account, but each request still goes to iterate first and is refused there, until the owner disconnects or sets a key of their own. Voice calls and web research stop until the owner sets a key.",
  );
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
  await stepEvent(context, mind.sign(["/minds/iterate.iterate.com/"]));
  expect(calls).toEqual([]);
  expect(mind).toMatchObject({ proposed: [] });
  expect(mind.chat()).toEqual([]);
});

// ── the step "Connect Cloudflare" ──

test("Connect Cloudflare on a stack with no OAuth client: no button, the deploy command, the same words for the agent, and nothing reaches Cloudflare", async () => {
  const mind = fakeMind();
  const { credit } = fakeCredit();
  const context = contextOf(mind, credit);
  expect(await cloudflareCard(context)).toEqual({
    step: CLOUDFLARE,
    status: "no-client",
    title: "Connect Cloudflare",
    optional: true,
    text: [
      "Your mind can read its own Cloudflare account: logs, usage, settings. It can change nothing there.",
      "This mind has no OAuth client at Cloudflare yet. Run this command once more on your computer and paste one Cloudflare API token when it asks:",
    ],
    command: "npx iterate deploy --domain example.com",
    buttons: [],
  });
  // the agent's tool: the same words, and a press of "connect" begins nothing
  const answer = await runStep(context, CLOUDFLARE, "connect");
  expect(answer).toEqual({
    status: "no-client",
    words: expect.stringContaining("Command: npx iterate deploy --domain example.com"),
    link: undefined,
  });
  expect(mind).toMatchObject({ outside: [] });
});

test("Connect Cloudflare: one sentence and one button; no request to Cloudflare before the member presses; the press begins the stack's own connect, and the tool answers its link", async () => {
  const mind = fakeMind({ cloudflare: { stackClient: true } });
  const { credit } = fakeCredit();
  const context = contextOf(mind, credit);
  expect(await cloudflareCard(context)).toEqual({
    step: CLOUDFLARE,
    status: "not-asked",
    title: "Connect Cloudflare",
    optional: true,
    text: [
      "Your mind can read its own Cloudflare account: logs, usage, settings. It can change nothing there.",
    ],
    buttons: [
      { label: "Connect Cloudflare", action: "connect", primary: true, opens: true },
      { label: "Not now", action: "decline" },
    ],
  });
  expect(mind).toMatchObject({ outside: [] });
  // the press: the same connect as the Integrations card's "Connect", through the stack's client
  const answer = await runStep(context, CLOUDFLARE, "connect");
  const consent = "https://dash.cloudflare.com/oauth2/auth?client_id=stack-client";
  expect(answer).toMatchObject({ status: "connecting", link: consent });
  expect(mind.outside[0]).toBe(
    `beginOAuth /secrets/cloudflare ${JSON.stringify({
      client: { stack: "cloudflare" },
      straightToProvider: true,
      next: "https://onboarding.example.com/",
    })}`,
  );
  expect(mind.outside.filter((call) => call.startsWith("fetch"))).toEqual([]);
  expect(await cloudflareCard(context)).toMatchObject({
    status: "connecting",
    text: ["Waiting for your approval on Cloudflare's page."],
    buttons: [{ label: "Open Cloudflare's page", href: consent, primary: true }],
  });
});

test("Connect Cloudflare after the consent: the account's name; the template's words for another account; a refusal reads as an error", async () => {
  // the vault refused the consent: its own words, as a failure with Try again
  const refused = fakeMind({ cloudflare: { stackClient: true } });
  const { credit } = fakeCredit();
  await runStep(contextOf(refused, credit), CLOUDFLARE, "connect");
  refused.cloudflare.attempt = {
    status: "failed",
    error:
      "The consent does not reach the Cloudflare account that holds this mind (abc). Nothing was kept.",
  };
  expect(await cloudflareCard(contextOf(refused, credit))).toMatchObject({
    status: "failed",
    text: [
      "The consent does not reach the Cloudflare account that holds this mind (abc). Nothing was kept.",
    ],
    buttons: [
      { label: "Try again", action: "connect", primary: true, opens: true },
      { label: "Not now", action: "decline" },
    ],
  });

  // the consent kept: its set settles the connect, and the card names the account
  const mind = fakeMind({ cloudflare: { stackClient: true } });
  const context = contextOf(mind, credit);
  await runStep(context, CLOUDFLARE, "connect");
  Object.assign(mind.cloudflare, {
    held: true,
    attempt: { status: "complete" },
    row: { account: "Ada's account", status: { kind: "ok" } },
  });
  await stepEvent(context, {
    type: "events.iterate.com/secret/set",
    path: "/secrets/cloudflare",
    offset: 900,
  });
  expect(await cloudflareCard(context)).toEqual({
    step: CLOUDFLARE,
    status: "connected",
    title: "Cloudflare is connected",
    text: ["Your mind reads the account Ada's account. It can change nothing there."],
    buttons: [{ label: "Connect again", action: "again", opens: true }],
  });
  // a consent of another account, as the template's check wrote it on the Integrations card
  mind.cloudflare.row = {
    account: "Cloudflare account",
    status: {
      kind: "error",
      text: "The consent does not reach the Cloudflare account that holds example.com: it is for another account. Connect again, and approve as a member of the account that holds example.com.",
    },
  };
  await stepEvent(context, {
    type: "events.iterate.com/integration/connection-configured",
    path: "/integrations",
    offset: 901,
  });
  expect(await cloudflareCard(context)).toMatchObject({
    status: "failed",
    text: [
      expect.stringMatching(
        /^The consent does not reach the Cloudflare account that holds example\.com/,
      ),
    ],
    buttons: [{ label: "Connect again", action: "again", primary: true, opens: true }],
  });
  expect(mind.outside.filter((call) => call.startsWith("fetch"))).toEqual([]);
});

// ── the table of "Connect Cloudflare" (steps/connect-cloudflare.ts, at the top): one test a row ──

test("table, no-client: neither connect nor again begins anything", async () => {
  const { context, begins } = cloudflareTable({ stackClient: false });
  for (const action of ["connect", "again"])
    expect(await runStep(context, CLOUDFLARE, action)).toMatchObject({ status: "no-client" });
  expect(begins()).toBe(0);
});

test("table, not-asked and declined: Connect Cloudflare begins, and the page opens its tab", async () => {
  const { begins, press } = cloudflareTable();
  await press("Not now");
  expect(await press("Connect Cloudflare")).toMatchObject({ status: "connecting", link: CONSENT });
  expect(begins()).toBe(1);
});

test("table, connecting: connect answers the same link and begins nothing; again begins", async () => {
  const { context, begins } = cloudflareTable();
  const first = await runStep(context, CLOUDFLARE, "connect");
  // the owner is on Cloudflare's page; the agent, or a second tab's button, presses again
  expect(await runStep(context, CLOUDFLARE, "connect")).toEqual(first);
  expect(begins()).toBe(1);
  expect(await runStep(context, CLOUDFLARE, "again")).toMatchObject({ status: "connecting" });
  expect(begins()).toBe(2);
});

test("table, failed with no grant: Try again begins a new consent; Not now puts it aside", async () => {
  const { mind, begins, press, refused } = cloudflareTable();
  await press("Connect Cloudflare");
  mind.cloudflare.attempt = refused;
  expect(await press("Try again")).toMatchObject({ status: "connecting", link: CONSENT });
  expect(begins()).toBe(2);
  mind.cloudflare.attempt = refused;
  expect(await press("Not now")).toMatchObject({ status: "declined" });
});

test("table, failed: an attempt that a later begin replaced is no longer connecting, and Try again begins", async () => {
  const { mind, card, begins, press } = cloudflareTable();
  await press("Connect Cloudflare");
  // the Integrations card's "Connect" began its own attempt on the same path
  mind.cloudflare.attempt = { status: "unavailable" };
  expect(await card()).toMatchObject({
    status: "failed",
    text: ["A newer link to Cloudflare replaced this one. Nothing was kept from it."],
  });
  expect(await press("Try again")).toMatchObject({ status: "connecting" });
  expect(begins()).toBe(2);
});

test("table, connected: connect begins nothing; Connect again begins, and the page opens its tab", async () => {
  const { begins, press, kept, context } = cloudflareTable();
  await press("Connect Cloudflare");
  await kept();
  expect(await runStep(context, CLOUDFLARE, "connect")).toMatchObject({
    status: "connected",
    link: undefined,
  });
  expect(begins()).toBe(1);
  expect(await press("Connect again")).toMatchObject({ status: "connecting", link: CONSENT });
  expect(begins()).toBe(2);
});

test("table, connected and a newer attempt refused: Try again begins a new consent, though the earlier grant is held", async () => {
  const { mind, context, card, begins, press, kept, refused } = cloudflareTable();
  await press("Connect Cloudflare");
  await kept();
  await press("Connect again");
  mind.cloudflare.attempt = refused;
  expect(await card()).toMatchObject({
    status: "failed",
    text: [refused.error],
  });
  expect(await press("Try again")).toMatchObject({ status: "connecting", link: CONSENT });
  expect(begins()).toBe(3);
  // the agent's connect on the same failed card begins too
  mind.cloudflare.attempt = refused;
  expect(await runStep(context, CLOUDFLARE, "connect")).toMatchObject({ status: "connecting" });
  expect(begins()).toBe(4);
  // Not now puts the refused attempt aside: the card is the grant's again
  mind.cloudflare.attempt = refused;
  expect(await press("Not now")).toMatchObject({ status: "connected" });
});

test("table, another account: Connect again begins", async () => {
  const { begins, press, kept } = cloudflareTable();
  await press("Connect Cloudflare");
  await kept({
    account: "Cloudflare account",
    status: { kind: "error", text: "The consent does not reach the account that holds this mind." },
  });
  expect(await press("Connect again")).toMatchObject({ status: "connecting" });
  expect(begins()).toBe(2);
});

test("table, the hour ran out: Try again begins", async () => {
  const { context, begins, press } = cloudflareTable();
  await press("Connect Cloudflare");
  const later = { ...context, now: NOW + 3_600_001 };
  expect(await runStep(later, CLOUDFLARE, "check")).toMatchObject({ status: "failed" });
  expect(await runStep(later, CLOUDFLARE, "connect")).toMatchObject({ status: "connecting" });
  expect(begins()).toBe(2);
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
  expect(mind.proposed.at(-1)?.payload).toEqual({ append: [] });
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

test("the credit used: the card names the three ways to pay, and the chat and the owner's mail say it once", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.balance = {
    ok: true,
    balance: { grantedUsd: 10, spentUsd: 10.2, remainingUsd: -0.2 },
  };
  const answer = await runStep(context, STEP, "check");
  expect(answer).toMatchObject({ status: "spent" });
  expect(answer.words).toMatch(/Your \$10 of credit is used\./);
  // who pays now, said plainly: the agents fall back to Cloudflare, voice and research stop
  expect(answer.words).toMatch(
    /Your agents go on through your own Cloudflare account, but each of their requests still goes to iterate first and is refused there, until you disconnect or add a key of your own\./,
  );
  expect(answer.words).toMatch(
    /Voice calls and web research stop until you add a key of your own\./,
  );
  expect(answer.words).toMatch(/Choose what pays now:/);
  expect(answer.words).toMatch(/Command: npx iterate@latest chatgpt connect mind\.example\.com/);
  expect(answer.words).toMatch(/Add my OpenAI key · Add Cloudflare credit · Disconnect/);
  const drawn = () =>
    mind.chat().filter((event) => event.type === "events.iterate.com/agent/web-message-sent");
  expect(drawn()).toHaveLength(1);
  expect(mind).toMatchObject({
    mailed: [{ from: "onboarding@example.com", to: "owner@example.org" }],
  });
  // checked again, and the page opened again: nothing more is said
  await runStep(context, STEP, "check");
  await onboardingCards(context);
  expect(drawn()).toHaveLength(1);
  expect(mind.mailed).toHaveLength(1);
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
          proxy: { mind: "iterate.iterate.com", url: "https://cloud.iterate.com/secret-proxy" },
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
  expect(deleted).toEqual(["/secrets/exa"]);
});

test.for([
  [
    402,
    { error: { code: "iterate_credit_none_today", message: "No new grant today." } },
    "none-today",
  ],
  [402, { error: { code: "iterate_credit_paused" } }, "paused"],
  [401, {}, "not-recognised"],
  [502, {}, "no-working-key"],
  [500, {}, "cloud-unreachable"],
] as const)("the Cloud's %i answer is read as its reason", async ([status, body, reason]) => {
  const { credit } = realCredit({ cloud: async () => Response.json(body, { status }) });
  expect(await credit.connect()).toMatchObject({ ok: false, reason });
});

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
  // as shipped (CREDIT_OPEN true) the page gets iterate Cloud's card and Cloudflare's
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
});

test("one note at the owner's signed rule, which starts the agent's turn: with the balance when the credit came, and with the reason when it did not", async () => {
  const mind = fakeMind();
  const { credit } = fakeCredit();
  await runStep(contextOf(mind, credit), STEP, "connect");
  await hook(mind, credit, mind.sign(["/minds/iterate.iterate.com/"]));
  const notes = () => mind.chat().map((event) => JSON.stringify(event.payload));
  expect(notes()).toHaveLength(1);
  expect(notes()[0]).toMatch(/iterate\.iterate\.com can now send messages/);
  expect(notes()[0]).toMatch(/\$9\.58 of iterate's credit/);

  const refused = fakeMind();
  const none = fakeCredit({ connect: { ok: false, reason: "none-today" } });
  await runStep(contextOf(refused, none.credit), STEP, "connect");
  await hook(refused, none.credit, refused.sign(["/minds/iterate.iterate.com/"]));
  const [note] = refused.chat();
  expect(refused.chat()).toHaveLength(1);
  expect(JSON.stringify(note?.payload)).toMatch(
    /The credit did not come: iterate gives a limited number/,
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
  const rule = mind.sign(["/minds/iterate.iterate.com/"]);
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

test("the credit-used mail goes once for each grant: two checks at the same moment, and a balance that passes zero again, send no second one", async () => {
  const mind = fakeMind({ meld: "member" });
  const fake = fakeCredit();
  const context = contextOf(mind, fake.credit);
  await runStep(context, STEP, "connect");
  fake.state.balance = {
    ok: true,
    balance: { grantedUsd: 10, spentUsd: 10.2, remainingUsd: -0.2 },
  };
  // a page open and the hook at once: both see the change from the same facts
  await Promise.all([runStep(context, STEP, "check"), onboardingCards(context)]);
  expect(mind).toMatchObject({ mailed: [{ to: "owner@example.org" }] });
  // a reservation settles below its estimate: the balance goes up, then down again
  fake.state.balance = { ok: true, balance: { grantedUsd: 10, spentUsd: 9.9, remainingUsd: 0.1 } };
  await runStep(context, STEP, "check");
  fake.state.balance = {
    ok: true,
    balance: { grantedUsd: 10, spentUsd: 10.3, remainingUsd: -0.3 },
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
      await at(`/steps/${STEP}/disconnect`, { method: "POST" }),
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
    /** The mind's Cloudflare: whether the deploy made the stack's client, a kept grant, the
     *  Integrations card's row for it, and what the vault says of a connect's attempt. */
    cloudflare?: {
      stackClient?: boolean;
      held?: boolean;
      row?: { account: string; status: { kind: string; text?: string } };
      attempt?: { status: string; error?: string };
    };
  } = {},
) {
  const cloudflare = { stackClient: false, held: false, ...options.cloudflare };
  /** Every call that reaches Cloudflare or begins a connect: none before a member's press. */
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
    whoami: async () => ({ path: "/", mindSlug: "mind.example.com" }),
    url: async () => "https://example.com/",
    cd: (path: string) => ({
      readEvents: async (after = 0) => ({
        events: logOf(path).filter((e) => e.offset > after),
        scannedThroughOffset: offset,
        atHead: true,
      }),
      append: async (...events: Omit<Logged, "path" | "offset">[]) =>
        events.map((event) => appendAt(path, event)),
      // the Integrations registry, as the template's Cloudflare card keeps it
      facets: {
        get: () => ({
          snapshot: async () => ({
            state: {
              integrations: {},
              connections: cloudflare.row ? { "cloudflare/account": cloudflare.row } : {},
            },
          }),
        }),
      },
    }),
    fetch: async (request: Request) => {
      outside.push(`fetch ${request.url}`);
      return new Response(null, { status: 500 });
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
      hasStackClient: async (name: string) => name === "cloudflare" && cloudflare.stackClient,
      describe: async (path: string) => ({
        path,
        set: path === "/secrets/cloudflare" && cloudflare.held,
      }),
      beginOAuth: async (path: string, input: Record<string, unknown>) => {
        outside.push(`beginOAuth ${path} ${JSON.stringify(input)}`);
        // the vault's one attempt for the path: a new one waits
        delete cloudflare.attempt;
        return {
          authorizationUrl: "https://dash.cloudflare.com/oauth2/auth?client_id=stack-client",
          nonce: `attempt-${outside.filter((call) => call.startsWith("beginOAuth")).length}`,
        };
      },
      oauthResult: async (path: string, { nonce }: { nonce: string }) => {
        outside.push(`oauthResult ${path} ${nonce}`);
        return cloudflare.attempt || { status: "pending" };
      },
    },
    email: {
      send: async (mail: { from: string; to: unknown; text?: string }) => {
        mailed.push(mail);
      },
    },
  };
  /** The owner's signed rule, as the platform lands it on `/minds/iterate.iterate.com`. */
  const sign = (append: string[], member = true): MindEvent =>
    appendAt(MELD, {
      type: "events.iterate.com/mind-meld/configured",
      payload: { append },
      source: { signer: { principal: { email: "owner@example.org" }, member } },
    });
  if (options.meld) sign(["/minds/iterate.iterate.com/"], options.meld === "member");
  return {
    // the fake has what the step reads, and the step's type names the whole root
    itx: itx as unknown as OnboardingItx,
    cloudflare,
    outside,
    logs,
    proposed,
    mailed,
    sign,
    onboarding: () => logOf("/apps/onboarding").map((e) => e.type.split("/").at(-1)),
    chat: () => logOf("/agents/onboarding"),
  };
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
  const state = {
    connect: init.connect || { ok: true as const, balance: BALANCE },
    balance: init.balance || { ok: true as const, balance: BALANCE },
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
      if (secrets[path] !== "iterate-proxy") return false;
      calls.push(`delete ${path}`);
      secrets[path] = "unset";
      return true;
    },
  };
  return { credit, calls, secrets, state, setThrows };
}

/** A Cloudflare mind with the stack's client, and the press of a card's button by its label, as
 *  the page presses it: a press that answers a page is one the page opens a tab for. */
function cloudflareTable(
  cloudflare: NonNullable<Parameters<typeof fakeMind>[0]>["cloudflare"] = {},
) {
  const mind = fakeMind({ cloudflare: { stackClient: true, ...cloudflare } });
  const context = contextOf(mind, fakeCredit().credit);
  // a press's checks are keyed by its millisecond: each press here has its own
  let clock = NOW;
  const now = vi.spyOn(Date, "now").mockImplementation(() => ++clock);
  onTestFinished(() => now.mockRestore());
  const begins = () => mind.outside.filter((call) => call.startsWith("beginOAuth")).length;
  // each page open at its own moment: an open's check is keyed by its time
  let opens = 0;
  const card = () => cloudflareCard({ ...context, now: NOW + ++opens });
  const press = async (label: string) => {
    const button = (await card())?.buttons.find((one) => one.label === label);
    if (!button?.action) throw new Error(`no button "${label}"`);
    const answer = await runStep(context, CLOUDFLARE, button.action);
    if (answer.link) expect(button).toMatchObject({ opens: true });
    return answer;
  };
  /** The vault kept the consent: the grant is held, and the template's check named the account. */
  const kept = async (
    row: { account: string; status: { kind: string; text?: string } } = {
      account: "Ada's account",
      status: { kind: "ok" },
    },
  ) => {
    Object.assign(mind.cloudflare, { held: true, attempt: { status: "complete" }, row });
    await stepEvent(context, {
      type: "events.iterate.com/secret/set",
      path: "/secrets/cloudflare",
      offset: 900 + begins(),
    });
  };
  const refused = { status: "failed", error: "Not the account that holds this mind." };
  return { mind, context, begins, card, press, kept, refused };
}

/** The card "Connect Cloudflare", as the page draws it. */
async function cloudflareCard(context: StepContext) {
  return (await onboardingCards(context)).find((card) => card.step === CLOUDFLARE);
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

function realCredit(answers: {
  describe?: Record<string, unknown>;
  setThrows?: string;
  /** What a concurrent write made of a path, landed just before the set's refusal. */
  raced?: Record<string, unknown>;
  stackKey?: unknown;
  cloud?: () => Promise<Response>;
}) {
  const sets: unknown[][] = [];
  const deleted: string[] = [];
  const described: Record<string, unknown> = { ...answers.describe };
  const itx = {
    whoami: async () => ({ path: "/", mindSlug: "mind.example.com" }),
    fetch: async (request: Request) => {
      expect(request).toMatchObject({ url: "https://mind.example.com/keys/stack.json" });
      return Response.json(answers.stackKey ?? {});
    },
    minds: {
      get: (mind: string) => {
        expect(mind).toBe("iterate.iterate.com");
        return {
          fetch: (request: Request) => {
            expect(request.url.startsWith("https://cloud.iterate.com/secret-proxy/")).toBe(true);
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
    },
  };
  return { credit: cloudCredit(itx as unknown as OnboardingItx), sets, deleted };
}
