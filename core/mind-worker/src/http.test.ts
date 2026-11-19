// THE MIND'S HOST ENTRANCE (./http.ts `hostRequestOf`): only the mind's own request keeps its mark.
import { ITERATE_CAUSE_HEADER, ITX_OWN_HEADER } from "iterate/lib";
import { expect, test } from "vitest";
import { hostRequestOf } from "./http.ts";

const mark = JSON.stringify({ chain: "a chain", depth: 5, at: Date.now(), to: "app.example.org" });

test("a mark from outside is taken off, the mind's own is kept and resumed, and a request with none goes as it came", () => {
  const visitor = hostRequestOf(
    new Request("https://app.example.org/", { headers: { [ITERATE_CAUSE_HEADER]: mark } }),
  );
  const own = hostRequestOf(
    new Request("https://app.example.org/", {
      headers: { [ITERATE_CAUSE_HEADER]: mark, [ITX_OWN_HEADER]: "1" },
    }),
  );
  const plain = new Request("https://app.example.org/", { headers: { "x-plain": "kept" } });
  expect({
    visitor: [visitor.request.headers.get(ITERATE_CAUSE_HEADER), visitor.cause],
    own: [own.request.headers.get(ITERATE_CAUSE_HEADER), own.cause?.depth, own.cause?.chain],
    plain: hostRequestOf(plain),
  }).toEqual({
    visitor: [null, undefined],
    own: [mark, 6, "a chain"],
    plain: { request: plain, cause: undefined },
  });
});
