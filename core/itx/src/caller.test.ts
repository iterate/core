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

test("only the platform says that the mail provider refused a mail: a member reads it as the provider's words", () => {
  const failed = [{ type: "events.iterate.com/email/send-failed" }];
  expect(() => refuseNonPlatformWrites(failed, platform)).not.toThrow();
  expect(() => refuseNonPlatformWrites(failed, { principal: null })).toThrow(/platform's own/);
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
