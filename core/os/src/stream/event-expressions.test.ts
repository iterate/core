// event-expressions.test.ts — what a copy row's JSONata may use and what it evaluates to, on the
// real `@mmkal/jsonata/sync`. The header of event-expressions.ts says why each expression is refused.
// subscription-delivery.test.ts tests a row that uses these, and
// test/vitest/os/event-copies.e2e.test.ts tests copies between real contexts.
import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import { compileEventExpression, evaluateFilter, evaluatePayload } from "./event-expressions.ts";

test.for([
  { filter: `$type(payload.title) = "string"`, payload: { title: "Fix it" }, passes: true },
  { filter: `$type(payload.title) = "string"`, payload: { activity: "busy" }, passes: false },
  {
    filter: `payload.role = "user" and $not(payload.actor.type != "user")`,
    payload: { role: "user", actor: { type: "user" } },
    passes: true,
  },
  {
    name: "a message with no actor counts as from a person",
    filter: `payload.role = "user" and $not(payload.actor.type != "user")`,
    payload: { role: "user" },
    passes: true,
  },
  {
    name: "a message from another agent doesn't",
    filter: `payload.role = "user" and $not(payload.actor.type != "user")`,
    payload: { role: "user", actor: { type: "agent" } },
    passes: false,
  },
  {
    name: "a truthy answer that isn't `true` doesn't pass",
    filter: `payload.title`,
    payload: { title: "x" },
    passes: false,
  },
])(
  "a filter passes only when it answers exactly true: $filter over $payload",
  ({ filter, payload, passes }) => {
    expect(evaluateFilter(filter, committed({ payload }))).toEqual({ passes });
  },
);

test.for([
  { content: "Fix the build\nand then the docs", words: "Fix the build" },
  { content: "  \n\n   Fix the build  \nand then the docs", words: "Fix the build" },
  { content: "x".repeat(500), words: "x".repeat(120) },
  { content: "  \n ", payload: {} },
])(
  "the first non-blank line of a message, up to 120 chars: $content",
  ({ content, words, payload }) => {
    const text = `{ "words": $substring(($split(payload.content, "\\n").$trim($))[$ != ""][0], 0, 120) }`;
    expect(evaluatePayload(text, committed({ payload: { content } }))).toEqual({
      payload: payload || { words },
    });
  },
);

test("a payload is plain JSON whatever JSONata returns: a sequence becomes an array, and no result leaves the field out", () => {
  const evaluated = evaluatePayload(
    `{ "doubled": payload.ns.($ * 2), "missing": payload.absent }`,
    committed({ payload: { ns: [1, 2] } }),
  );
  expect(evaluated).toStrictEqual({ payload: { doubled: [2, 4] } });
  expect(evaluated).not.toHaveProperty("payload.doubled.sequence");
});

test.for([
  { name: "a string", text: `"just text"` },
  { name: "an array", text: `[{ "a": 1 }]` },
  { name: "nothing", text: `payload.absent` },
  { name: "an object with a function in it", text: `{ "f": $substring }` },
])("a payload expression that answers $name fails", ({ text }) => {
  expect(evaluatePayload(text, committed({ payload: {} }))).toMatchObject({
    error: { message: expect.stringMatching(/must answer a JSON object/) },
  });
});

test.for([
  // the attack this guards against: it adds a property to Object.prototype for every context in the isolate
  `($d := payload.__proto__.__defineGetter__; $o := payload.constructor; payload.__proto__.$d("polluted", $o))`,
  `payload.__proto__`,
  `payload.constructor`,
  `payload.hasOwnProperty`,
  `payload.__defineGetter__`,
  `payload.toString`,
  "payload.`__proto__`",
  `payload."__proto__"`,
  `"__proto__".x`,
  `payload ~> |__proto__|{"x":1}|`,
  // the same names, built at runtime
  `$lookup(payload, "__pro" & "to__")`,
  `$eval("payload.__proto__")`,
  `($f := $eval; $f("1"))`,
  // a single step that can do unbounded work, which the step limit can't see
  `$match(payload.text, /(a+)+$/)`,
  `$count([1..9999999])`,
  `$pad("", 100000000)`,
])("refused when the row is configured: %s", (text) => {
  expect(() => compileEventExpression(text)).toThrow(/may not use/);
});

test("expressions that only look like they touch __proto__ leave Object.prototype alone", () => {
  const before = Object.getOwnPropertyNames(Object.prototype);
  for (const text of [
    `payload ~> |$|{"__proto__":{"polluted":1}}|`,
    `{"__proto__":{"polluted":1}}`,
  ])
    expect(() => compileEventExpression(text)).not.toThrow();
  evaluateFilter(`payload ~> |$|{"__proto__":{"polluted":1}}|`, committed({ payload: {} }));
  evaluateFilter(`{"__proto__":{"polluted":1}}`, committed({ payload: {} }));
  expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(before);
  expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
});

test.for([
  { name: "an expression that doesn't parse", text: `payload.(` },
  { name: "an expression that's too long", text: `"${"x".repeat(2000)}"` },
])("refused when the row is configured: $name", ({ text }) => {
  expect(() => compileEventExpression(text)).toThrow();
});

test("a loop stops at the step limit, the error names the expression, and the next evaluation runs normally", () => {
  const event = committed({ payload: {} });
  const loop = `($f := function($n) { $f($n + 1) }; $f(0))`;
  expect(evaluateFilter(loop, event)).toMatchObject({
    error: { message: expect.stringMatching(/more than 10000 steps/) },
  });
  expect(evaluateFilter(`$error("no")`, event)).toMatchObject({
    error: { message: expect.stringMatching(/\$error.*failed: no/) },
  });
  expect(evaluateFilter(`true`, event)).toEqual({ passes: true });
});

test("a variable set while evaluating one event is gone for the next, since rows in any project share an expression with the same text", () => {
  const text = `{ "seen": $seen := $exists($seen) ? $seen & payload.n : payload.n }`;
  expect(evaluatePayload(text, committed({ payload: { n: "a" } }))).toEqual({
    payload: { seen: "a" },
  });
  expect(evaluatePayload(text, committed({ payload: { n: "b" } }))).toEqual({
    payload: { seen: "b" },
  });
});

/** An event as it is stored in a log. */
function committed(event: Partial<StreamEvent>): StreamEvent {
  return {
    type: "test/said",
    offset: 7,
    createdAt: "2026-11-02T10:00:00.000Z",
    path: "/child",
    source: { origin: "/child" },
    ...event,
  };
}
