import { expect, test } from "vitest";
import {
  DISPLAY_NAME_MAX_CHARACTERS,
  displayNameOf,
  ITX_PERSON_HEADER,
  ITX_GRANT_HEADER,
  ITX_MIND_HEADER,
  ITX_PRINCIPAL_HEADER,
  principalStampOf,
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

// A MIND IS NEVER A MEMBER: it travels in `x-itx-mind`, a header of its own, which the one
// splitter answers as `mind`; `principal`, which every member check reads, stays null.
const MIND = { actor: "ab".repeat(32), kind: "mind", hostname: "iterate.peer.example" };

test("the splitter answers a member's stamp as the principal, and no mind", () => {
  const member = { actor: "user_1", email: "ada@example.org" };
  expect(principalStampOf(stamped(ITX_PRINCIPAL_HEADER, member).headers)).toEqual({
    principal: member,
    mind: undefined,
  });
});

test("the splitter answers a mind's stamp as the mind, and never as the principal", () => {
  expect(principalStampOf(stamped(ITX_MIND_HEADER, MIND).headers)).toEqual({
    principal: null,
    mind: MIND,
  });
  expect(stampedCallerOf(stamped(ITX_MIND_HEADER, MIND))).toEqual({
    principal: null,
    mind: MIND,
    grant: undefined,
    person: undefined,
  });
});

test("a grant with no principal reads as it did: the grant, and nobody", () => {
  const request = new Request("https://app.example.com/", {
    headers: { [ITX_GRANT_HEADER]: "key:x" },
  });
  expect(stampedCallerOf(request)).toEqual({
    principal: null,
    mind: undefined,
    grant: "key:x",
    person: undefined,
  });
});

test("no stamp is neither a member nor a mind", () => {
  expect(principalStampOf(new Headers())).toEqual({ principal: null, mind: undefined });
});

test.for<{ name: string; header: string; value: string }>([
  { name: "no JSON", header: ITX_PRINCIPAL_HEADER, value: "{actor" },
  {
    name: "a member with no actor",
    header: ITX_PRINCIPAL_HEADER,
    value: JSON.stringify({ email: "ada@example.org" }),
  },
  {
    name: "a guest",
    header: ITX_PRINCIPAL_HEADER,
    value: JSON.stringify({ actor: "user_1", kind: "guest" }),
  },
  {
    name: "a kind the platform has not got",
    header: ITX_PRINCIPAL_HEADER,
    value: JSON.stringify({ actor: "user_1", kind: "x" }),
  },
  // the member's header holds a member alone: a mind's stamp there is no member
  {
    name: "a mind's stamp in the member's header",
    header: ITX_PRINCIPAL_HEADER,
    value: JSON.stringify(MIND),
  },
  // a mind's stamp whose writer forgot `kind` is no member
  {
    name: "a member with a mind's hostname",
    header: ITX_PRINCIPAL_HEADER,
    value: JSON.stringify({ ...MIND, kind: undefined }),
  },
  { name: "a member's header present and empty", header: ITX_PRINCIPAL_HEADER, value: "" },
  { name: "a mind's header with no JSON", header: ITX_MIND_HEADER, value: "{actor" },
  {
    name: "a member's stamp in the mind's header",
    header: ITX_MIND_HEADER,
    value: JSON.stringify({ actor: "user_1", email: "ada@example.org" }),
  },
  {
    name: "a mind with no hostname",
    header: ITX_MIND_HEADER,
    value: JSON.stringify({ actor: MIND.actor, kind: "mind" }),
  },
  {
    name: "a mind whose actor is a hostname",
    header: ITX_MIND_HEADER,
    value: JSON.stringify({ ...MIND, actor: "peer.example" }),
  },
  {
    name: "a mind with an email",
    header: ITX_MIND_HEADER,
    value: JSON.stringify({ ...MIND, email: "ada@example.org" }),
  },
  {
    name: "a mind whose hostname is no DNS name",
    header: ITX_MIND_HEADER,
    value: JSON.stringify({ ...MIND, hostname: "/" }),
  },
  { name: "a mind's header present and empty", header: ITX_MIND_HEADER, value: "" },
])("a stamp that is $name is a defect, and throws", ({ header, value }) => {
  const headers = new Headers({ [header]: value });
  expect(() => principalStampOf(headers)).toThrow();
});

test("a member and a mind on one request are a defect, and throw", () => {
  const headers = new Headers({
    [ITX_PRINCIPAL_HEADER]: JSON.stringify({ actor: "user_1" }),
    [ITX_MIND_HEADER]: JSON.stringify(MIND),
  });
  expect(() => principalStampOf(headers)).toThrow(/a member and a mind/);
});

test("a person beside a mind is a defect, and throws: a mind's request opens no person's view", () => {
  const person = { userId: "user_1", email: "ada@example.org", name: "ada", method: "email" };
  const request = new Request("https://app.example.com/", {
    headers: {
      [ITX_MIND_HEADER]: JSON.stringify(MIND),
      [ITX_PERSON_HEADER]: stampJsonOf(person),
    },
  });
  expect(() => stampedCallerOf(request)).toThrow(/person is stamped beside a mind/);
});

test("a grant beside a mind is a defect, and throws", () => {
  const request = new Request("https://app.example.com/", {
    headers: { [ITX_MIND_HEADER]: JSON.stringify(MIND), [ITX_GRANT_HEADER]: "grant_1" },
  });
  expect(() => stampedCallerOf(request)).toThrow(/grant is stamped beside a mind/);
});

function stamped(header: string, value: unknown) {
  return new Request("https://app.example.com/", { headers: { [header]: stampJsonOf(value) } });
}
