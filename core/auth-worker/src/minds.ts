// minds.ts — ANOTHER MIND AS A SIGNER: a mind that this mind lets in adds events here with a
// statement that names it as `from`, signed with a key it publishes at its own domain
// (iterate/signed `publishedMindOf`). The rule that lets it in is a member's
// `events.iterate.com/mind-meld/configured` on `/minds/<domain>` (./statements.ts), and the
// `mind_melds` row is its copy. No key is exchanged: the rule names the domain, the domain names
// the key.
import { type Envelope, isMindDomain, keyIdOf, publishedMindOf, statementOf } from "iterate/signed";
import { z } from "zod";
import type { Env } from "./env.ts";
import { canonicalPath } from "./key-rules.ts";
import type { KnownKey } from "./keys.ts";

/** The key of the mind a statement names as `from`, with the rule's `append` as its paths; null
 *  when the statement names no mind; or why it does not sign here. Nothing is fetched for a mind
 *  that is not let in: a stranger must not make this Worker ask a host. */
export async function mindKeyOf(
  env: Env,
  envelope: Envelope,
): Promise<KnownKey | { refused: string } | null> {
  // read before the signature checks, only to know whose published keys to check it with
  const statement = statementOf(envelope.statement);
  const from = "refused" in statement ? undefined : statement.from;
  if (!from) return null;
  const rule = await env.DB.prepare(
    `select append, key from mind_melds where domain = ?1 and append != '[]'`,
  )
    .bind(from)
    .first<{ append: string; key: string | null }>();
  if (!rule) return { refused: `${from} is not let in here` };
  if (rule.key && rule.key !== envelope.signature.key)
    return { refused: "the rule names another key" };
  const published = await publishedMindOf(from, (request) => fetch(request));
  if ("why" in published) return { refused: `${from} gave no keys: ${published.why}` };
  const key = published.keys.find(({ key }) => key === envelope.signature.key);
  if (!key) return { refused: `${from} publishes no such key` };
  // A key's id is the hash of its public key. Without this check a document could publish another
  // public key under the id that a rule pins.
  if ((await keyIdOf(key.publicKey)) !== key.key)
    return { refused: `${from} publishes a key under an id that is not its own` };
  return {
    principal: { actor: from, kind: "mind" },
    publicKey: key.publicKey,
    label: key.label,
    format: "p256",
    paths: z.array(z.string()).parse(JSON.parse(rule.append)),
  };
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
  if (!rule.path.startsWith("/minds/") || !isMindDomain(domain) || domain === rule.own)
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
