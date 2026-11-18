import { inspect } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import { Redacted, redacted } from "./app-config.ts";
import {
  isControlPlaneHostname,
  mindConfigOf,
  controlPlaneOriginOf,
  zoneCoversControlPlaneHostname,
  zoneOf,
  zoneOfMailAddress,
  MindConfig,
} from "./mind-config.ts";

const shared = {
  mindId: "a".repeat(64),
  controlPlaneHostname: "iterate.example.com",
  zones: ["example.com", "example.org"],
  ownerEmails: ["ada@elsewhere.example"],
  topology: "full-cloudflare",
};

test.for([
  ["example.com", "example.com"],
  ["dash.example.com", "example.com"],
  ["a.b.example.com", "example.com"],
  ["iterate.example.com", "example.com"],
  ["example.org", "example.org"],
  ["blog.example.org", "example.org"],
  // a name that only ends in a zone's letters is not under it
  ["notexample.com", null],
  ["example.com.evil.example", null],
  ["example.net", null],
] as const)("with two zones, %s is in the zone %s", ([hostname, zone]) => {
  expect(zoneOf(shared, hostname)).toBe(zone);
});

test("a zone under another zone takes its own names, whatever order the config lists them in", () => {
  for (const zones of [
    ["example.com", "sub.example.com"],
    ["sub.example.com", "example.com"],
  ]) {
    expect(zoneOf({ zones }, "sub.example.com")).toBe("sub.example.com");
    expect(zoneOf({ zones }, "app.sub.example.com")).toBe("sub.example.com");
    expect(zoneOf({ zones }, "other.example.com")).toBe("example.com");
    expect(zoneOf({ zones }, "example.com")).toBe("example.com");
  }
});

test("a hostname is one name whatever its case, and with one trailing dot: the control-plane hostname and the zones are compared the same way", () => {
  expect(isControlPlaneHostname(shared, "iterate.example.com")).toBe(true);
  expect(isControlPlaneHostname(shared, "ITERATE.Example.com")).toBe(true);
  expect(isControlPlaneHostname(shared, "iterate.example.com.")).toBe(true);
  expect(isControlPlaneHostname(shared, "iterate.example.com..")).toBe(false);
  expect(isControlPlaneHostname(shared, "iterate.example.org")).toBe(false);
  expect(isControlPlaneHostname(shared, "example.com")).toBe(false);
  expect(zoneOf(shared, "App.Example.ORG")).toBe("example.org");
  expect(zoneOf(shared, "app.example.org.")).toBe("example.org");
  expect(zoneOf(shared, "example.org.")).toBe("example.org");
  expect(zoneOf(shared, "example.org.evil.example.")).toBeNull();
});

test("a mail address is the mind's when its domain is in a zone", () => {
  expect(zoneOfMailAddress(shared, "Agent@Example.ORG")).toBe("example.org");
  expect(zoneOfMailAddress(shared, "agent@example.com")).toBe("example.com");
  expect(zoneOfMailAddress(shared, "agent@elsewhere.example")).toBeNull();
  expect(zoneOfMailAddress(shared, "example.com")).toBeNull();
  expect(zoneOfMailAddress(shared, "@example.com")).toBeNull();
});

test("a Worker's config is the shared object and its own key, which a dump never shows", () => {
  const config = mindConfigOf(
    { ITERATE: JSON.stringify(shared), ITERATE__SIGNING_KEY: "the-key", OTHER: "ignored" },
    { signingKey: redacted(z.string().min(1)) },
  );
  expect(config).toMatchObject(shared);
  expect(controlPlaneOriginOf(config)).toBe("https://iterate.example.com");
  expect(config.signingKey).toBeInstanceOf(Redacted);
  expect(config.signingKey.exposeSecret()).toBe("the-key");
  expect(JSON.parse(JSON.stringify(config))).toEqual({ ...shared, signingKey: "REDACTED" });
  // the three ways a value is printed each give the one word, and nothing of the key
  expect([
    `${config.signingKey}`,
    JSON.stringify(config.signingKey),
    inspect(config.signingKey),
  ]).toEqual(["REDACTED", '"REDACTED"', "REDACTED"]);
});

test("the config's variable is the object as JSON text or the object itself, a Workers JSON binding, with the key merged onto either", () => {
  const own = { signingKey: redacted(z.string().min(1)) };
  const asText = mindConfigOf(
    { ITERATE: JSON.stringify(shared), ITERATE__SIGNING_KEY: "the-key" },
    own,
  );
  const asObject = mindConfigOf({ ITERATE: shared, ITERATE__SIGNING_KEY: "the-key" }, own);
  expect(JSON.parse(JSON.stringify(asObject))).toEqual({ ...shared, signingKey: "REDACTED" });
  expect(JSON.parse(JSON.stringify(asObject))).toEqual(JSON.parse(JSON.stringify(asText)));
  expect(asObject.signingKey.exposeSecret()).toBe("the-key");
  // one field set alone lands on the bound object too
  expect(
    mindConfigOf(
      { ITERATE: shared, ITERATE__TOPOLOGY: "external-mind-connects-into-cloudflare-boundary" },
      {},
    ),
  ).toMatchObject({ topology: "external-mind-connects-into-cloudflare-boundary" });
});

test.for([
  // an apex, of either zone
  ["example.com", true],
  ["example.org", true],
  // one label under the second zone
  ["login.example.org", true],
  // two labels deep: no certificate of the zone covers it
  ["a.iterate.example.com", false],
  // names that only look like one of the zones
  ["notexample.com", false],
  ["iterate.example.com.evil.example", false],
  ["iterate.example.net", false],
] as const)(
  "with two zones, the control plane may answer at %s: %s",
  ([controlPlaneHostname, allowed]) => {
    expect(zoneCoversControlPlaneHostname({ ...shared, controlPlaneHostname })).toBe(allowed);
    const parse = () => mindConfigOf({ ITERATE: { ...shared, controlPlaneHostname } }, {});
    if (allowed) expect(parse()).toMatchObject({ controlPlaneHostname });
    else expect(parse).toThrow("ITERATE controlPlaneHostname (ITERATE__CONTROL_PLANE_HOSTNAME)");
  },
);

test("a zone under another zone covers the names one label under itself", () => {
  const zones = ["example.com", "sub.example.com"];
  expect(
    zoneCoversControlPlaneHostname({ controlPlaneHostname: "iterate.sub.example.com", zones }),
  ).toBe(true);
});

test("a Worker's config is parsed once for each env object and each shape of its own fields", () => {
  const own = { signingKey: redacted(z.string().min(1)) };
  const env = { ITERATE: JSON.stringify(shared), ITERATE__SIGNING_KEY: "the-key" };
  expect(mindConfigOf(env, own)).toBe(mindConfigOf(env, own));
  // another Worker's fields over the same variables, and the same fields over another env
  expect(mindConfigOf(env, {})).not.toBe(mindConfigOf(env, own));
  expect(mindConfigOf({ ...env }, own)).not.toBe(mindConfigOf(env, own));
});

test("a config with a field missing throws, naming the field in both spellings", () => {
  expect(() =>
    mindConfigOf({ ITERATE: JSON.stringify(shared) }, { signingKey: redacted(z.string().min(1)) }),
  ).toThrow("ITERATE signingKey (ITERATE__SIGNING_KEY)");
});

test.for([
  ["no mind id", undefined],
  ["a mind id of 63 characters", "a".repeat(63)],
  ["a mind id of 65 characters", "a".repeat(65)],
  ["a mind id with a capital", "A".repeat(64)],
  ["a mind id that is no hex", "g".repeat(64)],
  ["a hostname as the mind id", "iterate.example.com"],
] as const)("a config with %s is refused, and the refusal names the field", ([, mindId]) => {
  const refused = MindConfig.safeParse({ ...shared, mindId });
  expect(refused.error?.issues.map((issue) => issue.path)).toEqual([["mindId"]]);
  expect(MindConfig.safeParse({ ...shared, mindId: "ab".repeat(32) })).toMatchObject({
    success: true,
  });
});
