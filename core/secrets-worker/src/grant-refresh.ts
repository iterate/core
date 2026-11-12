// grant-refresh.ts — THE PERSONS' GRANTS THAT THE ITERATE CLOUD BROKERS, REFRESHED ON WORD. A mind
// works with an installation's tokens and never uses the grant of the person who connected the
// account, so nothing refreshes it (./secret/durable-object.ts `refreshGrant` says what follows
// from that). The mind's schedule calls this once a day: the vault walks its list of set secrets
// (./secret-list.ts) and asks each object that holds such a grant to refresh.
//
// GITHUB'S CLIENTS ALONE, for now: the Cloud ends a GitHub claim that is not made again within its
// limit, and makes it again at a refresh. A grant of another client refreshes when its provider
// refuses a token, as before.
import type {
  GrantRefreshed,
  GrantsRefreshed,
  SecretAnswer,
  SecretDescription,
} from "iterate/workers";
import type { GrantRefresh } from "./secret/durable-object.ts";

/** How many grants one call refreshes, one after another: each is a call of the provider through
 *  the Cloud. A vault with more answers where it stopped (`next`), and the caller goes on from
 *  there, so every grant is reached. A mind has one grant for each person who connected. */
const GRANTS_IN_ONE_CALL = 20;

type RefreshDeps = {
  /** The secrets that are set (./secret-list.ts). */
  set(): Promise<SecretDescription[]>;
  /** The names of the Cloud's clients whose persons' grants are refreshed here. */
  clients(): Promise<string[]>;
  /** A secret's object: its refresh on word, for a grant of one of `clients`. */
  refresh(path: string, clients: string[]): Promise<SecretAnswer<GrantRefresh>>;
};

/** One row for each grant that was asked, by path, and the facts for the mind's log. One grant
 *  after another, and a failed one says so in its row and stops no other. `after` is the path
 *  that the call before stopped at: the walk goes on behind it. `next`, when the vault has more
 *  grants than one call refreshes, is the path to go on from. */
export async function refreshBrokeredGrants(
  deps: RefreshDeps,
  after = "",
): Promise<SecretAnswer<GrantsRefreshed>> {
  // a secret's description says the kind of its refresh, and only its object says whose client
  const grants = (await deps.set())
    .filter((secret) => secret.refresh === "oauth-refresh-token" && secret.path > after)
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  if (!grants.length) return { result: { grants: [] }, facts: [] };
  const clients = await deps.clients();
  const asked = grants.slice(0, GRANTS_IN_ONE_CALL);
  const rows: GrantRefreshed[] = [];
  const allFacts: SecretAnswer<GrantsRefreshed>["facts"] = [];
  for (const { path } of asked) {
    const { result, facts } = await deps
      .refresh(path, clients)
      .catch((error: unknown) => thrown(path, error));
    if (result.outcome === "not-a-brokered-grant") continue;
    rows.push(
      result.outcome === "failed"
        ? { path, outcome: "failed", error: result.error }
        : { path, outcome: result.outcome },
    );
    allFacts.push(...facts);
  }
  const next = grants.length > asked.length ? asked.at(-1)?.path : undefined;
  return { result: { grants: rows, next }, facts: allFacts };
}

/** A GRANT WHOSE REFRESH THROWS STOPS NO OTHER. An object answers `failed` when its provider
 *  refused. It throws when it has no answer: its stored value does not open, or the object
 *  itself did not answer. Each walk starts at the first path, so a throw that stood would keep
 *  every grant behind it from a refresh for good. It is that grant's own failure, with the fact
 *  that a refresh on word writes. */
function thrown(path: string, error: unknown): SecretAnswer<GrantRefresh> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    result: { outcome: "failed", error: message },
    facts: [
      {
        path,
        events: [
          {
            type: "events.iterate.com/secret/refreshed",
            payload: { kind: "oauth-refresh-token", ok: false, error: message },
          },
        ],
      },
    ],
  };
}
