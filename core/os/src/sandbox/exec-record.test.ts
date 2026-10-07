import { expect, test } from "vitest";
import { outputForLog } from "./exec-record.ts";

test("a short output is kept whole", () => {
  expect(outputForLog(bytes("hello\n"))).toEqual({ text: "hello\n", omitted: 0 });
  expect(outputForLog(bytes(""))).toEqual({ text: "", omitted: 0 });
});

test("a long output keeps its two ends and says how much the middle held", () => {
  const output = outputForLog(bytes(`start-${"x".repeat(10_000)}-end`));
  expect(output).toMatchObject({ omitted: 10_000 + "start--end".length - 4000 });
  expect(output.text.startsWith("start-x")).toBe(true);
  expect(output.text.endsWith("x-end")).toBe(true);
  expect(output.text).toContain(`… ${output.omitted} bytes omitted …`);
  expect(output.text.length).toBeLessThan(4100);
});

const bytes = (text: string) => new TextEncoder().encode(text);
