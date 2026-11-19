import { expect, test } from "vitest";
import { ITX_MIND_HEADER, ITX_PERSON_HEADER } from "iterate/principal";
import { admitted } from "./callback-page.ts";

// A secret's pages let in a member: another mind (`x-itx-mind`) is no member and no person,
// so it is sent to sign in as nobody is; a person stamped beside a mind is a defect, and throws.
const MIND = { actor: "ab".repeat(32), kind: "mind", hostname: "iterate.peer.example" };
test("a page that a member alone may open sends another mind to sign in, as it sends nobody", () => {
  const answer = admitted(page({ [ITX_MIND_HEADER]: JSON.stringify(MIND) }), false);
  const nobody = admitted(page({}), false);
  expect([answer, nobody].map((each) => (each instanceof Response ? each.status : each))).toEqual([
    303, 303,
  ]);
});

test("a person stamped beside a mind is a defect at a secret's page, and throws", () => {
  const person = { userId: "user_1", email: "jo@example.net", name: "jo", method: "email" };
  const request = page({
    [ITX_PERSON_HEADER]: JSON.stringify(person),
    [ITX_MIND_HEADER]: JSON.stringify(MIND),
  });
  expect(() => admitted(request, false)).toThrow(/person is stamped beside a mind/);
});

function page(headers: Record<string, string>) {
  return new Request("https://iterate.example.com/secrets/x/collect", { headers });
}
