import { expect, test } from "vitest";
import { type Caller, refuseNonPlatformWrites, stampCaller } from "./caller.ts";

const signer = { principal: { actor: "iterate-cloud" }, key: "cloud-key" };
const wrong = { principal: { actor: "someone-else" }, key: "another-key" };
const signed = {
  statement: "{}",
  signature: { format: "p256" as const, key: "cloud-key", sig: "" },
};
const claimed = { type: "x/message-received", source: { signer }, signed };
const platform: Caller = { principal: null, platform: true };

test("an event never names its own signer, whoever appends it", () => {
  // the platform's own append is the platform's word
  expect(stampCaller(claimed, platform, "/")).toEqual({
    type: "x/message-received",
    source: { origin: "/", platform: true },
  });
  for (const caller of [{ principal: null }, { principal: null, app: true as const }])
    expect(stampCaller(claimed, caller, "/")).toEqual({
      type: "x/message-received",
      source: { origin: "/" },
    });
  expect(stampCaller(claimed, { principal: null, signer }, "/")).toEqual({
    type: "x/message-received",
    source: { origin: "/" },
  });
});

test("the call that carries the auth Worker's answer names the signer, and the event is not the platform's", () => {
  const event: typeof claimed = { type: "x/message-received", source: { signer: wrong }, signed };
  expect(stampCaller(event, { ...platform, signer }, "/")).toEqual({
    type: "x/message-received",
    source: { origin: "/", signer },
    signed,
  });
});

test("a signed statement is held to the rule that guards the platform's facts", () => {
  const mail = [{ type: "events.iterate.com/email/received" }];
  expect(() => refuseNonPlatformWrites(mail, platform)).not.toThrow();
  expect(() => refuseNonPlatformWrites(mail, { ...platform, signer })).toThrow(/platform's own/);
  expect(() => refuseNonPlatformWrites(mail, { principal: null })).toThrow(/platform's own/);
});

test("only the platform says that a forward of a mail failed: a member reads it as what Cloudflare said", () => {
  const failed = [{ type: "events.iterate.com/email/forward-failed" }];
  expect(() => refuseNonPlatformWrites(failed, platform)).not.toThrow();
  expect(() => refuseNonPlatformWrites(failed, { principal: null })).toThrow(/platform's own/);
});

test("only the platform says that a deploy reached the mind: loaded code cannot replace the stack's record, with a key or with none", () => {
  const deployed = {
    type: "events.iterate.com/mind/stack-deployed",
    payload: { config: { ownerEmails: ["mallory@elsewhere.example"] }, versionId: "forged" },
  };
  const loadedCode: Caller = { principal: null, app: true, path: "/" };
  expect(() => refuseNonPlatformWrites([deployed], platform)).not.toThrow();
  expect(() => refuseNonPlatformWrites([deployed], loadedCode)).toThrow(/platform's own/);
  expect(() =>
    refuseNonPlatformWrites([{ ...deployed, idempotencyKey: "any-key" }], loadedCode),
  ).toThrow(/platform's own/);
  // nor by a schedule, which fires under its maker's stamp
  const scheduled = {
    type: "events.iterate.com/itx/schedule-set",
    payload: { events: [deployed] },
  };
  expect(() => refuseNonPlatformWrites([scheduled], loadedCode)).toThrow(/platform's own/);
});

test.for([
  "events.iterate.com/mind/identity-record-accepted",
  "events.iterate.com/mind/identity-record-refused",
])(
  "only the platform says that a record of the mind's identity was checked: %s is refused from a member, from loaded code and from a signed statement",
  (type) => {
    const checked = [{ type, payload: { mind: "forged" } }];
    expect(() => refuseNonPlatformWrites(checked, platform)).not.toThrow();
    for (const caller of [
      { principal: null },
      { principal: null, app: true as const, path: "/" },
      { ...platform, signer },
    ])
      expect(() => refuseNonPlatformWrites(checked, caller)).toThrow(/platform's own/);
  },
);

test("a key of the platform's is nobody else's to take: a member, loaded code, a schedule and a signed statement are refused, whatever the event's type", () => {
  // an ordinary event under the key that the mind's genesis is appended with
  const squat = [{ type: "notes/note-added", idempotencyKey: "mind/identity-record:the-mind-id" }];
  const member: Caller = { principal: { actor: "user_ada", email: "ada@example.org" } };
  const loadedCode: Caller = { principal: null, app: true, path: "/" };
  const scheduled = (events: typeof squat) => [
    { type: "events.iterate.com/itx/schedule-set", payload: { key: "x", events } },
  ];
  for (const caller of [
    member,
    loadedCode,
    { ...member, grant: "a-grant" },
    { ...platform, signer },
  ]) {
    expect(() => refuseNonPlatformWrites(squat, caller)).toThrow(
      'idempotency key "mind/identity-record:the-mind-id" is the platform\'s',
    );
    // a schedule fires under its maker's stamp, so its events are held to the rule when it is set
    expect(() => refuseNonPlatformWrites(scheduled(squat), caller)).toThrow(/is the platform's/);
    for (const idempotencyKey of ["itx/child-created:/x", "repo/pushed:1", "itx@/agents/a"])
      expect(() => refuseNonPlatformWrites([{ ...squat[0]!, idempotencyKey }], caller)).toThrow(
        /is the platform's/,
      );
    // a key of the caller's own, and a key that only looks alike
    for (const idempotencyKey of ["notes:1", "mind:example.com:/notes@4", "minds/1", undefined])
      expect(() =>
        refuseNonPlatformWrites(
          [{ ...squat[0]!, idempotencyKey }, ...scheduled([{ ...squat[0]!, idempotencyKey: "n" }])],
          caller,
        ),
      ).not.toThrow();
  }
  // The platform's own appends keep every key.
  for (const caller of [platform, { ...platform, ...member }]) {
    expect(() => refuseNonPlatformWrites(squat, caller)).not.toThrow();
    expect(() => refuseNonPlatformWrites(scheduled(squat), caller)).not.toThrow();
  }
});

test("the keys of the mind's identity need the explicit platform flag: the target of a stored row, which a member may have written, cannot take a record's key", () => {
  // as the kernel calls a subscription's target (iterate-context-durable-object.ts `runAsDelivery`)
  const runsRow: Caller = { principal: null, runsRow: true };
  const firstParty: Caller = { principal: null, path: "/" };
  for (const idempotencyKey of [
    "mind/identity-record:the-mind-id",
    "mind/identity-record-refused:a-record's-hash",
  ]) {
    const ordinary = [{ type: "notes/note-added", idempotencyKey }];
    for (const caller of [runsRow, firstParty, { principal: null }])
      for (const events of [
        ordinary,
        [{ type: "events.iterate.com/itx/schedule-set", payload: { key: "x", events: ordinary } }],
      ])
        expect(() => refuseNonPlatformWrites(events, caller)).toThrow(
          `idempotency key ${JSON.stringify(idempotencyKey)} is the platform's`,
        );
    expect(() => refuseNonPlatformWrites(ordinary, platform)).not.toThrow();
  }
  // The other keys of the platform stay with the kernel's own code, which calls with no
  // principal and is no loaded code: a facet of the mind's Worker, a context that announces
  // itself to its parent.
  for (const idempotencyKey of ["mind/created", "itx/child-created:/x", "itx@/agents/a"])
    for (const caller of [runsRow, firstParty, { principal: null }])
      expect(() =>
        refuseNonPlatformWrites([{ type: "notes/note-added", idempotencyKey }], caller),
      ).not.toThrow();
});

test("only the platform says that the mail provider refused a mail: a member reads it as the provider's words", () => {
  const failed = [{ type: "events.iterate.com/email/send-failed" }];
  expect(() => refuseNonPlatformWrites(failed, platform)).not.toThrow();
  expect(() => refuseNonPlatformWrites(failed, { principal: null })).toThrow(/platform's own/);
});

test("only the platform says that a sent mail was not delivered: a member reads it as what Cloudflare said", () => {
  const bounced = [{ type: "events.iterate.com/email/delivery-failed" }];
  expect(() => refuseNonPlatformWrites(bounced, platform)).not.toThrow();
  expect(() => refuseNonPlatformWrites(bounced, { principal: null })).toThrow(/platform's own/);
});

test.for([
  "events.iterate.com/repo/pushed",
  "events.iterate.com/repo/cloned",
  "events.iterate.com/repo/fetched",
  "events.iterate.com/repo/token-created",
  "events.iterate.com/repo/token-revoked",
])("only the platform says %s: a reader takes it as what Cloudflare said of the repo", (type) => {
  const fact = [{ type, payload: {} }];
  expect(() => refuseNonPlatformWrites(fact, platform)).not.toThrow();
  expect(() => refuseNonPlatformWrites(fact, { principal: null })).toThrow(/platform's own/);
});

test.for([
  "events.iterate.com/approval/rule-proposed",
  "events.iterate.com/approval/rule-proposal-signed",
  "events.iterate.com/approval/rule-proposal-rejected",
  "events.iterate.com/approval/rule-set",
])("only the platform appends %s: a reader counts the open proposals by these facts", (type) => {
  // An end that anyone could append would hide a proposal that still waits on the gate.
  const fact = [{ type, payload: { id: "p1", proposal: "p1" } }];
  expect(() => refuseNonPlatformWrites(fact, platform)).not.toThrow();
  for (const other of [
    { principal: null },
    { principal: null, app: true as const },
    { principal: { actor: "user_1", email: "jo@example.net" } },
  ])
    expect(() => refuseNonPlatformWrites(fact, other)).toThrow(
      `${type} is the platform's own fact: no one else appends or schedules it`,
    );
  // and no one schedules it for later
  expect(() =>
    refuseNonPlatformWrites(
      [{ type: "events.iterate.com/itx/schedule-set", payload: { events: fact } }],
      { principal: null, app: true },
    ),
  ).toThrow("is the platform's own fact");
});

// Another mind that asks is no principal: what its call appends names nobody, as loaded code's
// own append does, so no reader of `source.principal` can take it for a member.
test("an event appended by a call that another mind asks names no principal and no grant", () => {
  const mind = { actor: "ab".repeat(32), kind: "mind" as const, hostname: "iterate.peer.example" };
  const event = { type: "x/message-received", source: { principal: { actor: "user_forged" } } };
  expect(stampCaller(event, { principal: null, mind, grant: "grant_1" }, "/")).toEqual({
    type: "x/message-received",
    source: { origin: "/" },
  });
});

// Another mind's request is from outside: the platform's reserved keys are refused to it, as to
// a member, though it names none.
test("a call that another mind asks may not take a key of the platform's", () => {
  const mind = { actor: "ab".repeat(32), kind: "mind" as const, hostname: "iterate.peer.example" };
  const byMind: Caller = { principal: null, mind, runsRow: true };
  for (const idempotencyKey of ["itx/child-created:/x", "repo/pushed:1", "secret/set:1"])
    expect(() =>
      refuseNonPlatformWrites([{ type: "notes/note-added", idempotencyKey }], byMind),
    ).toThrow(/is the platform's/);
});

// The member's type and the mind's are not one: one in the other's place does not compile.
test("a mind is no Caller.principal, and a member is no Caller.mind, by type", () => {
  const mind = { actor: "ab".repeat(32), kind: "mind" as const, hostname: "iterate.peer.example" };
  const member = { actor: "user_1", email: "a@example.org" };
  // @ts-expect-error a mind in the member's place
  const mindAsMember: Caller = { principal: mind };
  // @ts-expect-error a member in the mind's place
  const memberAsMind: Caller = { principal: null, mind: member };
  expect([mindAsMember.principal, memberAsMind.mind]).toEqual([mind, member]);
});
