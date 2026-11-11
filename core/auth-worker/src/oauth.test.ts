import { expect, test } from "vitest";
import { grantedScopes, grantLifetimeOf, type GrantProps } from "./oauth.ts";

const NOW = Date.UTC(2026, 10, 12);
const DAY_MS = 24 * 3600_000;
const person = { userId: "user_1", email: "member@example.com" };
const letIn = { reason: "a deploy", clientName: "the installer" };

test("a sign-in has no end date: a refresh years on gets an hour's token, and the library's idle limit alone ends it", () => {
  const made: GrantProps = person;
  // a grant made before 2026-11-12 carries a thirty-day deadline, which nothing reads
  const old: GrantProps = { ...person, deadline: NOW - 400 * DAY_MS };
  for (const grant of [made, old])
    for (const now of [NOW, NOW + 3 * 365 * DAY_MS]) {
      expect(grantLifetimeOf(grant, { refresh: true, host: false, now })).toEqual({
        accessTokenTTL: 3600,
      });
      expect(grantLifetimeOf(grant, { refresh: false, host: true, now })).toEqual({
        accessTokenTTL: 24 * 3600,
      });
    }
});

test("being let in keeps its end: one token for the time asked for, no refresh, and nothing past the deadline", () => {
  const grant: GrantProps = { ...person, deadline: NOW + 900_000, letIn };
  expect(grantLifetimeOf(grant, { refresh: false, host: false, now: NOW })).toEqual({
    accessTokenTTL: 900,
    refreshTokenTTL: 900,
  });
  expect(grantLifetimeOf(grant, { refresh: true, host: false, now: NOW })).toBe(
    "let_in_no_refresh",
  );
  expect(grantLifetimeOf(grant, { refresh: false, host: false, now: NOW + 900_000 })).toBe(
    "deadline_passed",
  );
  expect(grantLifetimeOf({ ...person, letIn }, { refresh: false, host: false, now: NOW })).toBe(
    "deadline_passed",
  );
});

test.for([
  ["the API's own scope", ["iterate"], false, ["iterate"]],
  ["no scope at all", [], false, ["iterate"]],
  // the Codex CLI asks for every scope in the server's metadata
  ["every scope the metadata lists", ["iterate", "identity"], false, ["iterate"]],
  ["another scope only", ["identity"], false, null],
  ["a mind hostname's own scope", ["identity"], true, ["identity"]],
  ["every scope, for a mind hostname", ["iterate", "identity"], true, ["identity"]],
  ["the API's scope only, for a mind hostname", ["iterate"], true, null],
] as const)(
  "a request for %s is granted the resource's one scope, or refused",
  ([, requested, host, granted]) => {
    expect(grantedScopes(requested, host)).toEqual(granted);
  },
);
