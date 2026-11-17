import { expect, test } from "vitest";
import { useLines } from "./callback-page.ts";
import { accessTokenEnded, oauthTokensOf, refreshSecretMaterial, secretUseOf } from "./secrets.ts";

test("a token answer's expires_in is kept as the time the access token ends, and a token past that time has ended", async () => {
  const before = Date.now();
  const tokens = await oauthTokensOf(
    Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
    "oauth",
  );
  const ends = Date.parse(tokens.accessTokenExpiresAt!);
  expect(ends - before).toBeGreaterThanOrEqual(3_600_000);
  expect(ends - before).toBeLessThan(3_610_000);
  // a minute before its end it counts as ended, so no request leaves with a token about to end
  expect(accessTokenEnded(tokens, ends - 3_000_000)).toBe(false);
  expect(accessTokenEnded(tokens, ends - 30_000)).toBe(true);
  expect(accessTokenEnded(tokens, ends + 1)).toBe(true);
  // an answer that names no end: nothing says the token ended, and a 401 starts the refresh
  const endless = await oauthTokensOf(Response.json({ access_token: "a" }), "oauth");
  expect(endless).toEqual({ accessToken: "a" });
  expect(accessTokenEnded(endless)).toBe(false);
  expect(accessTokenEnded("a plain string secret")).toBe(false);
});

test("a refresh replaces the old token's end with the new answer's, or with none", async () => {
  const held = {
    clientId: "id",
    clientSecret: "s",
    accessToken: "old",
    refreshToken: "r1",
    accessTokenExpiresAt: "2026-01-01T00:00:00.000Z",
  };
  const refresh = {
    kind: "oauth-refresh-token" as const,
    tokenEndpoint: "https://provider.test/token",
    clientAuth: "client_secret_post" as const,
  };
  const plain = async (secret: string) => secret;
  const renewed = await refreshSecretMaterial(
    refresh,
    held,
    async () => Response.json({ access_token: "new", refresh_token: "r2", expires_in: 3600 }),
    plain,
  );
  expect(renewed).toMatchObject({ accessToken: "new", refreshToken: "r2", clientSecret: "s" });
  expect(accessTokenEnded(renewed)).toBe(false);
  const endless = await refreshSecretMaterial(
    refresh,
    held,
    async () => Response.json({ access_token: "new" }),
    plain,
  );
  expect(endless).toEqual({
    clientId: "id",
    clientSecret: "s",
    accessToken: "new",
    refreshToken: "r1",
  });
});

test("a secret lends to no other by default, to the paths its maker lists, and to every secret when its maker says null", () => {
  expect(secretUseOf(undefined)).toMatchObject({ lendTo: [] });
  expect(secretUseOf({ lendTo: ["/secrets/account", "/secrets/account"] })).toMatchObject({
    lendTo: ["/secrets/account"],
  });
  expect(secretUseOf({ lendTo: null })).toEqual({
    placement: "header",
    operations: [],
    lendTo: null,
  });
});

test.for([[""], [false], [0], ["/secrets/account"], [["account"]]] as const)(
  "a lendTo that is neither a list of secret paths nor null is refused: %j",
  ([lendTo]) => {
    expect(() => secretUseOf({ lendTo })).toThrow("lendTo lists secret paths");
  },
);

test("the page that a person sees says when the secret is lent to every secret", () => {
  const use = { placement: "header" as const, operations: [] };
  expect(useLines({ ...use, lendTo: null }, false)).toBe(
    "<p>The refresh of any secret of this mind may borrow it.</p>",
  );
  expect(useLines({ ...use, lendTo: ["/secrets/account"] }, false)).toContain(
    "The refresh of these secrets may borrow it: /secrets/account.",
  );
  expect(useLines({ ...use, lendTo: [] }, false)).toBe("");
});
