// cloudflare-access-sign-in.test.ts — the token check `login.methods.cloudflareAccess` signs in by:
// jose checks the signature, the team, the audience and the times; the rest is ours.
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, test, vi } from "vitest";
import { verifyAccessToken } from "./cloudflare-access-sign-in.ts";

test.for<{ name: string; claims?: Record<string, unknown>; audience?: string; result: object }>([
  {
    name: "a person's token gives their email, lowercased",
    result: { email: "person@example.com" },
  },
  {
    name: "a service token is refused",
    claims: { email: undefined, common_name: "client-id.access" },
    result: { error: "not a person's sign-in" },
  },
  {
    name: "an org token is refused",
    claims: { type: "org" },
    result: { error: "not a person's sign-in" },
  },
  {
    name: "a token with no email is refused",
    claims: { email: "" },
    result: { error: "no email" },
  },
  {
    name: "another application's token is refused",
    audience: "aud-of-another-app",
    result: { error: expect.stringContaining('"aud"') },
  },
])("$name", async ({ claims, audience = AUD, result }) => {
  const { privateKey, publicKey } = await KEY;
  // the team's published keys, as <teamDomain>/cdn-cgi/access/certs serves them
  vi.stubGlobal("fetch", async () =>
    Response.json({ keys: [{ ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256" }] }),
  );
  const token = await new SignJWT({ type: "app", email: "Person@Example.com", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .setIssuer(TEAM)
    .setAudience([audience])
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  expect(await verifyAccessToken(token, { teamDomain: TEAM, aud: AUD })).toEqual(result);
});

const TEAM = "https://acme.cloudflareaccess.com";
const AUD = "aud-of-the-sign-in-app";
const KEY = generateKeyPair("RS256");
