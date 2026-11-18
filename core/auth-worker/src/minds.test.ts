import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { errorCode } from "iterate/lib";
import { identityHashOf } from "iterate/mind-identity";
import {
  base64url,
  type Envelope,
  keyIdOf,
  signedMlDsa65,
  signedP256,
  statementOf,
  statementText,
  verifySignature,
} from "iterate/signed";
import { expect, test, vi } from "vitest";
import { newIdentityLog } from "../../lib/src/test-support/identity-log.ts";
import type { Env } from "./env.ts";
import { mindKeyOf, mindSignerOf } from "./minds.ts";
import { signedByStack, signedDeliveryByStack, stackKeyResponse } from "./stack-key.ts";
import { statementsResponse } from "./statements.ts";
import { configVars, keyRows, stackKeyPair } from "./test-support.ts";

const MIND = "iterate.example.com";
const SITE = { origin: `https://${MIND}`, rpId: MIND };
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

test("a member's passkey lets a mind in, the mind's statement lands as itself, and an empty rule ends it", async () => {
  const { send, owner, peer, melds } = await stack("peer-one.net");
  expect(
    await send(await owner("/minds/peer-one.net", { append: ["/minds/peer-one.net/"] })),
  ).toMatchObject({ status: 200 });
  expect(melds.get("peer-one.net")).toMatchObject({ append: '["/minds/peer-one.net/"]' });
  expect(await send(await peer.signs({ path: "/minds/peer-one.net/notes" }))).toMatchObject({
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

test("a mind's statement is refused, with its own reason, where its rule does not reach", async () => {
  const { send, owner, peer, fetched } = await stack("peer-four.net");
  await send(await owner("/minds/peer-four.net", { append: ["/minds/peer-four.net/"] }));
  expect(await send(await peer.signs({ path: "/agents/one" }))).toEqual({
    status: 403,
    body: { refused: "this key adds events under /minds/peer-four.net/ alone" },
    facts: [],
  });
  for (const path of ["/minds/peer-four.net/../agents", "/minds/peer-four.net/./x"])
    expect(await send(await peer.signs({ path }))).toMatchObject({ status: 403, facts: [] });
  expect(
    await send(
      await peer.signs({
        path: "/minds/peer-four.net/x",
        type: "events.iterate.com/itx/subscription-configured",
      }),
    ),
  ).toEqual({
    status: 403,
    body: { refused: "events.iterate.com/itx/subscription-configured is the platform's own" },
    facts: [],
  });
  // one read of the mind's identity log for all of it
  expect(fetched).toEqual(["https://peer-four.net/.well-known/iterate"]);
});

// Each case is its own mind: a reader keeps a log for a minute by its hostname.
test.for([
  {
    name: "a key that the log does not list",
    domain: "peer-ten.net",
    by: "an unlisted key",
    refused: "peer-ten.net lists no such working key",
  },
  {
    name: "a P-256 signature under the listed key's id",
    domain: "peer-fifteen.net",
    by: "P-256",
    refused: "this key signs as ML-DSA-65",
  },
  {
    name: "another ML-DSA-65 key's signature under the listed key's id",
    domain: "peer-sixteen.net",
    by: "a forger",
    refused: "the signature is not this key's",
  },
] as const)("a mind's statement signed by $name is refused", async ({ domain, by, refused }) => {
  const { send, owner, peer } = await stack(domain);
  await send(await owner(`/minds/${domain}`, { append: [`/minds/${domain}/`] }));
  expect(await send(await peer.signs({ path: `/minds/${domain}/x`, by }))).toEqual({
    status: 403,
    body: { refused },
    facts: [],
  });
});

test("a working key that the log lists for another purpose signs no statement", async () => {
  const { send, owner, peer } = await stack("peer-eleven.net", { peerPurpose: "backups" });
  await send(await owner("/minds/peer-eleven.net", { append: ["/minds/peer-eleven.net/"] }));
  expect(await send(await peer.signs({ path: "/minds/peer-eleven.net/x" }))).toEqual({
    status: 403,
    body: { refused: "peer-eleven.net lists no such working key" },
    facts: [],
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
  ["the mind's own name", "/minds/iterate.example.com", { append: [] }],
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

test("nothing is read for a mind that is not let in, and a mind that is let in is read once", async () => {
  const { send, owner, peer, fetched } = await stack("peer-twelve.net");
  expect(await send(await peer.signs({ path: "/minds/peer-twelve.net/x" }))).toMatchObject({
    status: 403,
    body: { refused: "peer-twelve.net is not let in here" },
  });
  expect(fetched).toEqual([]);
  await send(await owner("/minds/peer-twelve.net", { append: ["/minds/peer-twelve.net/"] }));
  for (const path of ["/minds/peer-twelve.net/x", "/minds/peer-twelve.net/y"])
    expect(await send(await peer.signs({ path }))).toMatchObject({ status: 200 });
  expect(fetched).toEqual(["https://peer-twelve.net/.well-known/iterate"]);
});

test("mindSignerOf answers the mind id that the log proves, the hostname and the listed key, and checks no rule; mindKeyOf asks the rule first", async () => {
  const { env, peer, fetched } = await stack("peer-seven.net");
  const listed = await peer.signs({ path: "/minds/peer-seven.net/x" });
  // no rule lets the mind in: mindKeyOf fetches nothing
  expect(await mindKeyOf(env, listed)).toEqual({ refused: "peer-seven.net is not let in here" });
  expect(fetched).toEqual([]);
  expect(await mindSignerOf(env, listed)).toEqual({
    mind: peer.mind,
    hostname: "peer-seven.net",
    key: {
      principal: { actor: "peer-seven.net", kind: "mind" },
      publicKey: peer.publicKey,
      label: "stack",
      format: "ML-DSA-65",
    },
  });
  expect(fetched).toEqual(["https://peer-seven.net/.well-known/iterate"]);
  // it checks no signature: a forger's statement under the listed id gets the same key back,
  // and the signature's check refuses it (the test above)
  expect(await mindSignerOf(env, await peer.signs({ path: "/x", by: "a forger" }))).toMatchObject({
    mind: peer.mind,
  });
  expect(await mindSignerOf(env, await peer.signs({ path: "/x", by: "an unlisted key" }))).toEqual({
    refused: "peer-seven.net lists no such working key",
  });
  // a statement that names no mind is no mind's
  const { privateKey, key } = await stackKeyPair();
  const own = await signedMlDsa65(
    statementText({ mind: MIND, path: "/x", type: "t", at: 0, expires: 1 }),
    privateKey,
    key,
  );
  expect(await mindSignerOf(env, own)).toBeNull();
  expect(await mindKeyOf(env, own)).toBeNull();
});

test("mindSignerOf and mindKeyOf, with a rule and without, answer nothing while this mind's own identity lists no key of its stack", async () => {
  const { env, send, owner, peer, fetched } = await stack("peer-thirteen.net", {
    listed: "no record",
  });
  const refused = {
    refused:
      "this mind's identity lists no working key of its stack yet, so it takes no statement from another mind",
  };
  const statement = await peer.signs({ path: "/minds/peer-thirteen.net/x" });
  expect(await mindSignerOf(env, statement)).toEqual(refused);
  await send(await owner("/minds/peer-thirteen.net", { append: ["/minds/peer-thirteen.net/"] }));
  expect(await mindKeyOf(env, statement)).toEqual(refused);
  expect(await mindSignerOf(env, statement)).toEqual(refused);
  expect(fetched).toEqual([]);
});

test.for([
  { name: "has no record", listed: "no record" },
  { name: "lists another working key", listed: "another key" },
] as const)(
  "while the mind's identity $name, the mind signs nothing as itself and takes no statement from another mind",
  async ({ listed }) => {
    const { env, send, owner, peer, fetched } = await stack("peer-six.net", { listed });
    const refusal = await signedByStack(env, {
      path: "/x",
      type: "events.iterate.com/test/note-added",
    }).catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      message:
        "the mind's identity lists no working key of this stack yet, so the mind signs nothing as itself",
    });
    // No code: this ends when a record lists the key, so a subscription that sends to another
    // mind tries again with its back-off. A coded FORBIDDEN would halt its row for good.
    expect(errorCode(refusal)).toBeUndefined();
    await expect(
      signedDeliveryByStack(env, {
        mind: "peer-six.net",
        path: "/integrations/github/7",
        type: "events.iterate.com/github/webhook-received",
      }),
    ).rejects.toThrow("the mind's identity lists no working key of this stack yet");
    // a member's rule is a member's statement, and is taken
    expect(
      await send(await owner("/minds/peer-six.net", { append: ["/minds/peer-six.net/"] })),
    ).toMatchObject({ status: 200 });
    expect(await send(await peer.signs({ path: "/minds/peer-six.net/x" }))).toEqual({
      status: 403,
      body: {
        refused:
          "this mind's identity lists no working key of its stack yet, so it takes no statement from another mind",
      },
      facts: [],
    });
    expect(fetched).toEqual([]);
    // the key is a candidate
    expect(await (await stackKeyResponse(env)).json()).toMatchObject({ listed: false });
  },
);

test("a rule that names a key takes that key alone", async () => {
  const { send, owner, peer } = await stack("peer-five.net");
  await send(
    await owner("/minds/peer-five.net", { append: ["/minds/peer-five.net/"], key: "another" }),
  );
  expect(await send(await peer.signs({ path: "/minds/peer-five.net/x" }))).toMatchObject({
    status: 403,
    body: { refused: "the rule names another key" },
  });
  await send(
    await owner("/minds/peer-five.net", { append: ["/minds/peer-five.net/"], key: peer.key }),
  );
  expect(await send(await peer.signs({ path: "/minds/peer-five.net/x" }))).toMatchObject({
    status: 200,
  });
});

test("the stack signs with ML-DSA-65 under the key that it publishes, and a reader verifies it there", async () => {
  const { env } = await stack("peer-fourteen.net");
  const published = (await (await stackKeyResponse(env)).json()) as Record<string, unknown>;
  expect(published).toEqual({
    mind: MIND,
    key: expect.any(String),
    publicKey: expect.any(String),
    algorithm: "ML-DSA-65",
    listed: true,
  });
  const signed = await signedByStack(env, {
    mind: "peer-fourteen.net",
    path: "/x",
    type: "events.iterate.com/test/note-added",
  });
  expect(signed.signature).toMatchObject({ format: "ML-DSA-65", key: published.key });
  const publicKey = published.publicKey as string;
  expect(await verifySignature(signed, publicKey, SITE)).toEqual({});
  const changed = { ...signed, statement: signed.statement.replace("note", "nope") };
  expect(await verifySignature(changed, publicKey, SITE)).toEqual({
    refused: "the signature is not this key's",
  });
  // another algorithm's key is no key for this signature
  expect(await verifySignature(signed, (await keyPair()).publicKey, SITE)).toEqual({
    refused: "malformed key or signature",
  });
});

test("signedByStack names this mind as `mind` alone, or with `mind` as the other mind and `from` as this one", async () => {
  const { env } = await stack("peer-eight.net");
  const read = (envelope: Envelope) => statementOf(envelope.statement);
  const input = { path: "/x", type: "events.iterate.com/test/note-added" };
  expect(await signedByStack(env, input).then(read)).not.toHaveProperty("from");
  expect(await signedByStack(env, input).then(read)).toMatchObject({ mind: MIND });
  expect(await signedByStack(env, { ...input, mind: "peer-eight.net" }).then(read)).toMatchObject({
    mind: "peer-eight.net",
    from: MIND,
  });
  await expect(signedByStack(env, { ...input, mind: MIND })).rejects.toThrow(/another mind/);
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
    from: MIND,
    path: `/minds/${MIND}/integrations/github/7`,
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
    `/minds/${MIND}/integrations/github/7`,
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
  const publicKey = base64url(
    new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer),
  );
  return { key: await keyIdOf(publicKey), publicKey, privateKey: pair.privateKey };
}

/** A stack whose owner is a member by the config, the Cloud's key under `/integrations/`, and the
 *  mind at `peerDomain`, whose identity log, truly signed, lists one ML-DSA-65 working key for
 *  `peerPurpose`, behind a fake `fetch`. `listed`: what this mind's own identity lists as its
 *  working key. This mind's last record is a row written by hand: the intake's own path to it is
 *  in ./working-key.test.ts. */
async function stack(
  peerDomain: string,
  {
    listed = "the stack's key",
    peerPurpose = "statements",
  }: { listed?: "the stack's key" | "another key" | "no record"; peerPurpose?: string } = {},
) {
  const [stackKey, otherStackKey, peerWorking, peerUnlisted] = await Promise.all(
    Array.from({ length: 4 }, () => stackKeyPair()),
  );
  const [ownerKey, cloudKey, peerP256] = await Promise.all(Array.from({ length: 3 }, keyPair));
  const melds = new Map<string, Record<string, unknown>>();
  const peerLog = await newIdentityLog([peerDomain]);
  const peerSecond = await peerLog.next(peerLog.genesis, {
    workingKeys: [{ ...peerWorking.entry, purpose: peerPurpose }],
  });
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    fetched.push(request.url);
    return Response.json({
      version: 1,
      mind: peerLog.mind,
      head: await identityHashOf(peerSecond.record),
      records: [peerLog.genesis, peerSecond],
    });
  });
  // THIS MIND'S OWN LOG, as `identityOf` reads its last row.
  const ownLog = await newIdentityLog([MIND]);
  const ownHead = {
    hash: "e".repeat(64),
    position: 2,
    record: JSON.stringify({
      ...JSON.parse(ownLog.genesis.record),
      nonce: undefined,
      prev: ownLog.mind,
      workingKeys: [listed === "another key" ? otherStackKey.entry : stackKey.entry],
    }),
  };
  const keys = await keyRows([
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
  ]);
  const prepare = (sql: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async () => {
      if (sql.includes("from keys k left join users u")) return keys(bound[0]);
      // nobody was added by hand: the members are the owners
      if (sql.includes("from members")) return null;
      if (sql.includes("from stack_key")) return stackKey.row;
      if (sql.includes("from identity_records")) return listed === "no record" ? null : ownHead;
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
    ...configVars(),
    DB: { prepare },
  } as unknown as Env;
  const statementFor = (
    fields: Partial<Parameters<typeof statementText>[0]> & { path: string; type: string },
  ) => {
    const at = Date.now() + (fields.at ?? 0);
    return statementText({ mind: MIND, ...fields, at, expires: at + 60_000 });
  };
  const send = async (envelope: Envelope) => {
    const answer = await statementsResponse(
      env,
      new Request(`https://${MIND}/statements`, {
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
      signedP256(
        statementFor({ path, type: "events.iterate.com/mind-meld/configured", payload, at }),
        ownerKey.privateKey,
        ownerKey.key,
      ),
    cloud: (path: string, type: string, payload: Record<string, unknown>) =>
      signedP256(statementFor({ path, type, payload }), cloudKey.privateKey, cloudKey.key),
    peer: {
      mind: peerLog.mind,
      key: peerWorking.key,
      publicKey: peerWorking.publicKey,
      /** A statement from the peer, as `itx.minds` sends one, signed with the working key that
       *  its log lists. `by`: signed with a key that the log does not list, under its own id; or
       *  under the listed key's id with a P-256 key, or with another ML-DSA-65 key. */
      signs: (fields: {
        path: string;
        type?: string;
        payload?: Record<string, unknown>;
        by?: "an unlisted key" | "P-256" | "a forger";
      }) => {
        const statement = statementFor({
          from: peerDomain,
          path: fields.path,
          type: fields.type || "events.iterate.com/test/note-added",
          payload: fields.payload || { text: "hello" },
          about: ["/notes@4"],
        });
        if (fields.by === "an unlisted key")
          return signedMlDsa65(statement, peerUnlisted.privateKey, peerUnlisted.key);
        if (fields.by === "P-256")
          return signedP256(statement, peerP256.privateKey, peerWorking.key);
        if (fields.by === "a forger")
          return signedMlDsa65(statement, peerUnlisted.privateKey, peerWorking.key);
        return signedMlDsa65(statement, peerWorking.privateKey, peerWorking.key);
      },
    },
  };
}
