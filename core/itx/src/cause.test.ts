// THE CAUSE OF THE MIND'S OWN REQUEST (`causeOfOwnRequest`): with the boundary's stamp, our mark
// for the host that the code named resumes its chain one step deeper; with no stamp, or a mark of
// any other form or for another host, the request begins a chain as before. A count past the
// limit and a time ahead of the clock are cut.
import { ITERATE_CAUSE_HEADER, ITX_OWN_HEADER } from "iterate/lib";
import { expect, test } from "vitest";
import { causeOfOwnRequest, crossingOneMore } from "./cause.ts";

const HOST = "app.example.org";

test("the mind's own request resumes its chain one step deeper", () => {
  const at = Date.now();
  const mark = { chain: "a chain", depth: 3, at, hops: 2, parent: "/agents/a@4", to: HOST };
  expect(ownCause(JSON.stringify(mark))).toEqual({
    chain: "a chain",
    depth: 4,
    at,
    parent: "/agents/a@4",
  });
});

// A request is a new call: the hops of the call that sent it stay with that call.
test("an own request sent deep in a call begins its own hops: its handler crosses contexts as any request's does, and its depth still steps", () => {
  const cause = ownCause(
    JSON.stringify({ chain: "c", depth: 3, at: Date.now(), hops: 15, to: HOST }),
  )!;
  expect({ depth: cause.depth, crossed: crossingOneMore(cause, "/b", 2).hops }).toEqual({
    depth: 4,
    crossed: 2,
  });
});

test("a request with our mark but no stamp of the boundary's begins a chain as before", () => {
  const mark = JSON.stringify({ chain: "a chain", depth: 3, at: Date.now(), to: HOST });
  expect(causeOfOwnRequest(new Headers({ [ITERATE_CAUSE_HEADER]: mark }), HOST)).toBeUndefined();
  expect(
    causeOfOwnRequest(new Headers({ [ITERATE_CAUSE_HEADER]: mark, [ITX_OWN_HEADER]: "yes" }), HOST),
  ).toBeUndefined();
});

test("a parent that is not printable ASCII stays behind, as `causeHeader` writes it", () => {
  const mark = (parent: string) =>
    JSON.stringify({ chain: "c", depth: 3, at: Date.now(), parent, to: HOST });
  expect([
    ownCause(mark("/agents/a@4"))?.parent,
    ownCause(mark("/agents/ä\u0007@4"))?.parent,
  ]).toEqual(["/agents/a@4", undefined]);
});

// The comparison of the mark's `to` with the served host alone; the redirect that makes the two
// differ is in request-stamps.test.ts.
test("a mark's `to` must be the served host: another host or a mark with no host begins a chain; letter case and a trailing dot are the same host", () => {
  const mark = (to?: string) => JSON.stringify({ chain: "c", depth: 3, at: Date.now(), to });
  expect({
    named: ownCause(mark(HOST))?.depth,
    redirected: ownCause(mark("outside.example.net")),
    noHost: ownCause(mark()),
    sameHost: [
      ownCause(mark("App.Example.ORG."))?.depth,
      ownCause(mark(HOST), "APP.example.org.")?.depth,
    ],
  }).toEqual({ named: 4, redirected: undefined, noHost: undefined, sameHost: [4, 4] });
});

// Each mark but the first two names the served host (`markTo`), so it fails for its own reason.
test.for<{ name: string; mark: string | undefined }>([
  { name: "no mark", mark: undefined },
  { name: "no JSON", mark: "{chain" },
  { name: "an empty chain", mark: markTo({ chain: "", depth: 1 }) },
  { name: "a chain of 600 characters", mark: markTo({ chain: "x".repeat(600), depth: 1 }) },
  {
    name: "a mark longer than 4,096 characters",
    mark: markTo({ chain: "c", depth: 1, unread: "x".repeat(4100) }),
  },
  { name: "a control character", mark: markTo({ chain: "a\u0007chain", depth: 1 }) },
  { name: "a depth below 0", mark: markTo({ chain: "c", depth: -3 }) },
  // JSON that is no object: no mark, and no throw
  { name: "the JSON value null", mark: "null" },
  { name: "the JSON number 5", mark: "5" },
  { name: 'the JSON string "x"', mark: '"x"' },
  { name: "an empty JSON array", mark: "[]" },
  { name: "an empty JSON object", mark: "{}" },
])("an own request with $name begins a chain as before", ({ mark }) => {
  expect(ownCause(mark)).toBeUndefined();
});

test("the same mark with the served host and a valid form resumes, so each case above fails for its own reason", () => {
  expect(ownCause(markTo({ chain: "c", depth: 1, unread: "x".repeat(3900) }))?.depth).toBe(2);
});

// 18 at most: a depth past the limit is cut to 17 (the limit plus one, so it is still refused),
// and the request is then one step deeper.
test("a depth past the limit resumes at 18 at most, and a time ahead of the clock at now", () => {
  const before = Date.now();
  const cause = ownCause(
    JSON.stringify({
      chain: "c",
      depth: Number.MAX_SAFE_INTEGER,
      at: Number.MAX_SAFE_INTEGER,
      to: HOST,
    }),
  );
  expect(cause?.depth).toBe(18);
  expect(cause?.at).toBeGreaterThanOrEqual(before);
  expect(cause?.at).toBeLessThanOrEqual(Date.now());
});

function ownCause(mark: string | undefined, host = HOST) {
  return causeOfOwnRequest(
    new Headers({ [ITX_OWN_HEADER]: "1", ...(mark && { [ITERATE_CAUSE_HEADER]: mark }) }),
    host,
  );
}

/** A mark for the served host. */
function markTo(fields: object) {
  return JSON.stringify({ ...fields, to: HOST });
}
