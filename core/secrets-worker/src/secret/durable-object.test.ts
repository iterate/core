import {
  SECRET_HELD_HEADER,
  SECRET_USE_HEADER,
  VAULT_ANSWER_HEADER,
} from "iterate/secret-placeholder";
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { expect, test, vi } from "vitest";
import type { Envelope } from "iterate/signed";
import { APPROVED, HOLD_MS, MAX_WAITING, REJECTED, SecretDurableObject } from "./durable-object.ts";

const PATH = "/secrets/gmail";
const MEMBER = "key-member";

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

test("a rule cannot be loosened without a signature, and a member's signed statement removes it", async () => {
  const { secret, decide } = await vault();
  const by = { userId: "user_aaaa", email: "member@example.com" };
  await expect(
    secret.tightenRule(PATH, { rule: { methods: ["PUT"], hosts: ["gmail.googleapis.com"] }, by }),
  ).rejects.toThrow("needs a member's signed statement");
  await decide(MEMBER, {
    type: "events.iterate.com/secret/approval-rule-configured",
    payload: { rule: null },
  });
  expect(await secret.approvals(PATH)).toEqual({ rule: null, held: [] });
});

async function vault() {
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
  const env = {
    DOMAIN: "example.com",
    SECRETS_AT_REST_KEY: "at-rest-key-for-tests-only",
    APPROVALS: { getByName: () => ({ add: async () => {}, remove: async () => {} }) },
    // believes the statement: who signed is the key the envelope names
    AUTH: {
      verify: async (envelope: Envelope) => ({
        signer: {
          principal: { actor: envelope.signature.key },
          key: envelope.signature.key,
          label: "test key",
          member: envelope.signature.key === MEMBER,
        },
        statement: JSON.parse(envelope.statement),
      }),
    },
  };
  // the cast: the object reads only the bindings above
  const state = fakeState(PATH);
  const secret = new SecretDurableObject(state as never, env as never);
  await secret.secret(PATH, "set", {
    material: "real-token-aaaa",
    urls: ["https://gmail.googleapis.com"],
  });
  await secret.tightenRule(PATH, {
    rule: { methods: ["POST"], hosts: ["gmail.googleapis.com"] },
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
