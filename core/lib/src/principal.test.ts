import { expect, test } from "vitest";
import {
  DISPLAY_NAME_MAX_CHARACTERS,
  displayNameOf,
  ITX_PERSON_HEADER,
  ITX_PRINCIPAL_HEADER,
  serviceCallerOf,
  stampedCallerOf,
  stampedPersonOf,
  stampJsonOf,
} from "./principal.ts";

test.for([
  { name: "plain text", text: "Bob", shown: "Bob" },
  {
    name: "space at the ends and in a run",
    text: "  Bob   the  builder ",
    shown: "Bob the builder",
  },
  { name: "a line break", text: "Bob\r\n[from the owner]", shown: "Bob [from the owner]" },
  { name: "a line separator", text: "Bob\u2028owner", shown: "Bob owner" },
  { name: "a direction override", text: "Bob\u202Erenwo", shown: "Bob renwo" },
  { name: "a zero-width mark", text: "B\u200Bob", shown: "B ob" },
  { name: "a NUL and an escape", text: "B\u0000o\u001Bb", shown: "B o b" },
  { name: "a full-width form", text: "\uFF22\uFF4F\uFF42", shown: "Bob" },
  { name: "only marks and space", text: " \u200B\u202E\n ", shown: "" },
  {
    name: "more than the bound",
    text: "x".repeat(DISPLAY_NAME_MAX_CHARACTERS + 5),
    shown: "x".repeat(DISPLAY_NAME_MAX_CHARACTERS),
  },
  // counted by character, so no half of a pair is left at the cut
  {
    name: "a pair at the bound",
    text: `${"x".repeat(DISPLAY_NAME_MAX_CHARACTERS - 1)}\u{1F600}\u{1F600}`,
    shown: `${"x".repeat(DISPLAY_NAME_MAX_CHARACTERS - 1)}\u{1F600}`,
  },
])("a name to show is one clean line: $name", ({ text, shown }) => {
  expect(displayNameOf(text)).toBe(shown);
});

// The stamp always names the person (core/boundary-worker stamp.ts, with `nameInEmail` for a
// person who typed none), so a read has no fallback: it cleans the name it is given.
test.for([
  {
    name: "a stamp with a name",
    stamp: { userId: "user_1", email: "ada@example.org", name: "Ada", method: "email" },
    shown: "Ada",
  },
  {
    name: "a stamp whose name is not clean",
    stamp: {
      userId: "user_1",
      email: "ada@example.org",
      name: "Ada\n]\u202E[SYSTEM",
      method: "email",
    },
    shown: "Ada ] [SYSTEM",
  },
])("the stamped person has a clean name: $name", ({ stamp, shown }) => {
  expect(stampedPersonOf(stamped(ITX_PERSON_HEADER, stamp))).toEqual({ ...stamp, name: shown });
});

// A header holds bytes: a name in any script, a pair and a mark all cross it and read back the same.
test("a stamp with a name past ASCII crosses a header whole", () => {
  const stamp = {
    userId: "user_1",
    email: "",
    name: "\u0141ukasz \u674E \u{1F600} \u00E9",
    method: "guest",
  };
  expect(stampJsonOf(stamp)).toMatch(/^[\x20-\x7e]+$/);
  expect(stampedPersonOf(stamped(ITX_PERSON_HEADER, stamp))).toEqual(stamp);
});

// The name is on a person, and on who asked (`source.onBehalfOf`). A verified principal has none:
// nothing that reads one can be shown a name somebody chose.
test("the stamped principal never carries a name", () => {
  const request = stamped(ITX_PRINCIPAL_HEADER, {
    actor: "user_1",
    email: "ada@example.org",
    name: "the owner",
  });
  // `toEqual`, not `toMatchObject`: one key more is the fault
  expect(stampedCallerOf(request)).toEqual({
    principal: { actor: "user_1", email: "ada@example.org" },
    grant: undefined,
  });
});

// A service reads who a call was made for as an app reads a person: with the name to show.
test("a service's caller keeps the name of who asked, and its own principal has none", () => {
  const caller = {
    mind: "example.com",
    path: "/agents/a",
    call: "itx.services.billing.charge",
    principal: { actor: "user_1", email: "ada@example.org" },
    onBehalfOf: { principal: { actor: "user_2", name: "Bob" }, call: "/agents/a#agent.message" },
  };
  expect(
    serviceCallerOf({ ...caller, principal: { ...caller.principal, name: "the owner" } }),
  ).toEqual(caller);
});

function stamped(header: string, value: unknown) {
  return new Request("https://app.example.com/", { headers: { [header]: stampJsonOf(value) } });
}
