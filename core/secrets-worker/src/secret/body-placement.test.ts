// A SECRET THAT NAMES BODY FIELDS, AT THE SECRET'S OBJECT (./durable-object.ts): the value goes
// into a header and into the named field of the named request, and nowhere else in a body. The
// pin, the one secret of a request, an approval rule and the at-rest binding hold it as they hold
// any secret, and nothing adds a body field to a value that is stored.
// ../body-placement.test.ts has the filling on its own.
import { timingSafeEqual } from "node:crypto";
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import {
  SECRET_HELD_HEADER,
  SECRET_USE_HEADER,
  VAULT_ANSWER_HEADER,
} from "iterate/secret-placeholder";
import type { Envelope } from "iterate/signed";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { hmacSha256Hex } from "../secrets.ts";
import { APPROVED, SecretDurableObject } from "./durable-object.ts";

// workerd's own comparison, which Node's Web Crypto has not got
Object.assign(crypto.subtle, { timingSafeEqual });

const PATH = "/secrets/sink";
const API = "https://api.example.com";
const TOKEN = "real-token-aaaa";
const PLACEHOLDER = `getSecret("${PATH}")`;
const AT_REST_KEY = "at-rest-key-for-tests-only";
/** The one request that fills: a POST to the sinks, at `config.token`. */
const SINKS = { method: "POST", url: `${API}/sinks`, field: "config.token" };

test("a secret goes into a header and into its body field of one request, and its use says that it did", async () => {
  const { secret, sent } = await vault({ bodyFields: [SINKS] });
  const answer = await secret.fetch(sink({ name: "events", config: { token: PLACEHOLDER } }));
  expect({
    status: answer.status,
    sent,
    facts: decodeFacts(answer.headers.get(FACTS_HEADER) || ""),
    described: await secret.secret(PATH, "describe", undefined),
  }).toMatchObject({
    status: 200,
    sent: [
      {
        url: `${API}/sinks`,
        authorization: `Bearer ${TOKEN}`,
        body: `{"name":"events","config":{"token":"${TOKEN}"}}`,
      },
    ],
    facts: [
      {
        path: PATH,
        events: [
          {
            type: "events.iterate.com/secret/used",
            payload: { method: "POST", url: `${API}/sinks`, status: 200, inBody: true },
          },
        ],
      },
    ],
    described: { placement: "header", bodyFields: [SINKS] },
  });
});

test.for([
  {
    name: "to another path of the pinned host",
    request: () => useRequest(`${API}/notes`, json({ config: { token: PLACEHOLDER } })),
  },
  {
    name: "with another method",
    request: () =>
      useRequest(`${API}/sinks`, { ...json({ config: { token: PLACEHOLDER } }), method: "PUT" }),
  },
  {
    name: "with a query",
    request: () => useRequest(`${API}/sinks?dry=1`, json({ config: { token: PLACEHOLDER } })),
  },
  {
    // a host may take it for a DELETE: it is no request that the secret's maker named
    name: "with a header that names another method",
    request: () =>
      useRequest(`${API}/sinks`, {
        ...json({ config: { token: PLACEHOLDER } }),
        headers: { "x-http-method-override": "DELETE" },
      }),
  },
])(
  "the same body $name is not filled: the placeholder leaves as written, and no value is in it",
  async ({ request }) => {
    const { secret, sent } = await vault({ bodyFields: [SINKS] });
    const answer = await secret.fetch(request());
    const [used] = decodeFacts(answer.headers.get(FACTS_HEADER) || "")[0]?.events ?? [];
    expect({ status: answer.status, sent }).toMatchObject({
      status: 200,
      sent: [
        {
          authorization: `Bearer ${TOKEN}`,
          body: `{"config":{"token":"${PLACEHOLDER.replaceAll('"', '\\"')}"}}`,
        },
      ],
    });
    expect(used?.payload).not.toHaveProperty("inBody");
  },
);

test("a secret that names no body field sends a body as written, whatever its type and size: 2 MiB of text with a placeholder", async () => {
  const { secret, sent } = await vault({});
  const text = `token=${PLACEHOLDER}&pad=${"x".repeat(2 * 1024 * 1024)}`;
  const answer = await secret.fetch(
    useRequest(`${API}/sinks`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: text,
    }),
  );
  expect({
    status: answer.status,
    authorization: sent[0]?.authorization,
    length: sent[0]?.body.length,
    start: sent[0]?.body.slice(0, 40),
  }).toEqual({
    status: 200,
    authorization: `Bearer ${TOKEN}`,
    length: text.length,
    start: `token=${PLACEHOLDER}&pad=xxx`,
  });
});

test.for([
  {
    name: "to an origin outside its pin",
    request: () =>
      useRequest("https://other.example.com/sinks", json({ config: { token: PLACEHOLDER } })),
    refused: `the secret ${PATH} is pinned to ${API}`,
  },
  {
    name: "at another field alone of the request that fills",
    request: () => sink({ name: PLACEHOLDER, config: { token: "x" } }),
    refused: "this body has no placeholder there",
  },
  {
    name: "with another secret's placeholder at its field",
    request: () => sink({ config: { token: 'getSecret("/secrets/other")' } }),
    refused: `getSecret("/secrets/other") does not belong to the secret ${PATH}`,
  },
  {
    name: "in the URL, where only a secret placed in a URL goes",
    request: () => useRequest(`${API}/notes?token=${PLACEHOLDER}`, { method: "GET" }),
    refused: `the secret ${PATH} is placed in headers alone`,
  },
])(
  "a secret with a body field is refused $name, and nothing is sent",
  async ({ request, refused }) => {
    const { secret, sent } = await vault({ bodyFields: [SINKS] });
    const answer = await secret.fetch(request());
    const [used] = decodeFacts(answer.headers.get(FACTS_HEADER) || "")[0]?.events ?? [];
    expect({
      status: answer.status,
      kind: answer.headers.get(VAULT_ANSWER_HEADER),
      text: await answer.text(),
      sent,
    }).toMatchObject({
      status: 403,
      kind: "refused",
      text: expect.stringContaining(refused),
      sent: [],
    });
    // a request that never left put the value into no body
    expect(used?.payload).not.toHaveProperty("inBody");
  },
);

test("with a rule, a request whose body is filled waits for a member whatever the rule names, and then goes once with the value", async () => {
  const { secret, sent, approve } = await vault({
    bodyFields: [SINKS],
    rule: { methods: ["DELETE"], hosts: ["api.example.com"] },
  });
  // the rule names no POST: one to a path that fills nothing goes at once
  const free = await secret.fetch(useRequest(`${API}/notes`, json({ name: "read" })));
  const first = await secret.fetch(sink({ config: { token: PLACEHOLDER } }));
  const { digest } = Held.parse(await first.clone().json());
  const [requested] = decodeFacts(first.headers.get(FACTS_HEADER) || "")[0]?.events ?? [];
  const waited = secret.fetch(
    useRequest(`${API}/sinks`, { method: "POST", headers: { [SECRET_HELD_HEADER]: digest } }),
  );
  await approve(digest);
  expect({
    free: free.status,
    first: first.status,
    kind: first.headers.get(VAULT_ANSWER_HEADER),
    requested,
    waited: (await waited).status,
    sent,
    approvals: await secret.approvals(PATH),
  }).toMatchObject({
    free: 200,
    first: 202,
    kind: "held",
    // what the member reads is the placeholder, never the value
    requested: {
      type: "events.iterate.com/secret/approval-requested",
      payload: { digest, bodyStart: `{"config":{"token":"getSecret(\\"${PATH}\\")"}}` },
    },
    waited: 200,
    sent: [
      { body: '{"name":"read"}' },
      { authorization: `Bearer ${TOKEN}`, body: `{"config":{"token":"${TOKEN}"}}` },
    ],
    // the page that shows the rule and the held request gets the secret's body fields
    approvals: { bodyFields: [SINKS] },
  });
});

test("a request that fills is held as it will leave: a member reads its body written again, with the placeholder at the field, and the host gets that text with the value", async () => {
  const { secret, sent, approve } = await vault({
    bodyFields: [SINKS],
    rule: { methods: ["DELETE"], hosts: ["api.example.com"] },
  });
  // uneven space and a key written twice: neither is in what waits, nor in what leaves
  const written = `{ "amount": 1, "amount": 1000,\n "config": { "token": ${JSON.stringify(PLACEHOLDER)} } }`;
  const first = await secret.fetch(useRequest(`${API}/sinks`, { method: "POST", body: written }));
  const { digest } = Held.parse(await first.clone().json());
  const [row] = (await secret.approvals(PATH)).held;
  await approve(digest);
  await secret.fetch(
    useRequest(`${API}/sinks`, { method: "POST", headers: { [SECRET_HELD_HEADER]: digest } }),
  );
  expect({ held: JSON.parse(row?.text || "{}").body, sent: sent.map(({ body }) => body) }).toEqual({
    held: `{"amount":1000,"config":{"token":${JSON.stringify(PLACEHOLDER)}}}`,
    sent: [`{"amount":1000,"config":{"token":"${TOKEN}"}}`],
  });
});

test.for([
  {
    name: "with a body field that it did not have",
    before: undefined,
    after: [SINKS],
    // the row was held to fill nothing: it is still listed, and leaves no more
    listed: 1,
    fills: { fields: ["config.token"], version: 2 },
  },
  {
    name: "without the field that the request was held with",
    before: [SINKS],
    after: undefined,
    listed: 0,
    fills: undefined,
  },
  {
    name: "with another value and the same field",
    before: [SINKS],
    after: [SINKS],
    listed: 0,
    fills: { fields: ["config.token"], version: 2 },
  },
])(
  "a request that waited leaves as it was approved, or not at all: once the secret is given again $name, the approved request is refused, and the same request sent now waits anew",
  async ({ before, after, listed, fills }) => {
    // the rule names the request's method, so it waits with a body field and without one
    const { secret, sent, approve } = await vault({
      bodyFields: before,
      rule: { methods: ["POST"], hosts: ["api.example.com"] },
    });
    const first = await secret.fetch(sink({ config: { token: PLACEHOLDER } }));
    const { digest } = Held.parse(await first.clone().json());
    await approve(digest);
    await secret.secret(PATH, "set", {
      material: "another-value-aaaa",
      urls: [API],
      bodyFields: after,
    });
    const stillListed = (await secret.approvals(PATH)).held.length;
    const approved = await secret.fetch(
      useRequest(`${API}/sinks`, { method: "POST", headers: { [SECRET_HELD_HEADER]: digest } }),
    );
    const again = await secret.fetch(sink({ config: { token: PLACEHOLDER } }));
    const anew = Held.parse(await again.clone().json()).digest;
    expect({
      approved: [approved.status, await approved.text()],
      sent,
      stillListed,
      again: again.status,
      // the new request says what it fills, and for which version, in the text that is approved
      anew: (await secret.approvals(PATH)).held
        .filter((row) => row.digest === anew && anew !== digest)
        .map((row) => JSON.parse(row.text).fills),
    }).toEqual({
      approved: [
        409,
        expect.stringContaining("was given again or deleted since this request arrived"),
      ],
      sent: [],
      stillListed: listed,
      again: 202,
      anew: [fills],
    });
  },
);

test.for([
  { name: "loses its body field", before: [SINKS], after: undefined },
  { name: "gets a body field", before: undefined, after: [SINKS] },
])(
  "a request that did not wait leaves with what its first read found, or not at all: a secret that $name while its token is refreshed sends nothing more",
  async ({ before, after }) => {
    // no rule, so the request does not wait; its access token has ended, so a refresh comes first
    const { secret, sent, upstream } = await vault({
      bodyFields: before,
      material: { ...GRANT.material, accessTokenExpiresAt: "2026-01-01T00:00:00.000Z" },
      refresh: GRANT.refresh,
    });
    upstream.mockImplementation(async (request: Request) => {
      sent.push(await seen(request));
      // the owner gives the secret again while the token endpoint answers
      await secret.secret(PATH, "set", {
        material: "given-again-aaaa",
        urls: [API],
        bodyFields: after,
      });
      return Response.json({ access_token: "new-access-aaaa" });
    });
    const answer = await secret.fetch(granted({ config: { token: ACCESS } }));
    expect({
      status: answer.status,
      text: await answer.text(),
      sent: sent.map(({ url }) => url),
    }).toEqual({
      status: 409,
      text: expect.stringContaining("was given again or deleted since this request arrived"),
      sent: [`${API}/token`],
    });
  },
);

test("a refresh is no new giving: a request that was approved to fill leaves after a refresh, with the new token in its header and its body", async () => {
  const { secret, sent, upstream, approve } = await vault({
    bodyFields: [SINKS],
    rule: { methods: ["DELETE"], hosts: ["api.example.com"] },
    ...GRANT,
  });
  const first = await secret.fetch(granted({ config: { token: ACCESS } }));
  const { digest } = Held.parse(await first.clone().json());
  await approve(digest);
  // the host takes the old token no more: the approved request starts a refresh and goes again
  upstream.mockImplementation(async (request: Request) => {
    const call = await seen(request);
    sent.push(call);
    if (call.url === `${API}/token`) return Response.json({ access_token: "new-access-aaaa" });
    return new Response("answered", {
      status: call.authorization === "Bearer new-access-aaaa" ? 200 : 401,
    });
  });
  const approved = await secret.fetch(
    new Request(`${API}/sinks`, {
      method: "POST",
      headers: { [SECRET_USE_HEADER]: PATH, [SECRET_HELD_HEADER]: digest },
    }),
  );
  expect({ status: approved.status, sent: sent.map(({ url, body }) => [url, body]) }).toEqual({
    status: 200,
    sent: [
      [`${API}/sinks`, '{"config":{"token":"old-access-aaaa"}}'],
      [`${API}/token`, expect.any(String)],
      [`${API}/sinks`, '{"config":{"token":"new-access-aaaa"}}'],
    ],
  });
});

test("with a rule, a request with no place to fill is refused at once, before a member is asked: no placeholder at the field, no body, no JSON type, too many bytes", async () => {
  // The rule names the request itself: without the first check, each of these would wait for a
  // member. The first check does not ask what a placeholder names: another secret's at the field
  // is held, and refused when the request leaves.
  const { secret, sent } = await vault({
    bodyFields: [SINKS],
    rule: { methods: ["POST"], hosts: ["api.example.com"] },
  });
  const asText = { method: "POST", headers: { "content-type": "text/plain" } };
  const answers = [
    await secret.fetch(sink({ name: PLACEHOLDER, config: { token: "x" } })),
    await secret.fetch(sink({ name: "names it nowhere" })),
    await secret.fetch(useRequest(`${API}/sinks`, { method: "POST" })),
    await secret.fetch(
      useRequest(`${API}/sinks`, {
        ...asText,
        body: JSON.stringify({ config: { token: PLACEHOLDER } }),
      }),
    ),
    await secret.fetch(
      useRequest(`${API}/sinks`, {
        method: "POST",
        body: JSON.stringify({ config: { token: PLACEHOLDER }, pad: "x".repeat(1024 * 1024) }),
      }),
    ),
  ];
  expect({
    answers: await Promise.all(
      answers.map(async (answer) => [
        answer.status,
        answer.headers.get(VAULT_ANSWER_HEADER),
        await answer.text(),
      ]),
    ),
    sent,
    held: (await secret.approvals(PATH)).held,
  }).toEqual({
    answers: [
      "this body has no placeholder there",
      "this body has no placeholder there",
      "this request has no body",
      "the content type of this body is not JSON",
      "this body is too large, or is no UTF-8 text",
    ].map((reason) => [403, "refused", expect.stringContaining(`itx.fetch: ${reason}. `)]),
    sent: [],
    held: [],
  });
});

test("a rule set while a filled body was being prepared holds it: nothing leaves, and no fact says that the value went into a body", async () => {
  const { secret, sent, state } = await vault({ bodyFields: [SINKS] });
  // no rule when the request arrives, and one that names no POST by the time it would leave
  const read = state.storage.kv.get;
  let reads = 0;
  state.storage.kv.get = (key: string) =>
    key === "approval-rule" && ++reads > 1
      ? { methods: ["DELETE"], hosts: ["api.example.com"] }
      : read(key);
  const answer = await secret.fetch(sink({ config: { token: PLACEHOLDER } }));
  const [used] = decodeFacts(answer.headers.get(FACTS_HEADER) || "")[0]?.events ?? [];
  expect({
    status: answer.status,
    kind: answer.headers.get(VAULT_ANSWER_HEADER),
    sent,
    used: used?.payload,
  }).toEqual({
    status: 409,
    kind: "refused",
    sent: [],
    // exact: `inBody` here would say that a value left
    used: { method: "POST", url: `${API}/sinks`, status: 409 },
  });
});

test.for([
  { name: "with no rule", rule: undefined },
  { name: "with a rule", rule: { methods: ["DELETE"], hosts: ["api.example.com"] } },
])(
  "a body whose JSON type would come from the secret itself is filled for no host, $name: the type is read as the request wrote it",
  async ({ rule }) => {
    const { secret, sent } = await vault({
      bodyFields: [SINKS],
      material: { type: "application/json", token: TOKEN },
      rule,
    });
    const answer = await secret.fetch(
      new Request(`${API}/sinks`, {
        ...json({ config: { token: `getSecret("${PATH}", { field: "token" })` } }),
        headers: {
          authorization: `Bearer getSecret("${PATH}", { field: "token" })`,
          "content-type": `getSecret("${PATH}", { field: "type" })`,
          [SECRET_USE_HEADER]: PATH,
        },
      }),
    );
    expect({
      status: answer.status,
      kind: answer.headers.get(VAULT_ANSWER_HEADER),
      text: await answer.text(),
      sent,
    }).toEqual({
      status: 403,
      kind: "refused",
      text: expect.stringContaining("the content type of this body is not JSON"),
      sent: [],
    });
  },
);

test("a refresh after a 401 fills the body again from the request's copy, and the secret keeps its body fields", async () => {
  const { secret, sent, upstream } = await vault({ bodyFields: [SINKS], ...GRANT });
  upstream.mockImplementation(async (request: Request) => {
    const call = await seen(request);
    sent.push(call);
    if (call.url === `${API}/token`) return Response.json({ access_token: "new-access-aaaa" });
    return new Response("answered", {
      status: call.authorization === "Bearer new-access-aaaa" ? 200 : 401,
    });
  });
  const answer = await secret.fetch(granted({ config: { token: ACCESS } }));
  expect({
    status: answer.status,
    sent,
    described: await secret.secret(PATH, "describe", undefined),
  }).toMatchObject({
    status: 200,
    sent: [
      {
        url: `${API}/sinks`,
        authorization: "Bearer old-access-aaaa",
        body: '{"config":{"token":"old-access-aaaa"}}',
      },
      { url: `${API}/token` },
      {
        url: `${API}/sinks`,
        authorization: "Bearer new-access-aaaa",
        body: '{"config":{"token":"new-access-aaaa"}}',
      },
    ],
    // the refresh sealed a new value with the fields that the old one had, and no other
    described: { bodyFields: [SINKS] },
  });
});

test("a field that the secret's refresh alone reads goes into no body, as it goes into no header", async () => {
  const { secret, sent } = await vault({ bodyFields: [SINKS], ...GRANT });
  const answer = await secret.fetch(
    granted({ config: { token: `getSecret("${PATH}", { field: "refreshToken" })` } }),
  );
  expect({ status: answer.status, text: await answer.text(), sent }).toMatchObject({
    status: 403,
    text: expect.stringContaining(
      `"refreshToken" of ${PATH} is what the secret's oauth-refresh-token refresh reads`,
    ),
    sent: [],
  });
});

test("a placeholder at another place of a body that fills leaves as text: the value is at the field alone", async () => {
  const { secret, sent } = await vault({ bodyFields: [SINKS] });
  const answer = await secret.fetch(
    sink({ name: PLACEHOLDER, note: `Bearer ${PLACEHOLDER}`, config: { token: PLACEHOLDER } }),
  );
  expect({ status: answer.status, body: sent[0] && JSON.parse(sent[0].body) }).toEqual({
    status: 200,
    body: { name: PLACEHOLDER, note: `Bearer ${PLACEHOLDER}`, config: { token: TOKEN } },
  });
});

test("no answer is read for a value that went into a body: a host that shows it back shows it to the caller, in the answer to the fill and to a later read", async () => {
  // what the form says to the person who gives the value, and what no filter would hold
  const created = `{"created":{"config":{"token":"${TOKEN}"}}}`;
  const { secret, upstream } = await vault({ bodyFields: [SINKS] });
  upstream.mockImplementation(
    async () => new Response(created, { headers: { "x-echo": `got ${TOKEN}` } }),
  );
  const answers = [
    await secret.fetch(sink({ config: { token: PLACEHOLDER } })),
    await secret.fetch(useRequest(`${API}/sinks/1`, { method: "GET" })),
  ];
  expect(
    await Promise.all(
      answers.map(async (answer) => [await answer.text(), answer.headers.get("x-echo")]),
    ),
    // a header loses the value that the request's own header held, as for every secret
  ).toEqual(answers.map(() => [created, "got [redacted]"]));
});

test("a secret that is deleted while the body of a request arrives sends nothing: the secret is read again after the body", async () => {
  const { secret, sent } = await vault({ bodyFields: [SINKS] });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // the caller sends its body as slowly as it likes: the owner deletes the secret meanwhile
      await secret.secret(PATH, "delete", undefined);
      controller.enqueue(
        new TextEncoder().encode(JSON.stringify({ config: { token: PLACEHOLDER } })),
      );
      controller.close();
    },
  });
  const answer = await secret.fetch(
    // the cast: a stream as a body needs `duplex`, which workers-types' RequestInit does not declare
    useRequest(`${API}/sinks`, { method: "POST", body, ...({ duplex: "half" } as object) }),
  );
  expect({ status: answer.status, text: await answer.text(), sent }).toEqual({
    status: 409,
    text: expect.stringContaining("was given again or deleted since this request arrived"),
    sent: [],
  });
});

test.for([
  {
    name: "a secret that had none gets one",
    made: {},
    changed: (cell: Record<string, unknown>) => ({ ...cell, bodyFields: [SINKS] }),
  },
  {
    name: "its body field is moved to another field",
    made: { bodyFields: [SINKS] },
    changed: (cell: Record<string, unknown>) => ({
      ...cell,
      bodyFields: [{ ...SINKS, field: "name" }],
    }),
  },
  {
    name: "a second body field is added",
    made: { bodyFields: [SINKS] },
    changed: (cell: Record<string, unknown>) => ({
      ...cell,
      bodyFields: [SINKS, { ...SINKS, url: `${API}/notes` }],
    }),
  },
])(
  "a sealed cell opens only with the body fields it was sealed with: $name, and it opens nowhere",
  async ({ made, changed }) => {
    const { secret } = await vault(made);
    const until = Date.now() + 60_000;
    const { sealed } = Exported.parse(
      await secret.secret(PATH, "exportSealed", {
        until,
        proof: await hmacSha256Hex(AT_REST_KEY, JSON.stringify([PATH, "exportSealed", until])),
      }),
    ).result;
    await secret.secret(PATH, "delete", undefined);
    const importing = async (cell: string) =>
      secret.secret(PATH, "importSealed", {
        cell,
        proof: await hmacSha256Hex(AT_REST_KEY, JSON.stringify([PATH, cell])),
      });
    const stored = Sealed.parse(JSON.parse(sealed));
    // the proof is made with the stack's own key: even its holder adds no field to a sealed value
    await expect(
      importing(JSON.stringify({ ...stored, cell: changed(stored.cell) })),
    ).rejects.toThrow("does not open under this stack's at-rest key");
    await importing(sealed);
    expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({
      set: true,
      bodyFields: made.bodyFields,
    });
  },
);

test("a set names body fields only together with the value: with no material it is refused, and the secret is as it was", async () => {
  const { secret } = await vault({});
  await expect(secret.secret(PATH, "set", { urls: [API], bodyFields: [SINKS] })).rejects.toThrow(
    "material is a string or a JSON object",
  );
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({
    set: true,
    bodyFields: undefined,
  });
});

test("a collection form that names body fields changes the secret only when a person gives the value again", async () => {
  const { secret } = await vault({});
  const { url } = Collection.parse(
    await secret.secret(PATH, "collectFromUser", { egress: { urls: [API] }, bodyFields: [SINKS] }),
  );
  const nonce = new URL(url).searchParams.get("nonce") ?? "";
  const by = { member: true, userId: "user_aaaa", email: "member@example.com" };
  // the form that the person reads names the field
  expect(await secret.collectionForm(PATH, { nonce })).toMatchObject({
    use: { bodyFields: [SINKS] },
  });
  await expect(secret.collect(PATH, { nonce, values: {}, by })).rejects.toThrow("enter the value");
  // nothing was typed: the stored value has the use that it was given with
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({
    set: true,
    bodyFields: undefined,
  });
  await secret.collect(PATH, { nonce, values: { value: "typed-again-aaaa" }, by });
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({ bodyFields: [SINKS] });
});

/** The answer that holds a request: the digest to wait on. */
const Held = z.object({ digest: z.string() });
/** `exportSealed`'s answer, which the object's verbs give untyped. */
const Exported = z.object({ result: z.object({ sealed: z.string() }) });
/** A sealed cell as text holds it, as far as a test changes it. */
const Sealed = z.looseObject({ cell: z.record(z.string(), z.unknown()) });
/** `collectFromUser`'s answer. */
const Collection = z.object({ url: z.string() });

/** A grant as a connect leaves it, with the refresh that makes its next access token. */
const GRANT = {
  material: {
    accessToken: "old-access-aaaa",
    refreshToken: "refresh-aaaa",
    clientId: "client-aaaa",
  },
  refresh: { kind: "oauth-refresh-token" as const, tokenEndpoint: `${API}/token` },
};
/** The grant's access token, as a request names it. */
const ACCESS = `getSecret("${PATH}", { field: "accessToken" })`;

/** The Worker's variables: the config of a mind at `iterate.example.com`, and an at-rest key. */
const VARS = {
  ITERATE: JSON.stringify({
    mindId: "a".repeat(64),
    controlPlaneHostname: "iterate.example.com",
    zones: ["example.com"],
    ownerEmails: ["owner@example.net"],
    topology: "full-cloudflare",
  }),
  ITERATE__AT_REST_KEY: AT_REST_KEY,
  // a stack whose deploy made no SFU app or TURN key (../stack-secrets.test.ts has them)
  ITERATE__CLOUDFLARE_REALTIME: JSON.stringify({
    sfu: { refusal: "Authentication error" },
    turn: { refusal: "Authentication error" },
  }),
};

/** What the pinned host got of one request. */
async function seen(request: Request) {
  return {
    url: request.url,
    authorization: request.headers.get("authorization"),
    body: await request.text(),
  };
}

/** A vault with the one secret, pinned to `API`, made with `options`, and its rule when one is
 *  given. The pinned host answers 200 and keeps what it got in `sent`. */
async function vault(options: {
  bodyFields?: { method: string; url: string; field: string }[];
  material?: Record<string, string>;
  refresh?: { kind: "oauth-refresh-token"; tokenEndpoint: string };
  rule?: { methods: string[]; hosts: string[] };
}) {
  const sent: Awaited<ReturnType<typeof seen>>[] = [];
  const upstream = vi.fn(async (request: Request) => {
    sent.push(await seen(request));
    return new Response("sent");
  });
  vi.stubGlobal("fetch", upstream);
  const env = {
    ...VARS,
    // the vault's lists of paths: nothing here reads them
    APPROVALS: { getByName: () => ({ add: async () => {}, remove: async () => {} }) },
    // believes the statement: who signed is the key the envelope names, a member's
    AUTH: {
      verify: async (envelope: Envelope) => ({
        signer: {
          principal: { actor: envelope.signature.key },
          key: envelope.signature.key,
          label: "test key",
          member: true,
        },
        statement: JSON.parse(envelope.statement),
      }),
    },
  };
  const state = fakeState(PATH);
  // the cast: the object reads only the bindings above
  const secret = new SecretDurableObject(state as never, env as never);
  await secret.secret(PATH, "set", {
    material: options.material || TOKEN,
    urls: [API],
    bodyFields: options.bodyFields,
    refresh: options.refresh,
  });
  if (options.rule)
    await secret.tightenRule(PATH, {
      rule: options.rule,
      by: { userId: "user_aaaa", email: "member@example.com" },
    });
  const approve = (digest: string) =>
    secret.decide(PATH, {
      statement: JSON.stringify({
        mind: "iterate.example.com",
        path: PATH,
        at: 0,
        expires: 1,
        nonce: "n",
        type: APPROVED,
        about: [digest],
      }),
      signature: { format: "p256", key: "key-member", sig: "sig" },
    });
  return { secret, state, upstream, sent, approve };
}

/** A request as egress hands it over: the secret named in the Authorization header. */
function useRequest(url: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${PLACEHOLDER}`);
  headers.set(SECRET_USE_HEADER, PATH);
  if (init.body) headers.set("content-type", headers.get("content-type") ?? "application/json");
  return new Request(url, { ...init, headers });
}

/** A POST of `body` as JSON. */
function json(body: unknown) {
  return { method: "POST", body: JSON.stringify(body) };
}

/** The request that fills: a POST to the sinks with `body` as JSON. */
function sink(body: unknown) {
  return useRequest(`${API}/sinks`, json(body));
}

/** The request that fills, for the grant: its access token in the Authorization header. */
function granted(body: unknown) {
  return new Request(`${API}/sinks`, {
    ...json(body),
    headers: {
      authorization: `Bearer ${ACCESS}`,
      "content-type": "application/json",
      [SECRET_USE_HEADER]: PATH,
    },
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
