import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import { accessTeamFoundOrMade } from "./access-team.ts";

void test("an account with a team and a PIN login: both are used, and nothing is made", async () => {
  const { account, made } = accountWith({ team: "ada.cloudflareaccess.com", pinLogin: "pin-1" });
  assert.deepEqual(await Effect.runPromise(accessTeamFoundOrMade(account)), {
    teamDomain: "ada.cloudflareaccess.com",
    pinLoginId: "pin-1",
  });
  assert.deepEqual(made, []);
});

void test("an account with a team and no PIN login: the login alone is made", async () => {
  const { account, made } = accountWith({ team: "ada.cloudflareaccess.com", pinLogin: null });
  assert.deepEqual(await Effect.runPromise(accessTeamFoundOrMade(account)), {
    teamDomain: "ada.cloudflareaccess.com",
    pinLoginId: "made-pin",
  });
  assert.deepEqual(made, ["pin login"]);
});

void test("an account with no team: the organization is made, read again for its domain, and the login is made", async () => {
  const { account, made } = accountWith({ team: null, pinLogin: null });
  assert.deepEqual(await Effect.runPromise(accessTeamFoundOrMade(account)), {
    teamDomain: "made-team.cloudflareaccess.com",
    pinLoginId: "made-pin",
  });
  assert.deepEqual(made, ["organization", "pin login"]);
});

void test("a new organization that brings its own PIN login keeps that login", async () => {
  const { account, made } = accountWith({ team: null, pinLogin: "cloudflares-own" });
  assert.equal(
    (await Effect.runPromise(accessTeamFoundOrMade(account))).pinLoginId,
    "cloudflares-own",
  );
  assert.deepEqual(made, ["organization"]);
});

void test("an account where Cloudflare makes no organization fails the deploy, and makes no login", async () => {
  const { account, made } = accountWith({ team: null, pinLogin: null });
  const exit = await Effect.runPromiseExit(
    accessTeamFoundOrMade({ ...account, makeOrganization: Effect.void }),
  );
  assert.match(JSON.stringify(exit), /made no Zero Trust organization/);
  assert.deepEqual(made, []);
});

/** An account as the provider's four calls see it, and what the provider made in it. A fresh
 *  account answers an organization with no domain, as Cloudflare does. */
function accountWith(has: { team: string | null; pinLogin: string | null }) {
  const made: string[] = [];
  let team = has.team;
  return {
    made,
    account: {
      organization: Effect.sync(() => ({ authDomain: team })),
      makeOrganization: Effect.sync(() => {
        made.push("organization");
        team = "made-team.cloudflareaccess.com";
      }),
      pinLogin: Effect.sync(() => (has.pinLogin ? { id: has.pinLogin } : undefined)),
      makePinLogin: Effect.sync(() => {
        made.push("pin login");
        return { id: "made-pin" };
      }),
    },
  };
}
