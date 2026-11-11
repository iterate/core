import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, test } from "vitest";
import { googleAddressOf } from "./google-id-token.ts";

const CLIENT = "the-cloud's-client-id";
const NONCE = "this-browser's-nonce";

test("Google vouches for a Gmail address, and for an address of the account's own Workspace domain", async () => {
  const { token, expected } = await setup();
  expect(await googleAddressOf(await token({ email: "Ada@Gmail.com" }), expected)).toEqual({
    email: "ada@gmail.com",
  });
  expect(
    await googleAddressOf(await token({ email: "ada@acme.example", hd: "acme.example" }), expected),
  ).toEqual({
    email: "ada@acme.example",
  });
});

test("an address Google only mailed once is refused: no Workspace domain, or another one's", async () => {
  const { token, expected } = await setup();
  // a Google account made with an outside address: `email_verified` is true, and Google is not
  // the authority for that address
  expect(await googleAddressOf(await token({ email: "ada@acme.example" }), expected)).toMatchObject(
    {
      refused: expect.stringContaining("Google does not vouch for ada@acme.example"),
    },
  );
  expect(
    await googleAddressOf(
      await token({ email: "ada@acme.example", hd: "other.example" }),
      expected,
    ),
  ).toMatchObject({ refused: expect.stringContaining("Google does not vouch") });
  expect(
    await googleAddressOf(await token({ email: "ada@gmail.com", email_verified: false }), expected),
  ).toMatchObject({ reason: "the id_token names no verified address" });
});

test("a token that is not Google's own, for this client and this browser, says nothing", async () => {
  const { token, expected, stranger } = await setup();
  const ada = { email: "ada@gmail.com" };
  const refusals = await Promise.all([
    // signed by a key Google does not publish: what a dishonest broker could make
    token(ada, { signer: stranger.privateKey }).then((idToken) =>
      googleAddressOf(idToken, expected),
    ),
    // Google's own token for another app
    token(ada, { audience: "another-client" }).then((idToken) =>
      googleAddressOf(idToken, expected),
    ),
    token(ada, { issuer: "https://accounts.example" }).then((idToken) =>
      googleAddressOf(idToken, expected),
    ),
    // Google's own token for another sign-in: a replay
    token({ ...ada, nonce: "another-browser's-nonce" }).then((idToken) =>
      googleAddressOf(idToken, expected),
    ),
    googleAddressOf("not.a.token", expected),
  ]);
  expect(
    refusals.map((each) => ("refused" in each ? each.reason.split(":")[0] : "accepted")),
  ).toEqual([
    "the id_token is not Google's for this client",
    "the id_token is not Google's for this client",
    "the id_token is not Google's for this client",
    "the id_token is for another sign-in",
    "the id_token is not Google's for this client",
  ]);
});

/** A key set that stands in for Google's, and an id_token signed by it (or by `signer`). */
async function setup() {
  const google = await generateKeyPair("RS256");
  const stranger = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(google.publicKey)), kid: "google-1", alg: "RS256", use: "sig" }],
  });
  const token = (
    claims: Record<string, unknown>,
    { issuer = "https://accounts.google.com", audience = CLIENT, signer = google.privateKey } = {},
  ) =>
    new SignJWT({ nonce: NONCE, email_verified: true, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "google-1" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signer);
  return { token, stranger, expected: { keys, clientId: CLIENT, nonce: NONCE } };
}
