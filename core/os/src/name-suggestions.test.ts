import { expect, test } from "vitest";
import { suggestOrganizationName, suggestOrganizationNameFromEmail } from "./name-suggestions.ts";

// ── suggestOrganizationName ──
test("prefers the OAuth display name over the email local part", () => {
  expect(
    suggestOrganizationName({
      name: "Jonas Templestein",
      email: "jonas.huckestein@gmail.com",
    }),
  ).toBe("Jonas Templestein");
});

test("trims the display name", () => {
  expect(suggestOrganizationName({ name: "  Ada Lovelace  " })).toBe("Ada Lovelace");
});

test("falls back to the email heuristic when name is missing", () => {
  expect(suggestOrganizationName({ email: "ada@acme.com" })).toBe("Acme");
  expect(suggestOrganizationName({ name: "   ", email: "jane.doe@gmail.com" })).toBe("Jane Doe");
  expect(suggestOrganizationName({})).toBe("");
});

// ── suggestOrganizationNameFromEmail ──
test("uses the company domain's first label", () => {
  expect(suggestOrganizationNameFromEmail("ada@acme.com")).toBe("Acme");
  expect(suggestOrganizationNameFromEmail("hi@my-startup.co.uk")).toBe("My Startup");
});

test("falls back to the local part for generic email providers", () => {
  expect(suggestOrganizationNameFromEmail("jane.doe@gmail.com")).toBe("Jane Doe");
  expect(suggestOrganizationNameFromEmail("jane.doe+work@outlook.com")).toBe("Jane Doe");
  expect(suggestOrganizationNameFromEmail("bob_smith@icloud.com")).toBe("Bob Smith");
});

test("reads the team's own domain and the test people's as generic", () => {
  expect(suggestOrganizationNameFromEmail("misha@nustom.com")).toBe("Misha");
  expect(suggestOrganizationNameFromEmail("aaa@preview.iterate.test")).toBe("Aaa");
});

test("normalizes case and whitespace", () => {
  expect(suggestOrganizationNameFromEmail("  ADA@ACME.COM  ")).toBe("Acme");
  expect(suggestOrganizationNameFromEmail("  MISHA@NUSTOM.COM  ")).toBe("Misha");
});

test("returns an empty string for junk input", () => {
  expect(suggestOrganizationNameFromEmail("")).toBe("");
  expect(suggestOrganizationNameFromEmail("not-an-email")).toBe("");
  expect(suggestOrganizationNameFromEmail("@nustom.com")).toBe("");
});
