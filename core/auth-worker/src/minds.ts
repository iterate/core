// minds.ts — ANOTHER MIND AS A SIGNER: a mind that this mind lets in adds events here with a
// statement that names it as `from`, signed with the ML-DSA-65 working key that its identity log
// lists, read at its own domain (iterate/mind-identity-log `publishedMindOf`). The rule that lets
// it in is a member's `events.iterate.com/mind-meld/configured` on `/minds/<domain>`
// (./statements.ts), and the `mind_melds` row is its copy. No key is exchanged: the rule names the domain, the domain's
// log names the key.
import { identityKeyIdOf } from "iterate/mind-identity";
import { publishedMindOf } from "iterate/mind-identity-log";
import { type Envelope, isMindControlPlaneHostname, statementOf } from "iterate/signed";
import { z } from "zod";
import type { Env } from "./env.ts";
import { canonicalPath } from "./key-rules.ts";
import type { KnownKey } from "./keys.ts";
import { stackKeyIsListed } from "./stack-key.ts";

/** THE MIND THAT A STATEMENT NAMES AS ITS SIGNER, as its own log proves the mind: null when the
 *  statement names no mind as `from`; else the mind id that the log at `from` proves
 *  (iterate/mind-identity-log `publishedMindOf`), that hostname, and the working key for
 *  statements that the log lists under the signature's key id, as a key this Worker checks a
 *  statement with.
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
): Promise<{ mind: string; hostname: string; key: KnownKey } | { refused: string } | null> {
  const from = fromOf(envelope);
  if (!from) return null;
  if (!(await stackKeyIsListed(env))) return NOT_LISTED;
  const published = await publishedMindOf(from, (request) => fetch(request));
  // `from` is unverified here: 80 characters of it, as in the log line; a `why` names a hostname
  if ("why" in published) return { refused: `${from.slice(0, 80)} gave no keys: ${published.why}` };
  // A key's id is the hash of its public key, computed here: the log lists no id of its own.
  for (const key of published.current.workingKeys) {
    if (key.purpose !== "statements") continue;
    if ((await identityKeyIdOf(key.publicKey)) !== envelope.signature.key) continue;
    return {
      mind: published.expected,
      hostname: from,
      key: {
        principal: { actor: from, kind: "mind" },
        publicKey: key.publicKey,
        label: key.label,
        // the schema of a working key lists this algorithm alone (iterate/mind-identity)
        format: key.algorithm,
      },
    };
  }
  return { refused: `${from} lists no such working key` };
}

/** The key of the mind a statement names as `from`, with the rule's `append` as its paths; null
 *  when the statement names no mind; or why it does not sign here. The rule is read first, so
 *  nothing is fetched for a mind that is not let in: a stranger must not make this Worker ask a
 *  host. */
export async function mindKeyOf(
  env: Env,
  envelope: Envelope,
): Promise<KnownKey | { refused: string } | null> {
  const from = fromOf(envelope);
  if (!from) return null;
  if (!(await stackKeyIsListed(env))) return NOT_LISTED;
  const rule = await env.DB.prepare(
    `select append, key from mind_melds where domain = ?1 and append != '[]'`,
  )
    .bind(from)
    .first<{ append: string; key: string | null }>();
  if (!rule) return { refused: `${from} is not let in here` };
  if (rule.key && rule.key !== envelope.signature.key)
    return { refused: "the rule names another key" };
  const signer = await mindSignerOf(env, envelope);
  if (!signer || "refused" in signer) return signer;
  return { ...signer.key, paths: z.array(z.string()).parse(JSON.parse(rule.append)) };
}

const NOT_LISTED = {
  refused:
    "this mind's identity lists no working key of its stack yet, so it takes no statement from another mind",
};

/** The mind a statement names as `from`, read before the signature checks, only to know whose
 *  published keys to check it with. */
function fromOf(envelope: Envelope) {
  const statement = statementOf(envelope.statement);
  return "refused" in statement ? undefined : statement.from;
}

/** A rule's payload: at most 20 context paths, each by its own canonical path; `/` is every
 *  context. An empty `append` ends the meld. `key`: the one key id that counts. */
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
  key: z.string().min(1).optional(),
});

/** THE RULE A MEMBER SIGNED, written as the `mind_melds` row, or why it is refused. `path` is the
 *  statement's, `/minds/<domain>`; `own` is this mind's domain. A rule older than the row's is
 *  not taken, so an old rule sent again changes nothing. */
export async function configuredMeld(
  env: Env,
  rule: { path: string; payload: unknown; at: number; by: string; own: string },
): Promise<{ domain: string; append: string[] } | { refused: string }> {
  const domain = rule.path.slice("/minds/".length);
  if (
    !rule.path.startsWith("/minds/") ||
    !isMindControlPlaneHostname(domain) ||
    domain === rule.own
  )
    return { refused: "a mind meld is set on /minds/<domain>, for another mind's domain" };
  const payload = MeldRule.safeParse(rule.payload);
  if (!payload.success)
    return { refused: "a mind meld's payload is { append: [at most 20 context paths], key? }" };
  const { append, key } = payload.data;
  await env.DB.prepare(
    `insert into mind_melds (domain, append, key, configured_at, configured_by)
     values (?1, ?2, ?3, ?4, ?5)
     on conflict (domain) do update set append = excluded.append, key = excluded.key,
       configured_at = excluded.configured_at, configured_by = excluded.configured_by
     where excluded.configured_at >= mind_melds.configured_at`,
  )
    .bind(domain, JSON.stringify(append), key || null, rule.at, rule.by)
    .run();
  console.info({ event: "auth.mind-meld-configured", domain, append });
  return { domain, append };
}
