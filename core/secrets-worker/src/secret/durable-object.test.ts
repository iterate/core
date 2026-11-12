import { timingSafeEqual } from "node:crypto";
import {
  SECRET_HELD_HEADER,
  SECRET_USE_HEADER,
  VAULT_ANSWER_HEADER,
} from "iterate/secret-placeholder";
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { expect, test, vi } from "vitest";
import type { Envelope } from "iterate/signed";
import { hmacSha256Hex } from "../secrets.ts";
import { encryptSecretMaterial } from "../secret-at-rest.ts";
import { APPROVED, HOLD_MS, MAX_WAITING, REJECTED, SecretDurableObject } from "./durable-object.ts";

// workerd's own comparison, which Node's Web Crypto has not got
Object.assign(crypto.subtle, { timingSafeEqual });

const PATH = "/secrets/gmail";
const MEMBER = "key-member";
const UNCHECKED = "key-member-unchecked";

test("a matching request is held at once with its fact, and the wait call sends it once with the real value", async () => {
  const { secret, sent, approve } = await vault();
  const first = await secret.fetch(gmailPost("hello"));
  const { digest } = (await first.clone().json()) as { digest: string };
  expect({
    status: first.status,
    kind: first.headers.get(VAULT_ANSWER_HEADER),
    facts: decodeFacts(first.headers.get(FACTS_HEADER) || ""),
    sent,
  }).toMatchObject({
    status: 202,
    kind: "held",
    facts: [
      {
        path: PATH,
        events: [
          {
            type: "events.iterate.com/secret/approval-requested",
            payload: { digest, method: "POST" },
          },
          { payload: { status: 202 } },
        ],
      },
    ],
    sent: [],
  });
  const waited = secret.fetch(waitCall(digest));
  await approve(digest);
  expect({ status: (await waited).status, sent }).toEqual({
    status: 200,
    sent: [{ authorization: "Bearer real-token-aaaa", body: '{"raw":"hello"}', extra: null }],
  });
  const again = await secret.fetch(gmailPost("hello"));
  expect({
    status: again.status,
    kind: again.headers.get(VAULT_ANSWER_HEADER),
    sends: sent.length,
  }).toEqual({
    status: 409,
    kind: "sent-before",
    sends: 1,
  });
});

test("a wait call sends the stored text, not the body or headers it carries itself", async () => {
  const { secret, sent, approve } = await vault();
  const digest = await held(secret, "stored");
  const waited = secret.fetch(
    waitCall(digest, { body: '{"raw":"other"}', headers: { "x-extra": "1" } }),
  );
  await approve(digest);
  await waited;
  expect(sent).toEqual([
    { authorization: "Bearer real-token-aaaa", body: '{"raw":"stored"}', extra: null },
  ]);
});

test("a wait call for a digest that does not wait in this secret is refused", async () => {
  const other = await vault();
  const digest = await held(other.secret, "elsewhere");
  const { secret, sent } = await vault();
  const answer = await secret.fetch(waitCall(digest));
  expect({
    status: answer.status,
    kind: answer.headers.get(VAULT_ANSWER_HEADER),
    sends: sent.length,
  }).toEqual({
    status: 404,
    kind: "refused",
    sends: 0,
  });
});

test("two wait calls for one request send it once", async () => {
  const { secret, sent, approve } = await vault();
  const digest = await held(secret, "twice");
  const both = [secret.fetch(waitCall(digest)), secret.fetch(waitCall(digest))];
  await approve(digest);
  const statuses = (await Promise.all(both)).map((answer) => answer.status).sort();
  expect({ statuses, sends: sent.length }).toEqual({ statuses: [200, 409], sends: 1 });
});

test("an approved request with no wait call is never sent, and the identical retry sends it at once", async () => {
  const { secret, sent, approve } = await vault();
  const digest = await held(secret, "later");
  await approve(digest);
  // nothing asks for it: a caller that never makes the wait call sends nothing
  expect(sent).toEqual([]);
  expect({ status: (await secret.fetch(gmailPost("later"))).status, sends: sent.length }).toEqual({
    status: 200,
    sends: 1,
  });
});

test("a rejection answers the wait call 403 with the reason, and nothing is sent", async () => {
  const { secret, sent, decide } = await vault();
  const digest = await held(secret, "no");
  const waited = secret.fetch(waitCall(digest));
  await decide(MEMBER, { type: REJECTED, about: [digest], payload: { reason: "not this one" } });
  const answer = await waited;
  expect({
    status: answer.status,
    kind: answer.headers.get(VAULT_ANSWER_HEADER),
    text: await answer.text(),
    sends: sent.length,
  }).toMatchObject({
    status: 403,
    kind: "rejected",
    text: expect.stringContaining("not this one"),
    sends: 0,
  });
});

test.for([
  {
    name: "a service's key, such as the Cloud's, approves nothing",
    key: "key-cloud",
    about: true,
    path: PATH,
    refused: "only a member's key",
  },
  {
    name: "a statement for another secret approves nothing",
    key: MEMBER,
    about: true,
    path: "/secrets/other",
    refused: "is about /secrets/other",
  },
  {
    name: "a statement with no digests approves nothing",
    key: MEMBER,
    about: false,
    path: PATH,
    refused: "names no request",
  },
])("$name, and the wait call runs out", async ({ key, about, path, refused }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { secret, sent, decide } = await vault();
    const digest = await held(secret, "wait");
    const waited = secret.fetch(waitCall(digest));
    const answer = await decide(key, { type: APPROVED, about: about ? [digest] : [], path });
    // the wait call holds once its timer is set
    await vi.waitFor(() => expect(vi.getTimerCount()).toEqual(1));
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    const expired = await waited;
    expect({
      refusal: answer.result.error,
      status: expired.status,
      kind: expired.headers.get(VAULT_ANSWER_HEADER),
      sends: sent.length,
    }).toMatchObject({
      refusal: expect.stringContaining(refused),
      status: 403,
      kind: "waiting",
      sends: 0,
    });
  } finally {
    vi.useRealTimers();
  }
});

test("a rule set while a request is being sent holds it: the rule is read again right before it leaves", async () => {
  const { secret, sent, state } = await vault();
  const get = useRequest("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
    method: "GET",
  });
  // the rule names POST when the request arrives, and GET too by the time it would leave
  const read = state.storage.kv.get;
  let reads = 0;
  state.storage.kv.get = (key: string) =>
    key === "approval-rule" && ++reads > 1
      ? { methods: ["GET", "POST"], hosts: ["gmail.googleapis.com"] }
      : read(key);
  const answer = await secret.fetch(get);
  expect({
    status: answer.status,
    kind: answer.headers.get(VAULT_ANSWER_HEADER),
    sent,
  }).toEqual({ status: 409, kind: "refused", sent: [] });
});

test("a flood of requests is refused past the limit, and nothing is stored for it", async () => {
  const { secret, sent } = await vault();
  for (let n = 0; n < MAX_WAITING; n += 1) await held(secret, `message ${n}`);
  const over = await secret.fetch(gmailPost("one too many"));
  expect({
    status: over.status,
    kind: over.headers.get(VAULT_ANSWER_HEADER),
    sent,
  }).toMatchObject({ status: 429, kind: "refused", sent: [] });
});

test("a request the rule does not match is sent at once, and an upstream's copy of the vault's header goes", async () => {
  const { secret, upstream } = await vault();
  upstream.mockResolvedValue(new Response("ok", { headers: { [VAULT_ANSWER_HEADER]: "waiting" } }));
  const answer = await secret.fetch(
    useRequest("https://gmail.googleapis.com/gmail/v1/users/me/messages", { method: "GET" }),
  );
  expect({
    status: answer.status,
    header: answer.headers.get(VAULT_ANSWER_HEADER),
    sends: upstream.mock.calls.length,
  }).toEqual({
    status: 200,
    header: null,
    sends: 1,
  });
});

test("a rule with strings of the body lets a read go with its body whole, and holds a send", async () => {
  const { secret, sent, decide } = await vault();
  // holds less than the rule before it, so a member signs it
  await decide(MEMBER, {
    type: "events.iterate.com/secret/approval-rule-configured",
    payload: {
      rule: { methods: ["POST"], hosts: ["gmail.googleapis.com"], jsonStrings: ["messages/send"] },
    },
  });
  const post = (body: string) =>
    secret.fetch(
      useRequest("https://gmail.googleapis.com/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
  const read = JSON.stringify({ calls: ["messages/list"] });
  const answers = [
    await post(read),
    await post(JSON.stringify({ calls: ["messages/send"] })),
    await post("not JSON"),
  ];
  expect({
    statuses: answers.map((answer) => answer.status),
    kinds: answers.map((answer) => answer.headers.get(VAULT_ANSWER_HEADER)),
    sent,
  }).toEqual({
    statuses: [200, 202, 202],
    kinds: [null, "held", "held"],
    sent: [{ authorization: "Bearer real-token-aaaa", body: read, extra: null }],
  });
});

test("a member's passkey that did not check its user approves no request and changes no rule", async () => {
  const { secret, sent, decide } = await vault();
  const digest = await held(secret, "hello");
  const answers = [
    await decide(UNCHECKED, { type: APPROVED, about: [digest] }),
    await decide(UNCHECKED, {
      type: "events.iterate.com/secret/approval-rule-configured",
      payload: { rule: null },
    }),
  ];
  expect(answers.map((answer) => answer.result.error)).toEqual([
    expect.stringContaining("did not check that it is you"),
    expect.stringContaining("did not check that it is you"),
  ]);
  expect({ sent, approvals: await secret.approvals(PATH) }).toMatchObject({
    sent: [],
    approvals: { rule: { methods: ["POST"] }, held: [{ digest, state: "waiting" }] },
  });
});

test("a delete that comes in while a new value is being sealed is the later word: the value is not stored", async () => {
  const { secret } = await vault();
  // not awaited: it has reserved its version and seals
  const set = secret.secret(PATH, "set", {
    material: "newer-token-bbbb",
    urls: ["https://gmail.googleapis.com"],
  });
  const stored = expect(set).rejects.toThrow("deleted while this value was being stored");
  await secret.secret(PATH, "delete", {});
  await stored;
  expect(await secret.secret(PATH, "describe", {})).toEqual({ path: PATH, set: false });
  // a value set after the delete is kept
  await secret.secret(PATH, "set", { material: "newest", urls: ["https://gmail.googleapis.com"] });
  expect(await secret.secret(PATH, "describe", {})).toMatchObject({ set: true });
});

test("a secret's object keeps its own row in the vault's list of set secrets: there when it is set, gone when it is deleted, and right when the two cross", async () => {
  const { secret, listedAsSet } = await vault();
  const value = { material: "newer-token-bbbb", urls: ["https://gmail.googleapis.com"] };
  expect(listedAsSet()).toEqual([PATH]);
  await secret.secret(PATH, "delete", {});
  expect(listedAsSet()).toEqual([]);
  // a set that a delete overtakes stores nothing, and leaves no row
  await secret.secret(PATH, "set", value);
  const lost = expect(secret.secret(PATH, "set", value)).rejects.toThrow("deleted while");
  await secret.secret(PATH, "delete", {});
  await lost;
  expect(await secret.secret(PATH, "describe", {})).toEqual({ path: PATH, set: false });
  expect(listedAsSet()).toEqual([]);
  await secret.secret(PATH, "set", value);
  expect(listedAsSet()).toEqual([PATH]);
  // the vault's list asks for this when a row and its object disagree: the object writes what it is
  await secret.keepListed(PATH);
  expect(listedAsSet()).toEqual([PATH]);
});

test("a set whose value a delete took while the vault's list was written is refused, and no fact says that the secret is set", async () => {
  const { secret, listedAsSet, holdListCall } = await vault();
  const value = { material: "newer-token-bbbb", urls: ["https://gmail.googleapis.com"] };
  // a write calls the list once before it stores and once after: the second call is held open
  const afterTheStore = holdListCall(2);
  const set = secret.secret(PATH, "set", value).then(
    () => "set",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  const letGo = await afterTheStore;
  // the value is stored now, and the delete takes it
  const deleted = await secret.secret(PATH, "delete", {});
  letGo();

  expect(await set).toContain("deleted while this value was being stored");
  expect(deleted).toMatchObject({
    facts: [{ path: PATH, events: [{ type: "events.iterate.com/secret/deleted" }] }],
  });
  expect(await secret.secret(PATH, "describe", {})).toEqual({ path: PATH, set: false });
  expect(listedAsSet()).toEqual([]);
});

test("a delete that a set overtook while the vault's list was written gives no fact: the set's own fact is the last word", async () => {
  const { secret, listedAsSet, holdListCall } = await vault();
  const value = { material: "newer-token-bbbb", urls: ["https://gmail.googleapis.com"] };
  // a delete clears the object and then calls the list: that call is held open
  const afterTheClear = holdListCall(1);
  const deleted = secret.secret(PATH, "delete", {});
  const letGo = await afterTheClear;
  // nothing is held now, and the set stores a value
  const set = await secret.secret(PATH, "set", value);
  letGo();

  expect(await deleted).toMatchObject({ result: { path: PATH }, facts: [] });
  expect(set).toMatchObject({
    facts: [{ path: PATH, events: [{ type: "events.iterate.com/secret/set" }] }],
  });
  expect(await secret.secret(PATH, "describe", {})).toMatchObject({ set: true });
  expect(listedAsSet()).toEqual([PATH]);
});

test("an import with no proof keeps nothing of the cell: the cell with its proof is still taken after it, once", async () => {
  const { secret } = await vault();
  // a cell of an old mind: its value does not open here, which the proof does not depend on
  const cell = JSON.stringify({
    context: "old-mind:/secrets/gmail",
    urls: ["https://gmail.googleapis.com"],
    refresh: null,
    nonce: "nonce-of-the-old-cell",
    material: { algorithm: "AES-256-GCM+SECRET-V1", iv: "AAAA", ciphertext: "AAAA" },
  });
  const proof = await hmacSha256Hex("at-rest-key-for-tests-only", JSON.stringify([PATH, cell]));
  const importing = (given: string) => secret.secret(PATH, "importSealed", { cell, proof: given });

  // whoever does not hold the at-rest key names the cell and proves nothing
  await expect(importing("0".repeat(64))).rejects.toThrow("no proof under the at-rest key");
  // The cell's own import is not shut out by that: it gets as far as the value.
  await expect(importing(proof)).rejects.toThrow("does not open under this stack's at-rest key");
  // a proven cell is taken once: its proof is good for ever
  await expect(importing(proof)).rejects.toThrow("imported once already");
});

test("a rule with a path that never waits lets a file go there, and refuses the same bytes at the API's own address", async () => {
  const { secret, upstream, decide } = await vault();
  await decide(MEMBER, {
    type: "events.iterate.com/secret/approval-rule-configured",
    payload: {
      rule: {
        methods: ["POST"],
        hosts: ["gmail.googleapis.com"],
        jsonStrings: ["messages/send"],
        freePaths: ["/upload/"],
      },
    },
  });
  // the first bytes of a JPEG: no text, so no JSON
  const file = (path: string) =>
    secret.fetch(
      useRequest(`https://gmail.googleapis.com${path}`, {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      }),
    );
  const answers = [await file("/upload/u1/"), await file("/batch"), await file("/upload/u%31/")];
  expect({
    statuses: answers.map((answer) => answer.status),
    kinds: answers.map((answer) => answer.headers.get(VAULT_ANSWER_HEADER)),
    sends: upstream.mock.calls.length,
  }).toEqual({ statuses: [200, 415, 415], kinds: [null, "refused", "refused"], sends: 1 });
});

test("a POST that a header makes a DELETE is held by a rule for DELETE, and a plain POST is not", async () => {
  const { secret, sent, decide } = await vault();
  await decide(MEMBER, {
    type: "events.iterate.com/secret/approval-rule-configured",
    payload: { rule: { methods: ["DELETE"], hosts: ["gmail.googleapis.com"] } },
  });
  const post = (headers: Record<string, string>) =>
    secret.fetch(
      useRequest("https://gmail.googleapis.com/gmail/v1/users/me/messages/m1", {
        method: "POST",
        headers,
        body: "{}",
      }),
    );
  const answers = [await post({}), await post({ "X-HTTP-Method-Override": "DELETE" })];
  expect({
    statuses: answers.map((answer) => answer.status),
    kinds: answers.map((answer) => answer.headers.get(VAULT_ANSWER_HEADER)),
    sends: sent.length,
  }).toEqual({ statuses: [200, 202], kinds: [null, "held"], sends: 1 });
});

test("a secret with an approval rule signs nothing on the side, and still checks a signature", async () => {
  const { secret, decide } = await vault();
  await secret.secret(PATH, "set", {
    material: "signing-key-aaaa",
    urls: ["https://gmail.googleapis.com"],
    operations: ["signHmac", "verifyHmac"],
  });
  const signed = () => secret.secret(PATH, "signHmac", { payload: "pay 5 to jo" });
  // the rule of `vault()` stands: what the secret signed would leave in a request it never sees
  expect(await signed()).toMatchObject({
    refused: { code: "FORBIDDEN", message: expect.stringContaining("has an approval rule") },
  });
  expect(
    await secret.secret(PATH, "verifyHmac", { payload: "pay 5 to jo", signature: "00" }),
  ).toMatchObject({ result: false });
  await decide(MEMBER, {
    type: "events.iterate.com/secret/approval-rule-configured",
    payload: { rule: null },
  });
  expect(await signed()).toMatchObject({ result: expect.stringMatching(/^[0-9a-f]{64}$/) });
});

test("an ask of the Cloud that the secret's rule names is held, and is sent once a member approves it", async () => {
  const CLOUD = "https://cloud.example.com";
  const { secret, upstream, approve } = await vault({
    cloud: CLOUD,
    rule: { methods: ["POST"], hosts: ["cloud.example.com"] },
  });
  const ask = () =>
    useRequest(`${CLOUD}/clients/github/ask/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "an answer for a person" }),
    });
  const first = await secret.fetch(ask());
  const { digest } = (await first.clone().json()) as { digest: string };
  // held as any request the rule names: nothing has gone to the Cloud
  expect({
    status: first.status,
    kind: first.headers.get(VAULT_ANSWER_HEADER),
    sends: upstream.mock.calls.length,
  }).toEqual({ status: 202, kind: "held", sends: 0 });
  const waited = secret.fetch(
    useRequest(`${CLOUD}/clients/github/ask/reply`, {
      method: "POST",
      headers: { [SECRET_HELD_HEADER]: digest },
    }),
  );
  await approve(digest);
  const answer = await waited;
  const [sent] = upstream.mock.calls.map(([request]) => request);
  expect({
    status: answer.status,
    sends: upstream.mock.calls.length,
    url: sent?.url,
    // the Cloud gets the stack's signed statement and no header that names the secret
    namesTheSecret: sent?.headers.get("authorization"),
    facts: decodeFacts(answer.headers.get(FACTS_HEADER) || "")[0]?.events.at(-1),
  }).toMatchObject({
    status: 200,
    sends: 1,
    url: `${CLOUD}/clients/github/ask/reply`,
    namesTheSecret: null,
    facts: { type: "events.iterate.com/secret/used", payload: { status: 200, digest } },
  });
});

test("an ask of the Cloud that the rule does not name goes at once, with no value of the secret", async () => {
  const CLOUD = "https://cloud.example.com";
  // the rule names the provider's host, not the Cloud's
  const { secret, upstream } = await vault({ cloud: CLOUD });
  const answer = await secret.fetch(
    useRequest(`${CLOUD}/clients/github/ask/reply`, { method: "POST", body: "{}" }),
  );
  expect({
    status: answer.status,
    sends: upstream.mock.calls.length,
    namesTheSecret: upstream.mock.calls[0]?.[0].headers.get("authorization"),
  }).toEqual({ status: 200, sends: 1, namesTheSecret: null });
});

test("a person's grant that the Cloud brokers is refreshed on word: the Cloud is asked with the stack's statement, and the secret holds what the provider gave", async () => {
  const { secret } = await vault({ cloud: CLOUD_OF_GRANTS, material: GRANT });
  const cloud = cloudThatAnswers(() =>
    Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 28800 }),
  );

  expect(await secret.refreshGrant(PATH)).toEqual({
    result: { outcome: "refreshed" },
    facts: [{ path: PATH, events: [REFRESHED(true)] }],
  });
  // the next refresh sends the token that this one brought: each refresh token works once
  await secret.refreshGrant(PATH);

  expect(cloud).toMatchObject({
    asked: [
      { url: `${CLOUD_OF_GRANTS}/clients/github/token`, refreshToken: "old-refresh", signed: true },
      { url: `${CLOUD_OF_GRANTS}/clients/github/token`, refreshToken: "new-refresh", signed: true },
    ],
  });
});

test("a refresh on word that the provider refuses says so, and the secret is as it was", async () => {
  const { secret } = await vault({ cloud: CLOUD_OF_GRANTS, material: GRANT });
  const cloud = cloudThatAnswers(() => new Response("bad_refresh_token", { status: 401 }));

  const refused = await secret.refreshGrant(PATH);
  // it deletes nothing: the secret is set, and the next try sends the same refresh token
  await secret.refreshGrant(PATH);

  expect(refused).toMatchObject({
    result: { outcome: "failed", error: expect.stringContaining("answered 401") },
    facts: [{ path: PATH, events: [{ payload: { kind: "oauth-refresh-token", ok: false } }] }],
  });
  expect(await secret.secret(PATH, "describe", {})).toMatchObject({ set: true });
  expect(cloud.asked.map((ask) => ask.refreshToken)).toEqual(["old-refresh", "old-refresh"]);
});

test("a refresh on word of a secret that is no grant of the Cloud's asks nobody", async () => {
  // a plain token; and a grant with a client of the mind's own would refresh when its provider asks
  const { secret } = await vault();
  const cloud = cloudThatAnswers(() => Response.json({}));

  expect(await secret.refreshGrant(PATH)).toEqual({
    result: { outcome: "not-a-brokered-grant" },
    facts: [],
  });
  await secret.secret(PATH, "delete", {});
  expect(await secret.refreshGrant(PATH)).toMatchObject({
    result: { outcome: "not-a-brokered-grant" },
  });
  expect(cloud).toMatchObject({ asked: [] });
});

test("a rule cannot be loosened without a signature, and a member's signed statement removes it", async () => {
  const { secret, decide } = await vault();
  const by = { userId: "user_aaaa", email: "member@example.com" };
  await expect(
    secret.tightenRule(PATH, { rule: { methods: ["PUT"], hosts: ["gmail.googleapis.com"] }, by }),
  ).rejects.toThrow(
    `That takes your key, whether the rules for mail and calls are locked or not: go back, and press "Sign and save" in the block of ${PATH}`,
  );
  await decide(MEMBER, {
    type: "events.iterate.com/secret/approval-rule-configured",
    payload: { rule: null },
  });
  expect(await secret.approvals(PATH)).toEqual({ rule: null, held: [] });
});

/** A vault with one secret and its rule. With `cloud`, the secret is one connected through the
 *  Cloud's client `github`, and the stack signs what it asks of that Cloud. */
async function vault(
  options: {
    cloud?: string;
    rule?: { methods: string[]; hosts: string[] };
    /** What the secret holds, when a plain token is not enough: a grant's tokens. */
    material?: Record<string, string>;
  } = {},
) {
  const sent: { authorization: string | null; body: string; extra: string | null }[] = [];
  const upstream = vi.fn(async (request: Request) => {
    sent.push({
      authorization: request.headers.get("authorization"),
      body: await request.text(),
      extra: request.headers.get("x-extra"),
    });
    return new Response("sent");
  });
  vi.stubGlobal("fetch", upstream);
  const sets = new Map<string, Set<string>>();
  const list: { calls: number; wait?: (call: number) => Promise<void> } = { calls: 0 };
  const env = {
    DOMAIN: "example.com",
    CLOUD_ORIGIN: options.cloud,
    SECRETS_AT_REST_KEY: "at-rest-key-for-tests-only",
    // the vault's sets of paths, by name: "index" (a rule or a held request) and "set"
    APPROVALS: {
      getByName: (name: string) => {
        const paths = sets.get(name) ?? new Set<string>();
        sets.set(name, paths);
        // A call of the list is a call of another object: it lets another call of the secret's
        // object in. A test holds one call open to put a set or a delete into that moment.
        const called = async () => {
          list.calls += 1;
          await list.wait?.(list.calls);
        };
        return {
          add: async (path: string) => {
            await called();
            paths.add(path);
          },
          remove: async (path: string) => {
            await called();
            paths.delete(path);
          },
        };
      },
    },
    // believes the statement: who signed is the key the envelope names
    AUTH: {
      sign: async (input: object) => ({
        statement: JSON.stringify(input),
        signature: { format: "p256", key: "key-stack", sig: "sig" },
      }),
      verify: async (envelope: Envelope) => ({
        signer: {
          principal: { actor: envelope.signature.key },
          key: envelope.signature.key,
          label: "test key",
          member: envelope.signature.key.startsWith(MEMBER),
          // a passkey says whether it checked its user; this one did not
          ...(envelope.signature.key === UNCHECKED && { userVerified: false }),
        },
        statement: JSON.parse(envelope.statement),
      }),
    },
  };
  // the cast: the object reads only the bindings above
  const state = fakeState(PATH);
  const secret = new SecretDurableObject(state as never, env as never);
  await secret.secret(PATH, "set", {
    material: options.material || "real-token-aaaa",
    urls: ["https://gmail.googleapis.com"],
  });
  if (options.cloud) {
    // Only a connect through the Cloud's own page makes such a secret (`set` refuses a client):
    // the stored cell is given what that connect writes, the client's name and its broker.
    // The value is sealed again with it: a cell opens only as the thing it was sealed as.
    // the cast: the stored cell, as the object's own seal wrote it a moment ago
    const current = state.storage.kv.get("current") as {
      cell: {
        context: string;
        urls: string[];
        version: number;
        nonce: string;
        material: unknown;
        refresh: unknown;
        placement: string;
        operations: string[];
        lendTo?: string[] | null;
      };
    };
    const {
      context,
      urls,
      version,
      nonce,
      material: _sealed,
      refresh: _none,
      ...use
    } = current.cell;
    const refresh = {
      kind: "oauth-refresh-token" as const,
      tokenEndpoint: `${options.cloud}/clients/github/token`,
      client: { cloud: "github" },
    };
    const material = await encryptSecretMaterial(
      options.material || "real-token-aaaa",
      { context, urls, refresh, version, nonce, use },
      env.SECRETS_AT_REST_KEY,
    );
    state.storage.kv.put("current", { ...current, cell: { ...current.cell, refresh, material } });
  }
  await secret.tightenRule(PATH, {
    rule: options.rule || { methods: ["POST"], hosts: ["gmail.googleapis.com"] },
    by: { userId: "user_aaaa", email: "member@example.com" },
  });
  const decide = (
    key: string,
    fields: { type: string; about?: string[]; payload?: object; path?: string },
  ) =>
    secret.decide(PATH, {
      statement: JSON.stringify({
        mind: "example.com",
        path: PATH,
        at: 0,
        expires: 1,
        nonce: "n",
        ...fields,
      }),
      signature: { format: "p256", key, sig: "sig" },
    });
  return {
    secret,
    state,
    upstream,
    sent,
    decide,
    approve: (digest: string) => decide(MEMBER, { type: APPROVED, about: [digest] }),
    /** The paths in the vault's set of secrets that are set. */
    listedAsSet: () => [...(sets.get("set") ?? [])],
    /** Holds the list's call that is `after` calls from now open. Answers a promise that settles
     *  when that call has come, with the function that lets it go on. */
    holdListCall: (after: number) => {
      const at = list.calls + after;
      return new Promise<() => void>((reached) => {
        list.wait = (call) =>
          call === at ? new Promise<void>((go) => reached(go)) : Promise.resolve();
      });
    },
  };
}

async function held(secret: SecretDurableObject, raw: string): Promise<string> {
  const answer = await secret.fetch(gmailPost(raw));
  return ((await answer.json()) as { digest: string }).digest;
}

function waitCall(digest: string, init: { body?: string; headers?: Record<string, string> } = {}) {
  return useRequest("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { "content-type": "application/json", [SECRET_HELD_HEADER]: digest, ...init.headers },
    body: init.body,
  });
}

function useRequest(url: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer getSecret("${PATH}")`);
  headers.set(SECRET_USE_HEADER, PATH);
  return new Request(url, { ...init, headers });
}

function gmailPost(raw: string) {
  return useRequest("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { "content-type": "application/json", traceparent: `00-${crypto.randomUUID()}-01` },
    body: JSON.stringify({ raw }),
  });
}

// ordered as SQLite's
function fakeState(name: string) {
  const store = new Map<string, unknown>();
  return {
    id: { name },
    exports: {},
    storage: {
      kv: {
        get: (key: string) => structuredClone(store.get(key)),
        put: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
        delete: (key: string) => store.delete(key),
        list: ({ prefix = "" }: { prefix?: string } = {}) =>
          [...store.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, value]) => [key, structuredClone(value)]),
      },
    },
  };
}

const CLOUD_OF_GRANTS = "https://cloud.example.com";
/** A person's grant as a connect through the Cloud leaves it: the tokens and the client's id. */
const GRANT = { accessToken: "old-access", refreshToken: "old-refresh", clientId: "Iv1.client" };
const REFRESHED = (ok: boolean) => ({
  type: "events.iterate.com/secret/refreshed",
  payload: { kind: "oauth-refresh-token", ok },
});

/** The Cloud's token route, standing in for `fetch`: what each call asked, and `answer` to it. */
function cloudThatAnswers(answer: () => Response) {
  const asked: { url: string; refreshToken: string | null; signed: boolean }[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    asked.push({
      url: request.url,
      refreshToken: new URLSearchParams(await request.text()).get("refresh_token"),
      signed: request.headers.has("iterate-statement"),
    });
    return answer();
  });
  return { asked };
}
