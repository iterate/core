// /minds and /minds/published: a member's page of the minds this mind lets in. The two presses,
// "End" and "Let it in", are a browser's passkey and are proven on a deployed mind, not here.
import { identityHashOf } from "iterate/mind-identity";
import { expect, test, vi } from "vitest";
import { newIdentityLog, newRootKey } from "../../lib/src/test-support/identity-log.ts";
import { browserSessionsFake } from "./browser-sessions-fake.ts";
import { sessionCookie } from "./cookies.ts";
import type { Env } from "./env.ts";
import { configVars } from "./test-support.ts";
import { mindsPageResponse } from "./minds-page.ts";

const MIND = "iterate.example.com";
const ISSUER = `https://${MIND}`;
const OWNER = { id: "user_owner", email: "owner@example.net" };
const ADA = { id: "user_ada", email: "ada@example.org" };
const AT = Date.UTC(2026, 10, 17, 9, 30);

test("signed out leads to the sign-in and back, and a person who is no member is refused", async () => {
  const { env } = stackOf([]);
  const signedOut = (await mindsPageResponse(env, new Request(`${ISSUER}/minds`)))!;
  expect(signedOut.headers.get("location")).toBe("/sign-in?next=%2Fminds");
  const ada = await signedIn(env, ADA);
  const refused = (await mindsPageResponse(env, get("/minds", ada)))!;
  expect(refused).toMatchObject({ status: 403 });
  expect(await refused.text()).toContain("is not a member of");
  expect(await mindsPageResponse(env, new Request(`${ISSUER}/keys`))).toBeNull();
});

test("an empty list says what a meld is", async () => {
  const { env } = stackOf([]);
  const owner = await signedIn(env, OWNER);
  const body = await (await mindsPageResponse(env, get("/minds", owner)))!.text();
  expect(body).toContain("No mind is let in. A meld lets another mind add events to this one");
  expect(body).not.toContain("Melds that ended");
  expect(body).toContain("Let a mind in");
});

test("a meld is listed with its paths, its key and who let it in; an ended meld has no button", async () => {
  const { env } = stackOf([
    {
      domain: "peer-one.net",
      append: JSON.stringify(["/minds/peer-one.net/", "/notes/<b>/"]),
      key: null,
      configured_at: AT,
      email: OWNER.email,
    },
    {
      domain: "peer-two.net",
      append: JSON.stringify(["/minds/peer-two.net/"]),
      key: "pinnedkeyid-of-a-test",
      configured_at: AT,
      email: OWNER.email,
    },
    { domain: "peer-old.net", append: "[]", key: null, configured_at: AT, email: OWNER.email },
  ]);
  const owner = await signedIn(env, OWNER);
  const body = await (await mindsPageResponse(env, get("/minds", owner)))!.text();
  expect(body).toContain("<code>/minds/peer-one.net/</code>, <code>/notes/&#60;b&#62;/</code>");
  expect(body).toContain("signed with its published keys");
  expect(body).toContain("signed with the key pinnedke.");
  expect(body).toContain(`${OWNER.email} let it in at 2026-11-17 09:30 UTC`);
  expect(body).toContain(`data-end="peer-one.net"`);
  expect(body).toContain("Melds that ended");
  expect(body).toContain("peer-old.net <span");
  expect(body).not.toContain(`data-end="peer-old.net"`);
});

test("/minds/published answers a member the id and the working keys that a mind's identity log lists, and anyone else nothing", async () => {
  const { env } = stackOf([]);
  const log = await newIdentityLog(["peer-three.net"]);
  const workingKey = await newRootKey("stack");
  // a key of another purpose signs no statement, so the page does not show it
  const otherKey = await newRootKey("for another use");
  const second = await log.next(log.genesis, {
    workingKeys: [
      { ...otherKey.entry, purpose: "nostr" },
      { ...workingKey.entry, purpose: "statements" },
    ],
  });
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    fetched.push(request.url);
    return Response.json({
      version: 1,
      mind: log.mind,
      head: await identityHashOf(second.record),
      records: [log.genesis, second],
    });
  });
  const owner = await signedIn(env, OWNER);
  const answer = (await mindsPageResponse(
    env,
    get("/minds/published?domain=peer-three.net", owner),
  ))!;
  expect(await answer.json()).toEqual({
    mind: log.mind,
    keys: [{ key: workingKey.id, label: "stack" }],
  });
  expect(fetched).toEqual(["https://peer-three.net/.well-known/iterate"]);

  const own = await mindsPageResponse(env, get(`/minds/published?domain=${MIND}`, owner));
  expect(own).toMatchObject({ status: 400 });

  const ada = await signedIn(env, ADA);
  expect(
    await mindsPageResponse(env, get("/minds/published?domain=peer-three.net", ada)),
  ).toMatchObject({ status: 403 });
  expect(
    await mindsPageResponse(env, new Request(`${ISSUER}/minds/published?domain=x.net`)),
  ).toMatchObject({ status: 403 });
  expect(fetched).toHaveLength(1);
});

const get = (path: string, cookie: string) =>
  new Request(`${ISSUER}${path}`, { headers: { cookie } });

async function signedIn(env: Env, user: { id: string; email: string }) {
  const { setCookie } = await sessionCookie(env, new Request(ISSUER), user, "key-1");
  return setCookie.split(";")[0]!;
}

/** The owner is the config's member and holds the passkey "key-1"; Ada is no member. `melds` are
 *  the rows the page's one query answers. */
function stackOf(melds: unknown[]) {
  const sessions = browserSessionsFake();
  const prepare = (sql: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async () => {
      const session = sessions.statementOf(sql, bound);
      if (session) return session.first();
      if (sql.includes("from members") || sql.includes("from blocked")) return null;
      throw new Error(`not expected: ${sql}`);
    },
    all: async () => {
      if (sql.includes("from mind_melds")) return { results: melds };
      throw new Error(`not expected: ${sql}`);
    },
    run: async () => sessions.statementOf(sql, bound)!.results(),
    results: () => sessions.statementOf(sql, bound)!.results(),
  });
  const env = {
    ...configVars({ ownerEmails: [OWNER.email] }),
    DB: {
      prepare,
      batch: async (statements: ReturnType<typeof prepare>[]) =>
        statements.map((statement) => statement.results()),
    },
    // the cast: the page reads these bindings and no other
  } as unknown as Env;
  return { env };
}
