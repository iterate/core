import { timingSafeEqual } from "node:crypto";
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { SECRET_USE_HEADER } from "iterate/secret-placeholder";
import {
  base64url,
  envelopeOfStatementHeader,
  MIND_FETCH_STATEMENT_TYPE,
  signedMlDsa65,
  statementText,
  verifySignature,
} from "iterate/signed";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { hmacSha256Hex } from "../secrets.ts";
import { SecretDurableObject } from "./durable-object.ts";

// workerd's own comparison, which Node's Web Crypto has not got
Object.assign(crypto.subtle, { timingSafeEqual });

const PATH = "/secrets/openai";
/** A cause as the kernel writes it (core/itx/src/cause.ts). */
const CAUSE = JSON.stringify({
  chain: "2026-11-19T00:00:00.000Z with a request ~n1",
  depth: 3,
  at: 1,
  hops: 2,
});
const PROXY = { mind: "iterate.example.com", url: "https://cloud.example.com/secret-proxy" };
const OPENAI = ["https://api.openai.com"];

test("a set with proxy stores no value, and describe, list's describe and the set fact carry the proxy", async () => {
  const { secret } = await vault();
  const answer = await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  expect(answer).toMatchObject({
    facts: [
      {
        path: PATH,
        events: [
          {
            type: "events.iterate.com/secret/set",
            payload: { path: PATH, urls: OPENAI, proxy: PROXY, operations: [], lendTo: [] },
          },
        ],
      },
    ],
  });
  expect(await secret.secret(PATH, "describe", undefined)).toEqual({
    path: PATH,
    set: true,
    urls: OPENAI,
    placement: "header",
    operations: [],
    lendTo: [],
    proxy: PROXY,
  });
});

test("a set with proxy refuses what does not go with it, each with a coded sentence", async () => {
  const { secret } = await vault();
  const set = (fields: Record<string, unknown>) =>
    secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY, ...fields });
  for (const [fields, words] of [
    ...[
      { material: "sk-own" },
      { refresh: { kind: "worker", source: "exchange" } },
      { operations: ["signHmac"] },
      { lendTo: [] },
      { placement: "url" },
      // the proxy gets the body as it was written: no value is here to put into it
      {
        bodyFields: [
          { method: "POST", url: "https://api.openai.com/v1/keys", field: "config.token" },
        ],
      },
      { merge: true },
      { public: ["mind"] },
      { urls: [] },
    ].map((fields) => [fields, "and nothing else"] as const),
    [{ proxy: { mind: "Iterate.Example.com", url: PROXY.url } }, "proxy.mind is"],
    [{ proxy: { ...PROXY, extra: 1 } }, "proxy is { mind, url }"],
  ] as const)
    await expect(set(fields)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining(words),
    });
  for (const url of [
    "http://cloud.example.com/secret-proxy",
    "https://cloud.example.com/secret-proxy/",
    "https://cloud.example.com/secret-proxy?key=1",
    "https://cloud.example.com/secret-proxy#part",
    "https://user:pass@cloud.example.com/secret-proxy",
  ])
    await expect(set({ proxy: { ...PROXY, url } })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("proxy.url is an https URL"),
    });
  expect(await secret.secret(PATH, "describe", undefined)).toEqual({ path: PATH, set: false });
});

test("a set with proxy is refused over anything set: a value or another proxy; a value over a proxy is an ordinary set", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const other = { mind: "other.example.net", url: "https://other.example.net/proxy" };
  await expect(
    secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: other }),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
    message: expect.stringContaining("is set or being set; delete it first"),
  });
  await secret.secret(PATH, "set", { material: "sk-own-aaaa", urls: OPENAI });
  expect(await secret.secret(PATH, "describe", undefined)).not.toHaveProperty("proxy");
  await expect(
    secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY }),
  ).rejects.toThrow("is set or being set; delete it first");
  const { sent } = useIs(new Response("own"));
  await secret.fetch(useRequest("https://api.openai.com/v1/responses", { method: "POST" }));
  expect(sent[0]?.url).toBe("https://api.openai.com/v1/responses");
  expect(sent[0]?.headers.authorization).toBe("Bearer sk-own-aaaa");
  // deleted first, the proxy is set
  await secret.secret(PATH, "delete", undefined);
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: other });
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({ proxy: other });
});
test("a use goes to the proxied URL, signed for the proxy's mind, with no header that names the secret and the caller's own headers and streamed body unchanged", async () => {
  const { secret, stackKey, signs } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const { sent } = useIs(new Response("proxied", { status: 401 }));
  const chunks = ['{"model":', '"gpt"}'];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const answer = await secret.fetch(
    useRequest("https://api.openai.com/v1/responses?stream=true", {
      method: "post",
      headers: {
        "content-type": "application/json",
        session_id: "session-aaaa",
        accept: "text/event-stream",
        "x-also-named": `getSecret("${PATH}")`,
      },
      body,
      duplex: "half",
    } as RequestInit),
  );
  // the answer as it came: a 401 from the proxy starts no refresh, and the proxy is asked once
  expect({ status: answer.status, text: await answer.text(), sends: sent.length }).toEqual({
    status: 401,
    text: "proxied",
    sends: 1,
  });
  const proxied = "https://cloud.example.com/secret-proxy/api.openai.com/v1/responses?stream=true";
  const { headers } = sent[0]!;
  expect(sent[0]).toMatchObject({ url: proxied, method: "POST", body: chunks.join("") });
  expect({
    authorization: headers.authorization,
    named: headers["x-also-named"],
    use: headers[SECRET_USE_HEADER],
    contentType: headers["content-type"],
    session: headers.session_id,
    accept: headers.accept,
  }).toEqual({
    authorization: undefined,
    named: undefined,
    use: undefined,
    contentType: "application/json",
    session: "session-aaaa",
    accept: "text/event-stream",
  });
  const envelope = envelopeOfStatementHeader(headers["iterate-auth-statement"]!);
  expect(envelope && (await verifySignature(envelope, stackKey, SITE))).toEqual({});
  expect(JSON.parse(envelope!.statement)).toMatchObject({
    mind: PROXY.mind,
    from: "iterate.ada.example",
    path: "/",
    type: MIND_FETCH_STATEMENT_TYPE,
    payload: { method: "POST", url: proxied },
  });
  expect(signs).toEqual([expect.objectContaining({ expiresInSeconds: 300 })]);
  expect(decodeFacts(answer.headers.get(FACTS_HEADER) || "")).toMatchObject([
    {
      path: PATH,
      events: [
        {
          type: "events.iterate.com/secret/used",
          payload: {
            method: "POST",
            url: "https://api.openai.com/v1/responses?stream=true",
            status: 401,
            proxy: proxied,
          },
        },
      ],
    },
  ]);
});

test("a use outside urls is refused before anything is signed or sent", async () => {
  const { secret, signs } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const { sent } = useIs(new Response("never"));
  const answer = await secret.fetch(useRequest("https://api.exa.ai/search", { method: "POST" }));
  expect({ status: answer.status, signs: signs.length, sends: sent.length }).toEqual({
    status: 403,
    signs: 0,
    sends: 0,
  });
});

test("a secret by proxy takes no approval rule: a set with proxy over a rule is refused, and a use under a rule that landed while it was set is refused: nothing is signed or sent", async () => {
  const { secret, signs, holdNextAdd } = await vault();
  const rule = { methods: ["POST"], hosts: ["api.openai.com"] };
  const by = { userId: "user_aaaa", email: "member@example.com" };
  // a rule that outlives a delete
  const ruled = await vault();
  await ruled.secret.tightenRule(PATH, { rule, by });
  await expect(
    ruled.secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY }),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
    message: expect.stringContaining("clear the rule first"),
  });
  // a rule set while the proxy's set is in flight
  const release = holdNextAdd();
  const setting = secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  await secret.tightenRule(PATH, { rule, by });
  release();
  await setting;
  const { sent } = useIs(new Response("never"));
  const answer = await secret.fetch(
    useRequest("https://api.openai.com/v1/responses", { method: "POST", body: "{}" }),
  );
  expect({
    status: answer.status,
    text: await answer.text(),
    signs: signs.length,
    sends: sent.length,
  }).toEqual({
    status: 403,
    text: expect.stringContaining("no approval rule holds it here"),
    signs: 0,
    sends: 0,
  });
  // a rule set on a secret by proxy is refused
  await expect(secret.tightenRule(PATH, { rule, by })).rejects.toThrow(
    "no approval rule holds it here",
  );
});
test("a WebSocket upgrade by proxy goes to the proxy with its upgrade header", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const { sent } = useIs(new Response("upgraded"));
  const answer = await secret.fetch(
    useRequest("https://api.openai.com/v1/responses", {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    }),
  );
  expect({ status: answer.status, url: sent[0]?.url, upgrade: sent[0]?.headers.upgrade }).toEqual({
    status: 200,
    url: "https://cloud.example.com/secret-proxy/api.openai.com/v1/responses",
    upgrade: "websocket",
  });
});

test("a secret by proxy is exported and imported as any other, and the import uses it by proxy", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const until = Date.now() + 60_000;
  const exportProof = await hmacSha256Hex(
    AT_REST_KEY,
    JSON.stringify([PATH, "exportSealed", until]),
  );
  const { sealed } = z
    .object({ result: z.object({ sealed: z.string() }) })
    .parse(await secret.secret(PATH, "exportSealed", { proof: exportProof, until })).result;
  const other = await vault();
  const proof = await hmacSha256Hex(AT_REST_KEY, JSON.stringify([PATH, sealed]));
  await other.secret.secret(PATH, "importSealed", { cell: sealed, proof });
  expect(await other.secret.secret(PATH, "describe", undefined)).toMatchObject({ proxy: PROXY });
  const { sent } = useIs(new Response("proxied"));
  await other.secret.fetch(useRequest("https://api.openai.com/v1/responses", { method: "POST" }));
  expect(sent[0]?.url).toBe("https://cloud.example.com/secret-proxy/api.openai.com/v1/responses");
});

test("a value's verbs refuse a secret by proxy: it holds none here", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  await expect(secret.secret(PATH, "signHmac", { payload: "m" })).rejects.toThrow(
    "goes by proxy and holds no value here",
  );
});

test("a backup edited in the archive and proved anew, as restoreMind does, does not import: the mark off, the mark on, the proxy edited, a pin edited", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const proxyCell = JSON.parse(await exported(secret));
  const valued = await vault();
  await valued.secret.secret(PATH, "set", { material: "sk-own-aaaa", urls: OPENAI });
  const valueCell = JSON.parse(await exported(valued.secret));
  const { byProxy: _, ...markOff } = proxyCell.cell;
  // the proxy is ciphertext: an edit of one character of it, as an edit to another URL would be
  const { ciphertext } = proxyCell.cell.material;
  const edited = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
  for (const changed of [
    // a value with no mark would go only to the pinned host, but it does not open at all
    { ...proxyCell, cell: markOff },
    // a value's material under the mark: it does not open, and were it opened, it is no proxy
    { ...valueCell, cell: { ...valueCell.cell, byProxy: true } },
    {
      ...proxyCell,
      cell: { ...proxyCell.cell, material: { ...proxyCell.cell.material, ciphertext: edited } },
    },
    { ...proxyCell, cell: { ...proxyCell.cell, urls: ["https://elsewhere.example"] } },
  ]) {
    const other = await vault();
    const cell = JSON.stringify(changed);
    // a fresh proof over the edited text (packages/mind-backup/src/restore.ts): the at-rest seal refuses it
    const proof = await hmacSha256Hex(AT_REST_KEY, JSON.stringify([PATH, cell]));
    await expect(other.secret.secret(PATH, "importSealed", { cell, proof })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await other.secret.secret(PATH, "describe", undefined)).toEqual({
      path: PATH,
      set: false,
    });
  }
});

test("a set with proxy while a value's set is in flight is refused, and the value lands", async () => {
  const { secret, holdNextAdd } = await vault();
  const release = holdNextAdd();
  const value = secret.secret(PATH, "set", { material: "sk-own-aaaa", urls: OPENAI });
  await expect(
    secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY }),
  ).rejects.toThrow("is set or being set; delete it first");
  release();
  await value;
  expect(await secret.secret(PATH, "describe", undefined)).not.toHaveProperty("proxy");
});
test("deleteIfProxy deletes a secret by proxy, with its fact, and the vault's list drops it", async () => {
  const { secret, listed } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  expect([...listed]).toEqual([PATH]);
  const deleted = secret.secret(PATH, "deleteIfProxy", undefined);
  expect(await deleted).toMatchObject({ result: { deleted: true } });
  expect([...listed]).toEqual([]);
  expect(await deleted).toEqual({
    result: { path: PATH, deleted: true },
    facts: [
      {
        path: PATH,
        events: [{ type: "events.iterate.com/secret/deleted", payload: { path: PATH } }],
      },
    ],
  });
  expect(await secret.secret(PATH, "describe", undefined)).toEqual({ path: PATH, set: false });
  // a second call finds nothing to do, and says so
  expect(await secret.secret(PATH, "deleteIfProxy", undefined)).toEqual({
    result: { path: PATH, deleted: false },
    facts: [],
  });
});

test.for(["a key form", "an OAuth attempt"] as const)(
  "deleteIfProxy over %s that lapsed deletes the proxy: a lapsed one blocks nothing",
  async (what) => {
    const { secret } = await vault();
    await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
    const begun =
      what === "a key form"
        ? await secret.secret(PATH, "collectFromUser", { egress: { urls: OPENAI } })
        : await secret.secret(PATH, "beginOAuth", {
            authorizationEndpoint: "https://provider.example/authorize",
            tokenEndpoint: "https://provider.example/token",
            clientId: "client",
          });
    expect(begun).toBeTruthy();
    // a day and an hour later: past a form's 24 hours and an attempt's own end
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60_000);
    try {
      expect(await secret.secret(PATH, "deleteIfProxy", undefined)).toMatchObject({
        result: { path: PATH, deleted: true },
      });
    } finally {
      clock.mockRestore();
    }
    expect(await secret.secret(PATH, "describe", undefined)).toEqual({ path: PATH, set: false });
  },
);

test("deleteIfProxy deletes nothing but a secret by proxy: a value, a path never set, an OAuth attempt, a key form", async () => {
  const { secret } = await vault();
  const nothing = { result: { path: PATH, deleted: false }, facts: [] };
  // never set: no throw
  expect(await secret.secret(PATH, "deleteIfProxy", undefined)).toEqual(nothing);
  // an own value
  await secret.secret(PATH, "set", { material: "sk-own-aaaa", urls: OPENAI });
  expect(await secret.secret(PATH, "deleteIfProxy", undefined)).toEqual(nothing);
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({ set: true });
  expect(await secret.secret(PATH, "describe", undefined)).not.toHaveProperty("proxy");
  await secret.secret(PATH, "delete", undefined);
  // a proxy with a key form open on it: the owner's form stays
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const form = (await secret.secret(PATH, "collectFromUser", { egress: { urls: OPENAI } })) as {
    url: string;
  };
  expect(await secret.secret(PATH, "deleteIfProxy", undefined)).toEqual(nothing);
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({ proxy: PROXY });
  expect(form).toMatchObject({ url: expect.any(String) });
  await secret.secret(PATH, "delete", undefined);
  // a proxy with an OAuth attempt waiting on it
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  await secret.secret(PATH, "beginOAuth", {
    authorizationEndpoint: "https://provider.example/authorize",
    tokenEndpoint: "https://provider.example/token",
    clientId: "client",
  });
  expect(await secret.secret(PATH, "deleteIfProxy", undefined)).toEqual(nothing);
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({ proxy: PROXY });
});

test("deleteIfProxy after the caller's describe saw the proxy, and the owner's own value landed since: the value stays", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({ proxy: PROXY });
  // the owner's key: a value's set over a proxy is an ordinary set
  await secret.secret(PATH, "set", { material: "sk-own-aaaa", urls: OPENAI });
  expect(await secret.secret(PATH, "deleteIfProxy", undefined)).toEqual({
    result: { path: PATH, deleted: false },
    facts: [],
  });
  const described = await secret.secret(PATH, "describe", undefined);
  expect(described).toMatchObject({ set: true });
  expect(described).not.toHaveProperty("proxy");
});

test("deleteIfProxy while an own value's set is in flight over the proxy deletes nothing, and the value lands", async () => {
  const { secret, holdNextAdd } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const release = holdNextAdd();
  // not awaited: it has reserved its version and waits on the vault's list
  const value = secret.secret(PATH, "set", { material: "sk-own-aaaa", urls: OPENAI });
  expect(await secret.secret(PATH, "deleteIfProxy", undefined)).toEqual({
    result: { path: PATH, deleted: false },
    facts: [],
  });
  release();
  await value;
  const described = await secret.secret(PATH, "describe", undefined);
  expect(described).toMatchObject({ set: true });
  expect(described).not.toHaveProperty("proxy");
});

test("a use whose secret is set again while it is signed does not leave, and says to send it again", async () => {
  const { secret, hooks } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  hooks.duringSign = async () => {
    hooks.duringSign = undefined;
    await secret.secret(PATH, "set", { material: "sk-own-aaaa", urls: OPENAI });
  };
  const { sent } = useIs(new Response("never"));
  const answer = await secret.fetch(
    useRequest("https://api.openai.com/v1/responses", { method: "POST", body: "{}" }),
  );
  expect({ status: answer.status, text: await answer.text(), sends: sent.length }).toEqual({
    status: 409,
    text: expect.stringContaining("was set again while this request was being signed"),
    sends: 0,
  });
});

test("a header that names the secret inside a Basic credential, and every x-itx header, are taken off", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const { sent } = useIs(new Response("proxied"));
  await secret.fetch(
    useRequest("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "x-basic": `Basic ${btoa(`user:getSecret("${PATH}")`)}`,
        "x-itx-awake": "test",
        "x-plain": "kept",
      },
    }),
  );
  expect(sent[0]?.headers).toMatchObject({ "x-plain": "kept" });
  expect(sent[0]?.headers).not.toHaveProperty("x-basic");
  expect(sent[0]?.headers).not.toHaveProperty("x-itx-awake");
});

test("a statement the stack cannot make is a 503 that says so, not a 414: only the length check is too long", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  // the cast: the object's bindings, whose auth Worker now answers an envelope that holds no statement
  const { AUTH } = (secret as unknown as { env: { AUTH: { sign: () => Promise<unknown> } } }).env;
  AUTH.sign = async () => ({
    statement: "no statement",
    signature: { format: "ml-dsa-65", key: "k", sig: "s" },
  });
  const { sent } = useIs(new Response("proxied"));
  const answer = await secret.fetch(
    useRequest("https://api.openai.com/v1/responses", { method: "GET" }),
  );
  expect({ status: answer.status, sends: sent.length }).toEqual({ status: 503, sends: 0 });
  expect(await answer.text()).toContain("could not be signed now");
});

test("a proxy URL with no path is taken as written, and the use goes under it", async () => {
  const { secret } = await vault();
  const proxy = { mind: PROXY.mind, url: "https://proxy.example" };
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy });
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({ proxy });
  const { sent } = useIs(new Response("proxied"));
  await secret.fetch(useRequest("https://api.openai.com/v1/responses", { method: "POST" }));
  expect(sent[0]?.url).toBe("https://proxy.example/api.openai.com/v1/responses");
});

test("the encoded statement is checked against the receiver's 16 KiB before it leaves: 6 KiB of URL goes, 8 KiB does not", async () => {
  const { secret, signs } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const { sent } = useIs(new Response("proxied"));
  const use = (characters: number) =>
    secret.fetch(
      useRequest(`https://api.openai.com/v1/responses?q=${"a".repeat(characters)}`, {
        method: "GET",
      }),
    );
  expect(await use(6 * 1024)).toMatchObject({ status: 200 });
  const over = await use(8 * 1024);
  expect({ status: over.status, signs: signs.length, sends: sent.length }).toEqual({
    status: 414,
    signs: 2,
    sends: 1,
  });
  expect(sent[0]?.headers["iterate-auth-statement"]?.length).toBeLessThanOrEqual(16 * 1024);
});

test("a use whose signing failed is a 503 with the reason, as any signing fault is, and its fact names the proxy", async () => {
  const { secret, hooks } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  hooks.duringSign = async () => {
    throw new Error("the mind's identity lists no working key of this stack yet");
  };
  const { sent } = useIs(new Response("never"));
  const answer = await secret.fetch(
    useRequest("https://api.openai.com/v1/responses", { method: "POST" }),
  );
  expect({ status: answer.status, sends: sent.length }).toEqual({ status: 503, sends: 0 });
  expect(await answer.text()).toContain("lists no working key of this stack yet");
  expect(decodeFacts(answer.headers.get(FACTS_HEADER) || "")).toMatchObject([
    {
      events: [
        {
          type: "events.iterate.com/secret/used",
          payload: {
            status: 503,
            proxy: "https://cloud.example.com/secret-proxy/api.openai.com/v1/responses",
          },
        },
      ],
    },
  ]);
});

test("the refusals of a secret by proxy name the real reason: a URL placeholder, a lend", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  useIs(new Response("never"));
  const inUrl = await secret.fetch(
    useRequest(`https://api.openai.com/v1/responses?key=getSecret("${PATH}")`, { method: "GET" }),
  );
  expect({ status: inUrl.status, text: await inUrl.text() }).toEqual({
    status: 403,
    text: expect.stringContaining("goes by proxy, so its placeholder sits in a header alone"),
  });
  expect(
    await secret.clientSecretFor(PATH, { borrower: "/secrets/other", origin: "https://x.example" }),
  ).toMatchObject({
    refused: { message: expect.stringContaining("goes by proxy and holds no value") },
  });
});

test("a set with proxy refused over a stored value takes no version; an import of a proxy over a value is refused, and once the value is deleted it imports", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", { material: "sk-own-aaaa", urls: OPENAI });
  await expect(
    secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY }),
  ).rejects.toThrow("is set or being set; delete it first");
  // the next value write is version 2: the refused set took none
  await secret.secret(PATH, "set", { material: "sk-own-bbbb", urls: OPENAI });
  const source = await vault();
  await source.secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const cell = await exported(source.secret);
  const proof = await hmacSha256Hex(AT_REST_KEY, JSON.stringify([PATH, cell]));
  await expect(secret.secret(PATH, "importSealed", { cell, proof })).rejects.toThrow(
    "is set or being set; delete it first",
  );
  await secret.secret(PATH, "delete", undefined);
  await secret.secret(PATH, "importSealed", { cell, proof });
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({ proxy: PROXY });
});
test("an import of a proxy refused because a value's set took a version while the cell opened frees its nonce: the same backup imports once the value is deleted", async () => {
  const source = await vault();
  await source.secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const cell = await exported(source.secret);
  const proof = await hmacSha256Hex(AT_REST_KEY, JSON.stringify([PATH, cell]));
  const { secret } = await vault();
  // the import's cell opens only after the value is stored
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  const opened = Promise.withResolvers<void>();
  const spy = vi
    .spyOn(crypto.subtle, "decrypt")
    .mockImplementationOnce(async (...args: Parameters<SubtleCrypto["decrypt"]>) => {
      await opened.promise;
      return decrypt(...args);
    });
  const importing = secret.secret(PATH, "importSealed", { cell, proof });
  // the import has kept the nonce and opens the cell
  await vi.waitFor(() => expect(spy).toHaveBeenCalled());
  await secret.secret(PATH, "set", { material: "sk-own-aaaa", urls: OPENAI });
  opened.resolve();
  await expect(importing).rejects.toThrow("is set or being set");
  spy.mockRestore();
  await secret.secret(PATH, "delete", undefined);
  await secret.secret(PATH, "importSealed", { cell, proof });
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({ proxy: PROXY });
});

test("x-iterate headers of the caller are taken off but the cause, which leaves with the request; refreshGrant finds no brokered grant; an unreachable proxy is called the secret proxy", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const { sent } = useIs(new Response("proxied"));
  await secret.fetch(
    useRequest("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "x-iterate-marker": "test", "x-iterate-cause": CAUSE },
    }),
  );
  expect(
    Object.keys(sent[0]?.headers ?? {}).filter((name) => name.startsWith("x-iterate-")),
  ).toEqual(["x-iterate-cause"]);
  // the cause leaves with the request, as `leavingTheStack` writes it
  expect(JSON.parse(sent[0]?.headers["x-iterate-cause"] ?? "")).toMatchObject({
    chain: "2026-11-19T00:00:00.000Z with another stack ~n1",
    depth: 3,
  });
  expect(await secret.refreshGrant(PATH)).toEqual({
    result: { outcome: "not-a-brokered-grant" },
    facts: [],
  });
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("connection refused");
  });
  const unreachable = await secret.fetch(
    useRequest("https://api.openai.com/v1/responses", { method: "POST" }),
  );
  expect({ status: unreachable.status, text: await unreachable.text() }).toEqual({
    // a gateway's failure, not a refusal of the caller
    status: 502,
    text: expect.stringContaining(
      "the secret proxy https://cloud.example.com could not be reached",
    ),
  });
});

test("a use by proxy refuses a URL that holds a username or a password, before anything is signed or sent; the rest of the URL is built exactly as written", async () => {
  const { secret, signs } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const { sent } = useIs(new Response("proxied"));
  for (const url of ["https://user:pass@api.openai.com/v1", "https://user@api.openai.com/v1"]) {
    const refused = await asWorkerdCarriesUserinfo(() =>
      secret.fetch(withUrlAsWorkerdCarriesIt(useRequest, url)),
    );
    expect({ status: refused.status, text: await refused.text() }).toMatchObject({
      status: 403,
      text: expect.stringContaining("a use by proxy takes no credentials in its URL"),
    });
  }
  expect({ signs: signs.length, sends: sent.length }).toEqual({ signs: 0, sends: 0 });
  for (const url of [
    "https://api.openai.com/v1/responses?",
    "https://api.openai.com//x",
    "https://api.openai.com/v1/%7Euser",
  ])
    await secret.fetch(useRequest(url, { method: "GET" }));
  expect(sent.map(({ url }) => url)).toEqual([
    "https://cloud.example.com/secret-proxy/api.openai.com/v1/responses?",
    "https://cloud.example.com/secret-proxy/api.openai.com//x",
    "https://cloud.example.com/secret-proxy/api.openai.com/v1/%7Euser",
  ]);
});

test("a use by proxy carries no target host, keeps an empty query, refuses a host of . or .., and cancels a body it refuses", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", {
    material: null,
    urls: [...OPENAI, "https://..", "https://unpinned-not.example"],
    proxy: PROXY,
  });
  const { sent } = useIs(new Response("proxied"));
  await secret.fetch(
    useRequest("https://api.openai.com/v1/responses?", {
      method: "POST",
      body: "{}",
      headers: { host: "api.openai.com" },
    }),
  );
  expect(sent).toMatchObject([
    { url: "https://cloud.example.com/secret-proxy/api.openai.com/v1/responses?" },
  ]);
  expect(sent[0]?.headers).not.toHaveProperty("host");
  const dotted = await secret.fetch(useRequest("https://../v1", { method: "GET" }));
  expect({ status: dotted.status, sends: sent.length }).toEqual({ status: 403, sends: 1 });
  // a streamed body that a refusal leaves unread is cancelled
  let cancelled = false;
  const body = new ReadableStream({
    pull: () => {},
    cancel: () => {
      cancelled = true;
    },
  });
  const refused = await secret.fetch(
    useRequest("https://off-pin.example/v1", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit),
  );
  expect({ status: refused.status, cancelled, sends: sent.length }).toEqual({
    status: 403,
    cancelled: true,
    sends: 1,
  });
});

test("one proxy cell that does not open fails no describe: it says the secret is set, by proxy, and cannot be read", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  // the cast: the object's storage, which the test changes as a damaged cell would be
  const { kv } = (secret as unknown as { ctx: { storage: { kv: FakeKv } } }).ctx.storage;
  const current = kv.get<{ cell: { nonce: string } }>("current");
  // the nonce is in the seal's additional data: another one opens nothing
  kv.put("current", { ...current, cell: { ...current?.cell, nonce: "another" } });
  const described = await secret.secret(PATH, "describe", undefined);
  expect(described).toMatchObject({ path: PATH, set: true, byProxy: true });
  expect(described).not.toHaveProperty("proxy");
  expect(described).toHaveProperty("unreadable", expect.stringContaining("does not open"));
});

test("a warm use by proxy signs nothing: the statement is used again while it has more than a minute to live, then signed anew", async () => {
  const { secret, signs } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  const { sent } = useIs(new Response("proxied"));
  const use = () =>
    secret.fetch(useRequest("https://api.openai.com/v1/responses", { method: "POST", body: "{}" }));
  await use();
  await use();
  expect({ signs: signs.length, sends: sent.length }).toEqual({ signs: 1, sends: 2 });
  expect(sent[1]?.headers["iterate-auth-statement"]).toBe(
    sent[0]?.headers["iterate-auth-statement"],
  );
  // another method is another statement
  await secret.fetch(useRequest("https://api.openai.com/v1/responses", { method: "GET" }));
  expect(signs).toHaveLength(2);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 241_000);
  try {
    await use();
  } finally {
    clock.mockRestore();
  }
  expect(signs).toHaveLength(3);
});

test("an answer of the proxy that echoes the statement gives it to no code: it is cut out as a value is", async () => {
  const { secret } = await vault();
  await secret.secret(PATH, "set", { material: null, urls: OPENAI, proxy: PROXY });
  vi.stubGlobal(
    "fetch",
    async (request: Request) =>
      new Response("proxied", {
        headers: { "x-echo": `got ${request.headers.get("iterate-auth-statement")}` },
      }),
  );
  const answer = await secret.fetch(
    useRequest("https://api.openai.com/v1/responses", { method: "GET" }),
  );
  expect(answer.headers.get("x-echo")).toBe("got [redacted]");
});

const AT_REST_KEY = "at-rest-key-for-tests-only";
const SITE = { origin: "https://iterate.ada.example", rpId: "iterate.ada.example" };

/** A secret's object on its own, whose auth Worker signs as `signedByStack` does: an ML-DSA-65
 *  key of the test's own, `from` this mind, `mind` the one it is for. */
async function vault() {
  const pair = (await crypto.subtle.generateKey({ name: "ML-DSA-65" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const stackKey = base64url(
    new Uint8Array(
      // the casts: Node's Web Crypto names the raw public form "raw-public", which the DOM's
      // types do not list
      (await crypto.subtle.exportKey("raw-public" as "raw", pair.publicKey)) as ArrayBuffer,
    ),
  );
  const signs: { mind?: string; expiresInSeconds?: number }[] = [];
  // what runs while the auth Worker signs, and the one call of the vault's list that waits
  const hooks: { duringSign?: () => Promise<void>; nextAdd?: Promise<void> } = {};
  /** The vault's list of set secrets, as its `add` and `remove` leave it. */
  const listed = new Set<string>();
  const env = {
    ITERATE: JSON.stringify({
      mindId: "a".repeat(64),
      controlPlaneHostname: "iterate.ada.example",
      zones: ["ada.example"],
      ownerEmails: ["owner@example.net"],
      topology: "full-cloudflare",
    }),
    ITERATE__AT_REST_KEY: AT_REST_KEY,
    // a stack whose deploy made no SFU app or TURN key (../stack-secrets.test.ts has them)
    ITERATE__CLOUDFLARE_REALTIME: JSON.stringify({
      sfu: { refusal: "Authentication error" },
      turn: { refusal: "Authentication error" },
    }),
    APPROVALS: {
      getByName: () => ({
        add: async (path: string) => {
          const waits = hooks.nextAdd;
          hooks.nextAdd = undefined;
          await waits;
          listed.add(path);
        },
        remove: async (path: string) => {
          listed.delete(path);
        },
      }),
    },
    AUTH: {
      // a member's decision: who signed is the key the envelope names, and it is believed
      verify: async (envelope: { statement: string; signature: { key: string } }) => ({
        signer: {
          principal: { actor: envelope.signature.key },
          key: envelope.signature.key,
          label: "test key",
          member: true,
        },
        statement: JSON.parse(envelope.statement),
      }),
      sign: async (input: {
        mind: string;
        path: string;
        type: string;
        payload: Record<string, unknown>;
        expiresInSeconds: number;
      }) => {
        signs.push(input);
        await hooks.duringSign?.();
        const at = Date.now();
        const { mind, path, type, payload, expiresInSeconds } = input;
        return signedMlDsa65(
          statementText({
            mind,
            from: "iterate.ada.example",
            path,
            type,
            payload,
            at,
            expires: at + expiresInSeconds * 1000,
          }),
          pair.privateKey,
          "key-stack",
        );
      },
    },
  };
  // the cast: the object reads only the bindings above
  const secret = new SecretDurableObject(fakeState(PATH) as never, env as never);
  return {
    secret,
    stackKey,
    signs,
    hooks,
    listed,
    /** Holds the next call of the vault's list until the answered function is called. */
    holdNextAdd: () => {
      let go = () => {};
      hooks.nextAdd = new Promise<void>((release) => {
        go = release;
      });
      return () => go();
    },
  };
}

/** The network answers `response` to every request, and keeps what each one sent. */
function useIs(response: Response) {
  const sent: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    });
    return response.clone();
  });
  return { sent };
}

/** A use whose URL holds userinfo. workerd's Request takes one (the request's URL keeps it, and
 *  its origin does not); Node's refuses it, as the Fetch standard says. So the Request is made for
 *  the URL without userinfo and given the whole URL as its own `url`, which the code reads. */
function withUrlAsWorkerdCarriesIt(
  make: (url: string, init: RequestInit) => Request,
  url: string,
): Request {
  const request = make(url.replace(/\/\/[^/@]*@/, "//"), { method: "GET" });
  Object.defineProperty(request, "url", { value: url });
  return request;
}

/** While `run` runs, a Request made from one that `withUrlAsWorkerdCarriesIt` made keeps its URL,
 *  as workerd's `new Request(request, init)` does. */
async function asWorkerdCarriesUserinfo<T>(run: () => Promise<T>): Promise<T> {
  const Native = globalThis.Request;
  globalThis.Request = new Proxy(Native, {
    construct(target, args: unknown[]) {
      // the cast: Reflect.construct answers what the native constructor makes, a Request
      const made = Reflect.construct(target, args) as Request;
      const [input] = args;
      if (input instanceof Native && Object.hasOwn(input, "url"))
        Object.defineProperty(made, "url", { value: input.url });
      return made;
    },
  });
  try {
    return await run();
  } finally {
    globalThis.Request = Native;
  }
}

function useRequest(url: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer getSecret("${PATH}")`);
  headers.set(SECRET_USE_HEADER, PATH);
  return new Request(url, { ...init, headers });
}

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

/** The cell of the secret at PATH, as `exportSealed` hands it out. */
async function exported(secret: SecretDurableObject) {
  const until = Date.now() + 60_000;
  const proof = await hmacSha256Hex(AT_REST_KEY, JSON.stringify([PATH, "exportSealed", until]));
  return z
    .object({ result: z.object({ sealed: z.string() }) })
    .parse(await secret.secret(PATH, "exportSealed", { proof, until })).result.sealed;
}

type FakeKv = { get<T>(key: string): T | undefined; put(key: string, value: unknown): void };
