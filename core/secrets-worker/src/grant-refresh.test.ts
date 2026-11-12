import type { SecretDescription } from "iterate/workers";
import { expect, test } from "vitest";
import { refreshBrokeredGrants } from "./grant-refresh.ts";

test("each grant that the Cloud brokers is asked to refresh, whichever client it is of, one after another: a row for each, its facts, and a failed one stops no other", async () => {
  const vault = pretendVault({
    "/secrets/github-jo": { outcome: "refreshed" },
    "/secrets/github-sam": { outcome: "failed", error: "the token endpoint answered 401" },
    "/secrets/x-kim": { outcome: "fresh" },
    // a grant with a client of the mind's own: its object says that it is none of the Cloud's
    "/secrets/gmail": { outcome: "not-a-brokered-grant" },
  });

  expect(await refreshBrokeredGrants(vault.deps)).toEqual({
    result: {
      grants: [
        { path: "/secrets/github-jo", outcome: "refreshed" },
        {
          path: "/secrets/github-sam",
          outcome: "failed",
          error: "the token endpoint answered 401",
        },
        { path: "/secrets/x-kim", outcome: "fresh" },
      ],
      next: undefined,
    },
    facts: [
      { path: "/secrets/github-jo", events: [{ type: "refreshed", payload: { ok: true } }] },
      { path: "/secrets/github-sam", events: [{ type: "refreshed", payload: { ok: false } }] },
    ],
  });
  expect(vault).toMatchObject({
    // a plain token has no refresh: its object is not asked
    asked: ["/secrets/github-jo", "/secrets/github-sam", "/secrets/gmail", "/secrets/x-kim"],
  });
});

test("a grant whose refresh throws is said as failed, with a fact on its log, and the grants behind it are still refreshed", async () => {
  const vault = pretendVault({
    // its stored value does not open, or its object does not answer: no outcome, a throw
    "/secrets/github-broken": new Error(
      "the stored material of /secrets/github-broken cannot be opened",
    ),
    "/secrets/github-jo": { outcome: "refreshed" },
  });

  expect(await refreshBrokeredGrants(vault.deps)).toEqual({
    result: {
      grants: [
        {
          path: "/secrets/github-broken",
          outcome: "failed",
          error: "the stored material of /secrets/github-broken cannot be opened",
        },
        { path: "/secrets/github-jo", outcome: "refreshed" },
      ],
      next: undefined,
    },
    facts: [
      {
        path: "/secrets/github-broken",
        events: [
          {
            type: "events.iterate.com/secret/refreshed",
            payload: {
              kind: "oauth-refresh-token",
              ok: false,
              error: "the stored material of /secrets/github-broken cannot be opened",
            },
          },
        ],
      },
      { path: "/secrets/github-jo", events: [{ type: "refreshed", payload: { ok: true } }] },
    ],
  });
});

test("a vault with no grant asks no object", async () => {
  const vault = pretendVault({});

  expect(await refreshBrokeredGrants(vault.deps)).toEqual({ result: { grants: [] }, facts: [] });
  expect(vault).toMatchObject({ asked: [] });
});

test("a vault with more grants than one call refreshes says where it stopped, and the next call goes on from there: every grant is reached once", async () => {
  const paths = Array.from(
    { length: 25 },
    (_, at) => `/secrets/github-${String(at).padStart(2, "0")}`,
  );
  const vault = pretendVault(
    Object.fromEntries(paths.map((path) => [path, { outcome: "refreshed" as const }])),
  );

  const first = await refreshBrokeredGrants(vault.deps);
  const second = await refreshBrokeredGrants(vault.deps, first.result.next);

  expect({
    first: first.result.grants.map((grant) => grant.path),
    next: first.result.next,
    second: second.result.grants.map((grant) => grant.path),
    last: second.result.next,
  }).toEqual({
    first: paths.slice(0, 20),
    next: "/secrets/github-19",
    second: paths.slice(20),
    last: undefined,
  });
  expect(vault).toMatchObject({ asked: paths });
});

type Outcome =
  | { outcome: "refreshed" | "fresh" | "not-a-brokered-grant" }
  | { outcome: "failed"; error: string };

/** A vault whose set secrets are these grants, each with what its refresh on word answers, and
 *  one plain token beside them. It says which objects were asked. */
function pretendVault(grants: Record<string, Outcome | Error>) {
  const seen = { asked: [] as string[] };
  const set: SecretDescription[] = [
    { path: "/secrets/a-plain-token", set: true },
    ...Object.keys(grants)
      .sort()
      .map((path) => ({ path, set: true, refresh: "oauth-refresh-token" as const })),
  ];
  return Object.assign(seen, {
    deps: {
      set: async () => set,
      refresh: async (path: string) => {
        seen.asked.push(path);
        const result = grants[path]!;
        if (result instanceof Error) throw result;
        const ok = result.outcome === "refreshed";
        return {
          result,
          facts:
            ok || result.outcome === "failed"
              ? [{ path, events: [{ type: "refreshed", payload: { ok } }] }]
              : [],
        };
      },
    },
  });
}
