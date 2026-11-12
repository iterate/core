import { expect, test } from "vitest";
import { lendRefusal, operationRefusal, placementRefusal } from "./refusals.ts";

test("a refused operation names itself, what the secret answers now, and the option to make it with", () => {
  const words = operationRefusal("verifyEquals", "/secrets/hook", []);
  expect(words).toContain("verifyEquals: /secrets/hook was not made to answer it");
  expect(words).toContain("its operations are none");
  expect(words).toContain(
    'itx.secrets.set("/secrets/hook", material, { urls, operations: ["verifyEquals"] })',
  );
  // the operations it has are kept in the call: a set replaces the whole secret
  expect(operationRefusal("signHmac", "/secrets/hook", ["verifyHmac"])).toContain(
    'its operations are verifyHmac. Name the operation when the secret is made: itx.secrets.set("/secrets/hook", material, { urls, operations: ["verifyHmac", "signHmac"] })',
  );
});

test("a refused placement names the option to make the secret with", () => {
  const words = placementRefusal("/secrets/bot");
  expect(words).toContain("the secret /secrets/bot is placed in headers alone");
  expect(words).toContain('itx.secrets.set("/secrets/bot", material, { urls, placement: "url" })');
});

test("a refused lend names the borrower, whom the secret lends to now, and the option to make it with", () => {
  const words = lendRefusal("/secrets/app", "/secrets/account", []);
  expect(words).toContain("/secrets/app does not lend to /secrets/account: it lends to none");
  expect(words).toContain(
    'itx.secrets.set("/secrets/app", material, { urls, lendTo: ["/secrets/account"] })',
  );
  expect(lendRefusal("/secrets/app", "/secrets/b", ["/secrets/a"])).toContain(
    'it lends to /secrets/a. Name the borrower when the secret is made: itx.secrets.set("/secrets/app", material, { urls, lendTo: ["/secrets/a", "/secrets/b"] })',
  );
});

test.for([
  operationRefusal("verifyEquals", "/secrets/hook", []),
  placementRefusal("/secrets/bot"),
  lendRefusal("/secrets/app", "/secrets/account", []),
])(
  "each refusal says that a set replaces the whole secret, and names the two other ways to make one",
  (words) => {
    expect(words).toContain("collectFromUser and beginOAuth take the same option");
    expect(words).toContain("A set replaces the whole secret");
  },
);
