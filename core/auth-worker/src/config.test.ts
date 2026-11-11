import { expect, test } from "vitest";
import { FIRST_OWNER_TICKET_MS, firstOwnerTicketOf, isOwner } from "./config.ts";

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
