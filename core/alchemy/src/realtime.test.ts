// The SFU app and TURN key of a deploy that may not make them (realtime.ts), against a pretend
// Alchemy provider, and the secrets Worker's value of the two.
import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import { Forbidden } from "@distilled.cloud/cloudflare/calls";
import { Unauthorized } from "@distilled.cloud/cloudflare/Errors";
import type { ProviderService } from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import {
  CALLS_REFUSAL,
  callsWithoutWriteProvider,
  eachLineOnce,
  isCallsRefusal,
  NO_CALLS_PERMISSION_LINE,
  REALTIME_SFU,
  realtimeConfigOf,
} from "./realtime.ts";

/** Cloudflare's refusal of a Calls call to a token without the permission, as Alchemy's client
 *  gives it: HTTP 403 is `Forbidden`, and Cloudflare's code is 10000. */
const refusal = new Forbidden({ code: 10000, message: "Authentication error" });
const made = {
  appId: "app-1",
  accountId: "account-1",
  secret: Redacted.make("the app's secret"),
  name: "iterate-a-realtime-sfu",
  created: "",
  modified: "",
};

void test("only Cloudflare's refusal for a missing permission counts", () => {
  assert.equal(isCallsRefusal(refusal), true);
  assert.equal(isCallsRefusal(new Forbidden({ code: 10001, message: "x" })), false);
  // HTTP 401, a token that is not valid: the SDK's global `Unauthorized`, with no code
  assert.equal(isCallsRefusal(new Unauthorized({ message: "Authentication error" })), false);
  assert.equal(isCallsRefusal({ _tag: "CloudflareError", code: 10000 }), false);
  assert.equal(isCallsRefusal({ _tag: "TooManyRequests" }), false);
  assert.equal(isCallsRefusal(undefined), false);
});

void test("a deploy that may not make the app goes on without it, and says so once", async () => {
  const said: string[] = [];
  const provider = wrapped(pretendAlchemy(refusal), said);
  const output = await Effect.runPromise(provider.reconcile(reconcileInput(undefined)));
  assert.equal(output.appId, "");
  assert.equal(Redacted.value(output.secret), "");
  assert.equal(output.accountId, "account-1");
  assert.deepEqual(said, [NO_CALLS_PERMISSION_LINE]);
  // "Calls Write" is not the one permission that allows it: "Realtime" or "Realtime Admin" does too
  assert.doesNotMatch(NO_CALLS_PERMISSION_LINE, /Calls Write/);
  assert.match(
    NO_CALLS_PERMISSION_LINE,
    /lacks the permission to make Realtime \(Calls\) resources/,
  );
  assert.match(
    NO_CALLS_PERMISSION_LINE,
    /\/secrets\/cloudflare-realtime-sfu and \/secrets\/cloudflare-turn are not set/,
  );
});

void test("an app that an earlier deploy made stays as it is when Cloudflare refuses", async () => {
  const said: string[] = [];
  const provider = wrapped(pretendAlchemy(refusal), said);
  const output = await Effect.runPromise(provider.reconcile(reconcileInput(made)));
  assert.equal(output, made);
  assert.deepEqual(said, []);
});

void test("any other failure still fails the deploy", async () => {
  for (const failure of [
    new Forbidden({ code: 10001, message: "Method not allowed for token" }),
    { _tag: "CloudflareError", code: 10000 },
  ]) {
    const provider = wrapped(pretendAlchemy(failure), []);
    const exit = await Effect.runPromiseExit(provider.reconcile(reconcileInput(undefined)));
    assert.equal(Exit.isFailure(exit), true);
  }
});

void test("an app that is not made is asked for again at the next deploy, with no stable attribute", async () => {
  const provider = wrapped(pretendAlchemy(null), []);
  const notMade = { ...made, appId: "", secret: Redacted.make("") };
  assert.deepEqual(await Effect.runPromise(provider.diff!(diffInput(notMade))), {
    action: "update",
    stables: [],
  });
  assert.equal(await Effect.runPromise(provider.diff!(diffInput(made))), undefined);
});

void test("an app that is not made has nothing to delete; a made one is deleted by Alchemy", async () => {
  const deleted: string[] = [];
  const provider = wrapped(pretendAlchemy(null, deleted), []);
  await Effect.runPromise(provider.delete(deleteInput({ ...made, appId: "" })));
  assert.deepEqual(deleted, []);
  await Effect.runPromise(provider.delete(deleteInput(made)));
  assert.deepEqual(deleted, ["app-1"]);
});

void test("a destroy whose credential may not delete the app goes on, and says so", async () => {
  const said: string[] = [];
  const provider = wrapped(pretendAlchemy(refusal), said);
  await Effect.runPromise(provider.delete(deleteInput(made)));
  assert.match(said.join(), /app-1 stays in the account/);
});

void test("a deploy's line is said once, and a destroy names each leftover", () => {
  const lines: string[] = [];
  const say = eachLineOnce((line) => void lines.push(line));
  say(NO_CALLS_PERMISSION_LINE);
  say(NO_CALLS_PERMISSION_LINE);
  say("app-1 stays in the account");
  say("key-1 stays in the account");
  assert.deepEqual(lines, [
    NO_CALLS_PERMISSION_LINE,
    "app-1 stays in the account",
    "key-1 stays in the account",
  ]);
});

void test("the secrets Worker gets each one's id and secret, or why it was not made", () => {
  const value = realtimeConfigOf({
    appId: "app-1",
    appSecret: Redacted.make("the app's secret"),
    keyId: "",
    key: Redacted.make(""),
  });
  assert.deepEqual(value, {
    sfu: { appId: "app-1", appSecret: "the app's secret" },
    turn: { refusal: CALLS_REFUSAL },
  });
  // made, and its secret lost: another reason
  const lost = realtimeConfigOf({
    appId: "app-1",
    appSecret: Redacted.make(""),
    keyId: "key-1",
    key: Redacted.make("the key"),
  });
  assert.match(
    JSON.stringify(lost.sfu),
    /"refusal":"Cloudflare made app-1 and the stack holds no secret/,
  );
  assert.deepEqual(lost.turn, { keyId: "key-1", apiToken: "the key" });
});

void test("another resource of the same type is Alchemy's own", async () => {
  const said: string[] = [];
  const provider = wrapped(pretendAlchemy(refusal), said);
  const exit = await Effect.runPromiseExit(
    provider.reconcile({ ...reconcileInput(undefined), id: "AnotherApp" }),
  );
  assert.equal(Exit.isFailure(exit), true);
  assert.deepEqual(said, []);
});

type AppService = ProviderService<Cloudflare.Calls.App>;

function wrapped(base: AppService, said: string[]) {
  return callsWithoutWriteProvider(
    base,
    {
      id: REALTIME_SFU,
      cloudflareIdOf: (output) => output.appId,
      notMade: (accountId) => ({ ...made, accountId, appId: "", secret: Redacted.make("") }),
    },
    { accountId: Effect.succeed("account-1"), say: (line) => void said.push(line) },
  );
}

/** Alchemy's app provider, whose reconcile fails with `failure` (or makes the app with none). */
function pretendAlchemy(failure: object | null, deleted: string[] = []) {
  // The cast: of the provider, only `diff`, `reconcile` and `delete` are called here.
  return {
    diff: () => Effect.succeed(undefined),
    reconcile: () => (failure ? Effect.fail(failure) : Effect.succeed(made)),
    delete: (input: { output: typeof made }) =>
      failure ? Effect.fail(failure) : Effect.sync(() => void deleted.push(input.output.appId)),
  } as unknown as AppService;
}

// The casts below: the pretend provider reads only `id` and `output` of its input.
function reconcileInput(output: typeof made | undefined) {
  return { id: REALTIME_SFU, news: {}, output } as unknown as Parameters<
    ReturnType<typeof wrapped>["reconcile"]
  >[0];
}

function diffInput(output: typeof made) {
  return { id: REALTIME_SFU, news: {}, olds: {}, output } as unknown as Parameters<
    NonNullable<ReturnType<typeof wrapped>["diff"]>
  >[0];
}

function deleteInput(output: typeof made) {
  return { id: REALTIME_SFU, output } as unknown as Parameters<
    ReturnType<typeof wrapped>["delete"]
  >[0];
}
