// The placeholder grammar itself (./secret-placeholder.ts `SECRET_PLACEHOLDER`): which spellings
// name a secret, and what it costs to read a text that does not. What each Worker does with a
// placeholder is in that Worker's own tests.
import { expect, test } from "vitest";
import { SECRET_PLACEHOLDER, secretPathsIn } from "./secret-placeholder.ts";

test.for([
  { name: "the whole value", value: 'getSecret("/secrets/api")', named: [{}] },
  {
    name: "with space inside the parentheses",
    value: 'getSecret( "/secrets/api" \t)',
    named: [{}],
  },
  {
    name: "one field of a JSON secret",
    value: 'getSecret("/secrets/api", { field: "a.b" })',
    named: [{ field: "a.b" }],
  },
  {
    name: "a field with no space and with much",
    value:
      'getSecret("/secrets/api",{field:"a"}) getSecret(  "/secrets/api"  ,  {  field  :  "b"  }  )',
    named: [{ field: "a" }, { field: "b" }],
  },
  {
    name: "a GitHub App's JWT",
    value: 'getSecret("/secrets/api", { appJwt: true })',
    named: [{ appJwt: "appJwt" }],
  },
  {
    name: "as the URL parser writes it",
    value:
      "https://api.example.com/bot/getSecret(%22/secrets/api%22)/send?key=getSecret(%22/secrets/api%22,%20%7B%20field:%20%22a%22%20%7D%20)",
    named: [{}, { field: "a" }],
  },
  {
    name: "inside other text, twice",
    value: 'Bearer getSecret("/secrets/api"), then getSecret("/secrets/api")',
    named: [{}, {}],
  },
  { name: "single quotes", value: "getSecret('/secrets/api')", named: [] },
  { name: "no closing parenthesis", value: 'getSecret("/secrets/api"', named: [] },
  { name: "a comma and no options", value: 'getSecret("/secrets/api", )', named: [] },
  {
    name: "options that are no field",
    value: 'getSecret("/secrets/api", { other: 1 })',
    named: [],
  },
  { name: "the name ..", value: 'getSecret("/secrets/..")', named: [] },
  { name: "a path of two parts", value: 'getSecret("/secrets/a/b")', named: [] },
])("a placeholder is spelled $name", ({ value, named }) => {
  expect(
    [...value.matchAll(SECRET_PLACEHOLDER)].map(([, path, field, appJwt]) => ({
      path,
      field,
      appJwt,
    })),
    // `toEqual` takes a part that the placeholder did not name, which is undefined, as absent
  ).toEqual(named.map((options) => ({ path: "/secrets/api", ...options })));
});

test("a megabyte of space after a path, with no closing parenthesis, names nothing in time that grows with its length", () => {
  // The pattern reads every header from outside before anything else does
  // (`withoutOutsidePlaceholders`). Time that grew with the square of the run would be about half
  // an hour here: 6 s for 64,000 spaces, measured in workerd on 2026-11-20.
  const unclosed = `getSecret("/secrets/api"${" ".repeat(1024 * 1024)}!`;
  const encoded = `getSecret(%22/secrets/api%22${"%20".repeat(256 * 1024)}!`;
  expect([secretPathsIn(unclosed), secretPathsIn(encoded)]).toEqual([[], []]);
});
