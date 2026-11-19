// The two secrets that the stack made (./stack-secrets.ts), through the secret's own object: what
// `describe` says, a use pinned to Cloudflare's Realtime API, and the verbs that are refused.
import { timingSafeEqual } from "node:crypto";
import { SECRET_USE_HEADER } from "iterate/secret-placeholder";
import { expect, test, vi } from "vitest";
import { SecretDurableObject } from "./secret/durable-object.ts";
import { REALTIME_ORIGIN, REALTIME_SFU_PATH, TURN_PATH } from "./stack-secrets.ts";

// workerd's own comparison, which Node's Web Crypto has not got
Object.assign(crypto.subtle, { timingSafeEqual });

const MADE = {
  sfu: { appId: "the-sfu-app", appSecret: "an app secret for a test" },
  turn: { keyId: "the-turn-key", apiToken: "a turn token for a test" },
};
const REFUSAL = "Authentication error (HTTP 403, code 10000): the deploy may not";
const NOT_MADE = { sfu: { refusal: REFUSAL }, turn: { refusal: REFUSAL } };

test("a stack that made both: each path is set, pinned to Cloudflare's Realtime API, with its id public", async () => {
  expect(
    await secretAt(REALTIME_SFU_PATH, MADE).secret.secret(REALTIME_SFU_PATH, "describe", undefined),
  ).toEqual({
    path: REALTIME_SFU_PATH,
    set: true,
    urls: [REALTIME_ORIGIN],
    public: { appId: "the-sfu-app" },
    placement: "header",
    operations: [],
    lendTo: [],
  });
  expect(
    await secretAt(TURN_PATH, MADE).secret.secret(TURN_PATH, "describe", undefined),
  ).toMatchObject({ set: true, urls: [REALTIME_ORIGIN], public: { keyId: "the-turn-key" } });
});

test("a TURN credential is asked for with the key's token, which reaches Cloudflare alone", async () => {
  const { secret, sent } = secretAt(TURN_PATH, MADE);
  const url = `${REALTIME_ORIGIN}/v1/turn/keys/the-turn-key/credentials/generate`;
  const answer = await secret.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        [SECRET_USE_HEADER]: TURN_PATH,
        authorization: `Bearer getSecret("${TURN_PATH}", { field: "apiToken" })`,
      },
      body: JSON.stringify({ ttl: 600 }),
    }),
  );
  expect(answer).toMatchObject({ status: 201 });
  expect(sent).toEqual([{ url, authorization: "Bearer a turn token for a test" }]);
  // anywhere else, the token does not go
  const elsewhere = await secret.fetch(
    new Request("https://example.net/steal", {
      headers: {
        [SECRET_USE_HEADER]: TURN_PATH,
        authorization: `Bearer getSecret("${TURN_PATH}", { field: "apiToken" })`,
      },
    }),
  );
  expect(elsewhere).toMatchObject({ status: 403 });
  expect(sent).toHaveLength(1);
});

test("a stack that made neither: each path is not set, with the deploy's reason, and sends nothing", async () => {
  const { secret, sent } = secretAt(REALTIME_SFU_PATH, NOT_MADE);
  expect(await secret.secret(REALTIME_SFU_PATH, "describe", undefined)).toEqual({
    path: REALTIME_SFU_PATH,
    set: false,
    reason: REFUSAL,
  });
  const answer = await secret.fetch(
    new Request(`${REALTIME_ORIGIN}/v1/apps/the-sfu-app/sessions/new`, {
      method: "POST",
      headers: {
        [SECRET_USE_HEADER]: REALTIME_SFU_PATH,
        authorization: `Bearer getSecret("${REALTIME_SFU_PATH}", { field: "appSecret" })`,
      },
    }),
  );
  expect(answer).toMatchObject({ status: 403 });
  expect(sent).toEqual([]);
});

test.for([
  "set",
  "delete",
  "deleteIfProxy",
  "exportSealed",
  "beginOAuth",
  "collectFromUser",
  "signHmac",
])("the mind may not %s a secret that the stack made", async (verb) => {
  const { secret } = secretAt(TURN_PATH, MADE);
  await expect(
    secret.secret(TURN_PATH, verb, { material: "x", urls: ["https://example.net"] }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

/** The secret's object at `path`, in a stack whose deploy left `cloudflareRealtime`, and each
 *  request that left it. */
function secretAt(path: string, cloudflareRealtime: object) {
  const sent: { url: string; authorization: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, authorization: request.headers.get("authorization") });
    return Response.json({ iceServers: {} }, { status: 201 });
  });
  const store = new Map<string, unknown>();
  const state = {
    id: { name: path },
    exports: {},
    storage: {
      kv: {
        get: (key: string) => structuredClone(store.get(key)),
        put: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
        delete: (key: string) => store.delete(key),
        list: () => [],
      },
    },
  };
  const env = {
    ITERATE: JSON.stringify({
      mindId: "a".repeat(64),
      controlPlaneHostname: "iterate.example.com",
      zones: ["example.com"],
      ownerEmails: ["owner@example.net"],
      topology: "full-cloudflare",
    }),
    ITERATE__AT_REST_KEY: "at-rest-key-for-tests-only",
    ITERATE__CLOUDFLARE_REALTIME: JSON.stringify(cloudflareRealtime),
    APPROVALS: { getByName: () => ({ add: async () => {}, remove: async () => {} }) },
  };
  // the cast: the object reads only the bindings above
  return { secret: new SecretDurableObject(state as never, env as never), sent };
}
