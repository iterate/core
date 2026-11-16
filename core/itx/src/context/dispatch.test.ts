// The walk's refusal of a local function's own `call`, `apply` and `bind` (./dispatch.ts `stepGet`)
// leaves a handle's remote names alone. That a held verb reached through them runs nothing is in
// ./held-verbs-across-contexts.test.ts.
import { InvokeHandle, type ItxExpression } from "iterate/expression";
import { expect, test } from "vitest";
import { walkSteps } from "./dispatch.ts";

test.for([
  { name: "the handle's own member", steps: [["call", "getUser", { id: 1 }]] },
  { name: "a member under the handle", steps: ["users", ["call", "getUser", { id: 1 }]] },
] satisfies { name: string; steps: ItxExpression }[])(
  "a step named call on $name is a remote name, and the walk hands it to the handle",
  async ({ steps }) => {
    const sent: ItxExpression[] = [];
    const handle = new InvokeHandle((given) => {
      sent.push(given);
      return "answered";
    });

    await expect(
      walkSteps({ value: { api: handle }, receiver: undefined }, ["api", ...steps]),
    ).resolves.toMatchObject({ value: "answered" });
    // exact: the handle got the steps as they were written
    expect(sent).toEqual([steps]);
  },
);
