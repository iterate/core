// secret-list.ts — THE SECRETS THAT ARE SET, IN ONE CALL. The vault keeps the paths of the secrets
// that are set (./approvals-index.ts `SET`), and each secret's object writes its own row
// (./secret/durable-object.ts `keepListed`). So a list asks only the secrets that are set: not
// every path a mind ever had, a deleted secret's too, one call each, which is what the mind's own
// `secrets.list()` does from its `/secrets` log.
import { SECRET_PATH } from "iterate/secret-placeholder";
import type { SecretDescription } from "iterate/workers";

/** How many secrets' objects are asked at once. */
const ASKED_AT_ONCE = 16;

type ListDeps = {
  /** The vault's set of paths, and whether it was once filled from all that the mind knew. */
  list: { paths(): Promise<string[]>; complete(): Promise<boolean>; markComplete(): Promise<void> };
  /** A secret's object: what it is, and its own correction of its row in the set. */
  secretOf: (path: string) => {
    describe(path: string): Promise<SecretDescription>;
    keepListed(path: string): Promise<void>;
  };
};

/** The secrets that are set, by path. Each object stays the authority: a row whose object says
 *  "not set" is not listed, and the object corrects its row.
 *
 *  `known` is for a vault that held secrets before it kept the set: the paths the mind's log
 *  names. They are asked about until one list has taken them all, and never after. A mind that
 *  names paths of no secret makes the vault ask objects that hold nothing, and no more. */
export async function listSetSecrets(
  deps: ListDeps,
  known: readonly string[] = [],
): Promise<SecretDescription[]> {
  const listed = new Set(await deps.list.paths());
  const complete = await deps.list.complete();
  const hinted = complete ? [] : known.filter((path) => SECRET_PATH.test(path));
  const paths = [...new Set([...listed, ...hinted])].sort();
  const described: SecretDescription[] = [];
  for (let from = 0; from < paths.length; from += ASKED_AT_ONCE)
    described.push(
      ...(await Promise.all(
        paths.slice(from, from + ASKED_AT_ONCE).map(async (path) => {
          const secret = deps.secretOf(path);
          const description = await secret.describe(path);
          // the row and the object disagree: the object writes its own row
          if (description.set !== listed.has(path)) await secret.keepListed(path);
          return description;
        }),
      )),
    );
  if (!complete) await deps.list.markComplete();
  return described.filter((secret) => secret.set);
}
