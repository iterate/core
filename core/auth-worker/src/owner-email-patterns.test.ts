// owner-email-patterns.test.ts — WHAT AN OWNER EMAIL PATTERN OPENS, AND WHAT IT DOES NOT
// (iterate/mind-config `isOwnerEmail`): on a mind at example.com with one owner by address, one
// added member, and the pattern `*@company.example`.
import { expect, test, vi } from "vitest";
import { sessionCookie, sessionOf } from "./cookies.ts";
import { enrolmentCookie } from "./enrolment.ts";
import type { Env } from "./env.ts";
import { authResponse } from "./http.ts";
import { isMember, isMemberSession } from "./members.ts";
import { sqliteStack } from "./test-support.ts";
import { userOf } from "./users.ts";

const OWNER = "ada@adas-mail.example";
const ADDED = "bo@bos-mail.example";
const AT_PATTERN = "cy@company.example";
const PATTERNS = ["*@company.example"];
const ISSUER = "https://iterate.example.com";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const NOT_AT_PATTERN = [
  "cy@sub.company.example",
  "cy@company.example.evil.example",
  "cy@evilcompany.example",
  "cy@company.example@evil.example",
  "cy@other.example",
];

test("with no pattern, and with an empty list, the members are the owner and the added member alone", async () => {
  for (const ownerEmailPatterns of [undefined, []]) {
    const { env } = stackOf({ ownerEmailPatterns });
    expect(await membersAmong(env, [OWNER, ADDED, AT_PATTERN, ...NOT_AT_PATTERN])).toEqual([
      OWNER,
      ADDED,
    ]);
  }
});

test("a pattern makes an address at exactly its domain a member, and leaves every other answer as it was", async () => {
  const { env } = stackOf({ ownerEmailPatterns: PATTERNS });
  expect(
    await membersAmong(env, [OWNER, ADDED, AT_PATTERN, " Cy@Company.Example ", ...NOT_AT_PATTERN]),
  ).toEqual([OWNER, ADDED, AT_PATTERN, " Cy@Company.Example "]);
});

test("a session acts as a member by a pattern only when a passkey opened it: a mailed code's never does", async () => {
  const { env } = stackOf({ ownerEmailPatterns: PATTERNS });
  expect(await isMemberSession(env, { method: "passkey", email: AT_PATTERN })).toBe(true);
  expect(await isMemberSession(env, { method: "email", email: AT_PATTERN })).toBe(false);
  expect(await isMemberSession(env, { method: "passkey", email: NOT_AT_PATTERN[0]! })).toBe(false);
});

test("Cloudflare's proof of an address at a pattern opens the first passkey's session, as an owner's does; with no pattern it opens none", async () => {
  const request = new Request("https://iterate.example.com/sign-in/access");
  const withPattern = stackOf({ ownerEmailPatterns: PATTERNS });
  expect(
    await enrolmentCookie(withPattern.env, request, AT_PATTERN, "cloudflare-access"),
  ).toMatchObject({ setCookie: expect.any(String) });
  // an owner's link is for an added member: an owner by a pattern is an owner
  expect(await enrolmentCookie(withPattern.env, request, AT_PATTERN, "member-link")).toEqual({
    refused: `${AT_PATTERN} is an owner of iterate.example.com. An owner's link signs in no owner.`,
  });
  for (const email of NOT_AT_PATTERN)
    expect(
      await enrolmentCookie(withPattern.env, request, email, "cloudflare-access"),
    ).toMatchObject({ refused: expect.stringContaining("is not an owner") });
  expect(
    await enrolmentCookie(stackOf().env, request, AT_PATTERN, "cloudflare-access"),
  ).toMatchObject({ refused: expect.stringContaining("is not an owner") });
});

test("a deploy that takes the pattern away ends the membership of the people it named", async () => {
  const stack = stackOf({ ownerEmailPatterns: PATTERNS });
  expect(await isMember(stack.env, AT_PATTERN)).toBe(true);
  const without = stack.envOf({ ownerEmailPatterns: undefined });
  expect(await isMember(without, AT_PATTERN)).toBe(false);
  expect(await isMemberSession(without, { method: "passkey", email: AT_PATTERN })).toBe(false);
  expect(await membersAmong(without, [OWNER, ADDED])).toEqual([OWNER, ADDED]);
});

// A PERSON WHO LEFT: the mail provider closes the mailbox, and the passkey that the person added
// still works. An owner's block is what ends that one person, while the pattern stays.
test("an owner's block ends one person of a pattern: no member, no session, no way back in; the others of the pattern stay", async () => {
  const stack = stackOf({ ownerEmailPatterns: PATTERNS });
  const { env } = stack;
  const request = new Request("https://iterate.example.com/sign-in/access");
  const owner = await passkeyCookie(env, OWNER);
  const leaver = await passkeyCookie(env, AT_PATTERN);
  const asLeaver = new Request("https://iterate.example.com/keys", { headers: { cookie: leaver } });
  expect(await sessionOf(env, asLeaver)).toMatchObject({ email: AT_PATTERN });
  // a removal would change nothing, and says what does
  expect(await posted(env, owner, "remove", AT_PATTERN)).toContain("Block this address");
  expect(await isMember(env, AT_PATTERN)).toBe(true);

  expect(await posted(env, owner, "block", AT_PATTERN)).toContain(
    `${AT_PATTERN} is blocked: it is no owner and no member now`,
  );
  expect(await membersAmong(env, [OWNER, ADDED, AT_PATTERN, "cy+tag@company.example"])).toEqual([
    OWNER,
    ADDED,
  ]);
  expect(await isMember(env, "dee@company.example")).toBe(true);
  expect(await isMemberSession(env, { method: "passkey", email: AT_PATTERN })).toBe(false);
  expect(await sessionOf(env, asLeaver)).toBeNull();
  // neither Cloudflare's proof nor the recovery command's link opens a first passkey's session
  for (const proof of ["cloudflare-access", "recovery-link"] as const)
    expect(await enrolmentCookie(env, request, AT_PATTERN, proof)).toEqual({
      refused: `${AT_PATTERN} is not a member of iterate.example.com.`,
    });
  // a deploy that takes the pattern away and one that brings it back: the block is still there
  expect(await isMember(stack.envOf({ ownerEmailPatterns: undefined }), AT_PATTERN)).toBe(false);
  expect(await isMember(stack.envOf({ ownerEmailPatterns: PATTERNS }), AT_PATTERN)).toBe(false);

  expect(await posted(env, owner, "unblock", AT_PATTERN)).toContain("is no longer blocked");
  expect(await isMember(env, AT_PATTERN)).toBe(true);
});

test("a block of a person of a pattern takes their row of /members with it, and an owner by address and an added member are never blocked", async () => {
  const stack = stackOf({ ownerEmailPatterns: PATTERNS });
  const { env } = stack;
  stack.db
    .prepare("insert into members (email, added_by, added_at) values (?, ?, 0)")
    .run(AT_PATTERN, OWNER);
  const owner = await passkeyCookie(env, OWNER);
  await posted(env, owner, "block", AT_PATTERN);
  expect(stack.db.prepare("select email from members order by email").all()).toEqual([
    { email: ADDED },
  ]);
  expect(await isMember(env, AT_PATTERN)).toBe(false);
  for (const member of [OWNER, ADDED])
    expect(await posted(env, owner, "block", member)).toContain("a member is never blocked");
  expect(stack.db.prepare("select email from blocked").all()).toEqual([{ email: AT_PATTERN }]);
});

function stackOf(config: { ownerEmailPatterns?: string[] } = {}) {
  const stack = sqliteStack({ zones: ["example.com"], ownerEmails: [OWNER], ...config });
  vi.stubGlobal("fetch", async () => new Response("Not found", { status: 404 }));
  stack.db
    .prepare("insert into members (email, added_by, added_at) values (?, ?, 0)")
    .run(ADDED, OWNER);
  return stack;
}

/** The cookie of `email`'s session by a passkey, which the test gives them. */
async function passkeyCookie(env: Env, email: string) {
  const person = await userOf(env.DB, email);
  const key = `key-of-${person.id}`;
  await env.DB.prepare(
    `insert into keys (id, user_id, public_key, format, label, added_via, added_by, added_at)
     values (?2, ?1, ?2, 'webauthn', 'a passkey', 'keys-page', ?1, 1)`,
  )
    .bind(person.id, key)
    .run();
  const { setCookie } = await sessionCookie(env, new Request(ISSUER), person, key);
  return setCookie.split(";")[0]!;
}

/** The text of the members page after `cookie`'s person posted `action` for `email`. */
async function posted(env: Env, cookie: string, action: string, email: string) {
  const answer = await authResponse(
    new Request(`${ISSUER}/members`, {
      method: "POST",
      headers: { origin: ISSUER, cookie },
      body: new URLSearchParams({ action, email }),
    }),
    env,
    ctx,
  );
  // a removal answers with a redirect, and the page writes an apostrophe as a numbered entity
  return (await answer.text()).replaceAll(/&#(\d+);/g, (_all, code) =>
    String.fromCharCode(Number(code)),
  );
}

async function membersAmong(env: ReturnType<typeof stackOf>["env"], emails: string[]) {
  const members: string[] = [];
  for (const email of emails) if (await isMember(env, email)) members.push(email);
  return members;
}
