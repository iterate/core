import { expect, test } from "vitest";
import { useLines } from "./callback-page.ts";
import { secretUseOf } from "./secrets.ts";

test("a secret lends to no other by default, to the paths its maker lists, and to every secret when its maker says null", () => {
  expect(secretUseOf(undefined)).toMatchObject({ lendTo: [] });
  expect(secretUseOf({ lendTo: ["/secrets/account", "/secrets/account"] })).toMatchObject({
    lendTo: ["/secrets/account"],
  });
  expect(secretUseOf({ lendTo: null })).toEqual({
    placement: "header",
    operations: [],
    lendTo: null,
  });
});

test.for([[""], [false], [0], ["/secrets/account"], [["account"]]] as const)(
  "a lendTo that is neither a list of secret paths nor null is refused: %j",
  ([lendTo]) => {
    expect(() => secretUseOf({ lendTo })).toThrow("lendTo lists secret paths");
  },
);

test("the page that a person sees says when the secret is lent to every secret", () => {
  const use = { placement: "header" as const, operations: [] };
  expect(useLines({ ...use, lendTo: null }, false)).toBe(
    "<p>The refresh of any secret of this mind may borrow it.</p>",
  );
  expect(useLines({ ...use, lendTo: ["/secrets/account"] }, false)).toContain(
    "The refresh of these secrets may borrow it: /secrets/account.",
  );
  expect(useLines({ ...use, lendTo: [] }, false)).toBe("");
});
