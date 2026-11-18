import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { deployedMind, mindConfigIn } from "./deploy.ts";
import { newTicket, recoveryStatements } from "./recover.ts";

test("a ticket is 32 random bytes, and what goes into the database is its SHA-256 in hex", () => {
  const { ticket, hash } = newTicket();
  expect(Buffer.from(ticket, "base64url")).toHaveLength(32);
  expect(hash).toBe(createHash("sha256").update(ticket).digest("hex"));
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(newTicket()).not.toMatchObject({ ticket });
});

test("the two statements revoke the owner's live passkeys alone, and add the link's row as the auth Worker reads it", () => {
  // the auth Worker's own tables, by its migrations
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../../../auth-worker/migrations/", import.meta.url).pathname;
  for (const name of readdirSync(migrations).sort())
    db.exec(readFileSync(`${migrations}${name}`, "utf8"));
  db.exec(`
    insert into users (id, email) values
      ('user_owner', 'owner@example.net'), ('user_other', 'other@example.net');
    insert into keys (id, user_id, actor, paths, public_key, format, credential_id, label, added_via, added_by, added_at, revoked_at) values
      ('live', 'user_owner', null, null, 'k1', 'webauthn', 'c1', 'Laptop', 'keys-page', 'user_owner', 1, null),
      ('gone-before', 'user_owner', null, null, 'k2', 'webauthn', 'c2', 'Phone', 'keys-page', 'user_owner', 1, 5),
      ('another-persons', 'user_other', null, null, 'k3', 'webauthn', 'c3', 'Laptop', 'keys-page', 'user_other', 1, null),
      ('a-services', null, 'a-service', '[]', 'k4', 'p256', null, 'Service', 'enrol-page', 'user_owner', 1, null);
  `);
  const at = 1_800_000_000_000;
  const statements = recoveryStatements({
    owner: "owner@example.net",
    ticketHash: "the-hash",
    at,
  });
  expect(statements).toHaveLength(2);
  for (const { sql, params } of statements) db.prepare(sql).run(...params);

  expect(db.prepare("select id, revoked_at from keys order by id").all()).toEqual([
    { id: "a-services", revoked_at: null },
    { id: "another-persons", revoked_at: null },
    { id: "gone-before", revoked_at: 5 },
    { id: "live", revoked_at: at },
  ]);
  // `made_by` is the auth Worker's word for this command's link (enrolment.ts RECOVERY_COMMAND)
  expect(db.prepare("select * from member_tickets").all()).toEqual([
    {
      hash: "the-hash",
      email: "owner@example.net",
      made_by: "recovery-command",
      expires_at: at + 24 * 3600_000,
      spent_at: null,
    },
  ]);
  expect(
    readFileSync(new URL("../../../auth-worker/src/enrolment.ts", import.meta.url), "utf8"),
  ).toContain('export const RECOVERY_COMMAND = "recovery-command";');
});

test("the reader that recovery uses refuses a config whose control-plane hostname is outside its zones: no sign-in link goes to a host that is not the mind's", async () => {
  const asked: string[] = [];
  const settingsWith = (config: object) =>
    (async (method: string, path: string) => {
      asked.push(`${method} ${path}`);
      return {
        status: 200,
        result: {
          bindings: [{ type: "plain_text", name: "ITERATE", text: JSON.stringify(config) }],
        },
      };
    }) as unknown as Parameters<typeof deployedMind>[0];
  const config = {
    controlPlaneHostname: "iterate.ada-labs.com",
    zones: ["ada-labs.com"],
    ownerEmails: ["owner@example.net"],
    topology: "full-cloudflare",
  };
  expect(await deployedMind(settingsWith(config), "account", "ada-labs-com")).toEqual({
    ...config,
    stageName: "ada-labs-com",
  });
  for (const controlPlaneHostname of ["iterate.evil.example", "a.iterate.ada-labs.com"])
    await expect(
      deployedMind(settingsWith({ ...config, controlPlaneHostname }), "account", "ada-labs-com"),
    ).rejects.toThrow(/did not answer with the config of the mind .* Nothing was changed\./);
  // one read of the settings each time, and nothing else
  expect(asked).toEqual(
    Array(3).fill("GET /accounts/account/workers/scripts/iterate-ada-labs-com-boundary/settings"),
  );
});

test("a recovery keeps the mind's identity: it writes no config, its statements leave the identity's rows alone, and it makes no key", () => {
  // The command reads the mind's config and deploys nothing, so the id that the Workers hold
  // stays: of all that deploy.ts has, it takes the reader alone, and nothing of identity.ts.
  const source = readFileSync(new URL("./recover.ts", import.meta.url), "utf8");
  expect(source.match(/^import .* from "\.\/deploy\.ts";$/gm)).toEqual([
    'import { deployedMind } from "./deploy.ts";',
  ]);
  expect(source).not.toContain("identity.ts");
  expect(source).not.toMatch(/writeFile|generateKey/);
  // the reader hands the deployed id on as it is
  const config = {
    mindId: "cd".repeat(32),
    controlPlaneHostname: "ada-labs.com",
    zones: ["ada-labs.com"],
    ownerEmails: ["owner@example.net"],
    topology: "full-cloudflare",
  };
  expect(
    mindConfigIn({
      bindings: [{ type: "plain_text", name: "ITERATE", text: JSON.stringify(config) }],
    })?.mindId,
  ).toBe(config.mindId);

  // The auth Worker's database holds the mind's accepted identity records. The two statements
  // name none of its identity tables, by the names that its migrations give them.
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../../../auth-worker/migrations/", import.meta.url).pathname;
  for (const name of readdirSync(migrations).sort())
    db.exec(readFileSync(`${migrations}${name}`, "utf8"));
  const identityTables = db
    .prepare("select name from sqlite_master where type = 'table' and name like 'identity%'")
    .all()
    .map((table) => String(table.name));
  expect(identityTables).toContain("identity_records");
  const statements = recoveryStatements({
    owner: "owner@example.net",
    ticketHash: "the-hash",
    at: 1_800_000_000_000,
  });
  for (const { sql } of statements)
    for (const table of identityTables) expect(sql).not.toContain(table);
});
