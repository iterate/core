// The stamps that reach a target through loaded code's own `fetch` (`env.ITX.fetch`,
// `itx.<name>.fetch`). What a hop with a caller stamps is call-context.test.ts's subject.
import { expect, test } from "vitest";
import { statelessExpressionFetch } from "./iterate-context.ts";

test("a target that loaded code fetches gets no person or principal stamp that the code wrote itself", async () => {
  const answer = await statelessExpressionFetch(
    targetThatAnswersItsStamps(),
    () => ["itx", "tunnels", "dev"],
    new Request("https://dev.example.net/", {
      headers: {
        "x-itx-person": JSON.stringify({ userId: "user_2", email: "b@example.net" }),
        "x-itx-principal": JSON.stringify({ actor: "user_2", email: "b@example.net" }),
      },
    }),
    "itx.tunnels.dev.fetch",
  );

  expect(await answer.json()).toEqual({ person: null, principal: null });
});

/** A lent target that answers with the stamps on the Request it got. */
function targetThatAnswersItsStamps() {
  return {
    invoke: async (_expression: unknown, request: Request) =>
      Response.json({
        person: request.headers.get("x-itx-person"),
        principal: request.headers.get("x-itx-principal"),
      }),
  };
}
