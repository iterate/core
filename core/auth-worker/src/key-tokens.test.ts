import { mindApiUrlOf, mindMcpUrlOf } from "iterate/mind-api";
import {
  base64url,
  KEY_TOKEN_STATEMENT_TYPE,
  keyIdOf,
  signedP256,
  statementText,
} from "iterate/signed";
import { expect, test } from "vitest";
import type { Env } from "./env.ts";
import { keyTokenIdentity, keyTokenResponse } from "./key-tokens.ts";

const DOMAIN = "example.com";
const API = mindApiUrlOf(DOMAIN);

test("a key a member allowed to lend gets a token for the API, for an hour, as no member", async () => {
  const { env, bridge, rows } = await stack();
  const answer = await asked(env, await bridge.ask());
  expect(answer).toMatchObject({
    status: 200,
    body: { token_type: "Bearer", expires_in: 3600, provide: "whatsapp.jonas" },
  });
  expect(rows.get(bridge.key)).toMatchObject({ last_used_at: expect.any(Number) });
  const token = String(answer.body.access_token);
  expect(await keyTokenIdentity(env, token, API)).toEqual({
    principal: { actor: "bridge-whatsapp-jonas" },
    grant: `key:${bridge.key}`,
    expiresAt: expect.any(Number),
    member: false,
    provide: "whatsapp.jonas",
  });
  // for the API alone: the MCP server, a hostname and `/provide` never take it
  expect(await keyTokenIdentity(env, token, mindMcpUrlOf(DOMAIN))).toBeNull();
  expect(await keyTokenIdentity(env, token, `https://${DOMAIN}`)).toBeNull();
});

test("a removed key gets no token, and its live token is nobody's from then on", async () => {
  const { env, bridge, rows } = await stack();
  const { body } = await asked(env, await bridge.ask());
  rows.get(bridge.key)!.revoked_at = Date.now();
  expect(await keyTokenIdentity(env, String(body.access_token), API)).toBeNull();
  expect(await asked(env, await bridge.ask())).toMatchObject({
    status: 401,
    body: { error: "invalid_client" },
  });
});

test("a key allowed again for another name ends the tokens of the old name", async () => {
  const { env, bridge, rows } = await stack();
  const { body } = await asked(env, await bridge.ask());
  rows.get(bridge.key)!.provide = "herdr";
  expect(await keyTokenIdentity(env, String(body.access_token), API)).toBeNull();
});

test("a token may be asked for less than the hour, a minute at least, and never for more", async () => {
  const { env, bridge } = await stack();
  const life = async (seconds: unknown) =>
    (await asked(env, await bridge.ask({ payload: { seconds } }))).body.expires_in;
  expect([await life(120), await life(5), await life(86_400), await life("soon")]).toEqual([
    120, 60, 3600, 3600,
  ]);
});

test.for([
  ["a key the mind does not know", { by: "stranger" }, 401, "invalid_client"],
  ["a key that only adds events", { by: "events" }, 400, "invalid_scope"],
  [
    "a statement of another type",
    { by: "bridge", type: "events.iterate.com/x/said" },
    400,
    "invalid_grant",
  ],
  ["a statement at another path", { by: "bridge", path: "/integrations/x" }, 400, "invalid_grant"],
  ["a statement that ends in an hour", { by: "bridge", life: 3_600_000 }, 400, "invalid_grant"],
  ["a statement for another mind", { by: "bridge", mind: "example.net" }, 400, "invalid_grant"],
] as const)("%s gets no token", async ([, { by, ...change }, status, error]) => {
  const signers = await stack();
  const envelope = await signers[by].ask(change);
  expect(await asked(signers.env, envelope)).toMatchObject({ status, body: { error } });
});

test("a statement gets one token: sent again, it gets none", async () => {
  const { env, bridge } = await stack();
  const statement = await bridge.ask();
  expect(await asked(env, statement)).toMatchObject({ status: 200 });
  expect(await asked(env, statement)).toMatchObject({
    status: 400,
    body: { error: "invalid_grant", error_description: "the statement was seen before" },
  });
});

async function asked(env: Env, envelope: unknown) {
  const answer = await keyTokenResponse(
    env,
    new Request("https://iterate.example.com/keys/token", {
      method: "POST",
      body: JSON.stringify(envelope),
    }),
  );
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
}

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

async function keyPair() {
  const pair = (await crypto.subtle.generateKey(P256, true, ["sign", "verify"])) as CryptoKeyPair;
  const exported = async (format: "spki" | "pkcs8", key: CryptoKey) =>
    base64url(new Uint8Array((await crypto.subtle.exportKey(format, key)) as ArrayBuffer));
  const publicKey = await exported("spki", pair.publicKey);
  const key = await keyIdOf(publicKey);
  return {
    key,
    publicKey,
    pkcs8: await exported("pkcs8", pair.privateKey),
    /** A token request as `iterate provide --key` signs it, with one part changed. */
    ask: (
      change: {
        type?: string;
        path?: string;
        mind?: string;
        life?: number;
        payload?: Record<string, unknown>;
      } = {},
    ) => {
      const at = Date.now();
      return signedP256(
        statementText({
          mind: change.mind || DOMAIN,
          path: change.path || "/",
          type: change.type || KEY_TOKEN_STATEMENT_TYPE,
          payload: change.payload,
          at,
          expires: at + (change.life || 60_000),
        }),
        pair.privateKey,
        key,
      );
    },
  };
}

/** A stack with two keys a member allowed: one lends `itx.whatsapp.jonas`, one only adds events. */
async function stack() {
  const [own, bridge, events, stranger] = await Promise.all([
    keyPair(),
    keyPair(),
    keyPair(),
    keyPair(),
  ]);
  type Row = {
    public_key: string;
    format: string;
    label: string;
    actor: string;
    paths: string;
    provide: string | null;
    user_id: null;
    email: null;
    last_used_at: number | null;
    revoked_at: number | null;
  };
  const row = (publicKey: string, provide: string | null, paths: string[]): Row => ({
    public_key: publicKey,
    format: "p256",
    label: "a bridge",
    actor: "bridge-whatsapp-jonas",
    paths: JSON.stringify(paths),
    provide,
    user_id: null,
    email: null,
    last_used_at: null,
    revoked_at: null,
  });
  const rows = new Map([
    [bridge.key, row(bridge.publicKey, "whatsapp.jonas", [])],
    [events.key, row(events.publicKey, null, ["/integrations/x/"])],
  ]);
  const seen = new Set<unknown>();
  // the statements this module and ./keys.ts run, and nothing else of D1
  const prepare = (sql: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async () => {
      if (sql.includes("from stack_key"))
        return { key: own.key, public_key: own.publicKey, private_key: own.pkcs8 };
      const kept = rows.get(String(bound[0]));
      const live = kept && !kept.revoked_at ? kept : null;
      if (sql.includes("from keys k left join users")) return live;
      if (sql.startsWith("select 1 from keys where id = ?1 and actor = ?2 and provide = ?3"))
        return live && live.actor === bound[1] && live.provide === bound[2] ? { 1: 1 } : null;
      throw new Error(`not expected: ${sql}`);
    },
    run: async () => {
      if (!sql.startsWith("update keys set last_used_at")) throw new Error(`not expected: ${sql}`);
      rows.get(String(bound[1]))!.last_used_at = Number(bound[0]);
    },
    counted: () => {
      if (sql.startsWith("delete from statements")) return { meta: { changes: 0 } };
      if (!sql.startsWith("insert into statements")) throw new Error(`not expected: ${sql}`);
      const fresh = !seen.has(bound[0]);
      seen.add(bound[0]);
      return { meta: { changes: fresh ? 1 : 0 } };
    },
  });
  const env = {
    DOMAIN,
    AUTH_SETTINGS: JSON.stringify({
      login: { methods: { email: {} }, allow: [{ email: "owner@example.net" }] },
    }),
    AUTH_SIGNING_KEY: "a signing key for a test, never a real one",
    DB: {
      prepare,
      batch: async (statements: ReturnType<typeof prepare>[]) =>
        statements.map((statement) => statement.counted()),
    },
  } as unknown as Env;
  return { env, bridge, events, stranger, rows };
}
