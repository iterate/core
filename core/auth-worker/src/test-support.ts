// test-support.ts — THE WORKER'S VARIABLES FOR A TEST: the config of a mind at
// `iterate.example.com` whose one zone is `example.com` and whose one owner is
// `owner@example.net`, with `config` over it, the team and the application of Cloudflare Access,
// and a signing key.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { MindConfig } from "iterate/mind-config";
import { identityKeyIdOf } from "iterate/mind-identity";
import { base64url, keyIdOf } from "iterate/signed";
import type { Env } from "./env.ts";

export const configVars = (config: Partial<MindConfig> = {}) => ({
  ITERATE: JSON.stringify({
    mindId: "a".repeat(64),
    controlPlaneHostname: "iterate.example.com",
    zones: ["example.com"],
    ownerEmails: ["owner@example.net"],
    topology: "full-cloudflare",
    cloudflareAccessTeamDomain: "team.cloudflareaccess.com",
    cloudflareAccessAudienceTag: "the-audience-tag-of-the-owners-application",
    ...config,
  }),
  ITERATE__SIGNING_KEY: "a signing key for a test, never a real one",
});

/** A STACK'S KEY FOR A TEST: an ML-DSA-65 key pair as ./stack-key.ts keeps it. `row` is its
 *  `stack_key` row, `privateKey` signs as a stack that holds it, `entry` is the working key as an
 *  identity record lists it. */
export async function stackKeyPair(label = "stack") {
  // the casts: TypeScript's library knows neither the algorithm by name nor the two raw formats
  const pair = (await crypto.subtle.generateKey({ name: "ML-DSA-65" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = async (format: string, key: CryptoKey) =>
    base64url(new Uint8Array((await crypto.subtle.exportKey(format as "raw", key)) as ArrayBuffer));
  const publicKey = await exported("raw-public", pair.publicKey);
  const key = await identityKeyIdOf(publicKey);
  return {
    key,
    publicKey,
    privateKey: pair.privateKey,
    row: { key, public_key: publicKey, seed: await exported("raw-seed", pair.privateKey) },
    entry: {
      signs: "raw",
      algorithm: "ML-DSA-65",
      publicKey,
      label,
      purpose: "statements",
    } as const,
  };
}

/** THE `keys` ROWS THAT A STATEMENT'S CHECK READS (./keys.ts `knownKey`, whose query is the one
 *  `from keys k left join users u`), for keys a test holds: a person's, with `email` and the
 *  person's id as `actor`, or a service's, with `paths`. Answers the row of the key with an id, or
 *  null. */
export async function keyRows(
  keys: {
    actor: string;
    email?: string;
    publicKey: string;
    label: string;
    paths?: string[];
  }[],
) {
  const rows = new Map(
    await Promise.all(
      keys.map(
        async (key) =>
          [
            await keyIdOf(key.publicKey),
            {
              public_key: key.publicKey,
              format: "p256",
              label: key.label,
              actor: key.email ? null : key.actor,
              paths: key.paths ? JSON.stringify(key.paths) : null,
              provide: null,
              user_id: key.email ? key.actor : null,
              email: key.email || null,
            },
          ] as const,
      ),
    ),
  );
  return (id: unknown) => rows.get(String(id)) || null;
}

/** A STACK ON SQLITE IN MEMORY, made by the Worker's own migrations, so that the Worker's SQL
 *  runs as written: D1, a KV for the pages' challenges and the OAuth library's store, and a mail
 *  binding that keeps what it was given in `mailed`. `config` goes over `configVars`' mind. */
export function sqliteStack(config: Partial<MindConfig> = {}) {
  const db = new DatabaseSync(":memory:");
  const folder = new URL("../migrations/", import.meta.url).pathname;
  for (const name of readdirSync(folder).sort()) db.exec(readFileSync(`${folder}${name}`, "utf8"));
  const statementOf = (sql: string, bound: SQLInputValue[] = []) => {
    const execute = () => {
      const prepared = db.prepare(sql);
      if (prepared.columns().length) return { results: prepared.all(...bound), meta: {} };
      return { results: [], meta: { changes: Number(prepared.run(...bound).changes) } };
    };
    return {
      bind: (...values: SQLInputValue[]) => statementOf(sql, values),
      first: async () => execute().results[0] ?? null,
      all: async () => execute(),
      run: async () => execute(),
      execute,
    };
  };
  const kv = new Map<string, string>();
  const mailed: {
    from: { email: string; name: string };
    to: string[];
    subject: string;
    text: string;
  }[] = [];
  const bindings = {
    DB: {
      prepare: (sql: string) => statementOf(sql),
      batch: async (statements: ReturnType<typeof statementOf>[]) =>
        statements.map((statement) => statement.execute()),
    },
    // what the pages and the OAuth library call of KV
    OAUTH_KV: {
      get: async (key: string, type?: unknown) => {
        const kept = kv.get(key) ?? null;
        const json = type === "json" || (type as { type?: string } | undefined)?.type === "json";
        return kept && json ? JSON.parse(kept) : kept;
      },
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
      list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
        keys: [...kv.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
    },
    SEND_EMAIL: {
      send: async (message: (typeof mailed)[number]) => {
        mailed.push(message);
        return { messageId: `message-${mailed.length}` };
      },
    },
  };
  /** The Worker's `env` with `config` over the stack's own: the same database after a deploy
   *  that changed the config. */
  const envOf = (over: Partial<MindConfig> = {}) =>
    // the cast: of D1, KV and mail, the Worker calls only these members
    ({ ...configVars({ ...config, ...over }), ...bindings }) as unknown as Env;
  return { env: envOf(), envOf, db, mailed };
}
