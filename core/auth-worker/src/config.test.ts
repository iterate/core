import { expect, test } from "vitest";
import {
  AuthSettings,
  FIRST_OWNER_TICKET_MS,
  firstOwnerTicketOf,
  isOwner,
  memberByConfig,
} from "./config.ts";

const NOW = 1_000_000;
const SETTINGS = {
  login: { methods: { email: {} }, allow: [{ email: "owner@example.com" }, { everyone: {} }] },
};
test("a first owner's ticket for an address the allow list names, ending in 24 hours, is taken", () => {
  expect(firstOwnerTicketOf(ticket(), SETTINGS, NOW)).toEqual(JSON.parse(ticket()));
  expect(firstOwnerTicketOf(ticket({ email: " Owner@Example.com" }), SETTINGS, NOW)).toMatchObject({
    email: "owner@example.com",
  });
});

test.each([
  ["no JSON", "", "not JSON"],
  ["a ticket's text in place of its hash", ticket({ hash: "the ticket itself" }), "not {"],
  ["an address only `everyone` admits", ticket({ email: "other@example.com" }), "does not name"],
  ["an end past 24 hours", ticket({ expires: NOW + FIRST_OWNER_TICKET_MS + 1 }), "24 hours"],
])("a first owner's ticket with %s is refused", (_what, text, why) => {
  expect(firstOwnerTicketOf(text, SETTINGS, NOW)).toEqual({
    refused: expect.stringContaining(why),
  });
});

test("a mind may have no way to sign in beside a passkey, and may mail codes", () => {
  const allow = [{ email: "owner@example.com" }];
  // no `methods` at all, and an empty one: the owner's ticket and an owner's hand are the ways in
  expect(AuthSettings.parse({ login: { allow } }).login).toMatchObject({ methods: {} });
  expect(AuthSettings.parse({ login: { methods: {}, allow } }).login).toMatchObject({
    methods: {},
  });
  expect(AuthSettings.parse({ login: { methods: { email: {} }, allow } }).login).toMatchObject({
    methods: { email: {} },
  });
});

test("the sign-in with Google proves an address, and one switch makes it a full sign-in", () => {
  const allow = [{ email: "owner@example.com" }];
  expect(AuthSettings.parse({ login: { methods: { google: {} }, allow } }).login).toMatchObject({
    methods: { google: {} },
  });
  expect(
    AuthSettings.parse({ login: { methods: { google: { signsInAlone: true } }, allow } }).login,
  ).toMatchObject({ methods: { google: { signsInAlone: true } } });
  // the switch is on or absent: `false` would read as a choice that the default already makes
  expect(
    AuthSettings.safeParse({ login: { methods: { google: { signsInAlone: false } }, allow } }),
  ).toMatchObject({ success: false });
});

test("the sign-in through another iterate deployment is gone: a config that names it is refused", () => {
  const settings = {
    login: {
      methods: { iterate: { issuer: "https://iterate.example.com" } },
      allow: [{ email: "owner@example.com" }],
    },
  };
  expect(AuthSettings.safeParse(settings)).toMatchObject({ success: false });
});

test("a root key is a person's, with an email, or a service's, with paths: one with both is refused", () => {
  const key = { actor: "a", publicKey: "MFkw", label: "A key" };
  const settings = (extra: object) => ({
    login: { allow: [{ email: "owner@example.com" }] },
    keys: [{ ...key, ...extra }],
  });
  expect([
    AuthSettings.safeParse(settings({ email: "owner@example.com" })).success,
    AuthSettings.safeParse(settings({ paths: ["/integrations/"] })).success,
    AuthSettings.safeParse(settings({})).success,
  ]).toEqual([true, true, true]);
  // paths would read as a limit on the person's key, which approves and adds members all the same
  expect(
    AuthSettings.safeParse(settings({ email: "owner@example.com", paths: ["/integrations/"] })),
  ).toMatchObject({
    success: false,
    error: {
      issues: [{ path: ["keys", 0, "paths"], message: expect.stringContaining("no paths") }],
    },
  });
});

test("`everyone` makes no member of an address at the mind's own domain, whose mail the mind receives", () => {
  const config = { domain: "mind.example", login: { allow: [{ everyone: {} }] } };
  expect([
    memberByConfig(config, "anyone@example.com"),
    memberByConfig(config, "agent@mind.example"),
    memberByConfig(config, "Agent@Sub.Mind.Example "),
    // another domain that only ends with the same letters
    memberByConfig(config, "jo@notmind.example"),
  ]).toEqual([true, false, false, true]);
});

test("an owner is named by an email rule, by the exact address", () => {
  const login = {
    allow: [
      { email: "owner@example.com", subaddresses: true as const },
      { emailDomain: "example.com" },
    ],
  };
  expect(isOwner(login, "owner@example.com")).toBe(true);
  // a member by a +tag or by the domain rule, whose keys an owner removes
  expect(isOwner(login, "owner+tag@example.com")).toBe(false);
  expect(isOwner(login, "other@example.com")).toBe(false);
});

function ticket(fields: Record<string, unknown> = {}) {
  return JSON.stringify({
    email: "owner@example.com",
    hash: "a".repeat(64),
    expires: NOW + FIRST_OWNER_TICKET_MS,
    ...fields,
  });
}
