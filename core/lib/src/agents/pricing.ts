// pricing.ts — what one model request cost, from the usage OpenAI reports: plain input,
// cached input (read from the prompt cache), cache writes (input written to it, 1.25x for the
// GPT-6 family) and output (reasoning included). Prices per 1M tokens, standard tier, from
// https://developers.openai.com/api/docs/pricing (2026-10-03). A request over 272k input tokens is
// billed at the long-context rates throughout.

type Price = { input: number; cached: number; write: number; output: number };

const PRICES: Record<string, { short: Price; long?: Price }> = {
  "gpt-6-astra": {
    short: { input: 10, cached: 1, write: 12.5, output: 50 },
    long: { input: 20, cached: 2, write: 25, output: 75 },
  },
  "gpt-6.1-sol": { short: { input: 2, cached: 0.1, write: 2.5, output: 10 } },
  "gpt-6-sol": { short: { input: 2, cached: 0.2, write: 2.5, output: 10 } },
  "gpt-6-luna": { short: { input: 0.1, cached: 0.01, write: 0.125, output: 0.5 } },
};

/** Above this many input tokens a request is billed at the long-context rates. */
const LONG_CONTEXT_TOKENS = 272_000;

export type RequestUsage = {
  inputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
};

/** The request's cost in US dollars, or undefined for a model with no price here. */
export function requestCostUsd(model: string, usage: RequestUsage): number | undefined {
  const prices = PRICES[model];
  if (!prices) return undefined;
  // the long-context rates where the price page gives them; the short ones otherwise
  const price =
    usage.inputTokens > LONG_CONTEXT_TOKENS ? prices.long || prices.short : prices.short;
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteInputTokens ?? 0;
  const plain = Math.max(0, usage.inputTokens - cached - written);
  const usd =
    (plain * price.input +
      cached * price.cached +
      written * price.write +
      usage.outputTokens * price.output) /
    1e6;
  return Math.round(usd * 1e6) / 1e6;
}
