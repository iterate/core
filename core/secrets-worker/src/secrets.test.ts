import { expect, test } from "vitest";
import { useLines } from "./callback-page.ts";
import {
  accessTokenEnded,
  oauthTokensOf,
  REFRESH_READS,
  refreshOnlyFieldRefusal,
  refreshSecretMaterial,
  secretUseOf,
} from "./secrets.ts";

/** The pin of the secret whose use a test asks about. */
const PIN = ["https://api.example.com"];

test("the fields that a kind of refresh reads are the refresh's alone, each kind's by the schema it reads the material with, and any other field is given out", () => {
  const refused = (refresh: Parameters<typeof refreshOnlyFieldRefusal>[0], fields: string[]) =>
    fields.filter((field) => refreshOnlyFieldRefusal(refresh, "/secrets/a", field) !== null);
  const fields = ["accessToken", "refreshToken", "refreshToken.part", "clientId", "clientSecret"];
  const app = ["accessToken", "appId", "privateKey", "refreshToken"];
  expect({
    oauth: refused(
      { kind: "oauth-refresh-token", tokenEndpoint: "https://provider.example/token" },
      fields,
    ),
    app: refused(
      {
        kind: "github-app-installation",
        apiOrigin: "https://api.github.com",
        installationId: "1",
        client: { mind: "github" },
      },
      app,
    ),
    // exchange code of the maker's own gets the material whole: the platform names no field
    worker: refused({ kind: "worker", source: "export async function exchange() {}" }, fields),
    noRefresh: refused(null, fields),
    // a kind's fields are its schema's: what the refresh parses is what is kept from a request
    readByKind: Object.fromEntries(
      Object.entries(REFRESH_READS).map(([kind, reads]) => [kind, Object.keys(reads.shape)]),
    ),
  }).toEqual({
    oauth: ["refreshToken", "refreshToken.part", "clientId", "clientSecret"],
    app: ["appId", "privateKey"],
    worker: [],
    noRefresh: [],
    readByKind: {
      "oauth-refresh-token": ["refreshToken", "clientId", "clientSecret"],
      "github-app-installation": ["appId", "privateKey"],
      worker: [],
    },
  });
  // with no field named, nothing of an object is given out anyway
  expect(
    refreshOnlyFieldRefusal(
      { kind: "oauth-refresh-token", tokenEndpoint: "https://provider.example/token" },
      "/secrets/a",
      undefined,
    ),
  ).toBeNull();
});

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
  expect(secretUseOf(undefined, PIN)).toMatchObject({ lendTo: [] });
  expect(secretUseOf({ lendTo: ["/secrets/account", "/secrets/account"] }, PIN)).toMatchObject({
    lendTo: ["/secrets/account"],
  });
  expect(secretUseOf({ lendTo: null }, PIN)).toEqual({
    placement: "header",
    operations: [],
    lendTo: null,
  });
});

test.for([[""], [false], [0], ["/secrets/account"], [["account"]]] as const)(
  "a lendTo that is neither a list of secret paths nor null is refused: %j",
  ([lendTo]) => {
    expect(() => secretUseOf({ lendTo }, PIN)).toThrow("lendTo lists secret paths");
  },
);

test("a secret's body fields are kept with the method in capitals and each entry once, and a list of none is no list", () => {
  const sinks = { method: "post", url: "https://api.example.com/v1/sinks", field: "config.token" };
  const enable = { method: "POST", url: "https://api.example.com/v1/catalog/enable", field: "a" };
  expect({
    none: secretUseOf(undefined, PIN),
    empty: secretUseOf({ bodyFields: [] }, PIN),
    two: secretUseOf({ bodyFields: [sinks, enable, { ...sinks, method: "POST" }] }, PIN).bodyFields,
  }).toEqual({
    none: { placement: "header", operations: [], lendTo: [] },
    empty: { placement: "header", operations: [], lendTo: [] },
    two: [{ ...sinks, method: "POST" }, enable],
  });
});

test.for([
  {
    name: "a URL outside the pin",
    field: { url: "https://other.example.com/v1/sinks" },
    refused: "is outside the pin https://api.example.com",
  },
  {
    name: "a URL with a query",
    field: { url: "https://api.example.com/v1/sinks?all=1" },
    refused: "url is an https URL with a path of plain parts and no query",
  },
  {
    name: "a URL with a part that a host may read another way",
    field: { url: "https://api.example.com/v1/%2e%2e/sinks" },
    refused: "url is an https URL with a path of plain parts and no query",
  },
  {
    name: "a URL that is written another way than a URL writes itself",
    field: { url: "https://API.example.com/v1/../sinks" },
    refused: "is not as a URL writes itself",
  },
  {
    name: "a URL with no path",
    field: { url: "https://api.example.com" },
    refused: "url is an https URL with a path of plain parts and no query",
  },
  {
    name: "a URL that is not https",
    field: { url: "http://api.example.com/v1/sinks" },
    refused: "url is an https URL with a path of plain parts and no query",
  },
  {
    name: "an index of a list",
    field: { field: "items[0].token" },
    refused: "field is the dotted name of a field of the body's JSON object",
  },
  {
    name: "a wildcard",
    field: { field: "config.*" },
    refused: "field is the dotted name of a field of the body's JSON object",
  },
  {
    name: "no field",
    field: { field: "" },
    refused: "field is the dotted name of a field of the body's JSON object",
  },
  {
    name: "a field of more than 200 characters",
    field: { field: "a.".repeat(100) + "b" },
    refused: "field has at most 200 characters",
  },
  {
    name: "two methods",
    field: { method: "POST PUT" },
    refused: "method is one word, such as POST",
  },
  {
    name: "a key that is none of the three",
    field: { path: "/v1/sinks" },
    refused: "bodyFields lists at most 10 of { method, url, field }",
  },
])("a body field is refused with $name", ({ field, refused }) => {
  const sinks = { method: "POST", url: "https://api.example.com/v1/sinks", field: "config.token" };
  expect(() => secretUseOf({ bodyFields: [{ ...sinks, ...field }] }, PIN)).toThrow(refused);
});

test("a secret names ten body fields at most, and the list is a list", () => {
  const field = (n: number) => ({
    method: "POST",
    url: `https://api.example.com/v1/sinks/${n}`,
    field: "config.token",
  });
  const many = Array.from({ length: 11 }, (_, n) => field(n));
  expect(secretUseOf({ bodyFields: many.slice(0, 10) }, PIN).bodyFields).toHaveLength(10);
  expect(() => secretUseOf({ bodyFields: many }, PIN)).toThrow("bodyFields lists at most 10");
  expect(() => secretUseOf({ bodyFields: field(1) }, PIN)).toThrow("bodyFields lists at most 10");
});

test("the page that a person sees says, for each body field, where the value is sent and what that can cost", () => {
  const use = { placement: "header" as const, operations: [], lendTo: [] };
  expect(
    useLines(
      {
        ...use,
        bodyFields: [
          { method: "POST", url: "https://api.example.com/v1/sinks", field: "config.token" },
          {
            method: "POST",
            url: "https://api.example.com/v1/catalog/enable",
            field: "credential.token",
          },
        ],
      },
      false,
    ),
  ).toBe(
    "<p>It may also be sent inside the body of a request. A secret that is sent in a body is not kept from this mind's own code if that service shows it back. So give it only the reach that you would give the mind itself.</p>" +
      "<p>It may be sent inside the body, in the field config.token, of a POST to https://api.example.com/v1/sinks.</p>" +
      "<p>It may be sent inside the body, in the field credential.token, of a POST to https://api.example.com/v1/catalog/enable.</p>",
  );
  expect(useLines(use, false)).toBe("");
});

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
