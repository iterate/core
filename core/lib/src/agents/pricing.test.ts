// pricing.test.ts — a request's cost against what a provider billed for it.
import { expect, test } from "vitest";
import { requestCostUsd } from "./pricing.ts";

test("gpt-6.2-astra costs what the AI Gateway billed for a real request, and its long-context rates past 272k input tokens", () => {
  // the gateway's log of 2026-11-18 16:02:48 UTC: 13 tokens in, 5 out, $0.000304
  expect(requestCostUsd("gpt-6.2-astra", { inputTokens: 13, outputTokens: 5 })).toBe(0.000304);
  expect(
    requestCostUsd("gpt-6.2-astra", {
      inputTokens: 300_000,
      cachedInputTokens: 200_000,
      cacheWriteInputTokens: 50_000,
      outputTokens: 1_000,
    }),
  ).toBe(2.02);
});
