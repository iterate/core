// minds.ts — ANOTHER MIND AS A SIGNER: a mind that this mind lets in adds events here with a
// statement that names it as `from`, by its id, signed with the ML-DSA-65 working key that its
// identity log lists, read at `fromHost` (iterate/mind-identity-log `publishedMindOf`). The rule
// that lets it in is a member's `events.iterate.com/mind-meld/configured` on `/minds/<its id>`
// (./statements.ts), and the `mind_melds` row is its copy. No key is exchanged: the rule names
// the id, the log at the hostname proves the id and names the key.
//
// A MIND ON A RELEASE BEFORE 19 NOV 2026 names its hostname as `from`, with no `fromHost`. It is
// still taken: the log at that hostname proves the id, and the id decides as for any other. Each
// such statement writes one log line (`auth.mind-statement-hostname-form`); the reader goes when
// that count is zero. A row by hostname has no id: the first statement that
// uses it, once its signature checked, pins it to the id that its hostname's log proves then
// (trust on first use; the /minds page says so), and from then on another id at that hostname is
// refused and shown there.
//
// THE LOG STATE THIS WORKER READ LAST BELONGS TO THE ID, not to a hostname: whichever hostname
// serves the log next, a log that does not extend it is refused, so a second hostname that serves
// an older head (one that still lists a revoked key) gets nothing.
import { identityKeyIdOf } from "iterate/mind-identity";
import { type PublishedMind, publishedMindOf } from "iterate/mind-identity-log";
import type { MindConfig } from "iterate/mind-config";
import { type Envelope, isMindControlPlaneHostname, isMindId, statementOf } from "iterate/signed";
import { z } from "zod";
import type { Env } from "./env.ts";
import { canonicalPath } from "./key-rules.ts";
import type { KnownKey } from "./keys.ts";
import { stackKeyIsListed } from "./stack-key.ts";

type Signer = { mind: string; hostname: string; key: KnownKey };

/** WHETHER A STATEMENT'S `mind` IS THIS MIND: its id, as another mind names it; or its
 *  control-plane hostname, as its own keys and a mind in the hostname form name it. */
export const isForThisMind = (
  mind: string,
  own: Pick<MindConfig, "mindId" | "controlPlaneHostname">,
) => mind === own.mindId || mind === own.controlPlaneHostname;

/** THE MIND THAT A STATEMENT NAMES AS ITS SIGNER, as its own log proves the mind: null when the
 *  statement names no mind as `from`; else the mind id that the log at its hostname proves
 *  (iterate/mind-identity-log `publishedMindOf`), that hostname, and the working key for
 *  statements that the log lists under the signature's key id, as a key this Worker checks a
 *  statement with. A statement that names an id is refused when the log is another mind's.
 *
 *  IT CHECKS NO SIGNATURE, AND NO RULE. Its answer is only whose key the statement CLAIMS: a
 *  forger who copies a listed key id gets the real mind id and hostname back. A CALLER MUST
 *  VERIFY THE SIGNATURE WITH THE ANSWERED KEY (and its format) BEFORE IT TRUSTS `mind` OR
 *  `hostname`, as ./keys.ts `verifiedStatement` does, and decide itself what the mind may do
 *  here. It fetches, so a caller asks it only for a mind it has a reason to read. No mind's
 *  statement is taken before this mind's own identity lists its stack's key (./stack-key.ts):
 *  a mind that cannot sign as itself yet is in no exchange with another. */
export async function mindSignerOf(
  env: Env,
  envelope: Envelope,
): Promise<Signer | { refused: string } | null> {
  const sender = senderOf(envelope);
  if (!sender || "refused" in sender) return sender;
  if (!(await stackKeyIsListed(env))) return NOT_LISTED;
  const fetchOf = (request: Request) => fetch(request);
  let published = await publishedMindOf(
    sender.host,
    fetchOf,
    sender.id ? await keptStateOf(env, sender.id) : undefined,
  );
  // the hostname form names no id: the log proves it, and the log must go on from the state kept
  // for that id, at whichever hostname it is served (a log that does not extend it is refused)
  if (!sender.id && !("why" in published)) {
    const kept = await keptStateOf(env, published.expected);
    if (kept && kept.head !== published.head)
      published = await publishedMindOf(sender.host, fetchOf, kept);
  }
  // the host is unverified here: 80 characters of it, as in the log line
  if ("why" in published)
    return { refused: `${sender.host.slice(0, 80)} gave no keys: ${published.why}` };
  if (sender.id && published.expected !== sender.id)
    return { refused: `${sender.host} serves the log of another mind than the statement's from` };
  return signerIn(published, sender.host, envelope);
}

/** The key of the mind a statement names as `from`, with the rule's `append` as its paths; null
 *  when the statement names no mind; or why it does not sign here. The rule is read first, so
 *  nothing is fetched for a mind that is not let in: a stranger must not make this Worker ask a
 *  host. A newer state of a pinned row's log is kept at once. A row by hostname is pinned by the
 *  key's `settle` alone, which the caller runs once the statement verified (./keys.ts). */
export async function mindKeyOf(
  env: Env,
  envelope: Envelope,
): Promise<KnownKey | { refused: string } | null> {
  const sender = senderOf(envelope);
  if (!sender || "refused" in sender) return sender;
  if (!(await stackKeyIsListed(env))) return NOT_LISTED;
  const { results } = await env.DB.prepare(
    `select domain, mind, append, key, state from mind_melds
      where (mind = ?1 or domain = ?2) and append != '[]'`,
  )
    .bind(sender.id || null, sender.host)
    .all<MeldRow>();
  // the id's own row, else the row at the hostname: one row for each hostname (its key)
  const row =
    (sender.id && results.find((meld) => meld.mind === sender.id)) ||
    results.find((meld) => meld.domain === sender.host);
  if (!row) return { refused: `${sender.id || sender.host} is not let in here` };
  if (row.key && row.key !== envelope.signature.key)
    return { refused: "the rule names another key" };
  if (sender.id && row.mind && row.mind !== sender.id) {
    // another id at a hostname that is let in as one mind: shown to the owner when its log proves it
    await refusedAt(env, row, sender.host);
    return { refused: `${sender.host} is let in here as another mind` };
  }
  // the state this Worker read last for the row's id, at whichever hostname: the next read goes
  // on from its head
  // the cast: a row's state is an answer of `publishedMindOf` that this Worker wrote, and
  // `publishedMindOf` checks it again (identityStateFrom) before it reads on from it
  const kept = row.mind && row.state ? (JSON.parse(row.state) as PublishedMind) : undefined;
  const read = await publishedMindOf(sender.host, (request) => fetch(request), kept);
  if ("why" in read) {
    // a log that does not continue the one kept: what does the hostname serve now?
    if (kept) await refusedAt(env, row, sender.host);
    return { refused: `${sender.host.slice(0, 80)} gave no keys: ${read.why}` };
  }
  if (sender.id && read.expected !== sender.id)
    return { refused: `${sender.host} serves the log of another mind than the statement's from` };
  if (row.mind && read.expected !== row.mind) {
    await refusedAt(env, row, sender.host);
    return { refused: `${sender.host} is let in here as another mind` };
  }
  // a newer state of the id's own log is kept at once, whatever the statement proves: a key that
  // the log revoked stays revoked here, at every hostname
  if (row.mind && read.head !== kept?.head)
    await env.DB.prepare(`update mind_melds set state = ?1 where mind = ?2`)
      .bind(JSON.stringify(read), read.expected)
      .run();
  const signer = await signerIn(read, sender.host, envelope);
  if ("refused" in signer) return signer;
  return {
    ...signer.key,
    paths: pathsOf(row, read.expected),
    // TRUST ON FIRST USE, once the statement verified: a rule by hostname named this hostname
    // and no id
    settle: async () => {
      if (row.mind) return null;
      const pinned = await env.DB.prepare(
        `update mind_melds set mind = ?1, state = ?2, pinned_at = ?3
          where domain = ?4 and mind is null
            and not exists (select 1 from mind_melds other where other.mind = ?1)`,
      )
        .bind(read.expected, JSON.stringify(read), Date.now(), row.domain)
        .run();
      if (!pinned.meta.changes) return `${read.expected} is let in here at another hostname`;
      console.info({ event: "auth.mind-meld-pinned", domain: row.domain, mind: read.expected });
      return null;
    },
  };
}

/** A MIND IS ENROLLED HERE when the row that holds its id lets it append under its own context,
 *  `/minds/<id>/`, in either form (`pathsOf`). An empty rule, a rule for one path below it, or no
 *  row is not enrolled. A point read: `mind` has a unique index. */
export async function enrolledHere(env: Env, mind: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `select domain, mind, append, key, state from mind_melds where mind = ?1`,
  )
    .bind(mind)
    .first<MeldRow>();
  return !!row && pathsOf(row, mind).includes(`/minds/${mind}/`);
}

/** The log state kept for the mind a statement names: its id's row, or, for a statement that
 *  names a hostname alone, the pinned row at that hostname. */
async function keptStateOf(env: Env, mind: string) {
  const row = await env.DB.prepare(
    `select state from mind_melds where mind = ?1 and state is not null`,
  )
    .bind(mind)
    .first<{ state: string }>();
  // the cast: as in `mindKeyOf`, this Worker wrote it, and `publishedMindOf` checks it again
  return row ? (JSON.parse(row.state) as PublishedMind) : undefined;
}

/** THE PATHS THAT A ROW LETS ITS MIND APPEND UNDER: the rule's `append`, and each of its paths
 *  under the mind's own context in the other form too, `/minds/<hostname>/…` as `/minds/<id>/…`
 *  and back. A rule by hostname named the hostname, where a sender in the id form lands by id;
 *  a rule by id lets in a sender in the hostname form too, which lands by hostname. */
function pathsOf(row: MeldRow, mind: string) {
  const append = z.array(z.string()).parse(JSON.parse(row.append));
  const as = (from: string, to: string) =>
    append
      .filter((path) => path === from || path.startsWith(`${from}/`))
      .map((path) => `${to}${path.slice(from.length)}`);
  const byHostname = `/minds/${row.domain}`;
  const byId = `/minds/${mind}`;
  return [...new Set([...append, ...as(byHostname, byId), ...as(byId, byHostname)])];
}

/** The key in `published` that signed `envelope`, as a signer whose principal is the mind's id. */
async function signerIn(
  published: PublishedMind,
  hostname: string,
  envelope: Envelope,
): Promise<Signer | { refused: string }> {
  // A key's id is the hash of its public key, computed here: the log lists no id of its own.
  for (const key of published.current.workingKeys) {
    if (key.purpose !== "statements") continue;
    if ((await identityKeyIdOf(key.publicKey)) !== envelope.signature.key) continue;
    return {
      mind: published.expected,
      hostname,
      key: {
        principal: { actor: published.expected, kind: "mind", hostname },
        publicKey: key.publicKey,
        label: key.label,
        // the schema of a working key lists this algorithm alone (iterate/mind-identity)
        format: key.algorithm,
      },
    };
  }
  return { refused: `${hostname} lists no such working key` };
}

/** WHETHER A ROW'S HOSTNAME NOW SERVES ANOTHER MIND, after a log that did not continue the one
 *  kept or proved another id: when its log proves another id, that id is written for the owner
 *  (the /minds page). A host that answers nothing now writes nothing: that may pass. Only a row
 *  that a member signed is read, so a stranger makes this Worker ask no host. */
async function refusedAt(env: Env, row: MeldRow, hostname: string) {
  const now = await publishedMindOf(hostname, (request) => fetch(request));
  const mind = "why" in now ? null : now.expected;
  console.warn({ event: "auth.mind-meld-refused", domain: row.domain, pinned: row.mind, mind });
  // what another hostname serves says nothing of this row's: only the row's own is written
  if (!mind || mind === row.mind || hostname !== row.domain) return;
  await env.DB.prepare(`update mind_melds set refused = ?1 where domain = ?2`)
    .bind(JSON.stringify({ mind, at: Date.now() }), row.domain)
    .run();
}

type MeldRow = {
  domain: string;
  mind: string | null;
  append: string;
  key: string | null;
  state: string | null;
};

const NOT_LISTED = {
  refused:
    "this mind's identity lists no working key of its stack yet, so it takes no statement from another mind",
};

/** WHO A STATEMENT NAMES AS ITS SIGNER, read before the signature checks, only to know whose
 *  published keys to check it with: an id and the hostname where its log is read, or a hostname
 *  alone (a mind in the hostname form); null when it names no mind. */
function senderOf(envelope: Envelope): { id?: string; host: string } | { refused: string } | null {
  const statement = statementOf(envelope.statement);
  if ("refused" in statement || !statement.from) return null;
  const { from, fromHost } = statement;
  if (isMindId(from) && fromHost && isMindControlPlaneHostname(fromHost))
    return { id: from, host: fromHost };
  if (!fromHost && isMindControlPlaneHostname(from)) {
    console.info({ event: "auth.mind-statement-hostname-form", hostname: from });
    return { host: from };
  }
  return { refused: "a statement's from is a mind's id, with its hostname as fromHost" };
}

/** A rule's payload: at most 20 context paths, each by its own canonical path; `/` is every
 *  context. An empty `append` ends the meld. `name`: the hostname that the member saw, where the
 *  mind's log is read. `key`: the one key id that counts. */
const MeldRule = z.strictObject({
  append: z
    .array(
      z
        .string()
        .refine(
          (path) => path === "/" || canonicalPath(path.replace(/\/+$/, "")),
          "a context path",
        ),
    )
    .max(20),
  name: z.string().refine(isMindControlPlaneHostname, "a mind's control-plane hostname"),
  key: z.string().min(1).optional(),
});

/** A MELD RULE AS THIS MIND WOULD TAKE IT, or why it refuses it: the one check of both the press
 *  (`configuredMeld`) and the sign page's words (./statement-drafts.ts), so that the page never
 *  explains a rule that the press then refuses. `path` is the statement's, `/minds/<id>`; `own`
 *  is this mind's config. */
export function meldRuleOf(
  path: string,
  payload: unknown,
  own: Pick<MindConfig, "mindId" | "controlPlaneHostname">,
): { mind: string; name: string; append: string[]; key?: string } | { refused: string } {
  const mind = path.slice("/minds/".length);
  if (!path.startsWith("/minds/") || !isMindId(mind))
    return { refused: "a mind meld is set on /minds/<id>, for another mind's id" };
  const rule = MeldRule.safeParse(payload);
  if (!rule.success)
    return {
      refused: "a mind meld's payload is { append: [at most 20 context paths], name, key? }",
    };
  if (mind === own.mindId || rule.data.name === own.controlPlaneHostname)
    return { refused: "a mind does not meld with itself" };
  return { mind, ...rule.data };
}

/** THE RULE A MEMBER SIGNED, written as the `mind_melds` row at its `name`, or why it is refused
 *  (`meldRuleOf`). A rule older than a row it would change is refused, and nothing is written: an
 *  old rule sent again, or one that a newer rule passed, says so and is no fact (./statements.ts).
 *  The row of the same id at another hostname goes only with this rule's own write, in one batch:
 *  the mind moved, and one id has one row; the id's kept log state goes with it. An end changes
 *  the row at its `name` alone. */
export async function configuredMeld(
  env: Env,
  signed: {
    path: string;
    payload: unknown;
    at: number;
    by: string;
    own: Pick<MindConfig, "mindId" | "controlPlaneHostname">;
  },
): Promise<{ mind: string; append: string[] } | { refused: string }> {
  const rule = meldRuleOf(signed.path, signed.payload, signed.own);
  if ("refused" in rule) return rule;
  const { mind, name, append, key } = rule;
  if (append.length === 0) {
    // AN END ends the row at `name` alone, the row that the member saw (one by hostname has no id
    // yet), and moves nothing: a row of the same id at another hostname stays as it is
    // with no row there it writes one with no id, so that an older rule that comes later is refused
    const ended = await env.DB.prepare(
      `insert into mind_melds (domain, append, configured_at, configured_by) values (?1, '[]', ?3, ?4)
       on conflict (domain) do update set append = '[]', key = null,
         configured_at = excluded.configured_at, configured_by = excluded.configured_by, refused = null
        where (mind_melds.mind is null or mind_melds.mind = ?2)
          and mind_melds.configured_at <= excluded.configured_at`,
    )
      .bind(name, mind, signed.at, signed.by)
      .run();
    if (!ended.meta.changes)
      return {
        refused: `a newer rule at ${name}, or a rule there for another mind, is in force here`,
      };
    console.info({ event: "auth.mind-meld-configured", mind, domain: name, append });
    return { mind, append };
  }
  // the log state kept for the id goes with it to its new hostname: it belongs to the id
  const moving = await env.DB.prepare(
    `select state from mind_melds where mind = ?1 and domain != ?2 and state is not null`,
  )
    .bind(mind, name)
    .first<{ state: string }>();
  const [, written] = await env.DB.batch([
    // the id's row at another hostname, when it is no newer, and the row at `name` is no newer
    env.DB.prepare(
      `delete from mind_melds where mind = ?1 and domain != ?2 and configured_at <= ?3
        and not exists (select 1 from mind_melds here where here.domain = ?2 and here.configured_at > ?3)`,
    ).bind(mind, name, signed.at),
    env.DB.prepare(
      `insert into mind_melds (domain, mind, append, key, configured_at, configured_by, state)
       select ?1, ?2, ?3, ?4, ?5, ?6, ?7
        where not exists (select 1 from mind_melds other where other.mind = ?2 and other.domain != ?1)
       on conflict (domain) do update set mind = excluded.mind, append = excluded.append,
         key = excluded.key, configured_at = excluded.configured_at,
         configured_by = excluded.configured_by, refused = null, pinned_at = null,
         state = case when mind_melds.mind = excluded.mind then mind_melds.state else excluded.state end
       where excluded.configured_at >= mind_melds.configured_at`,
    ).bind(
      name,
      mind,
      JSON.stringify(append),
      key || null,
      signed.at,
      signed.by,
      moving?.state || null,
    ),
  ]);
  if (!written?.meta.changes)
    return { refused: "a newer rule for this mind, or for this hostname, is in force here" };
  console.info({ event: "auth.mind-meld-configured", mind, domain: name, append });
  return { mind, append };
}
