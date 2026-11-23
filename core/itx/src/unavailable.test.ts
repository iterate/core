import { codedError } from "iterate/lib";
import { expect, test, vi } from "vitest";
import { expressionFetchErrorAnswer, failedPageAnswer } from "./unavailable.ts";

test("a browser's own page load of a page that failed gets the error in words and that it is recorded; every other caller and every other status gets the answer as it is", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const broke = new TypeError("the page broke");
  expect(await answerTo({ "sec-fetch-dest": "document" }, broke)).toEqual({
    status: 500,
    type: "text/plain; charset=utf-8",
    text: "This page failed: the page broke\n\nThe mind tries to record this error for its owners.\n",
  });
  // an agent's fetch, a page's own fetch, a script: the body an agent reads, byte for byte
  const others: Record<string, string>[] = [
    {},
    { "sec-fetch-dest": "empty" },
    { "sec-fetch-dest": "script" },
  ];
  for (const headers of others)
    expect(await answerTo(headers, broke)).toEqual({
      status: 500,
      type: "text/plain;charset=UTF-8",
      text: "expression fetch error: the page broke\n",
    });
  // a status the kernel maps from a code stays as it is for a browser too
  expect(
    await answerTo({ "sec-fetch-dest": "document" }, codedError("INVALID_INPUT", "no such page")),
  ).toEqual({
    status: 400,
    type: "text/plain;charset=UTF-8",
    text: "expression fetch error: no such page\n",
  });
});

/** What `failedPageAnswer` answers a request with `headers` for `error`. */
async function answerTo(headers: Record<string, string>, error: unknown) {
  const answer = await failedPageAnswer(
    new Request("https://mind.example/", { headers }),
    expressionFetchErrorAnswer(error, '["fetch"]'),
    error,
  );
  return {
    status: answer.status,
    type: answer.headers.get("content-type"),
    text: await answer.text(),
  };
}
