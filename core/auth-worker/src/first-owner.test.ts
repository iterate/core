import { expect, test } from "vitest";
import { FIRST_OWNER_PATH } from "./config.ts";
import { browserSessionsFake } from "./browser-sessions-fake.ts";
import { sessionOf } from "./cookies.ts";
import { sha256Hex } from "./device/protocol.ts";
import type { Env } from "./env.ts";
import { firstOwnerResponse } from "./first-owner.ts";

const DOMAIN = "example.net";
const ISSUER = `https://iterate.${DOMAIN}`;

test.for([
  { ticket: "the-owners-ticket", email: "owner@example.org", method: "first-owner-ticket" },
  { ticket: "a-members-link", email: "member@example.org", method: "member-link" },
])(
  "a session that $ticket opens says so in its method: $method",
  async ({ ticket, email, method }) => {
    const env = await stack();
    const answer = await firstOwnerResponse(
      env,
      new Request(`${ISSUER}${FIRST_OWNER_PATH}`, {
        method: "POST",
        headers: { origin: ISSUER, "content-type": "application/json" },
        body: JSON.stringify({ ticket }),
      }),
    );
    const cookie = answer.headers.get("set-cookie")?.split(";")[0] || "";
    const session = await sessionOf(env, new Request(ISSUER, { headers: { cookie } }));
    expect({ status: answer.status, session }).toMatchObject({
      status: 200,
      session: { email, method },
    });
  },
);

/** A stack whose owner holds a deploy's ticket, and whose one other member holds an owner's link. */
async function stack(): Promise<Env> {
  const linkHash = await sha256Hex("a-members-link");
  const sessions = browserSessionsFake();
  const prepare = (sql: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async () => {
      const session = sessions.statementOf(sql, bound);
      if (session) return session.first();
      if (sql.startsWith("update member_tickets"))
        return bound[0] === linkHash ? { email: "member@example.org" } : null;
      if (sql.startsWith("select 1 from member_tickets")) return null;
      // no one holds a passkey yet
      if (sql.includes("format = 'webauthn'")) return null;
      if (sql.startsWith("insert into spent_tickets")) return { hash: bound[0] };
      throw new Error(`not expected: ${sql}`);
    },
    // `linkIdentity`'s three statements: the last one reads the user the first two made
    results: () =>
      sessions.statementOf(sql, bound)?.results() ??
      (sql.trimStart().startsWith("select u.id")
        ? { results: [{ id: `user_${String(bound[1]).split("@")[0]}`, email: bound[1] }] }
        : { results: [] }),
  });
  return {
    DOMAIN,
    AUTH_SIGNING_KEY: "a-signing-key-for-tests-only",
    AUTH_SETTINGS: JSON.stringify({
      login: { allow: [{ email: "owner@example.org" }, { email: "member@example.org" }] },
    }),
    FIRST_OWNER_TICKET: JSON.stringify({
      email: "owner@example.org",
      hash: await sha256Hex("the-owners-ticket"),
      expires: Date.now() + 3_600_000,
    }),
    DB: {
      prepare,
      batch: async (statements: ReturnType<typeof prepare>[]) =>
        statements.map((statement) => statement.results()),
    },
    // the cast: the ticket's sign-in reads these bindings and no other
  } as unknown as Env;
}
