import { expect, test } from "vitest";
import { startOnce } from "./start-once.ts";

test("a start asked for while another runs waits for it, then gets its own options", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const begin = startOnce<{ secrets?: string[] }>(
    (options) =>
      new Promise<void>((resolve) => {
        calls.push(`start ${options.secrets?.join(",") ?? "any"}`);
        finish = resolve;
      }),
    async (options) => void calls.push(`follow ${options.secrets?.join(",") ?? "none"}`),
  );
  const first = begin({});
  const second = begin({ secrets: ["/secrets/anthropic"] });
  finish();
  await Promise.all([first, second]);
  expect(calls).toEqual(["start any", "follow /secrets/anthropic"]);
});

test("a start after the last one ended starts again", async () => {
  let starts = 0;
  const begin = startOnce<object>(
    async () => void starts++,
    async () => undefined,
  );
  await begin({});
  await begin({});
  expect(starts).toBe(2);
});
