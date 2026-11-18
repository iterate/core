import { expect, test } from "vitest";
import { mintOnBehalfOf, verifyOnBehalfOf } from "./on-behalf-of.ts";

const SECRET = "test-signing-secret";

// The token is how a person's page names them on a call (person-context.ts): what it holds is what
// `source.onBehalfOf` then says. A name in any script crosses it; a field nobody defined does not.
test("the token carries the person's name, and no field it does not know", async () => {
  const principal = { actor: "user_1", email: "a@example.com", name: "\u0141ukasz \u674E" };
  const onBehalfOf = { principal, via: { appPage: "chat.example.com" }, call: "/a#agent.message" };
  const token = await mintOnBehalfOf(
    { ...onBehalfOf, principal: { ...principal, member: true } as typeof principal },
    SECRET,
    1000,
  );
  expect(await verifyOnBehalfOf(token, SECRET, 1000)).toEqual(onBehalfOf);
  expect(await verifyOnBehalfOf(token, "another-secret", 1000)).toBeUndefined();
});
