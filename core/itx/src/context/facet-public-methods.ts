// Only the walk's first step is checked: later steps walk what that public member answered.
// The platform's own calls into a facet (delivery, revive, secrets, egress) take entries no walk reaches.
import { codedError } from "iterate/lib";
import { itxExpressionStepName, type ItxExpression } from "iterate/expression";

export function assertFacetMethodIsPublic(
  facetName: string,
  publicMethods: readonly string[],
  itxExpressionSteps: ItxExpression,
): void {
  const method = itxExpressionStepName(itxExpressionSteps[0]) ?? "";
  if (publicMethods.includes(method)) return;
  throw codedError(
    "FORBIDDEN",
    `facet "${facetName}": ${JSON.stringify(method)} is not one of its public methods (${publicMethods.join(", ") || "it lists none"}) — a facet's class lists what a caller reaches by itx expression in static publicMethods`,
  );
}
