import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import {
  base64url,
  type Envelope,
  keyIdOf,
  publishedMindOf,
  signedP256,
  statementOf,
  statementText,
} from "iterate/signed";
import { expect, test, vi } from "vitest";
import type { Env } from "./env.ts";
import { signedByStack, signedDeliveryByStack } from "./stack-key.ts";
import { statementsResponse } from "./statements.ts";

const DOMAIN = "example.com";
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

test("a member's passkey lets a mind in, the mind's statement lands as itself, and an empty rule ends it", async () => {
  const { send, owner, peer, melds } = await stack("peer-one.net");
  expect(
    await send(await owner("/minds/peer-one.net", { append: ["/minds/peer-one.net/"] })),
  ).toMatchObject({ status: 200 });
  expect(melds.get("peer-one.net")).toMatchObject({ append: '["/minds/peer-one.net/"]' });
  const landed = await send(await peer.signs({ path: "/minds/peer-one.net/notes" }));
  expect(landed).toMatchObject({
    status: 200,
    facts: [
      {
        path: "/minds/peer-one.net/notes",
        events: [
          {
            type: "events.iterate.com/test/note-added",
            idempotencyKey: "mind:peer-one.net:/notes@4",
            source: {
              signer: { principal: { actor: "peer-one.net", kind: "mind" }, key: peer.key },
            },
          },
        ],
      },
    ],
  });
  expect(await send(await owner("/minds/peer-one.net", { append: [] }))).toMatchObject({
    status: 200,
  });
  expect(await send(await peer.signs({ path: "/minds/peer-one.net/notes" }))).toMatchObject({
    status: 403,
    body: { refused: "peer-one.net is not let in here" },
  });
});

test("an older rule sent again does not start a meld that a later rule ended", async () => {
  const { send, owner, melds } = await stack("peer-two.net");
  const older = await owner("/minds/peer-two.net", { append: ["/minds/peer-two.net/"] }, -1_000);
  expect(await send(await owner("/minds/peer-two.net", { append: [] }))).toMatchObject({
    status: 200,
  });
  await send(older);
  expect(melds.get("peer-two.net")).toMatchObject({ append: "[]" });
});

test("only a member's passkey sets a rule: a service's key and a melded mind are refused", async () => {
  const { send, owner, cloud, peer } = await stack("peer-three.net");
  await send(await owner("/minds/peer-three.net", { append: ["/minds/peer-three.net/"] }));
  const refusal = { status: 403, body: { refused: "only a member's passkey sets a mind meld" } };
  expect(
    await send(
      await cloud("/minds/peer-three.net", "events.iterate.com/mind-meld/configured", {
        append: ["/"],
      }),
    ),
  ).toMatchObject(refusal);
  expect(
    await send(
      await peer.signs({
        path: "/minds/peer-three.net/x",
        type: "events.iterate.com/mind-meld/configured",
        payload: { append: ["/agents/"] },
      }),
    ),
  ).toMatchObject(refusal);
});

test.for([
  ["the mind's own domain", "/minds/example.com", { append: [] }],
  ["a domain not in lowercase", "/minds/Peer.net", { append: [] }],
  ["a path that is no meld's", "/agents/peer.net", { append: [] }],
  ["a path with ..", "/minds/peer.net", { append: ["/minds/../agents/"] }],
  ["more than 20 paths", "/minds/peer.net", { append: Array(21).fill("/minds/peer.net/") }],
  ["a field the rule has not got", "/minds/peer.net", { append: [], until: 1 }],
] as const)("a rule with %s is refused", async ([, path, payload]) => {
  const { send, owner, melds } = await stack("peer.net");
  expect(await send(await owner(path, payload))).toMatchObject({ status: 403 });
  expect(melds).toMatchObject({ size: 0 });
});

test("a mind's statement is refused, with its own reason, where its rule does not reach", async () => {
  const { send, owner, peer, fetched } = await stack("peer-four.net");
  // not let in: nothing is fetched
  expect(await send(await peer.signs({ path: "/minds/peer-four.net/x" }))).toMatchObject({
    status: 403,
    body: { refused: "peer-four.net is not let in here" },
  });
  expect(fetched).toEqual([]);
  await send(await owner("/minds/peer-four.net", { append: ["/minds/peer-four.net/"] }));
  expect(await send(await peer.signs({ path: "/agents/one" }))).toMatchObject({
    status: 403,
    body: { refused: "this key adds events under /minds/peer-four.net/ alone" },
  });
  expect(
    await send(
      await peer.signs({
        path: "/minds/peer-four.net/x",
        type: "events.iterate.com/itx/subscription-configured",
      }),
    ),
  ).toMatchObject({ status: 403 });
  expect(await send(await peer.signs({ path: "/minds/peer-four.net/x", other: true }))).toEqual({
    status: 403,
    body: { refused: "peer-four.net publishes no such key" },
    facts: [],
  });
  // one read of the published document for all of it
  expect(fetched).toEqual(["https://peer-four.net/.well-known/iterate"]);
});

test("a published key whose id is not its own hash signs nothing, so a pinned id cannot be given another key", async () => {
  const { send, owner, peer } = await stack("peer-eight.net");
  const published = (await (await fetch(new Request("https://peer-eight.net/"))).json()) as {
    keys: { key: string }[];
  };
  const pinned = published.keys[0]!.key;
  const { publicKey } = await keyPair();
  vi.stubGlobal("fetch", async () =>
    Response.json({
      mind: "peer-eight.net",
      issuer: "https://iterate.peer-eight.net",
      statements: "https://iterate.peer-eight.net/statements",
      keys: [{ key: pinned, publicKey, label: "mind" }],
    }),
  );
  await send(
    await owner("/minds/peer-eight.net", { append: ["/minds/peer-eight.net/"], key: pinned }),
  );
  expect(await send(await peer.signs({ path: "/minds/peer-eight.net/x" }))).toMatchObject({
    status: 403,
    body: { refused: "peer-eight.net publishes a key under an id that is not its own" },
  });
});

test("a rule that names a key takes that key alone", async () => {
  const { send, owner, peer } = await stack("peer-five.net");
  await send(
    await owner("/minds/peer-five.net", { append: ["/minds/peer-five.net/"], key: "another" }),
  );
  expect(await send(await peer.signs({ path: "/minds/peer-five.net/x" }))).toMatchObject({
    status: 403,
    body: { refused: "the rule names another key" },
  });
});

test("the published document is read once a minute per domain, from the issuer when the address has none, and a redirect is no answer", async () => {
  const asked: string[] = [];
  const document = {
    mind: "peer-six.net",
    issuer: "https://iterate.peer-six.net",
    statements: "https://iterate.peer-six.net/statements",
    keys: [],
  };
  const fetcher = async (request: Request) => {
    asked.push(`${request.url} ${request.redirect}`);
    return request.url.startsWith("https://peer-six.net/")
      ? new Response(null, { status: 302, headers: { location: "https://evil.example/" } })
      : Response.json(document);
  };
  expect(await publishedMindOf("peer-six.net", fetcher)).toEqual(document);
  expect(await publishedMindOf("peer-six.net", fetcher)).toEqual(document);
  expect(asked).toEqual([
    "https://peer-six.net/.well-known/iterate manual",
    "https://iterate.peer-six.net/.well-known/iterate manual",
  ]);
  expect(
    await publishedMindOf(
      "peer-seven.net",
      async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    ),
  ).toEqual({
    why: "https://iterate.peer-seven.net/.well-known/iterate answered 302 with no document",
  });
});

test("signedByStack names this mind as `mind` alone, or with `mind` as the other mind and `from` as this one", async () => {
  const { env } = await stack("peer-eight.net");
  const read = (envelope: Envelope) => statementOf(envelope.statement);
  const input = { path: "/x", type: "events.iterate.com/test/note-added" };
  expect(await signedByStack(env, input).then(read)).not.toHaveProperty("from");
  expect(await signedByStack(env, input).then(read)).toMatchObject({ mind: DOMAIN });
  expect(await signedByStack(env, { ...input, mind: "peer-eight.net" }).then(read)).toMatchObject({
    mind: "peer-eight.net",
    from: DOMAIN,
  });
  await expect(signedByStack(env, { ...input, mind: DOMAIN })).rejects.toThrow(/another mind/);
});

test("a delivery is signed as this mind on /minds/<this mind>/integrations/<provider>/<account>, and on no other path", async () => {
  const { env } = await stack("peer-nine.net");
  const type = "events.iterate.com/github/webhook-received";
  const signed = await signedDeliveryByStack(env, {
    mind: "peer-nine.net",
    path: "/integrations/github/7",
    type,
    about: ["cloud:github:d-1"],
  });
  expect(statementOf(signed.statement)).toMatchObject({
    mind: "peer-nine.net",
    from: DOMAIN,
    path: `/minds/${DOMAIN}/integrations/github/7`,
    type,
    about: ["cloud:github:d-1"],
  });
  for (const path of [
    "/agents/onboarding",
    "/integrations/github",
    "/integrations/github/7/more",
    "/integrations/../..",
    "/integrations/./x",
    "/integrations/../x",
    "/integrations/github/..",
    `/minds/${DOMAIN}/integrations/github/7`,
    "/",
  ])
    await expect(signedDeliveryByStack(env, { mind: "peer-nine.net", path, type })).rejects.toThrow(
      /a delivery's path/,
    );
  await expect(
    signedDeliveryByStack(env, { mind: "", path: "/integrations/github/7", type }),
  ).rejects.toThrow(/names the mind/);
});
async function keyPair() {
  const pair = (await crypto.subtle.generateKey(P256, true, ["sign", "verify"])) as CryptoKeyPair;
  const exported = async (format: "spki" | "pkcs8", key: CryptoKey) =>
    base64url(new Uint8Array((await crypto.subtle.exportKey(format, key)) as ArrayBuffer));
  const publicKey = await exported("spki", pair.publicKey);
  return {
    key: await keyIdOf(publicKey),
    publicKey,
    pkcs8: await exported("pkcs8", pair.privateKey),
    privateKey: pair.privateKey,
  };
}

/** A stack whose owner is a member by the config, the Cloud's key under `/integrations/`, and the
 *  mind at `peerDomain`, which publishes one key (and a second it does not publish) behind a fake
 *  `fetch`. */
async function stack(peerDomain: string) {
  const [stackKey, ownerKey, cloudKey, peerKey, unpublished] = await Promise.all(
    Array.from({ length: 5 }, keyPair),
  );
  const melds = new Map<string, Record<string, unknown>>();
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    fetched.push(request.url);
    return Response.json({
      mind: peerDomain,
      issuer: `https://iterate.${peerDomain}`,
      statements: `https://iterate.${peerDomain}/statements`,
      keys: [{ key: peerKey.key, publicKey: peerKey.publicKey, label: "mind" }],
    });
  });
  const prepare = (sql: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async () => {
      // nobody was added by hand: the members and the keys are the config's
      if (sql.includes("from members") || sql.includes("from keys")) return null;
      if (sql.includes("from stack_key"))
        return {
          key: stackKey.key,
          public_key: stackKey.publicKey,
          private_key: stackKey.pkcs8,
        };
      if (sql.includes("from mind_melds")) {
        const row = melds.get(bound[0] as string);
        return row && row.append !== "[]" ? row : null;
      }
      throw new Error(`not expected: ${sql}`);
    },
    run: async () => {
      if (!sql.startsWith("insert into mind_melds")) throw new Error(`not expected: ${sql}`);
      const [domain, append, key, at, by] = bound;
      const kept = melds.get(domain as string);
      if (!kept || (at as number) >= (kept.configured_at as number))
        melds.set(domain as string, { append, key, configured_at: at, configured_by: by });
      return { meta: { changes: 1 } };
    },
  });
  const env = {
    DOMAIN,
    AUTH_SETTINGS: JSON.stringify({
      login: { methods: { email: {} }, allow: [{ email: "owner@example.net" }] },
      keys: [
        {
          actor: "iterate-cloud",
          publicKey: cloudKey.publicKey,
          label: "Cloud",
          paths: ["/integrations/"],
        },
        {
          actor: "user-owner",
          email: "owner@example.net",
          publicKey: ownerKey.publicKey,
          label: "a passkey",
        },
      ],
    }),
    DB: { prepare },
  } as unknown as Env;
  const signed = (
    key: { privateKey: CryptoKey; key: string },
    fields: Partial<Parameters<typeof statementText>[0]> & { path: string; type: string },
  ) => {
    const at = Date.now() + (fields.at ?? 0);
    return signedP256(
      statementText({ mind: DOMAIN, ...fields, at, expires: at + 60_000 }),
      key.privateKey,
      key.key,
    );
  };
  const send = async (envelope: Envelope) => {
    const answer = await statementsResponse(
      env,
      new Request("https://iterate.example.com/statements", {
        method: "POST",
        body: JSON.stringify(envelope),
      }),
    );
    return {
      status: answer.status,
      body: await answer.json(),
      facts: decodeFacts(answer.headers.get(FACTS_HEADER) || ""),
    };
  };
  return {
    env,
    melds,
    fetched,
    send,
    /** The owner's rule: `at` is how far from now it was signed. */
    owner: (path: string, payload: Record<string, unknown>, at = 0) =>
      signed(ownerKey, { path, type: "events.iterate.com/mind-meld/configured", payload, at }),
    cloud: (path: string, type: string, payload: Record<string, unknown>) =>
      signed(cloudKey, { path, type, payload }),
    peer: {
      key: peerKey.key,
      /** A statement from the peer, as `itx.minds` sends one: `other` signs with a key it does not
       *  publish. */
      signs: (fields: {
        path: string;
        type?: string;
        payload?: Record<string, unknown>;
        other?: true;
      }) =>
        signed(fields.other ? unpublished : peerKey, {
          from: peerDomain,
          path: fields.path,
          type: fields.type || "events.iterate.com/test/note-added",
          payload: fields.payload || { text: "hello" },
          about: ["/notes@4"],
        }),
    },
  };
}
