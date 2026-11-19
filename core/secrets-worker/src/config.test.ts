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
/** The stack's SFU app and TURN key, as the deploy binds them: one made, one not. */
const ITERATE__CLOUDFLARE_REALTIME = JSON.stringify({
  sfu: { appId: "the-sfu-app", appSecret: "an app secret for a test, never a real one" },
  turn: { refusal: "Authentication error" },
});
const VARS = { ITERATE, ITERATE__AT_REST_KEY, ITERATE__CLOUDFLARE_REALTIME };

test("the config is the shared one and the Worker's own at-rest key", () => {
  const config = secretsConfigOf(VARS);
  expect(config).toMatchObject({
    controlPlaneHostname: "iterate.example.com",
    zones: ["example.com"],
  });
  expect(config.atRestKey.exposeSecret()).toBe(ITERATE__AT_REST_KEY);
});

test("a stack deployed before 19 Nov 2026 still binds its OAuth client: the config ignores it", () => {
  const config = secretsConfigOf({
    ...VARS,
    ITERATE__CLOUDFLARE_CLIENT: JSON.stringify({ clientId: "a", clientSecret: "b" }),
    CLOUDFLARE_CLIENT_ID: "a",
    ITERATE__CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
  });
  expect(Object.keys(config)).not.toContain("cloudflareClient");
});

test("a config with no at-rest key is refused, and the refusal names the variable", () => {
  expect(() => secretsConfigOf({ ...VARS, ITERATE__AT_REST_KEY: undefined })).toThrow(
    "ITERATE__AT_REST_KEY",
  );
});

test("a dump of the config prints REDACTED where the at-rest key and the app's secret are", () => {
  const config = secretsConfigOf(VARS);
  expect(JSON.parse(JSON.stringify(config))).toMatchObject({
    atRestKey: "REDACTED",
    cloudflareRealtime: {
      sfu: { appId: "the-sfu-app", appSecret: "REDACTED" },
      turn: { refusal: "Authentication error" },
    },
  });
  expect(`${config.atRestKey}`).toBe("REDACTED");
  expect(inspect(config, { depth: 5 })).not.toMatch(/an at-rest key for a test|an app secret/);
});

test.for([
  ["no word of the SFU app and TURN key", undefined],
  ["an app with no secret", JSON.stringify({ sfu: { appId: "a" }, turn: { refusal: "c" } })],
  ["no word of the TURN key", JSON.stringify({ sfu: { refusal: "c" } })],
] as const)("a config with %s is refused, and the refusal names the variable", ([, value]) => {
  expect(() => secretsConfigOf({ ...VARS, ITERATE__CLOUDFLARE_REALTIME: value })).toThrow(
    "ITERATE__CLOUDFLARE_REALTIME",
  );
});

test("the config names no iterate Cloud, whatever a variable says: a secret names its own", () => {
  const config = secretsConfigOf({ ...VARS, ITERATE__CLOUD_ORIGIN: "https://cloud.example.net" });
  expect(Object.keys(config).filter((field) => /cloud(?!flare)/i.test(field))).toEqual([]);
  expect(JSON.stringify(config)).not.toContain("cloud.example.net");
});
