import { timingSafeEqual } from "node:crypto";
import {
  envelopeOf,
  type Envelope,
  fromBase64url,
  keyIdOf,
  signedBytes,
  statementOf,
  verifySignature,
} from "iterate/signed";
import { SECRET_USE_HEADER } from "iterate/secret-placeholder";
import { expect, test, vi } from "vitest";
import { hmacSha256Hex } from "../secrets.ts";
import { SecretDurableObject } from "./durable-object.ts";

// workerd's own comparison, which Node's Web Crypto has not got
Object.assign(crypto.subtle, { timingSafeEqual });

const PATH = "/secrets/cloud-key";
const AT_REST_KEY = "at-rest-key-for-tests-only";
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SITE = { origin: "https://iterate.example.com", rpId: "iterate.example.com" };
const STATEMENT = {
  mind: "example.com",
  path: "/integrations/github",
  type: "events.iterate.com/github/connected",
  payload: { account: "octo" },
};

test("a key made in the secret signs a statement that a mind's check and WebCrypto both take, and says its public half and id", async () => {
  const { secret } = vault();
  const made = (await secret.secret(PATH, "generateSigningKey", {
    statementPaths: ["/integrations/"],
  })) as { result: { publicKey: string; keyId: string } };
  const { publicKey, keyId } = made.result;
  expect(keyId).toBe(await keyIdOf(publicKey));
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({
    operations: ["signStatement"],
    statementPaths: ["/integrations/"],
    public: { publicKey, keyId },
  });
  const signed = (await secret.secret(PATH, "signStatement", STATEMENT)) as {
    result: Envelope;
    facts: unknown[];
  };
  const envelope = envelopeOf(JSON.parse(JSON.stringify(signed.result)))!;
  expect(envelope.signature).toMatchObject({ format: "p256", key: keyId });
  expect(await verifySignature(envelope, publicKey, SITE)).toEqual({});
  const statement = statementOf(envelope.statement);
  expect(statement).toMatchObject({ ...STATEMENT, nonce: expect.any(String) });
  const { at } = statement as { at: number };
  expect(statement).toMatchObject({ expires: at + 300_000 });
  const spki = await crypto.subtle.importKey("spki", fromBase64url(publicKey), P256, false, [
    "verify",
  ]);
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      spki,
      fromBase64url(envelope.signature.sig),
      signedBytes(envelope.statement),
    ),
  ).toBe(true);
  expect(signed).toMatchObject({
    facts: [
      {
        path: PATH,
        events: [
          {
            type: "events.iterate.com/secret/operated",
            payload: { verb: "signStatement", outcome: "answered" },
          },
        ],
      },
    ],
  });
});

test("a key collected from a person keeps its id, and its private half is in no answer, fact or log line", async () => {
  const logged = vi.spyOn(console, "info");
  const { secret } = vault();
  const jwk = await privateJwk();
  const { kty, crv, x, y } = jwk;
  const spki = await crypto.subtle.exportKey(
    "spki",
    await crypto.subtle.importKey("jwk", { kty, crv, x, y }, P256, true, ["verify"]),
  );
  const keyId = await keyIdOf(Buffer.from(spki).toString("base64url"));
  const { url } = (await secret.secret(PATH, "collectFromUser", {
    egress: { urls: ["https://iterate.example.com"] },
    // a public field of a signing secret is its public half alone, whatever the form names
    fields: [{ name: "privateKey", label: "The private JWK", multiline: true, public: true }],
    operations: ["signStatement"],
    statementPaths: ["/integrations/"],
  })) as { url: string };
  const nonce = new URL(url).searchParams.get("nonce")!;
  const answers: unknown[] = [];
  answers.push(
    await secret.collect(PATH, {
      nonce,
      values: { privateKey: JSON.stringify(jwk) },
      by: { userId: "user_aaaa", email: "member@example.com", member: true } as never,
    }),
    await secret.secret(PATH, "describe", undefined),
    await secret.secret(PATH, "signStatement", STATEMENT),
    await secret
      .secret(PATH, "signStatement", { ...STATEMENT, path: "/agents/one" })
      .catch((error: Error) => error.message),
    await secret.clientSecretFor(PATH, {
      borrower: "/secrets/other",
      origin: "https://iterate.example.com",
    }),
    await secret.fetch(placeholderRequest()).then((answer) => answer.text()),
  );
  expect(answers[1]).toMatchObject({ public: { keyId } });
  expect(answers[2]).toMatchObject({ result: { signature: { key: keyId } } });
  expect(answers[3]).toContain("signs statements under /integrations/ alone, not /agents/one");
  expect(JSON.stringify(answers[4])).toContain("is a signing key, so it is lent to no other");
  expect(answers[5]).toContain("is a signing key: it signs (signStatement) and is never sent");
  const everything = JSON.stringify([answers, logged.mock.calls]);
  expect(everything).not.toContain(jwk.d);
  expect(everything).not.toContain('"d"');
});

test("a secret made to sign takes no material but a P-256 private JWK, and quotes none of it back", async () => {
  const { secret } = vault();
  const set = (material: unknown) =>
    secret
      .secret(PATH, "set", {
        material,
        urls: ["https://iterate.example.com"],
        operations: ["signStatement"],
      })
      .catch((error: Error) => error.message);
  const notAKey = "aaaaabbbbbccccc111112222233333aaaaabbbbb";
  for (const material of [notAKey, { privateKey: notAKey }, { privateKey: '{"kty":"RSA"}' }]) {
    const refused = await set(material);
    expect(refused).toContain("a P-256 private JWK");
    expect(refused).not.toContain(notAKey);
  }
});

test("a secret not made with signStatement is refused, and one made with it answers within its limit per minute", async () => {
  const { secret } = vault();
  await secret.secret(PATH, "set", {
    material: { privateKey: JSON.stringify(await privateJwk()) },
    urls: ["https://iterate.example.com"],
    operations: ["publicKeyOf"],
  });
  expect(await secret.secret(PATH, "signStatement", STATEMENT)).toMatchObject({
    refused: { code: "FORBIDDEN", message: expect.stringContaining("was not made to answer it") },
  });
  // a key is never made over a value: the one the secret holds may be one that minds trust
  expect(
    await secret.secret(PATH, "generateSigningKey", {}).catch((error: Error) => error.message),
  ).toContain("holds a value; delete it first");
  await secret.secret(PATH, "delete", undefined);
  await secret.secret(PATH, "generateSigningKey", {});
  // no statementPaths: any path
  const answers = [];
  for (let at = 0; at < 301; at += 1)
    answers.push(await secret.secret(PATH, "signStatement", { ...STATEMENT, path: "/agents/x" }));
  expect(answers.slice(0, 300).every((answer) => "result" in (answer as object))).toBe(true);
  expect(answers[300]).toMatchObject({
    refused: { code: "FORBIDDEN", message: expect.stringContaining("limit for this minute") },
  });
});

test.for([
  ["/integrations", true],
  ["/integrations/x/y", true],
  ["/integrationsx", false],
  ["/integrations/../secrets/x", false],
  ["/integrations//x", false],
])("statementPaths /integrations/ and %s: signed %s", async ([path, signs]) => {
  const { secret } = vault();
  await secret.secret(PATH, "generateSigningKey", { statementPaths: ["/integrations/"] });
  const answer = await secret
    .secret(PATH, "signStatement", { ...STATEMENT, path })
    .catch((error: Error) => error.message);
  expect(typeof answer === "object" && "result" in (answer as object)).toBe(signs);
});

test("a signing key handed out as a sealed cell comes back whole: the same key id, its paths still bound", async () => {
  const { secret } = vault();
  const { result } = (await secret.secret(PATH, "generateSigningKey", {
    statementPaths: ["/integrations/"],
  })) as { result: { keyId: string } };
  const until = Date.now() + 60_000;
  const exported = (await secret.secret(PATH, "exportSealed", {
    proof: await hmacSha256Hex(AT_REST_KEY, JSON.stringify([PATH, "exportSealed", until])),
    until,
  })) as { result: { sealed: string } };
  const cell = exported.result.sealed;
  const imported = (widened: string) =>
    hmacSha256Hex(AT_REST_KEY, JSON.stringify([PATH, widened])).then((proof) =>
      secret.secret(PATH, "importSealed", { cell: widened, proof }).catch((error: Error) => error),
    );
  await secret.secret(PATH, "delete", undefined);
  // a copy whose paths were taken off does not open: they are sealed with the key
  const stored = JSON.parse(cell) as { cell: Record<string, unknown> };
  delete stored.cell.statementPaths;
  expect(await imported(JSON.stringify(stored))).toBeInstanceOf(Error);
  await imported(cell);
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({
    statementPaths: ["/integrations/"],
    public: { keyId: result.keyId },
  });
  expect(await secret.secret(PATH, "signStatement", STATEMENT)).toMatchObject({
    result: { signature: { key: result.keyId } },
  });
});

test("a set that lands while a key is being made is the later word: the key does not replace it", async () => {
  const { secret } = vault();
  const generating = secret
    .secret(PATH, "generateSigningKey", {})
    .catch((error: Error) => error.message);
  const set = secret.secret(PATH, "set", {
    material: { privateKey: JSON.stringify(await privateJwk()) },
    urls: ["https://iterate.example.com"],
    operations: ["signStatement"],
  });
  const [generated] = await Promise.all([generating, set]);
  expect(generated).toEqual(expect.stringContaining("holds a value; delete it first"));
});

test("a set that comes in while a made key is sealed is kept, and the key is not reported as kept", async () => {
  const { secret, hooks } = vault();
  const later = { privateKey: JSON.stringify(await privateJwk()) };
  hooks.adding = () =>
    secret.secret(PATH, "set", {
      material: later,
      urls: ["https://iterate.example.com"],
      operations: ["signStatement"],
    });
  expect(
    await secret.secret(PATH, "generateSigningKey", {}).catch((error: Error) => error.message),
  ).toContain("a later write to /secrets/cloud-key replaced the key");
  expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({
    public: { publicKey: expect.any(String) },
  });
});

/** A private JWK made here, as a test makes every key: no key material is in the repository. */
async function privateJwk() {
  const pair = (await crypto.subtle.generateKey(P256, true, ["sign", "verify"])) as CryptoKeyPair;
  // the cast: a "jwk" export answers a JsonWebKey; the generated types answer either form
  const { kty, crv, x, y, d } = (await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  )) as JsonWebKey;
  return { kty: kty!, crv: crv!, x: x!, y: y!, d: d! };
}

function placeholderRequest() {
  return new Request("https://iterate.example.com/x", {
    headers: {
      authorization: `Bearer getSecret("${PATH}")`,
      [SECRET_USE_HEADER]: PATH,
    },
  });
}

/** The secret's object with no approval rule, on a store in memory. */
function vault() {
  const hooks: { adding?: () => Promise<unknown> } = {};
  const store = new Map<string, unknown>();
  const state = {
    id: { name: PATH },
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
    DOMAIN: "example.com",
    SECRETS_AT_REST_KEY: AT_REST_KEY,
    // `adding`: run inside the next write's call of the vault's list, after it took its version
    APPROVALS: {
      getByName: () => ({
        add: async () => {
          const run = hooks.adding;
          hooks.adding = undefined;
          await run?.();
        },
        remove: async () => {},
      }),
    },
  };
  // the cast: the object reads only the bindings above
  return { secret: new SecretDurableObject(state as never, env as never), hooks };
}
