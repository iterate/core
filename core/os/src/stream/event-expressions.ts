// event-expressions.ts — runs the JSONata in a copy row: its `filter` and its `payload`.
// subscription-delivery.ts runs them on each event, and core-processor.ts compiles them
// when a row is configured, so a bad expression is refused up front. Each text is compiled once and
// cached, whichever project wrote it. Evaluation is synchronous, because the delivery loop checks a
// filter inside the commit hook, where it can't await.
//
// These expressions are a project's code running in the platform's isolate, which other projects'
// contexts share. So they may use less than all of JSONata:
//
//   - Nothing that can reach Object.prototype. JSONata path steps read inherited properties, so
//     `payload.__proto__.$f("x", payload.constructor)`, with `$f` bound to `__defineGetter__`, would
//     add a property to Object.prototype for every context in the isolate. We refuse, at compile
//     time, any name Object.prototype has, and `$eval` and `$lookup`, which could build such a name
//     at runtime.
//   - Nothing where one step can do unbounded work, since the step limit can't see inside it:
//     regular expressions, ranges (`[1..1000000]`) and `$pad`.
//   - A limit on steps rather than on time, because `Date.now()` doesn't move during a synchronous
//     turn on Workers.
//   - A fresh variable scope for every evaluation. Rows with the same text share one compiled
//     expression, so without it a top-level `$x := …` would still be set the next time the
//     expression runs, which may be on another project's event.
//
// An expression can still use a lot of memory, for example by doubling a string over and over. That
// pushes one isolate to its memory limit, which any context can already do
// (test/vitest/os/isolate-ceilings-deployed.e2e.test.ts).

import jsonata from "@mmkal/jsonata/sync";
import type { StreamEvent } from "iterate/stream/processor";
import { z } from "zod";

/** The longest expression allowed. Far more than any real row needs, and small enough not to bloat
 *  the checkpoint that stores the row. */
const EXPRESSION_MAX_CHARS = 1024;
/** The most steps one expression may take on one event. A runaway loop stops here; a real row takes
 *  under a hundred. */
const EVALUATION_MAX_STEPS = 10_000;
/** How many compiled expressions the cache keeps. When it fills up it's simply cleared: compiling
 *  again is cheap, and nothing relies on the cache to be correct. */
const COMPILED_EXPRESSIONS_MAX = 500;

const NAMES_ON_OBJECT_PROTOTYPE: ReadonlySet<unknown> = new Set(
  Object.getOwnPropertyNames(Object.prototype),
);
const FORBIDDEN_FUNCTIONS: ReadonlySet<unknown> = new Set(["eval", "lookup", "pad"]);

/** Describes the first part of a parsed expression that the header forbids, or returns undefined
 *  when there is none. */
function describeForbiddenNode(node: object, seen = new Set<object>()): string | undefined {
  if (seen.has(node)) return undefined;
  seen.add(node);
  // The parser's nodes aren't typed here, so each field is read as unknown and only compared with
  // literals.
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

/** The message of whatever JSONata threw. It throws plain objects with a message rather than
 *  Errors, and a deeply nested expression can throw a RangeError. */
const messageOf = (error: unknown): string => (error as Error)?.message || String(error);

/** Steps the current evaluation has left. JSONata calls `countStep` on every step. */
let stepsLeft = 0;
function countStep(): void {
  stepsLeft -= 1;
  if (stepsLeft < 0) throw new Error(`more than ${EVALUATION_MAX_STEPS} steps`);
}

const compiledExpressions = new Map<string, jsonata.Expression>();

/** Compiles `text`, or throws an error that says why it can't. Configuring a row calls this, so a
 *  bad expression is refused before the row is stored. */
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
  if (compiledExpressions.size >= COMPILED_EXPRESSIONS_MAX) compiledExpressions.clear();
  compiledExpressions.set(text, expression);
  return expression;
}

/** Evaluates `text` against `event`: its answer, or an error that names the expression. The text
 *  compiled when its row was configured, but it's compiled again here inside the `try`, because a
 *  later deploy may forbid what an earlier one allowed. */
function evaluate(text: string, event: StreamEvent): { value: unknown } | { error: Error } {
  try {
    const expression = compileEventExpression(text);
    stepsLeft = EVALUATION_MAX_STEPS; // safe as a global: the evaluation is synchronous, so nothing else runs before it ends
    return { value: expression.evaluate(event, {}) };
  } catch (error) {
    return {
      error: new Error(`the expression ${JSON.stringify(text)} failed: ${messageOf(error)}`),
    };
  }
}

/** Whether `event` passes a copy row's `filter`: only an answer of exactly `true` passes, and a row
 *  with no filter passes everything. A filter that fails answers its error. */
export function evaluateFilter(
  filter: string | undefined,
  event: StreamEvent,
): { passes: boolean } | { error: Error } {
  if (!filter) return { passes: true };
  const answer = evaluate(filter, event);
  if ("error" in answer) return answer;
  return { passes: answer.value === true };
}

/** A copy's payload is a JSON object, because the copy crosses to another context's Durable Object
 *  and is stored there as JSON. Parsing builds a fresh object, which also drops the extra properties
 *  JSONata puts on a sequence (an array it answers), and refuses a function. */
const CopyPayload = z.record(z.string(), z.json());

/** Evaluates a copy row's `payload` expression against `event`: the copy's payload, or an error if
 *  the expression fails or doesn't answer a JSON object. */
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
