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
