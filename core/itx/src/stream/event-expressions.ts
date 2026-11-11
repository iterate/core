// Synchronous: the delivery loop checks a filter inside the commit hook, where it can't await.
import jsonata from "@mmkal/jsonata/sync";
import type { StreamEvent } from "iterate/stream/processor";
import { z } from "zod";

const EXPRESSION_MAX_CHARS = 1024;
// Steps, not time: `Date.now()` doesn't move during a synchronous turn on Workers.
const EVALUATION_MAX_STEPS = 10_000;

// Expressions are a project's code in an isolate other projects share. Path steps read inherited
// properties, so a name on Object.prototype (or $eval/$lookup building one) could pollute it.
const NAMES_ON_OBJECT_PROTOTYPE: ReadonlySet<unknown> = new Set(
  Object.getOwnPropertyNames(Object.prototype),
);
// Regular expressions, ranges and $pad can do unbounded work in one step the step limit can't see.
const FORBIDDEN_FUNCTIONS: ReadonlySet<unknown> = new Set(["eval", "lookup", "pad"]);

function describeForbiddenNode(node: object, seen = new Set<object>()): string | undefined {
  if (seen.has(node)) return undefined;
  seen.add(node);
  const { type, value } = node as { type?: unknown; value?: unknown };
  if (type === "name" && NAMES_ON_OBJECT_PROTOTYPE.has(value)) return `the name ${String(value)}`;
  if (type === "variable" && FORBIDDEN_FUNCTIONS.has(value)) return `$${String(value)}`;
  if (type === "regex") return "a regular expression";
  if (type === "binary" && value === "..") return "a range";
  for (const child of Object.values(node)) {
    const forbidden = child && typeof child === "object" && describeForbiddenNode(child, seen);
    if (forbidden) return forbidden;
  }
  return undefined;
}

// JSONata throws plain objects with a message, not Errors.
const messageOf = (error: unknown): string => (error as Error)?.message || String(error);

let stepsLeft = 0;
function countStep(): void {
  stepsLeft -= 1;
  if (stepsLeft < 0) throw new Error(`more than ${EVALUATION_MAX_STEPS} steps`);
}

const compiledExpressions = new Map<string, jsonata.Expression>();

export function compileEventExpression(text: string): jsonata.Expression {
  const known = compiledExpressions.get(text);
  if (known) return known;
  if (text.length > EXPRESSION_MAX_CHARS)
    throw new Error(`an expression is at most ${EXPRESSION_MAX_CHARS} chars`);
  let expression: jsonata.Expression;
  try {
    expression = jsonata(text);
  } catch (error) {
    throw new Error(`the expression ${JSON.stringify(text)} does not parse: ${messageOf(error)}`);
  }
  const forbidden = describeForbiddenNode(expression.ast());
  if (forbidden)
    throw new Error(
      `the expression ${JSON.stringify(text)} may not use ${forbidden}: it runs in the platform's isolate`,
    );
  // JSONata's own hook, called on every step. Its typings only allow string keys.
  expression.assign(Symbol.for("jsonata.__evaluate_entry") as unknown as string, countStep);
  if (compiledExpressions.size >= 500) compiledExpressions.clear();
  compiledExpressions.set(text, expression);
  return expression;
}

// Compiled again inside the `try`: a later deploy may forbid what the row's configuring allowed.
function evaluate(text: string, event: StreamEvent): { value: unknown } | { error: Error } {
  try {
    const expression = compileEventExpression(text);
    stepsLeft = EVALUATION_MAX_STEPS; // safe as a global: the evaluation is synchronous, so nothing else runs before it ends
    // A fresh scope: rows share compiled expressions, so a top-level `$x := …` must not leak.
    return { value: expression.evaluate(event, {}) };
  } catch (error) {
    return {
      error: new Error(`the expression ${JSON.stringify(text)} failed: ${messageOf(error)}`),
    };
  }
}

export function evaluateFilter(
  filter: string | undefined,
  event: StreamEvent,
): { passes: boolean } | { error: Error } {
  if (!filter) return { passes: true };
  const answer = evaluate(filter, event);
  if ("error" in answer) return answer;
  return { passes: answer.value === true };
}

// Parsing builds a fresh JSON object: it drops the extra properties JSONata puts on a sequence and
// refuses a function.
const CopyPayload = z.record(z.string(), z.json());

export function evaluatePayload(
  text: string,
  event: StreamEvent,
): { payload: Record<string, unknown> } | { error: Error } {
  const answer = evaluate(text, event);
  if ("error" in answer) return answer;
  const payload = CopyPayload.safeParse(answer.value);
  if (payload.success) return { payload: payload.data };
  return {
    error: new Error(
      `the expression ${JSON.stringify(text)} must answer a JSON object: ${z.prettifyError(payload.error)}`,
    ),
  };
}
