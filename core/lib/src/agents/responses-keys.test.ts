// responses-keys.test.ts — the key stack's spec: the body every key takes, and which key answers.

import { expect, test } from "vitest";
import { bodyForKeys, postResponses } from "./responses-keys.ts";

const live = new AbortController().signal;

test("the body drops what a plan's token refuses, and the explicit cache breakpoint", () => {
  expect(
    bodyForKeys({
      model: "gpt-test",
      temperature: 1,
      max_output_tokens: 5,
      previous_response_id: "resp_a",
      store: false,
      input: [
        {
          role: "developer",
          content: [
            { type: "input_text", text: "head", prompt_cache_breakpoint: { mode: "explicit" } },
          ],
        },
      ],
    }),
  ).toEqual({
    model: "gpt-test",
    store: false,
    input: [{ role: "developer", content: [{ type: "input_text", text: "head" }] }],
  });
});

test("the first key that answers 2xx serves the request, and the others are never sent", async () => {
  const { itx, seen } = egress(200);
  const response = await postResponses(itx, { model: "gpt-test" }, KEYS, live);
  expect(response).toMatchObject({ status: 200 });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.authorization).toBe(`Bearer ${KEYS[0]}`);
});

test("a key that answers an error, or throws, hands the same body to the next key", async () => {
  for (const first of [429, new Error("no such secret")]) {
    const { itx, seen } = egress(first, 200);
    const log: string[] = [];
    const response = await postResponses(
      itx,
      { model: "gpt-test", temperature: 1 },
      KEYS,
      live,
      (line) => log.push(line),
    );
    expect(response).toMatchObject({ status: 200 });
    expect(seen.map((one) => one.authorization)).toEqual(KEYS.map((key) => `Bearer ${key}`));
    expect(seen[1]?.body).toEqual({ model: "gpt-test" });
    expect(log).toEqual([expect.stringContaining("API key 1 of 2")]);
  }
});

test("when no key answers 2xx, the last failed answer comes back unread", async () => {
  const { itx } = egress(401, 503);
  const response = await postResponses(itx, { model: "gpt-test" }, KEYS, live, () => undefined);
  expect(response).toMatchObject({ status: 503 });
  expect(await response.text()).toBe("answer 503");
});

test("a stack that only throws rethrows, and an empty stack says so", async () => {
  await expect(
    postResponses(egress(new Error("a"), new Error("b")).itx, {}, KEYS, live, () => undefined),
  ).rejects.toThrow("b");
  await expect(postResponses(egress().itx, {}, [], live, () => undefined)).rejects.toThrow(
    "llm.apiKeys is empty",
  );
});

test("an abort before the call sends nothing, and an abort during a key's request ends the call without trying the next key", async () => {
  const early = new AbortController();
  early.abort(new Error("expired"));
  const idle = egress(200);
  await expect(postResponses(idle.itx, {}, KEYS, early.signal, () => undefined)).rejects.toThrow(
    "expired",
  );
  expect(idle).toMatchObject({ seen: [] });

  const controller = new AbortController();
  let sent = 0;
  const hung = {
    fetch: () => {
      sent += 1;
      return new Promise<Response>(() => undefined);
    },
  };
  const call = postResponses(hung, {}, KEYS, controller.signal, () => undefined);
  controller.abort(new Error("interrupted"));
  await expect(call).rejects.toThrow("interrupted");
  expect(sent).toBe(1);
});

const KEYS = ['getSecret("/secrets/plan", { field: "accessToken" })', 'getSecret("/secrets/key")'];

/** An egress that answers each request with the next of `answers` (a status, or a throw). */
function egress(...answers: Array<number | Error>) {
  const seen: Array<{ authorization: string | null; body: unknown }> = [];
  return {
    seen,
    itx: {
      fetch: async (request: Request) => {
        seen.push({
          authorization: request.headers.get("authorization"),
          body: JSON.parse(await request.text()),
        });
        const answer = answers[seen.length - 1];
        if (answer instanceof Error) throw answer;
        return new Response(`answer ${String(answer)}`, { status: answer });
      },
    },
  };
}
