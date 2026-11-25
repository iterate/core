// What a proof of an address is good for, through the Worker's own router and SQL: the first
// passkey of a member (./enrolment.ts) by an owner's link and the recovery command's link, each
// to the address the browser ends at (Cloudflare Access, an owner's proof, is
// ./access-sign-in.test.ts); and the mailed code (./email-sign-in.ts), which gives a person who
// is no member a session that an app of the mind takes and the mind itself does not, and gives a
// member nothing. Then what an app names (./asking-app.ts): the sign-in methods that the issuer
// holds its host to, the form that its sign-in page opens on, and the zone and the name that its
// code is mailed from.
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { base64url, challengeOf, keyIdOf, signedP256, statementText } from "iterate/signed";
import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { expect, test, vi } from "vitest";
import { sha256Hex } from "./device/protocol.ts";
import { liveSessionsOf } from "./cookies.ts";
import {
  CODES_AN_HOUR_FOR_A_MAILBOX,
  LIVE_CHALLENGES,
  NON_MEMBER_CODES_AN_HOUR,
} from "./email-sign-in.ts";
import { passkeysOf as passkeysRead, RECOVERY_COMMAND } from "./enrolment.ts";
import type { Env } from "./env.ts";
import { authResponse } from "./http.ts";
import { hostCallbackOf, hostClientOf, oauthHelpers, sessionsByClientOf } from "./oauth.ts";
import { Auth } from "./rpc.ts";
import { sqliteStack } from "./test-support.ts";
import { userOf } from "./users.ts";
import { whoIs } from "./who-is.ts";

const ISSUER = "https://iterate.example.com";
const ZONES = ["example.com", "second.example"];
// no reserved name (RFC 2606): a code is mailed, to the test's own mail binding
const OWNER = "ada@adas-mail.dev";
const MEMBER = "bo@bos-mail.dev";
const GUEST = "eve@eves-mail.dev";
// an app that says nothing of itself: it is for anyone, whose people sign in by a mailed code
const GUESTBOOK = "https://guestbook.example.com";
const MIND = "iterate.example.com";

// A MAILED CODE IS FOR THE PEOPLE OF THE MIND'S APPS: a person who is no member gets a session
// that is no member's, and with it the app's host.
test("a mailed code gives a person who is no member a session that is no member's, which adds no passkey, and the app that the sign-in was for takes it", async () => {
  const stack = stackOf();
  const next = await appSignIn(stack.env);
  const guest = await codeRedeemed(stack, GUEST, next);
  expect({
    status: guest.status,
    location: guest.location,
    person: await personOf(stack.env, guest.cookie),
    mayAddAPasskey: (await formOf(stack.env, guest.cookie)).challenge !== null,
  }).toEqual({
    status: 303,
    location: next,
    person: {
      userId: expect.stringMatching(/^user_/),
      email: GUEST,
      member: false,
      method: "email",
      // when the browser's session ends, in Unix seconds: a session of the API ends no later
      expiresAt: expect.any(Number),
    },
    mayAddAPasskey: false,
  });
  // the browser goes on to the app's own authorization request, which gives a code for its host
  const on = await ask(stack.env, guest.location.slice(ISSUER.length), { cookie: guest.cookie });
  expect(on.headers.get("location")).toMatch(
    /^https:\/\/guestbook\.example\.com\/\.iterate\/callback\?code=/,
  );
});

// A MAILED CODE NEVER OPENS A WAY INTO THE MIND. A member's address is mailed its code as any
// address is, so the pages tell a stranger nothing; the right code, which proves the mailbox, is
// answered with what does sign that member in.
test.for([
  {
    who: "an owner who never had a passkey",
    email: OWNER,
    passkey: "none",
    words: `${OWNER} is an owner of ${MIND}, and a code by email signs in no member. Prove your email address with Cloudflare, and then add a passkey.`,
    way: "Prove your email address with Cloudflare",
  },
  {
    who: "an added member who never had a passkey",
    email: MEMBER,
    passkey: "none",
    words: `${MEMBER} is a member of ${MIND}, and a code by email signs in no member. Ask an owner of the mind for a sign-in link, and then add a passkey.`,
    way: "Sign in",
  },
  {
    who: "an owner who has a passkey",
    email: OWNER,
    passkey: "held",
    words: `${OWNER} has a passkey for ${MIND}, so nothing else signs it in. Sign in with the passkey.`,
    way: "Sign in",
  },
  {
    who: "an added member who has a passkey",
    email: MEMBER,
    passkey: "held",
    words: `${MEMBER} has a passkey for ${MIND}, so nothing else signs it in. Sign in with the passkey.`,
    way: "Sign in",
  },
  {
    who: "an owner whose passkey is gone",
    email: OWNER,
    passkey: "removed",
    words: `${OWNER} had a passkey for ${MIND}, so a code by email signs it in no more. An owner with no passkey left gets back in by the recovery command, which whoever holds this mind's Cloudflare account runs.`,
    way: "Sign in",
  },
  {
    who: "an added member whose passkey is gone",
    email: MEMBER,
    passkey: "removed",
    words: `${MEMBER} had a passkey for ${MIND}, so a code by email signs it in no more. Ask an owner of the mind for a sign-in link.`,
    way: "Sign in",
  },
])(
  "the right code of $who is refused, opens no session, and the page says what to do instead",
  async ({ email, passkey, words, way }) => {
    const stack = stackOf();
    if (passkey !== "none") await passkeyAdded(stack, email);
    if (passkey === "removed") stack.db.exec("update keys set revoked_at = 1");
    const next = await appSignIn(stack.env);
    // the sessions that are not over: a request for a code removes those that are (./cookies.ts)
    const sessions = () =>
      stack.db.prepare("select count(*) as n from browser_sessions where ended_at is null").get()!
        .n;
    const before = sessions();
    // the code is mailed to the member's address: `codeMailed` reads it from that mail
    const refused = await codeRedeemed(stack, email, next);
    expect(refused).toMatchObject({ status: 403, location: "", cookie: "" });
    expect(refused.text).toContain(`<p>${words}</p>`);
    // the one link under the words: for an owner with no passkey yet, on to Cloudflare Access
    const href = way === "Sign in" ? "/sign-in" : "/sign-in/access";
    expect(refused.text).toContain(
      `<p><a href="${href}?${new URLSearchParams({ next })}">${way}</a></p>`,
    );
    expect(sessions()).toBe(before);
  },
);

test("a session of a person who is no member reaches /sessions and sign-out, and no other page of the control plane", async () => {
  const stack = stackOf();
  const { cookie } = await codeRedeemed(stack, GUEST);
  expect(cookie).not.toBe("");
  expect(await statusOf(stack.env, "/sessions", cookie)).toBe(200);
  expect(await statusOf(stack.env, "/keys.json", cookie)).toBe(401);
  expect(await locationOf(stack.env, "/keys", cookie)).toBe(`${ISSUER}/sign-in?next=%2Fkeys`);
  expect(await locationOf(stack.env, "/members", cookie)).toBe("/sign-in?next=%2Fmembers");
  expect(await locationOf(stack.env, "/minds", cookie)).toBe("/sign-in?next=%2Fminds");
  expect(await locationOf(stack.env, "/self-test", cookie)).toBe(
    `${ISSUER}/sign-in?next=%2Fself-test`,
  );
  expect(await locationOf(stack.env, "/oauth2/device?user_code=WDJB-MJHT", cookie)).toMatch(
    /^\/sign-in\?/,
  );
  expect(await firstPasskeyAdded(stack.env, cookie)).toMatchObject({ status: 403 });
  // `/` says who is signed in, and that the address is no member
  expect(await statusOf(stack.env, "/", cookie)).toBe(403);
  const out = await ask(stack.env, "/sign-out", { method: "POST", cookie, body: new FormData() });
  expect(out).toMatchObject({ status: 303 });
  expect(await personOf(stack.env, cookie)).toBeNull();
});

test("a person who is no member gets a token for an app's host, which says so, and no grant for the mind's API: also once the address is a member's", async () => {
  const stack = stackOf();
  const { cookie } = await codeRedeemed(stack, GUEST);
  const host = "https://guestbook.example.com";
  const api = `${ISSUER}/api`;
  // the app's host signs its visitor in: the code goes to the host's own callback, with no consent
  const verifier = generateRandomCodeVerifier();
  const authorize = async (fields: Record<string, string>) =>
    ask(
      stack.env,
      `/oauth2/auth?${new URLSearchParams({
        response_type: "code",
        code_challenge: await calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state: "a-state",
        ...fields,
      })}`,
      { cookie },
    );
  const redirectUri = hostCallbackOf(host);
  const clientId = await hostClientOf(stack.env, new URL(host).host);
  const signedIn = await authorize({
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: host,
    scope: "identity",
  });
  const back = new URL(signedIn.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(redirectUri);
  const answer = await ask(stack.env, "/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: host,
    }),
  });
  const { access_token: token } = (await answer.json()) as { access_token: string };
  expect(await whoIs(stack.env, token, host)).toMatchObject({
    principal: { email: GUEST },
    member: false,
  });

  // the mind's API takes a member alone: the request gets a refusal's page, and no code
  const app = await oauthHelpers(stack.env).createClient({
    redirectUris: ["http://127.0.0.1:7777/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const forApi = () =>
    authorize({
      client_id: app.clientId,
      redirect_uri: "http://127.0.0.1:7777/callback",
      resource: api,
      scope: "iterate",
    });
  const refused = await forApi();
  expect(refused).toMatchObject({ status: 403 });
  expect(await refused.text()).toContain("is not a member of iterate.example.com");

  // An owner adds the address as a member. What mail proved is no member's all the same: the
  // session, the host's token and a new request for the API.
  stack.db
    .prepare("insert into members (email, added_by, added_at) values (?, ?, 0)")
    .run(GUEST, OWNER);
  expect(await personOf(stack.env, cookie)).toMatchObject({ email: GUEST, member: false });
  expect(await whoIs(stack.env, token, host)).toMatchObject({ member: false });
  expect(await forApi()).toMatchObject({ status: 403 });
});

test(`the whole mind mails ${NON_MEMBER_CODES_AN_HOUR} codes an hour to addresses that are no member's, and a member's code is no part of that`, async () => {
  const stack = stackOf();
  const next = await appSignIn(stack.env);
  // each request from a client address of its own: one client's own limit is another test's
  let clients = 0;
  const asked = async (email: string) => {
    const before = stack.mailed.length;
    const answer = await ask(stack.env, "/sign-in/email", {
      method: "POST",
      headers: { "cf-connecting-ip": `192.0.2.${(clients += 1)}` },
      body: new URLSearchParams({ email, next }),
    });
    return { status: answer.status, mailed: stack.mailed.length - before };
  };
  for (let n = 1; n <= NON_MEMBER_CODES_AN_HOUR; n += 1)
    expect(await asked(`guest-${n}@guests-mail.dev`)).toEqual({ status: 303, mailed: 1 });
  // past the cap: the same answer, and no mail
  expect(await asked("guest-too-many@guests-mail.dev")).toEqual({ status: 303, mailed: 0 });
  // An address with a tag is no member's, though its mailbox is the owner's. Past the cap it
  // mails nothing, so it spends none of the owner's own codes.
  const tagged = OWNER.replace("@", "+tag@");
  for (const email of [tagged, tagged, tagged, tagged, tagged, tagged])
    expect(await asked(email)).toEqual({ status: 303, mailed: 0 });
  expect(await asked(OWNER)).toEqual({ status: 303, mailed: 1 });
  expect(await asked(MEMBER)).toEqual({ status: 303, mailed: 1 });
  // an hour on, the mind mails strangers again
  stack.db.exec("update email_challenges set created_at = created_at - 3600000");
  expect(await asked("guest-an-hour-on@guests-mail.dev")).toEqual({ status: 303, mailed: 1 });
});

test("one client address asks for twenty codes in ten minutes, and no more", async () => {
  const stack = stackOf();
  const next = await appSignIn(stack.env);
  const asked = async (n: number) =>
    (
      await ask(stack.env, "/sign-in/email", {
        method: "POST",
        headers: { "cf-connecting-ip": "192.0.2.1" },
        body: new URLSearchParams({ email: `guest-${n}@guests-mail.dev`, next }),
      })
    ).status;
  const statuses = [];
  for (let n = 1; n <= 21; n += 1) statuses.push(await asked(n));
  expect(statuses).toEqual([...Array(20).fill(303), 400]);
});

test(`a mailbox gets one code a minute from one client, and ${CODES_AN_HOUR_FOR_A_MAILBOX} an hour from all: past either, the same answer and no mail`, async () => {
  const stack = stackOf();
  const next = await appSignIn(stack.env);
  let clients = 0;
  const asked = async (client = `192.0.2.${(clients += 1)}`) => {
    const before = stack.mailed.length;
    const answer = await ask(stack.env, "/sign-in/email", {
      method: "POST",
      headers: { "cf-connecting-ip": client },
      body: new URLSearchParams({ email: OWNER, next }),
    });
    return { status: answer.status, mailed: stack.mailed.length - before };
  };
  expect(await asked("192.0.2.200")).toEqual({ status: 303, mailed: 1 });
  // within the minute the same client gets no second mail, and another client does
  expect(await asked("192.0.2.200")).toEqual({ status: 303, mailed: 0 });
  for (let n = 2; n <= CODES_AN_HOUR_FOR_A_MAILBOX; n += 1)
    expect(await asked()).toEqual({ status: 303, mailed: 1 });
  expect(await asked()).toEqual({ status: 303, mailed: 0 });
  stack.db.exec("update email_challenges set created_at = created_at - 3600000");
  expect(await asked()).toEqual({ status: 303, mailed: 1 });
});

// THE ADDRESS PAGE TELLS A STRANGER NOTHING: with the mind's codes for strangers spent and a
// member's mailbox at its limit, a member's address and a stranger's get the same answer
test("past the strangers' cap and a member's mailbox limit, a member's address and a stranger's are answered alike", async () => {
  const stack = stackOf();
  const next = await appSignIn(stack.env);
  let clients = 0;
  const asked = async (email: string) => {
    const before = stack.mailed.length;
    const answer = await ask(stack.env, "/sign-in/email", {
      method: "POST",
      headers: { "cf-connecting-ip": `198.51.100.${(clients += 1)}` },
      body: new URLSearchParams({ email, next }),
    });
    return {
      status: answer.status,
      location: answer.headers.get("location"),
      mailed: stack.mailed.length - before,
    };
  };
  for (let n = 1; n <= NON_MEMBER_CODES_AN_HOUR; n += 1) await asked(`guest-${n}@guests-mail.dev`);
  for (let n = 1; n <= CODES_AN_HOUR_FOR_A_MAILBOX; n += 1) await asked(MEMBER);
  const [member, stranger] = [await asked(MEMBER), await asked("someone@guests-mail.dev")];
  expect(member).toEqual(stranger);
  expect(member).toMatchObject({ status: 303, mailed: 0 });
});

test(`the whole mind holds ${LIVE_CHALLENGES} challenges that are not over, whoever asks`, async () => {
  const stack = stackOf();
  const next = await appSignIn(stack.env);
  let clients = 0;
  const asked = async () =>
    (
      await ask(stack.env, "/sign-in/email", {
        method: "POST",
        headers: { "cf-connecting-ip": `198.51.100.${(clients += 1)}` },
        body: new URLSearchParams({ email: `guest-${clients}@guests-mail.dev`, next }),
      })
    ).status;
  for (let n = 1; n <= LIVE_CHALLENGES; n += 1) expect(await asked()).toBe(303);
  expect(await asked()).toBe(400);
  // the challenges end after their ten minutes, and the mind takes new ones
  stack.db.exec("update email_challenges set expires_at = expires_at - 600000");
  expect(await asked()).toBe(303);
});

test("a challenge that was not mailed takes no code, not the right one either", async () => {
  const stack = stackOf();
  const mailed = await codeMailed(stack, GUEST);
  stack.db.exec("update email_challenges set mailed = 0");
  const answer = await redeem(stack.env, mailed);
  expect(answer).toMatchObject({ status: 400, cookie: "" });
  expect(answer.text).toContain("That code is not right. 4 tries left.");
});

test("a code that went out while the address was no member's signs nobody in once the address is a member's", async () => {
  const stack = stackOf();
  const mailed = await codeMailed(stack, GUEST);
  stack.db
    .prepare("insert into members (email, added_by, added_at) values (?, ?, 0)")
    .run(GUEST, OWNER);
  const redeemed = await redeem(stack.env, mailed);
  expect(redeemed).toMatchObject({ status: 403, cookie: "" });
  expect(redeemed.text).toContain(
    `${GUEST} is a member of ${MIND}, and a code by email signs in no member.`,
  );
  expect(stack.db.prepare("select count(*) as n from browser_sessions").get()).toEqual({ n: 0 });
});

// THE CONTROL PLANE'S OWN SIGN-IN HAS NO MAILED CODE: the address page and the request for a code
// lead back to its sign-in page, and nothing is mailed or kept. So do an empty `next` and a `next`
// that is too long to keep, both of which go on to the mind's Dash.
test.for([
  { name: "the control plane's own page", next: "/keys" },
  { name: "the mind's API, for an outside client", next: "/oauth2/auth?client_id=c" },
  { name: "no next at all", next: "" },
  { name: "a hostname of the mind that is no authorization request", next: `${GUESTBOOK}/notes` },
  { name: "a next that is too long to keep", next: `${GUESTBOOK}/${"n".repeat(3000)}` },
])(
  "/sign-in/email mails no code for a sign-in with no asking app: $name",
  async ({ name, next }) => {
    const stack = stackOf();
    const page = await ask(stack.env, `/sign-in/email?${new URLSearchParams({ next })}`);
    const posted = await ask(stack.env, "/sign-in/email", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER, next }),
    });
    for (const answer of [page, posted]) {
      expect(answer).toMatchObject({ status: 303 });
      expect(answer.headers.get("location")).toMatch(/^\/sign-in\?next=/);
      expect(answer.headers.getSetCookie()).toEqual([]);
    }
    // the page keeps the `next` it was given; a request keeps the address that was checked
    expect(page.headers.get("location")).toBe(
      `/sign-in?${new URLSearchParams({ next: next || "/" })}`,
    );
    if (name === "no next at all" || name.includes("too long"))
      expect(posted.headers.get("location")).toBe(
        `/sign-in?${new URLSearchParams({ next: "https://dash.example.com/" })}`,
      );
    expect(stack).toMatchObject({ mailed: [] });
    expect(stack.db.prepare("select count(*) as n from email_challenges").get()).toEqual({ n: 0 });
  },
);

test("a session that a mailed code opened for a person who was no member lists and ends its own kind alone, once the address is a member's with a passkey", async () => {
  const stack = stackOf();
  const host = "https://guestbook.example.com";
  const before = await codeRedeemed(stack, GUEST);
  const beforeOnPhone = await codeRedeemed(stack, GUEST);
  await hostSignedIn(stack.env, before.cookie, host);
  // an owner adds the address, and the person adds a passkey and signs in to the same app
  stack.db
    .prepare("insert into members (email, added_by, added_at) values (?, ?, 0)")
    .run(GUEST, OWNER);
  const member = await passkeyAdded(stack, GUEST);
  await hostSignedIn(stack.env, member.cookie, host);
  const { userId } = (await personOf(stack.env, member.cookie))!;
  const held = async () => ({
    browsers: (await liveSessionsOf(stack.env, userId, "all")).map(({ method }) => method),
    grants: (await sessionsByClientOf(stack.env, userId, "all"))
      .flatMap(({ signIns }) => signIns.map(({ id }) => grantMethods.get(id)))
      .toSorted(),
  });
  // how the person of each grant signed in, as its metadata keeps it
  const grantMethods = new Map(
    (await oauthHelpers(stack.env).listUserGrants(userId)).items.map((grant) => [
      grant.id,
      (grant.metadata as { method: string }).method,
    ]),
  );
  expect(await held()).toEqual({
    browsers: ["passkey", "email", "email"],
    grants: ["email", "passkey"],
  });

  // the old session's page shows its own kind, and nothing that the passkey opened
  const page = await (await ask(stack.env, "/sessions", { cookie: before.cookie })).text();
  expect(page.match(/data-session="/g)).toHaveLength(2);
  expect(page).toContain("Email code");
  expect(page).not.toContain("Passkey");
  expect(page.match(/name="signIn"/g)).toHaveLength(1);

  // and its forms end its own kind alone: the other mailed session, and its own grant
  const post = (fields: Record<string, string>) =>
    ask(stack.env, "/sessions", {
      method: "POST",
      cookie: before.cookie,
      body: new URLSearchParams(fields),
    });
  await post({ others: "1" });
  await post({ client: await hostClientOf(stack.env, new URL(host).host) });
  expect(await held()).toEqual({ browsers: ["passkey", "email"], grants: ["passkey"] });
  expect(await personOf(stack.env, beforeOnPhone.cookie)).toBeNull();

  // the passkey's session ends everything of the person
  await ask(stack.env, "/sessions", {
    method: "POST",
    cookie: member.cookie,
    body: new URLSearchParams({ others: "1" }),
  });
  expect(await held()).toMatchObject({ browsers: ["passkey"] });
});

test("the sessions that are no passkey's are removed once they are over, as a code is asked for", async () => {
  const stack = stackOf();
  const guest = await codeRedeemed(stack, GUEST);
  const member = await passkeyAdded(stack, MEMBER);
  const rows = () => stack.db.prepare("select method from browser_sessions order by method").all();
  // the member's enrolment session ended as the passkey was added: it is over, and still a row
  expect(rows()).toEqual([{ method: "email" }, { method: "member-link" }, { method: "passkey" }]);
  await codeMailed(stack, "another-guest@guests-mail.dev");
  expect(rows()).toEqual([{ method: "email" }, { method: "passkey" }]);
  // expired: the guest's goes, and the passkey's, which its own sign-in removes, stays
  stack.db.exec("update browser_sessions set expires_at = 1");
  await codeMailed(stack, "one-more-guest@guests-mail.dev");
  expect(rows()).toEqual([{ method: "passkey" }]);
  expect([guest.cookie, member.cookie].every(Boolean)).toBe(true);
});

test("an address that an owner blocked is no longer blocked once an owner adds it as a member", async () => {
  const stack = stackOf();
  const owner = await ownerWithKey(stack);
  stack.db
    .prepare("insert into blocked (email, blocked_by, blocked_at) values (?, ?, 0)")
    .run(GUEST, OWNER);
  const answer = await ask(stack.env, "/members", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: await owner.signed("events.iterate.com/account/member-added", { email: GUEST }),
  });
  expect(answer).toMatchObject({ status: 200 });
  expect(stack.db.prepare("select email from blocked").all()).toEqual([]);
  expect(
    decodeFacts(answer.headers.get(FACTS_HEADER)!).flatMap(({ events }) =>
      events.map(({ type, payload }) => ({ type, email: (payload as { email: string }).email })),
    ),
  ).toEqual([
    { type: "events.iterate.com/account/person-unblocked", email: GUEST },
    { type: "events.iterate.com/account/member-added", email: GUEST },
  ]);
});

test("a code for a tagged address of a mailbox that was mailed just now waits, as the mailbox's own would", async () => {
  const stack = stackOf();
  const next = await appSignIn(stack.env);
  const post = (email: string) =>
    ask(stack.env, "/sign-in/email", {
      method: "POST",
      body: new URLSearchParams({ email, next }),
    });
  expect(await post(OWNER)).toMatchObject({ status: 303 });
  expect(await post(OWNER.replace("@", "+tag@"))).toMatchObject({ status: 303 });
  expect(stack.mailed).toHaveLength(1);
});

// A PASSKEY OF AN ADDRESS THAT IS NO MEMBER'S, from before ../migrations/0016: its `outsider`
// reads 0. It never signs in, and never bars a member's first passkey, also once an owner adds
// the address.
test("a passkey that an address held while it was no member's never signs in and never bars its first passkey as a member", async () => {
  const stack = stackOf();
  // the control: an owner's key of the same shape signs in, and with no `next` goes on to the Dash
  const ownerKey = await passkeyOfRow(stack, OWNER);
  expect(await passkeySignedIn(stack.env, ownerKey)).toMatchObject({
    status: 200,
    next: "https://dash.example.com/",
  });
  expect(await passkeySignedIn(stack.env, ownerKey, "/keys")).toMatchObject({
    status: 200,
    next: "https://iterate.example.com/keys",
  });
  const old = await passkeyOfRow(stack, GUEST);
  expect(await passkeySignedIn(stack.env, old)).toMatchObject({ status: 403 });
  const owner = await ownerWithKey(stack);
  const added = await ask(stack.env, "/members", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: await owner.signed("events.iterate.com/account/member-added", { email: GUEST }),
  });
  expect(added).toMatchObject({ status: 200 });
  // a member now, and the key is still no member's
  expect(
    stack.db.prepare("select outsider, revoked_at from keys where id = ?").get(old.id),
  ).toEqual({ outsider: 1, revoked_at: null });
  expect(await passkeySignedIn(stack.env, old)).toMatchObject({ status: 403 });
  expect(await passkeysRead(stack.env, GUEST)).toBe("none");
  // the owner's link opens the member's first passkey, which revokes the old one
  expect(await passkeyAdded(stack, GUEST)).toMatchObject({ status: 200 });
  expect(
    stack.db.prepare("select revoked_at is not null as revoked from keys where id = ?").get(old.id),
  ).toEqual({ revoked: 1 });
});

// THE THREE PROOFS THAT OPEN THE SESSION WHICH ADDS A FIRST PASSKEY are Cloudflare Access
// (./access-sign-in.test.ts), an owner's link and the recovery command's link.
test.for([
  { proof: "an owner's link", who: "an added member", email: MEMBER, method: "member-link" },
  { proof: "the recovery command's link", who: "an owner", email: OWNER, method: "recovery-link" },
])(
  "$proof signs in $who who has no passkey, to add the first one and nothing else",
  async ({ email, method }) => {
    const stack = stackOf();
    const opened = await enrolling(stack, email);
    expect(opened).toMatchObject({ status: 200 });
    expect(stack.db.prepare("select method, key_id from browser_sessions").all()).toEqual([
      { method, key_id: null },
    ]);
    // the session reaches the first passkey's page, and is nobody anywhere else
    const { cookie } = opened;
    expect(await formOf(stack.env, cookie)).toMatchObject({
      heading: "Add your passkey to iterate.example.com",
      html: expect.stringContaining(
        "A passkey is required to continue — there is no password or email sign-in, and this step cannot be skipped.",
      ),
    });
    expect(await statusOf(stack.env, "/keys.json", cookie)).toBe(401);
    expect(await locationOf(stack.env, "/keys", cookie)).toBe(`${ISSUER}/sign-in?next=%2Fkeys`);
    expect(await locationOf(stack.env, "/members", cookie)).toBe("/sign-in?next=%2Fmembers");
    expect(await locationOf(stack.env, "/sessions", cookie)).toBe("/sign-in?next=%2Fsessions");
    expect(await personOf(stack.env, cookie)).toBeNull();

    const added = await firstPasskeyAdded(stack.env, cookie);
    expect(added).toMatchObject({ status: 200, next: "https://onboarding.example.com/" });
    // the answer's cookie is the passkey's own session, a member's
    expect(await statusOf(stack.env, "/keys.json", added.cookie)).toBe(200);
    expect(await personOf(stack.env, added.cookie)).toMatchObject({ email, member: true });
    // and the session that the link opened is over
    expect(await personOf(stack.env, cookie)).toBeNull();
    expect(await firstPasskeyAdded(stack.env, cookie)).toMatchObject({ status: 403 });
  },
);

test("a link names whose it is: the recovery command's signs in no added member, an owner's link no owner, and neither a person who is no member", async () => {
  const stack = stackOf();
  const spent = async (email: string, madeBy: string) =>
    (await linkSpent(stack.env, await linkFor(stack, email, madeBy))).status;
  expect({
    recoveryForAnAddedMember: await spent(MEMBER, RECOVERY_COMMAND),
    ownersLinkForAnOwner: await spent(OWNER, OWNER),
    recoveryForNoMember: await spent(GUEST, RECOVERY_COMMAND),
    ownersLinkForNoMember: await spent(GUEST, OWNER),
  }).toEqual({
    recoveryForAnAddedMember: 403,
    ownersLinkForAnOwner: 403,
    recoveryForNoMember: 403,
    ownersLinkForNoMember: 403,
  });
  expect(stack.db.prepare("select count(*) as n from browser_sessions").get()).toEqual({ n: 0 });
});

test("a session of a proof that this Worker does not take adds no passkey", async () => {
  const stack = stackOf();
  const { cookie } = await enrolling(stack, MEMBER);
  expect(await formOf(stack.env, cookie)).toMatchObject({ challenge: expect.any(String) });
  const form = await formOf(stack.env, cookie);
  // the row's method is no proof of ./enrolment.ts: a mailed code's, by a name of its own
  stack.db.exec("update browser_sessions set method = 'member-email'");
  expect(await formOf(stack.env, cookie)).toMatchObject({ challenge: null });
  expect(await firstPasskeyAdded(stack.env, cookie, { challenge: form.challenge! })).toMatchObject({
    status: 403,
  });
  expect(passkeysOf(stack, MEMBER)).toBe(0);
});

test("the members page says how a new member gets in: by the sign-in link that an owner makes there, and by no mailed code", async () => {
  const stack = stackOf();
  const pageOf = async (email: string) =>
    (
      await (
        await ask(stack.env, "/members", { cookie: (await passkeyAdded(stack, email)).cookie })
      ).text()
    ).replaceAll(/\s+/g, " ");
  const [owners, members] = [await pageOf(OWNER), await pageOf(MEMBER)];
  expect(owners).toContain(
    `Then make the new member a <a href="#link">sign-in link</a>, to set up a passkey of their own.`,
  );
  expect(owners).toContain(
    `<h2 id="link">A sign-in link for a member</h2> <p>For a new member, or one whose keys you removed. It works once, within 24 hours, to add a passkey.`,
  );
  // a member who is no owner makes no link, and reads who does
  expect(members).toContain(
    "Then an owner makes the new member a sign-in link on this page, to set up a passkey of their own.",
  );
  expect(members).not.toContain(`id="link"`);
  for (const page of [owners, members])
    expect(page).not.toMatch(/sign-in\/email|signs in once with a code|get a code by email/);
});

test("the page of a link that is over says to ask for a new one, and offers no email address", async () => {
  const stack = stackOf();
  const html = await (await ask(stack.env, "/keys/first")).text();
  expect(html).toContain("<p>This link was used, or its 24 hours are over.</p>");
  expect(html).toContain(
    `<p>Ask for a new one. If you have a passkey here, <a href="/sign-in?next=https%3A%2F%2Fonboarding.example.com%2F">sign in</a>.</p>`,
  );
  expect(html).not.toMatch(/email/i);
});

test("a member whose passkeys an owner removed comes back by an owner's link, and adds a passkey with it", async () => {
  const stack = stackOf();
  await passkeyAdded(stack, MEMBER);
  stack.db.exec("update keys set revoked_at = 1");
  const { cookie, status } = await linkSpent(stack.env, await linkFor(stack, MEMBER, OWNER));
  expect(status).toBe(200);
  expect(await firstPasskeyAdded(stack.env, cookie)).toMatchObject({ status: 200 });
  expect(passkeysOf(stack, MEMBER)).toBe(1);
});

test("the first passkey ends every session that could add one: a second browser's is over, and reads nothing", async () => {
  const stack = stackOf();
  const first = await enrolling(stack, OWNER);
  const second = await enrolling(stack, OWNER);
  // both browsers hold a session that may add the first passkey
  expect(await formOf(stack.env, second.cookie)).toMatchObject({ challenge: expect.any(String) });
  const stale = await formOf(stack.env, second.cookie);

  const added = await firstPasskeyAdded(stack.env, first.cookie);
  expect(sessionsEndedIn(added.facts)).toHaveLength(2);
  expect(
    stack.db.prepare("select count(*) as n from browser_sessions where ended_at is null").get(),
  ).toEqual({ n: 1 });

  // the second browser: no form, no passkey of its own, no key's id, no person
  expect(await formOf(stack.env, second.cookie)).toMatchObject({ challenge: null });
  expect(
    await firstPasskeyAdded(stack.env, second.cookie, { challenge: stale.challenge! }),
  ).toMatchObject({ status: 403 });
  expect(await statusOf(stack.env, "/keys.json", second.cookie)).toBe(401);
  expect(await personOf(stack.env, second.cookie)).toBeNull();
  expect(passkeysOf(stack, OWNER)).toBe(1);
});

test("a link that was made before the first passkey and is opened after it opens no session", async () => {
  const stack = stackOf();
  const first = await enrolling(stack, MEMBER);
  const late = await linkFor(stack, MEMBER, OWNER);
  await firstPasskeyAdded(stack.env, first.cookie);
  expect(await linkSpent(stack.env, late)).toMatchObject({ status: 403, cookie: "" });
  expect(
    stack.db.prepare("select count(*) as n from browser_sessions where ended_at is null").get(),
  ).toEqual({ n: 1 });
});

test.for(["one after the other", "at once"])(
  "of two sessions that opened the first passkey's page, one adds a passkey: %s",
  async (when) => {
    const stack = stackOf();
    const sessions = [await enrolling(stack, OWNER), await enrolling(stack, OWNER)];
    const forms = await Promise.all(sessions.map(({ cookie }) => formOf(stack.env, cookie)));
    const add = (n: number) =>
      firstPasskeyAdded(stack.env, sessions[n]!.cookie, { challenge: forms[n]!.challenge! });
    const answers =
      when === "at once" ? await Promise.all([add(0), add(1)]) : [await add(0), await add(1)];
    expect({
      added: answers.filter(({ status }) => status === 200).length,
      passkeys: passkeysOf(stack, OWNER),
    }).toEqual({ added: 1, passkeys: 1 });
  },
);

test("an owner's link signs in no person who is an owner by the time it is opened, or by the time the passkey is recorded", async () => {
  const stack = stackOf();
  const promoted = stack.envOf({ ownerEmails: [OWNER, MEMBER] });
  // opened after the deploy that made the member an owner
  expect(await linkSpent(promoted, await linkFor(stack, MEMBER, OWNER))).toMatchObject({
    status: 403,
    cookie: "",
  });
  // opened before it: the session is over once the person is an owner
  const before = await linkSpent(stack.env, await linkFor(stack, MEMBER, OWNER));
  const form = await formOf(stack.env, before.cookie);
  expect(form).toMatchObject({ challenge: expect.any(String) });
  expect(await formOf(promoted, before.cookie)).toMatchObject({ challenge: null });
  expect(
    await firstPasskeyAdded(promoted, before.cookie, { challenge: form.challenge! }),
  ).toMatchObject({ status: 403 });
  expect(passkeysOf(stack, MEMBER)).toBe(0);
});

test("a link that the recovery command made signs in an owner with no passkey left, and no owner who has one", async () => {
  const stack = stackOf();
  await passkeyAdded(stack, OWNER);
  // the owner still has the passkey: the link opens nothing
  expect(await linkSpent(stack.env, await linkFor(stack, OWNER, RECOVERY_COMMAND))).toMatchObject({
    status: 403,
  });
  stack.db.exec("update keys set revoked_at = 1");
  const { cookie, status } = await linkSpent(
    stack.env,
    await linkFor(stack, OWNER, RECOVERY_COMMAND),
  );
  expect(status).toBe(200);
  expect(await firstPasskeyAdded(stack.env, cookie)).toMatchObject({ status: 200 });
  // a link is spent once
  const ticket = await linkFor(stack, OWNER, RECOVERY_COMMAND);
  stack.db.exec("update keys set revoked_at = 1");
  expect(await linkSpent(stack.env, ticket)).toMatchObject({ status: 200 });
  expect(await linkSpent(stack.env, ticket)).toMatchObject({ status: 403 });
});

// From the `next` that the first passkey's page was given to the address the page's script
// assigns once the passkey is added. A target is the whole `https:` URL that was checked, on a
// hostname of the mind, or the mind's front page.
test.for([
  {
    next: "https://shop.second.example/cart?item=1",
    ends: "https://shop.second.example/cart?item=1",
  },
  { next: "/keys/enrol?actor=a", ends: "https://iterate.example.com/keys/enrol?actor=a" },
  {
    next: "/oauth2/auth?client_id=c&state=a+b",
    ends: "https://iterate.example.com/oauth2/auth?client_id=c&state=a+b",
  },
  // a network-path reference names a host: it is that host, or nothing
  { next: "//shop.second.example/a", ends: "https://shop.second.example/a" },
  { next: "//evil.example/", ends: "https://onboarding.example.com/" },
  // a path that begins with two slashes stays a path of this origin, written whole
  {
    next: "https://iterate.example.com//evil.example/a",
    ends: "https://iterate.example.com//evil.example/a",
  },
  { next: "/\\evil.example/", ends: "https://onboarding.example.com/" },
  { next: "https://evil.example/", ends: "https://onboarding.example.com/" },
  { next: "http://shop.second.example/", ends: "https://onboarding.example.com/" },
  { next: "blob:https://iterate.example.com/a-page", ends: "https://onboarding.example.com/" },
  { next: "javascript:alert(1)", ends: "https://onboarding.example.com/" },
  { next: "/", ends: "https://onboarding.example.com/" },
  { next: "https://iterate.example.com/", ends: "https://onboarding.example.com/" },
  { next: "", ends: "https://onboarding.example.com/" },
])(
  "after the first passkey, the browser that came with next $next ends at $ends",
  async ({ next, ends }) => {
    const stack = stackOf();
    const { cookie } = await enrolling(stack, MEMBER);
    // the form keeps the address that was checked, and none for a `next` that is not the mind's
    const form = await formOf(stack.env, cookie, `/keys/first?${new URLSearchParams({ next })}`);
    expect(form).toMatchObject({ next: ends === "https://onboarding.example.com/" ? "" : ends });
    const added = await firstPasskeyAdded(stack.env, cookie, {
      challenge: form.challenge!,
      next: form.next,
    });
    expect(added).toMatchObject({ next: ends });
  },
);

test("a passkey's name is the person's to give: a default with none, and a refusal for one that is no short text", async () => {
  const names = async (label: unknown) => {
    const stack = stackOf();
    const { cookie } = await enrolling(stack, OWNER);
    const { status } = await firstPasskeyAdded(stack.env, cookie, { label });
    return {
      status,
      kept: stack.db
        .prepare("select label from keys")
        .all()
        .map((row) => row.label),
    };
  };
  const byDay = expect.stringMatching(/^Passkey, \d{4}-\d{2}-\d{2}$/);
  expect(await names(undefined)).toEqual({ status: 200, kept: [byDay] });
  expect(await names("   ")).toEqual({ status: 200, kept: [byDay] });
  expect(await names(" A phone ")).toEqual({ status: 200, kept: ["A phone"] });
  expect(await names("n".repeat(101))).toEqual({ status: 400, kept: [] });
  expect(await names(7)).toEqual({ status: 400, kept: [] });
});

// AN APP NAMES HOW ITS PEOPLE SIGN IN (iterate/app-description `signIn`), and the issuer holds
// every code for the app's host to the list, whichever client asks for it.
test("a mailed code's session at an app that names the passkey alone goes to that app's sign-in page, from the app's own page and from an MCP client alike; a passkey's session passes at every app", async () => {
  const stack = stackOf();
  const ledger = "https://ledger.example.com";
  const letters = "https://letters.second.example";
  stack.described.set("ledger.example.com", { name: "Ledger", signIn: ["passkey"] });
  stack.described.set("letters.second.example", { name: "Letters", signIn: ["email"] });
  const guest = (await codeRedeemed(stack, GUEST)).cookie;
  const member = await passkeyAdded(stack, MEMBER);
  const mcp = await oauthHelpers(stack.env).createClient({
    clientName: "An MCP client",
    redirectUris: [MCP_CALLBACK],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const ends = async (cookie: string, host: string) => ({
    own: (await authorized(stack.env, cookie, host)).ends,
    mcp: (await authorized(stack.env, cookie, host, mcp.clientId)).ends,
  });
  expect({
    // the app names the passkey alone: mail does not sign its people in
    guestAtLedger: await ends(guest, ledger),
    memberAtLedger: await ends(member.cookie, ledger),
    // the app names the mailed code alone: a passkey's session counts all the same
    guestAtLetters: await ends(guest, letters),
    memberAtLetters: await ends(member.cookie, letters),
    // an app that says nothing takes both
    guestAtAnother: await ends(guest, "https://another.example.com"),
  }).toEqual({
    guestAtLedger: { own: "the sign-in page", mcp: "the sign-in page" },
    memberAtLedger: { own: "a code for the host", mcp: "the consent page" },
    guestAtLetters: { own: "a code for the host", mcp: "the consent page" },
    memberAtLetters: { own: "a code for the host", mcp: "the consent page" },
    guestAtAnother: { own: "a code for the host", mcp: "the consent page" },
  });

  // The sign-in page that the person is sent to is the app's: it offers the passkey, and no
  // mailed code. An MCP client's page is the mind's own, with the app's methods.
  const refused = await authorized(stack.env, guest, ledger);
  const page = await (await ask(stack.env, refused.location.slice(ISSUER.length))).text();
  expect(page).toContain(
    `<h1>Sign in to Ledger</h1><p class="muted center">ledger.example.com</p>`,
  );
  expect(page).toContain(`<button type="submit">Sign in with a passkey</button>`);
  expect(page).not.toMatch(/sign-in\/email|type="email"/);
  const fromMcp = await authorized(stack.env, guest, ledger, mcp.clientId);
  const mcpPage = await (await ask(stack.env, fromMcp.location.slice(ISSUER.length))).text();
  expect(mcpPage).toContain("<h1>Sign in to iterate.example.com</h1>");
  expect(mcpPage).not.toMatch(/sign-in\/email|type="email"/);

  // no code is mailed in the name of an app that does not name "email": the address page and
  // the request for a code both lead back to the app's sign-in page
  const next = new URL(refused.location).searchParams.get("next")!;
  const before = stack.mailed.length;
  for (const answer of [
    await ask(stack.env, `/sign-in/email?${new URLSearchParams({ next })}`),
    await ask(stack.env, "/sign-in/email", {
      method: "POST",
      body: new URLSearchParams({ email: GUEST, next: `${ISSUER}${next}` }),
    }),
  ]) {
    expect(answer).toMatchObject({ status: 303 });
    expect(answer.headers.get("location")).toMatch(/^\/sign-in\?next=/);
  }
  expect(stack.mailed).toHaveLength(before);
});

// AN APP NAMES WHOSE ADDRESS A MAILED CODE SIGNS IN (iterate/app-description `allowedEmails`,
// `allowedEmailPatterns`), and the issuer holds the sign-up to them: at the mail, and at every
// code for the app's host.
test("an app that names addresses and patterns: no code is mailed to an address that neither names and no challenge is made, from the app's own page and from an MCP client alike; a session of such an address gets no code for the host; a passkey's session passes", async () => {
  const stack = stackOf();
  const shop = "https://shop.example.com";
  const inside = "eve@shop-people.dev";
  const named = "kit@kits-mail.dev";
  stack.described.set("shop.example.com", {
    name: "Shop",
    signIn: ["email", "passkey"],
    allowedEmails: [named],
    allowedEmailPatterns: ["*@shop-people.dev"],
  });
  const mcp = await oauthHelpers(stack.env).createClient({
    clientName: "An MCP client",
    redirectUris: [MCP_CALLBACK],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const nextOf = async (client?: string) =>
    new URL((await authorized(stack.env, "", shop, client)).location).searchParams.get("next")!;
  const own = await nextOf();
  const fromMcp = await nextOf(mcp.clientId);

  // the address page says whose address the app takes, on the app's page and on the mind's
  for (const next of [own, fromMcp])
    expect(
      await (await ask(stack.env, `/sign-in/email?${new URLSearchParams({ next })}`)).text(),
    ).toContain("Shop takes an address at shop-people.dev, and the addresses that it names, only.");

  const challenges = () =>
    stack.db.prepare("select count(*) as n from email_challenges").get() as { n: number };
  const asked = async (email: string, next: string) => {
    const before = { mailed: stack.mailed.length, challenges: challenges().n };
    const answer = await ask(stack.env, "/sign-in/email", {
      method: "POST",
      body: new URLSearchParams({ email, next: `${ISSUER}${next}` }),
    });
    return {
      status: answer.status,
      mailed: stack.mailed.length - before.mailed,
      challenges: challenges().n - before.challenges,
      says: answer.status === 400 ? /role="alert">([^<]*)</.exec(await answer.text())?.[1] : "",
    };
  };
  const refused = {
    status: 400,
    mailed: 0,
    challenges: 0,
    says: "Shop takes an address at shop-people.dev, and the addresses that it names, only. Use such an address.",
  };
  expect({
    // an address that neither names, at a subdomain of a pattern's, beside the named one at its
    // domain, and a member's: one answer for all
    outsider: await asked(GUEST, own),
    outsiderFromMcp: await asked(GUEST, fromMcp),
    subdomain: await asked("eve@mail.shop-people.dev", own),
    besideTheNamed: await asked("eve@kits-mail.dev", own),
    named: await asked(named, own),
    member: await asked(MEMBER, own),
    insider: await asked(inside, own),
    insiderInCapitals: await asked("Bo@Shop-People.dev", fromMcp),
  }).toEqual({
    outsider: refused,
    outsiderFromMcp: refused,
    subdomain: refused,
    besideTheNamed: refused,
    named: { status: 303, mailed: 1, challenges: 1, says: "" },
    member: refused,
    insider: { status: 303, mailed: 1, challenges: 1, says: "" },
    insiderInCapitals: { status: 303, mailed: 1, challenges: 1, says: "" },
  });

  // A SESSION THAT A MAILED CODE OPENED ELSEWHERE, at an app that takes any address, is no
  // session at the shop for an address outside its list.
  const outsider = (await codeRedeemed(stack, GUEST)).cookie;
  const insider = (await codeRedeemed(stack, inside)).cookie;
  const member = await passkeyAdded(stack, MEMBER);
  const ends = async (cookie: string) => ({
    own: (await authorized(stack.env, cookie, shop)).ends,
    mcp: (await authorized(stack.env, cookie, shop, mcp.clientId)).ends,
  });
  expect({
    outsider: await ends(outsider),
    insider: await ends(insider),
    // a passkey's session counts at every app: which members come is the app's own guard
    member: await ends(member.cookie),
    outsiderAtAnother: (await authorized(stack.env, outsider, GUESTBOOK)).ends,
  }).toEqual({
    outsider: { own: "the sign-in page", mcp: "the sign-in page" },
    insider: { own: "a code for the host", mcp: "the consent page" },
    member: { own: "a code for the host", mcp: "the consent page" },
    outsiderAtAnother: "a code for the host",
  });
});

test("a consent that a session of another method approves gives no code for an app that does not take that method", async () => {
  const stack = stackOf();
  const letters = "https://letters.second.example";
  const guest = (await codeRedeemed(stack, GUEST)).cookie;
  const mcp = await oauthHelpers(stack.env).createClient({
    clientName: "An MCP client",
    redirectUris: [MCP_CALLBACK],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  // the app took the mailed code when the consent page was shown, and names the passkey alone now
  const consent = await authorized(stack.env, guest, letters, mcp.clientId);
  expect(consent).toMatchObject({ ends: "the consent page" });
  stack.described.set("letters.second.example", { name: "Letters", signIn: ["passkey"] });
  stack.db.exec("delete from admissions");
  // the description is asked for again
  await stack.env.OAUTH_KV.delete("iterate-app-description:letters.second.example");
  const approved = await ask(stack.env, "/oauth2/auth", {
    method: "POST",
    cookie: [guest, consent.cookie].join("; "),
    body: new URLSearchParams({ handle: consent.handle, decision: "allow" }),
  });
  expect(approved).toMatchObject({ status: 403 });
  expect(approved.headers.get("location")).toBeNull();
});

// THE SIGN-IN PAGE OPENS ON THE FIRST METHOD that the app names, and offers the others below.
test.for([
  {
    name: "the mailed code first, then the passkey: the default of an app for anyone",
    says: { name: "Guestbook" },
    opensOn: "email",
    below: "passkey",
  },
  {
    // a passkey counts at every app, so it is offered below the form whatever the app names
    name: "the mailed code alone",
    says: { name: "Guestbook", signIn: ["email"] },
    opensOn: "email",
    below: "passkey",
  },
  {
    name: "the passkey alone: the default of an app for members",
    says: { name: "Guestbook", for: "members" },
    opensOn: "passkey",
    below: null,
  },
  {
    name: "the passkey alone, as the app names it",
    says: { name: "Guestbook", signIn: ["passkey"] },
    opensOn: "passkey",
    below: null,
  },
  {
    name: "the passkey first, then the mailed code, as the app names them",
    says: { name: "Guestbook", signIn: ["passkey", "email"] },
    opensOn: "passkey",
    below: "email",
  },
  {
    // the description is taken as it is written: the app's own code decides
    name: "an app for members that names the mailed code first",
    says: { name: "Guestbook", for: "members", signIn: ["email", "passkey"] },
    opensOn: "email",
    below: "passkey",
  },
])("an app's sign-in page, $name", async ({ says, opensOn, below }) => {
  const stack = stackOf();
  // a mind where somebody has a passkey: with none yet, an app for members opens on the first one
  stack.db.exec("insert into users (id, email) values ('user_owner', 'owner@example.net')");
  stack.db.exec(
    `insert into keys (id, user_id, public_key, format, label, added_via, added_by, added_at)
     values ('a-passkey', 'user_owner', 'a-public-key', 'webauthn', 'A phone', 'keys-page', 'user_owner', 0)`,
  );
  const host = "https://guestbook.second.example";
  stack.described.set("guestbook.second.example", says);
  const { location } = await authorized(stack.env, "", host);
  const html = await (await ask(stack.env, location.slice(ISSUER.length))).text();
  // the app's name, and under it the host that the person came from
  expect(html).toContain(
    `<h1>Sign in to Guestbook</h1><p class="muted center">guestbook.second.example</p>`,
  );
  const emailForm =
    /<form method="post" action="\/sign-in\/email" class="stack">[^]*<input type="email" name="email"/;
  const passkeyMain = `<button type="submit">Sign in with a passkey</button>`;
  const passkeyBelow = `<p class="or">or</p>`;
  const emailBelow = `<button type="submit" class="secondary">Sign in with your email address</button>`;
  expect({
    emailForm: emailForm.test(html),
    // the passkey's prompt as the page opens
    asksForPasskeyAtOpen: html.includes("\nsignIn(false);"),
    passkeyMain: html.includes(passkeyMain),
    passkeyBelow: html.includes(passkeyBelow),
    emailBelow: html.includes(emailBelow),
  }).toEqual({
    emailForm: opensOn === "email",
    asksForPasskeyAtOpen: opensOn === "passkey",
    passkeyMain: opensOn === "passkey",
    passkeyBelow: opensOn === "email" && below === "passkey",
    emailBelow: opensOn === "passkey" && below === "email",
  });
});

// THE MAIL COMES FROM WHERE THE PERSON IS: the zone of the app's hostname, under the app's name.
test("the code of an app in the mind's second zone is mailed from that zone, with the app's name as the sender's name and in the subject; the control plane's own comes from the zone of the control-plane hostname", async () => {
  const stack = stackOf();
  const host = "https://guestbook.second.example";
  stack.described.set("guestbook.second.example", { name: "Guestbook", icon: "/icon.svg" });
  const { location } = await authorized(stack.env, "", host);
  const next = `${ISSUER}${new URL(location).searchParams.get("next")!}`;
  await codeMailed(stack, GUEST, next);
  expect(stack.mailed.at(-1)).toMatchObject({
    from: { email: "sign-in@second.example", name: "Guestbook" },
    to: [GUEST],
    subject: "Your sign-in code for Guestbook",
    text: expect.stringContaining("to sign in to Guestbook (guestbook.second.example)."),
  });
  // an app that says nothing is named by its hostname, from its hostname's zone
  const plain = await authorized(stack.env, "", "https://plain.second.example");
  await codeMailed(stack, GUEST, `${ISSUER}${new URL(plain.location).searchParams.get("next")!}`);
  expect(stack.mailed.at(-1)).toMatchObject({
    from: { email: "sign-in@second.example", name: "plain.second.example" },
    subject: "Your sign-in code for plain.second.example",
    text: expect.stringContaining("to sign in to plain.second.example."),
  });
  // An outside client's sign-in to the app (an MCP client's) is no page of the app's: the mail is
  // the mind's own, from the zone of the control-plane hostname.
  const mcp = await oauthHelpers(stack.env).createClient({
    clientName: "An MCP client",
    redirectUris: [MCP_CALLBACK],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const fromMcp = await authorized(stack.env, "", host, mcp.clientId);
  await codeMailed(stack, GUEST, `${ISSUER}${new URL(fromMcp.location).searchParams.get("next")!}`);
  expect(stack.mailed.at(-1)).toMatchObject({
    from: { email: "sign-in@example.com", name: "iterate.example.com" },
    subject: "Your sign-in code for iterate.example.com",
  });
});

/** A mind with two zones, one owner and one member whom the owner added, and the web that its
 *  issuer reads for this test. `described` is what the mind's apps say of themselves, by
 *  hostname, as each answers at `/.well-known/iterate-app` (iterate/app-description). A hostname
 *  that is not there says nothing, as an app with no description: it is for anyone, and its
 *  people sign in by a mailed code first. Vitest restores the web after the test. */
function stackOf() {
  const stack = sqliteStack({ zones: ZONES, ownerEmails: [OWNER] });
  stack.db
    .prepare("insert into members (email, added_by, added_at) values (?, ?, 0)")
    .run(MEMBER, OWNER);
  const described = new Map<string, object>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const said = described.get(new URL(String(input)).hostname);
    return said ? Response.json(said) : new Response("Not found\n", { status: 404 });
  });
  return { ...stack, described };
}
type Stack = ReturnType<typeof stackOf>;

const ask = (env: Env, path: string, init: RequestInit & { cookie?: string } = {}) =>
  authResponse(
    new Request(`${ISSUER}${path}`, {
      ...init,
      headers: { origin: ISSUER, cookie: init.cookie || "", ...init.headers },
    }),
    env,
    // the cast: the pages hand the runtime nothing to keep alive in these flows
    {} as ExecutionContext,
  );

const cookieOf = (answer: Response, name: string) =>
  answer.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]!)
    .find((cookie) => cookie.startsWith(`${name}=`) && !cookie.endsWith("=")) || "";

/** THE `next` OF AN APP'S OWN SIGN-IN: the authorization request that a page of the app's host
 *  makes, as an address of the issuer. A sign-in page mails a code only for such a request, of
 *  an app that names "email". */
async function appSignIn(env: Env, host = GUESTBOOK) {
  const { location } = await authorized(env, "", host);
  return `${ISSUER}${new URL(location).searchParams.get("next")!}`;
}

/** A code asked for `email` on the mailed code's page, as it left in the mail. `next`: the
 *  sign-in that the code is for; with none, the guestbook's own. */
async function codeMailed(stack: Stack, email: string, next?: string) {
  // a second code for one mailbox waits a minute: the earlier ones are an hour old here
  stack.db.exec("update email_challenges set created_at = created_at - 3600000");
  const answer = await ask(stack.env, "/sign-in/email", {
    method: "POST",
    body: new URLSearchParams({ email, next: next || (await appSignIn(stack.env)) }),
  });
  expect(answer).toMatchObject({ status: 303 });
  const mail = stack.mailed.at(-1)!;
  expect(mail).toMatchObject({ to: [email] });
  return { cookie: cookieOf(answer, "__Host-iterate-auth-code"), code: mail.text.slice(0, 6) };
}

/** The answer to a code typed on its page: where it sends the browser, and the session's cookie
 *  when it opened one. */
async function redeem(env: Env, { cookie, code }: { cookie: string; code: string }) {
  const answer = await ask(env, "/sign-in/email/code", {
    method: "POST",
    cookie,
    body: new URLSearchParams({ code }),
  });
  return {
    status: answer.status,
    location: answer.headers.get("location") || "",
    cookie: cookieOf(answer, "__Host-iterate-auth-session"),
    // the page writes an apostrophe as a numbered entity
    text: (await answer.text()).replaceAll(/&#(\d+);/g, (_all, code) =>
      String.fromCharCode(Number(code)),
    ),
  };
}

const codeRedeemed = async (stack: Stack, email: string, next?: string) =>
  redeem(stack.env, await codeMailed(stack, email, next));

/** A SESSION THAT MAY ADD THE FIRST PASSKEY, opened by a link: an owner's link for an added
 *  member, and the recovery command's for an owner. */
const enrolling = async (stack: Stack, email: string) =>
  linkSpent(stack.env, await linkFor(stack, email, email === OWNER ? RECOVERY_COMMAND : OWNER));

/** The member of `email` with a first passkey, added through such a session: the passkey's own
 *  session. */
const passkeyAdded = async (stack: Stack, email: string) =>
  firstPasskeyAdded(stack.env, (await enrolling(stack, email)).cookie);

/** The browser of `cookie` signed in to an app of the mind at `host`: the code goes to the host's
 *  own callback, with no consent, and is exchanged for the host's token. */
async function hostSignedIn(env: Env, cookie: string, host: string) {
  const verifier = generateRandomCodeVerifier();
  const redirectUri = hostCallbackOf(host);
  const clientId = await hostClientOf(env, new URL(host).host);
  const signedIn = await ask(
    env,
    `/oauth2/auth?${new URLSearchParams({
      response_type: "code",
      code_challenge: await calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state: "a-state",
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: host,
      scope: "identity",
    })}`,
    { cookie },
  );
  const answer = await ask(env, "/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: new URL(signedIn.headers.get("location")!).searchParams.get("code")!,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: host,
    }),
  });
  expect(answer).toMatchObject({ status: 200 });
}

/** Where an outside client's code goes: an MCP client on the person's own computer. */
const MCP_CALLBACK = "http://127.0.0.1:4100/callback";

/** WHERE AN AUTHORIZATION FOR AN APP'S HOST ENDS for the browser of `cookie` ("": signed out).
 *  With no `client` it is the host's own sign-in, whose code goes to the host's own callback with
 *  no consent; with one, that client asks for the app's MCP server, as an MCP client does. */
async function authorized(env: Env, cookie: string, host: string, client?: string) {
  const redirectUri = client ? MCP_CALLBACK : hostCallbackOf(host);
  const answer = await ask(
    env,
    `/oauth2/auth?${new URLSearchParams({
      response_type: "code",
      code_challenge: await calculatePKCECodeChallenge(generateRandomCodeVerifier()),
      code_challenge_method: "S256",
      state: "a-state",
      client_id: client || (await hostClientOf(env, new URL(host).host)),
      redirect_uri: redirectUri,
      resource: client ? `${host}/mcp` : host,
      scope: "identity",
    })}`,
    { cookie },
  );
  const location = answer.headers.get("location") || "";
  const html = location ? "" : await answer.text();
  return {
    ends: location.startsWith(`${ISSUER}/sign-in?`)
      ? "the sign-in page"
      : location.startsWith(`${redirectUri}?code=`)
        ? "a code for the host"
        : html.includes(`wants to use ${new URL(host).host} as you`)
          ? "the consent page"
          : `${answer.status} ${location}`,
    location,
    // a consent's handle and the cookie that binds it, for the approval
    handle: /name="handle" value="([^"]+)"/.exec(html)?.[1] || "",
    cookie: answer.headers
      .getSetCookie()
      .map((set) => set.split(";")[0]!)
      .join("; "),
  };
}

/** The stack's owner with a P-256 key of their own on /keys, and a statement that the key signs
 *  as the body of a request. */
async function ownerWithKey(stack: Stack) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = base64url(
    new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer),
  );
  const key = await keyIdOf(publicKey);
  const user = await userOf(stack.env.DB, OWNER);
  stack.db
    .prepare(
      `insert into keys (id, user_id, public_key, format, label, added_via, added_by, added_at)
       values (?, ?, ?, 'p256', 'a key', 'keys-page', ?, 0)`,
    )
    .run(key, user.id, publicKey, user.id);
  return {
    signed: async (type: string, payload: Record<string, unknown>) => {
      const now = Date.now();
      const statement = statementText({
        mind: "iterate.example.com",
        path: "/",
        type,
        payload,
        at: now,
        expires: now + 60_000,
      });
      return JSON.stringify(await signedP256(statement, pair.privateKey, key));
    },
  };
}

/** A sign-in link's ticket for `email`, as `madeBy` wrote its row: an owner's address, or the
 *  recovery command. */
async function linkFor(stack: Stack, email: string, madeBy: string) {
  const ticket = `ticket-${crypto.randomUUID()}`;
  stack.db
    .prepare("insert into member_tickets (hash, email, made_by, expires_at) values (?, ?, ?, ?)")
    .run(await sha256Hex(ticket), email, madeBy, Date.now() + 3_600_000);
  return ticket;
}

async function linkSpent(env: Env, ticket: string) {
  const answer = await ask(env, "/keys/first/link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  return { status: answer.status, cookie: cookieOf(answer, "__Host-iterate-auth-session") };
}

/** The first passkey's page as this browser gets it: its form's challenge and `next`, or a null
 *  challenge for a browser that has no session for it. */
async function formOf(env: Env, cookie: string, path = "/keys/first") {
  const html = await (await ask(env, path, { cookie })).text();
  const attribute = (name: string) =>
    html
      .match(new RegExp(`data-${name}="([^"]*)"`))?.[1]
      ?.replace(/&#(\d+);/g, (_all, code) => String.fromCharCode(Number(code)));
  return {
    heading: html.match(/<h1>([^<]*)<\/h1>/)?.[1],
    html,
    challenge: attribute("challenge") ?? null,
    next: attribute("next") ?? "",
  };
}

/** The answer to a new P-256 passkey posted as the page's script posts it. `challenge`: one read
 *  from the page before; else the page is asked for one now. */
async function firstPasskeyAdded(
  env: Env,
  cookie: string,
  sent: { challenge?: string; next?: string; label?: unknown } = {},
) {
  const challenge = sent.challenge || (await formOf(env, cookie)).challenge || "no-challenge";
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
  );
  const clientData = { type: "webauthn.create", origin: ISSUER, challenge };
  const answer = await ask(env, "/keys/first", {
    method: "POST",
    cookie,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: sent.label,
      next: sent.next,
      publicKey: base64url(spki),
      credentialId: base64url(crypto.getRandomValues(new Uint8Array(16))),
      clientDataJSON: base64url(new TextEncoder().encode(JSON.stringify(clientData))),
    }),
  });
  const body = (await answer.json()) as { next?: string };
  return {
    status: answer.status,
    next: body.next,
    cookie: cookieOf(answer, "__Host-iterate-auth-session"),
    facts: answer.headers.has(FACTS_HEADER) ? decodeFacts(answer.headers.get(FACTS_HEADER)!) : [],
  };
}

const sessionsEndedIn = (facts: ReturnType<typeof decodeFacts>) =>
  facts.flatMap(({ events }) =>
    events.filter(({ type }) => type === "events.iterate.com/account/session-ended"),
  );

const statusOf = async (env: Env, path: string, cookie: string) =>
  (await ask(env, path, { cookie })).status;

const locationOf = async (env: Env, path: string, cookie: string) =>
  (await ask(env, path, { cookie })).headers.get("location");

/** Who the stack's other Workers are told this browser is (./rpc.ts `browserSession`). */
function personOf(env: Env, cookie: string) {
  // the cast: the entrypoint's `env` is the runtime's to set, and this call reads no `ctx`
  const auth = Object.assign(new (Auth as unknown as new () => Auth)(), { env });
  return auth.browserSession(cookie);
}

const passkeysOf = (stack: Stack, email: string) =>
  stack.db
    .prepare(
      `select count(*) as n from keys k join users u on u.id = k.user_id
       where u.email = ? and k.format = 'webauthn' and k.revoked_at is null`,
    )
    .get(email)!.n;

/** A passkey row of `email` as the old stack wrote it before ../migrations/0016: `outsider` 0. */
async function passkeyOfRow(stack: Stack, email: string) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = base64url(
    new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer),
  );
  const user = await userOf(stack.env.DB, email);
  const id = await keyIdOf(publicKey);
  const credentialId = `credential-of-${email}`;
  stack.db
    .prepare(
      `insert into keys (id, user_id, public_key, format, credential_id, label, added_via, added_by, added_at)
       values (?, ?, ?, 'webauthn', ?, 'a passkey', 'keys-page', ?, 0)`,
    )
    .run(id, user.id, publicKey, credentialId, user.id);
  return { id, credentialId, privateKey: pair.privateKey };
}

/** The passkey sign-in of ./passkey-sign-in.ts, as a browser's authenticator answers it. */
async function passkeySignedIn(
  env: Env,
  passkey: { credentialId: string; privateKey: CryptoKey },
  next?: string,
) {
  const asked = await ask(env, "/sign-in/passkey/challenge", { method: "POST" });
  const { statement } = (await asked.json()) as { statement: string };
  const encoder = new TextEncoder();
  const clientDataJSON = encoder.encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: await challengeOf(statement),
      origin: ISSUER,
    }),
  );
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(new URL(ISSUER).hostname)),
  );
  // user present and user verified
  const authenticatorData = new Uint8Array([...rpIdHash, 0x05, 0, 0, 0, 1]);
  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      passkey.privateKey,
      new Uint8Array([...authenticatorData, ...clientDataHash]),
    ),
  );
  const integer = (half: Uint8Array) => {
    let at = 0;
    while (at < half.length - 1 && half[at] === 0) at++;
    const bytes = half.subarray(at);
    const positive = bytes[0]! & 0x80 ? [0, ...bytes] : [...bytes];
    return [0x02, positive.length, ...positive];
  };
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  const answer = await ask(env, "/sign-in/passkey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      statement,
      credentialId: passkey.credentialId,
      sig: base64url(new Uint8Array([0x30, body.length, ...body])),
      authenticatorData: base64url(authenticatorData),
      clientDataJSON: base64url(clientDataJSON),
      next,
    }),
  });
  const parsed = (await answer.json()) as { next?: string };
  return {
    status: answer.status,
    cookie: cookieOf(answer, "__Host-iterate-auth-session"),
    next: parsed.next,
  };
}
