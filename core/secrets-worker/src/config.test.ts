import { inspect } from "node:util";
import { expect, test } from "vitest";
import { secretsConfigOf } from "./config.ts";

const ITERATE = JSON.stringify({
  mindId: "a".repeat(64),
  controlPlaneHostname: "iterate.example.com",
  zones: ["example.com"],
  ownerEmails: ["owner@example.net"],
  topology: "full-cloudflare",
});
const ITERATE__AT_REST_KEY = "an at-rest key for a test, never a real one";
/** The stack's OAuth client at Cloudflare, as the deploy binds it: one secret variable, as JSON. */
const ITERATE__CLOUDFLARE_CLIENT = JSON.stringify({
  clientId: "the-stack-client",
  clientSecret: "a client secret for a test, never a real one",
});
const ITERATE__CLOUDFLARE_ACCOUNT_ID = "0".repeat(32);
const VARS = {
  ITERATE,
  ITERATE__AT_REST_KEY,
  ITERATE__CLOUDFLARE_CLIENT,
  ITERATE__CLOUDFLARE_ACCOUNT_ID,
};

test("the config is the shared one, the Worker's own at-rest key and the stack's client at Cloudflare", () => {
  const config = secretsConfigOf(VARS);
  expect(config).toMatchObject({
    controlPlaneHostname: "iterate.example.com",
    zones: ["example.com"],
    cloudflareClient: { clientId: "the-stack-client" },
    cloudflareAccountId: ITERATE__CLOUDFLARE_ACCOUNT_ID,
  });
  expect(config.atRestKey.exposeSecret()).toBe(ITERATE__AT_REST_KEY);
  expect(
    "clientSecret" in config.cloudflareClient &&
      config.cloudflareClient.clientSecret.exposeSecret(),
  ).toBe("a client secret for a test, never a real one");
});

test("a config with no at-rest key is refused, and the refusal names the variable", () => {
  expect(() => secretsConfigOf({ ...VARS, ITERATE__AT_REST_KEY: undefined })).toThrow(
    "ITERATE__AT_REST_KEY",
  );
});

test("a dump of the config prints REDACTED where the at-rest key and the client's secret are", () => {
  const config = secretsConfigOf(VARS);
  expect(JSON.parse(JSON.stringify(config))).toMatchObject({
    atRestKey: "REDACTED",
    cloudflareClient: { clientId: "the-stack-client", clientSecret: "REDACTED" },
  });
  expect(`${config.atRestKey}`).toBe("REDACTED");
  expect(inspect(config, { depth: 5 })).not.toMatch(/an at-rest key for a test|a client secret/);
});

test("a stack whose deploy made no client says so, with Cloudflare's words", () => {
  const config = secretsConfigOf({
    ...VARS,
    ITERATE__CLOUDFLARE_CLIENT: JSON.stringify({ refusal: "Authentication error" }),
  });
  expect(config).toMatchObject({ cloudflareClient: { refusal: "Authentication error" } });
});

test.for([
  ["no word of the client", undefined],
  ["a client with no secret", JSON.stringify({ clientId: "the-stack-client" })],
  [
    "a client and a refusal at once",
    JSON.stringify({ clientId: "a", clientSecret: "b", refusal: "c" }),
  ],
] as const)("a config with %s is refused, and the refusal names the variable", ([, value]) => {
  expect(() => secretsConfigOf({ ...VARS, ITERATE__CLOUDFLARE_CLIENT: value })).toThrow(
    "ITERATE__CLOUDFLARE_CLIENT",
  );
});

test("the config names no iterate Cloud, whatever a variable says: a secret names its own", () => {
  const config = secretsConfigOf({ ...VARS, ITERATE__CLOUD_ORIGIN: "https://cloud.example.net" });
  expect(Object.keys(config).filter((field) => /cloud(?!flare)/i.test(field))).toEqual([]);
  expect(JSON.stringify(config)).not.toContain("cloud.example.net");
});
