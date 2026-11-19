// The default config's onboarding app (core/configs/default/apps/onboarding): the reduce of its
// four events, the step "Connect to iterate Cloud" against a double of its calls to iterate
// Cloud and the secrets (cloud-credit.ts), the agent's tool answers, the cards the page draws, and
// the real calls' reading of what the platform answers. The fake mind keeps logs in memory and
// takes what the real one takes: a key with another body is refused, one with the same body
// answers the event it has.
/// <reference path="../../configs/default/files.d.ts" />
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
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
const MELD = "/minds/iterate.iterate.com";
const NOW = Date.parse("2026-11-18T22:00:00Z");
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
      { label: "Connect", action: "connect", primary: true },
      { label: "Not now", action: "decline" },
    ],
    footnote: "You can disconnect at any time.",
  });
  expect(card?.text[0]).toMatch(/gives your mind \$10 of credit for AI/);
  const sees = card?.points?.find((point) => point.title === "What iterate sees")?.text;
  expect(sees).toMatch(
    /It stores the numbers \(which model, how much, the cost\), not the content\./,
  );
  expect(sees).toMatch(
    /The requests are made on iterate's accounts at OpenAI and Exa, and those providers keep them as they keep any request\./,
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
      { label: "Connect", action: "connect" },
      { label: "End the rule", action: "disconnect" },
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
      { label: "Disconnect", action: "disconnect" },
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
  ["cloud-unreachable", /iterate Cloud did not answer\. Nothing was set up\./],
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
    `Call \`check\` first. When it answers that this mind has no step "${STEP}" (iterate Cloud's credit is not open yet), or its \`status\` is \`${status}\`, ask the "let iterate in" question as before`,
  );
});

test("while the credit is closed (CREDIT_OPEN false, as shipped): no card, no press, and at the owner's signed rule nothing asks iterate or the secrets", async () => {
  expect(CREDIT_OPEN).toBe(false);
  const mind = fakeMind();
  const { credit, calls } = fakeCredit();
  const context = { ...contextOf(mind, credit), creditOpen: false };
  expect(await onboardingCards(context)).toEqual([]);
  await expect(runStep(context, STEP, "connect")).rejects.toThrow("its steps: none");
  await stepEvent(context, mind.sign(["/minds/iterate.iterate.com/"]));
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
  expect(answer.words).toMatch(/Your \$10 of credit is used\. Choose what pays now:/);
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

test("the tool refuses a step or an action it does not have, with the ones it has", async () => {
  const mind = fakeMind();
  const { credit } = fakeCredit();
  await expect(runStep(contextOf(mind, credit), "nope", "connect")).rejects.toThrow(
    'onboarding: no step "nope" on this mind; its steps: connect-iterate-cloud',
  );
  await expect(runStep(contextOf(mind, credit), STEP, "explode")).rejects.toThrow(
    "its actions: check, decline, connect, disconnect, add-openai-key",
  );
  // iterate Cloud's own mind is offered no credit
  const cloud = { ...contextOf(mind, credit), mind: "iterate.iterate.com" };
  expect(await onboardingCards(cloud)).toEqual([]);
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
  const raced = realCredit({
    setThrows:
      "secrets.set with proxy: /secrets/openai holds a key of its own; delete it first if the secret proxy is to take its place",
  });
  expect(await raced.credit.setByProxy("/secrets/openai", ["https://api.openai.com"])).toBe("own");
});

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

test("the real grant answers the balance; a stack with no signed request between minds is stack-without-proxy; the key document says whether the mind signs", async () => {
  expect(await realCredit({}).credit.connect()).toEqual({ ok: true, balance: BALANCE });
  const older = realCredit({
    cloud: async () => {
      throw new Error(
        "minds.get(hostname).fetch: a mind answers deliverEvents(events) and deliverEvent(event), each also after at(path)",
      );
    },
  });
  expect(await older.credit.balance()).toMatchObject({ ok: false, reason: "stack-without-proxy" });
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
  // as shipped (CREDIT_OPEN false) the page gets no card, and draws the chat alone
  expect({ status: cards.status, body: await cards.json() }).toEqual({ status: 200, body: [] });
  const press = await app.fetch(
    new Request(`https://onboarding.example.com/steps/${STEP}/check`, { method: "POST" }),
    host,
  );
  expect({ status: press.status, body: await press.json() }).toEqual({
    status: 400,
    body: { error: `onboarding: no step "${STEP}" on this mind; its steps: none` },
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

function fakeMind(options: { canSign?: boolean; meld?: "member" | "other" | null } = {}) {
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
    }),
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
      collectFromUser: async () => ({ url: "https://mind.example.com/secrets/collect/1" }),
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
  } = {},
) {
  const calls: string[] = [];
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
  return { credit, calls, secrets, state };
}

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
        if (answers.setThrows) throw new Error(answers.setThrows);
        described[args[0] as string] = { set: true, proxy: ITERATE_PROXY };
      },
      delete: async (path: string) => {
        deleted.push(path);
      },
    },
  };
  return { credit: cloudCredit(itx as unknown as OnboardingItx), sets, deleted };
}
