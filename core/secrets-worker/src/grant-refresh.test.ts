import type { SecretDescription } from "iterate/workers";
import { expect, test } from "vitest";
import { refreshBrokeredGrants } from "./grant-refresh.ts";

test("each grant of the Cloud's clients is asked to refresh, one after another: a row for each, its facts, and a failed one stops no other", async () => {
  const vault = pretendVault({
    "/secrets/github-jo": { outcome: "refreshed" },
    "/secrets/github-sam": { outcome: "failed", error: "the token endpoint answered 401" },
    "/secrets/github-kim": { outcome: "fresh" },
    // a grant with a client of the mind's own: its object says that it is none of the Cloud's
    "/secrets/gmail": { outcome: "not-a-brokered-grant" },
  });

  expect(await refreshBrokeredGrants(vault.deps)).toEqual({
    result: {
      grants: [
        { path: "/secrets/github-jo", outcome: "refreshed" },
        { path: "/secrets/github-kim", outcome: "fresh" },
        {
          path: "/secrets/github-sam",
          outcome: "failed",
          error: "the token endpoint answered 401",
        },
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
    asked: ["/secrets/github-jo", "/secrets/github-kim", "/secrets/github-sam", "/secrets/gmail"],
    clientsGiven: [["github"], ["github"], ["github"], ["github"]],
    cloudAsked: 1,
  });
});

test("a vault with no grant asks neither the Cloud nor any object", async () => {
  const vault = pretendVault({});

  expect(await refreshBrokeredGrants(vault.deps)).toEqual({ result: { grants: [] }, facts: [] });
  expect(vault).toMatchObject({ asked: [], cloudAsked: 0 });
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
 *  one plain token beside them. It says which objects were asked, with which clients, and how
 *  often the Cloud was asked for its clients. */
function pretendVault(grants: Record<string, Outcome>) {
  const seen = { asked: [] as string[], clientsGiven: [] as string[][], cloudAsked: 0 };
  const set: SecretDescription[] = [
    { path: "/secrets/a-plain-token", set: true },
    ...Object.keys(grants)
      .sort()
      .map((path) => ({ path, set: true, refresh: "oauth-refresh-token" as const })),
  ];
  return Object.assign(seen, {
    deps: {
      set: async () => set,
      clients: async () => {
        seen.cloudAsked += 1;
        return ["github"];
      },
      refresh: async (path: string, clients: string[]) => {
        seen.asked.push(path);
        seen.clientsGiven.push(clients);
        const result = grants[path]!;
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
