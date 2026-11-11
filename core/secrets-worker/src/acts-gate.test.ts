import {
  ACT_APPROVED,
  ACT_HELD,
  ACT_HOLD_EXPIRED,
  ACT_REJECTED,
  GATE_LOCKED,
  GATE_UNLOCKED,
  RULE_PROPOSED,
  RULE_SET,
  sha256Hex,
} from "iterate/acts";
import type { Envelope } from "iterate/signed";
import { expect, test, vi } from "vitest";
import { ActsGate } from "./acts-gate.ts";

const MEMBER = "key-member";
const MAIL = JSON.stringify({
  act: "email.send",
  from: "agent@example.com",
  fromName: "The agent",
  replyTo: null,
  to: ["jo@example.net"],
  cc: [],
  subject: "Hi",
  text: "Hello.",
  html: null,
  inReplyTo: null,
  references: null,
  attachments: [],
});
const CALL = JSON.stringify({ act: "itx.whatsapp.sendMessage", args: ["jo", { text: "hi" }] });
const member = { member: { userId: "user_aaaa", email: "member@example.com" } };

test("an act no rule names is free, and one a rule names waits from its first sight", async () => {
  const { gate } = vault();
  expect(await gate.act({ text: MAIL })).toEqual({ state: "free", facts: [] });
  await gate.setRules({ rules: [{ verb: "email.send" }], by: member });
  const digest = await sha256Hex(MAIL);
  expect(await gate.act({ text: MAIL, from: "/agents/a" })).toEqual({
    state: "held",
    digest,
    facts: [
      {
        path: "/approvals",
        events: [
          {
            type: ACT_HELD,
            payload: {
              digest,
              act: "email.send",
              summary: "Mail to jo@example.net: Hi",
              from: "/agents/a",
            },
          },
        ],
      },
    ],
  });
  // the same act again is the same held act, with nothing new to record
  expect(await gate.act({ text: MAIL })).toEqual({ state: "held", digest, facts: [] });
  expect(await gate.act({ text: CALL })).toMatchObject({ state: "free" });
  expect((await gate.state()).held).toMatchObject([{ digest, state: "waiting", waited: false }]);
});

test("a member's approval lets a waiting caller go once: the act again is done", async () => {
  const { gate, decide } = vault();
  await gate.setRules({ rules: [{ verb: "itx.whatsapp.*" }], by: member });
  const { digest } = (await gate.act({ text: CALL })) as { digest: string };
  const waited = gate.act({ text: CALL, wait: true });
  await waiting(gate);
  expect((await gate.state()).held).toMatchObject([{ waited: true }]);
  const approved = await decide(MEMBER, { type: ACT_APPROVED, about: [digest] });
  // its caller waits, so nobody else is asked to do it
  expect(approved).toMatchObject({
    result: { run: [] },
    facts: [{ events: [{ type: ACT_APPROVED }] }],
  });
  expect(await waited).toMatchObject({ state: "go", digest });
  expect(await gate.act({ text: CALL, wait: true })).toMatchObject({ state: "done", digest });
});

test("an act approved after its caller stopped waiting is named for the mind to do, once", async () => {
  // the clock alone: the gate's hashing still runs on the real event loop
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { gate, decide } = vault();
  await gate.setRules({ rules: [{ verb: "email.send" }], by: member });
  const { digest } = (await gate.act({ text: MAIL, from: "/agents/a" })) as { digest: string };
  const waited = gate.act({ text: MAIL, wait: true });
  await waiting(gate);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(await waited).toMatchObject({
    state: "waiting",
    facts: [{ events: [{ type: ACT_HOLD_EXPIRED, payload: { digest } }] }],
  });
  // hours later, still within its day
  await vi.advanceTimersByTimeAsync(6 * 3600_000);
  expect(await decide(MEMBER, { type: ACT_APPROVED, about: [digest] })).toMatchObject({
    result: { run: [digest] },
  });
  // the answer names it by its id alone: its text, which may be 1 MiB, is read here
  expect(await gate.approved(digest)).toEqual({ digest, text: MAIL, from: "/agents/a" });
  expect(await gate.act({ text: MAIL })).toMatchObject({ state: "go" });
  expect(await gate.approved(digest)).toBeNull();
  expect(await gate.act({ text: MAIL })).toMatchObject({ state: "done" });
  // and after its day it is gone: the same mail is a new act
  await vi.advanceTimersByTimeAsync(24 * 3600_000);
  expect(await gate.act({ text: MAIL })).toMatchObject({ state: "held" });
});

test("a mail the mail service refused keeps its approval; a verb, and a mail nobody approved, get none back", async () => {
  const { gate, decide } = vault();
  await gate.setRules({ rules: [{ verb: "email.send" }, { verb: "itx.whatsapp.*" }], by: member });
  const mail = (await gate.act({ text: MAIL })) as { digest: string };
  const call = (await gate.act({ text: CALL })) as { digest: string };
  // nobody approved it yet: there is nothing to give back
  await gate.notDone(mail.digest);
  expect(await gate.act({ text: MAIL })).toMatchObject({ state: "held" });
  await decide(MEMBER, { type: ACT_APPROVED, about: [mail.digest, call.digest] });
  expect(await gate.act({ text: MAIL })).toMatchObject({ state: "go" });
  // the send failed: the member's yes stands again, for one more send
  await gate.notDone(mail.digest);
  expect((await gate.state()).held).toMatchObject([{ state: "approved" }, { state: "approved" }]);
  expect(await gate.act({ text: MAIL })).toMatchObject({ state: "go" });
  expect(await gate.act({ text: MAIL })).toMatchObject({ state: "done" });
  // a verb that failed may have acted
  expect(await gate.act({ text: CALL })).toMatchObject({ state: "go" });
  await gate.notDone(call.digest);
  expect(await gate.act({ text: CALL })).toMatchObject({ state: "done" });
});

test("a rejection names its reason, and its caller hears who said no", async () => {
  const { gate, decide } = vault();
  await gate.setRules({ rules: [{ verb: "email.send" }], by: member });
  const { digest } = (await gate.act({ text: MAIL })) as { digest: string };
  expect(await decide(MEMBER, { type: ACT_REJECTED, about: [digest] })).toMatchObject({
    result: { error: "a rejection names its reason" },
  });
  await decide(MEMBER, {
    type: ACT_REJECTED,
    about: [digest],
    payload: { reason: "wrong person" },
  });
  expect(await gate.act({ text: MAIL, wait: true })).toMatchObject({
    state: "rejected",
    reason: "wrong person",
    by: MEMBER,
  });
});

test.for([
  ["a key that is no member's", { key: "key-service", type: ACT_APPROVED }, /only a member's key/],
  ["a statement about another context", { path: "/secrets/x", type: ACT_APPROVED }, /is about/],
  ["an approval that names no act", { type: ACT_APPROVED, about: [] }, /names no act/],
  [
    "an approval of an act that does not wait",
    { type: ACT_APPROVED, about: ["nope"] },
    /does not wait/,
  ],
  ["a type the gate does not know", { type: "events.iterate.com/x/said" }, /does not act on/],
  [
    "rules that are no rules",
    { type: RULE_SET, payload: { rules: [{ verb: "rm -rf" }] } },
    /names/,
  ],
] as const)("the gate refuses %s", async ([, statement, why]) => {
  const { gate, decide } = vault();
  await gate.setRules({ rules: [{ verb: "email.send" }], by: member });
  const { digest } = (await gate.act({ text: MAIL })) as { digest: string };
  const { key, ...fields }: Refused = { key: MEMBER, about: [digest], ...statement };
  const decided = await decide(key, fields);
  expect(decided).toMatchObject({ result: { error: expect.stringMatching(why) }, facts: [] });
  expect((await gate.state()).held).toMatchObject([{ state: "waiting" }]);
});

test("open at birth: anyone changes the rules. Locked: a session tightens, the mind proposes, a key does the rest", async () => {
  const { gate, decide } = vault();
  const mind = { mind: "/agents/onboarding" };
  await gate.setRules({ rules: [{ verb: "email.send" }, { verb: "itx.x.y" }], by: mind });
  await gate.setRules({ rules: [{ verb: "email.send", to: ["*@example.net"] }], by: mind });
  expect(await decide("key-service", { type: GATE_LOCKED })).toMatchObject({
    result: { error: expect.stringMatching(/only a member's key/) },
  });
  expect(await decide(MEMBER, { type: GATE_LOCKED })).toMatchObject({
    facts: [{ path: "/approvals", events: [{ type: GATE_LOCKED }] }],
  });
  await expect(gate.setRules({ rules: [], by: mind })).rejects.toThrow(/propose/);
  await expect(gate.setRules({ rules: [], by: member })).rejects.toThrow(/holds less/);
  // every mail in place of some holds more
  await gate.setRules({ rules: [{ verb: "email.send" }], by: member });
  expect(await decide(MEMBER, { type: RULE_SET, payload: { rules: [] } })).toMatchObject({
    facts: [{ events: [{ type: RULE_SET, payload: { rules: [] } }] }],
  });
  await decide(MEMBER, { type: GATE_UNLOCKED });
  await gate.setRules({ rules: [{ verb: "itx.x.*" }], by: mind });
  expect(await gate.state()).toMatchObject({ locked: false, rules: [{ verb: "itx.x.*" }] });
});

test("a rule the mind proposes is no rule until a member signs it", async () => {
  const { gate, decide } = vault();
  const { id, facts } = await gate.propose({ rule: { verb: "email.send" }, from: "/agents/a" });
  expect(facts).toMatchObject([
    { events: [{ type: RULE_PROPOSED, payload: { id, from: "/agents/a" } }] },
  ]);
  // asked for twice, it is one proposal
  expect(await gate.propose({ rule: { verb: "email.send" } })).toEqual({ id, facts: [] });
  expect(await gate.act({ text: MAIL })).toMatchObject({ state: "free" });
  await decide(MEMBER, {
    type: RULE_SET,
    payload: { rules: [{ verb: "email.send" }], proposal: id },
  });
  expect(await gate.state()).toMatchObject({ rules: [{ verb: "email.send" }], proposed: [] });
  expect(await gate.act({ text: MAIL })).toMatchObject({ state: "held" });
});

test("a rule taken away frees what waited under it", async () => {
  const { gate } = vault();
  await gate.setRules({ rules: [{ verb: "email.send" }], by: member });
  await gate.act({ text: MAIL });
  await gate.setRules({ rules: [], by: member });
  expect(await gate.act({ text: MAIL, wait: true })).toEqual({ state: "free", facts: [] });
  expect(await gate.state()).toMatchObject({ held: [] });
});

/** One statement the gate must refuse: a good approval with one part changed. */
type Refused = {
  key: string;
  type: string;
  about?: readonly string[];
  path?: string;
  payload?: object;
};

/** Until a call that has begun waits in the gate: its hashing ends on the real event loop. */
async function waiting(gate: ActsGate) {
  for (let turns = 0; turns < 500; turns++) {
    if ((await gate.state()).held.some((row) => row.waited)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("no call waits in the gate");
}

function vault() {
  const store = new Map<string, unknown>();
  // ordered as SQLite's
  const state = {
    storage: {
      kv: {
        get: (key: string) => structuredClone(store.get(key)),
        put: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
        delete: (key: string) => store.delete(key),
        list: ({ prefix = "" }: { prefix?: string } = {}) =>
          [...store.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, value]) => [key, structuredClone(value)]),
      },
    },
  };
  const env = {
    // believes the statement: who signed is the key the envelope names
    AUTH: {
      verify: async (envelope: Envelope) => ({
        signer: {
          principal: { actor: envelope.signature.key },
          key: envelope.signature.key,
          label: "test key",
          member: envelope.signature.key === MEMBER,
        },
        statement: JSON.parse(envelope.statement),
      }),
    },
  };
  // the cast: the gate reads only the bindings above
  const gate = new ActsGate(state as never, env as never);
  const decide = (
    key: string,
    fields: { type: string; about?: readonly string[]; payload?: object; path?: string },
  ) =>
    gate.decide({
      statement: JSON.stringify({
        mind: "example.com",
        path: "/approvals",
        at: 0,
        expires: 1,
        nonce: "n",
        ...fields,
      }),
      signature: { format: "p256", key, sig: "sig" },
    });
  return { gate, decide };
}
