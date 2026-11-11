import { expect, test } from "vitest";
import {
  canonicalPath,
  cloudNameRefusal,
  honouredNext,
  serviceKeyRequestOf,
  underPaths,
} from "./key-rules.ts";

const ISSUER = "https://iterate.example.com";
const TRUSTED = ["https://cloud.example.net"];

test.each([
  ["/keys?x=1", "/keys?x=1"],
  [`${ISSUER}/keys/enrol?actor=cloud`, "/keys/enrol?actor=cloud"],
  [
    "https://cloud.example.net/connected?d=example.com",
    "https://cloud.example.net/connected?d=example.com",
  ],
  ["https://onboarding.example.com/", "https://onboarding.example.com/"],
  ["https://example.com/welcome", "https://example.com/welcome"],
  ["http://onboarding.example.com/", null],
  ["https://onboarding.example.com.evil.example/", null],
  ["https://evilexample.com/", null],
  ["https://evil.example/", null],
  ["//evil.example/", null],
  ["/\\evil.example/", null],
  ["javascript:alert(1)", null],
  ["http://cloud.example.net/", null],
  ["", null],
  [null, null],
])("next %s is honoured as %s", (next, honoured) => {
  expect(honouredNext(next, ISSUER, TRUSTED)).toBe(honoured);
});

test("a key confined to paths reaches only under them; an unconfined key reaches every path", () => {
  expect(underPaths("/integrations/github", ["/integrations/"])).toBe(true);
  expect(underPaths("/agents/x", ["/integrations/"])).toBe(false);
  expect(underPaths("/agents/x", undefined)).toBe(true);
  expect(underPaths("/smokey/x", ["/smoke"])).toBe(false);
  expect(underPaths("/smoke", ["/smoke/"])).toBe(true);
  expect(underPaths("/anything", ["/"])).toBe(true);
});

test("a service's request names a plain actor, a label, a key and at least one path", () => {
  const ask = (query: Record<string, string>) => serviceKeyRequestOf(new URLSearchParams(query));
  const good = {
    actor: "cloud",
    label: "iterate Cloud",
    publicKey: "abc_-1",
    paths: "/integrations/, /integrations/x",
  };
  expect(ask(good)).toEqual({
    actor: "cloud",
    label: "iterate Cloud",
    publicKey: "abc_-1",
    paths: ["/integrations/", "/integrations/x"],
  });
  expect(ask({ ...good, actor: "user_abc" })).toHaveProperty("refused");
  expect(ask({ ...good, paths: "" })).toHaveProperty("refused");
  expect(ask({ ...good, paths: "integrations/" })).toHaveProperty("refused");
  expect(ask({ ...good, paths: "/" })).toHaveProperty("refused");
  expect(ask({ ...good, paths: "/integrations/, /agents/" })).toHaveProperty("refused");
  expect(ask({ ...good, paths: "/integrations/../secrets/" })).toHaveProperty("refused");
  expect(ask({ ...good, label: "" })).toHaveProperty("refused");
  expect(ask({ ...good, publicKey: "not base64url!" })).toHaveProperty("refused");
});

test("the Cloud's name goes to the key the stack's own Cloud publishes, and to no other", () => {
  const cloud = { origin: "https://cloud.example.net", publicKey: "cloud-key" };
  expect(cloudNameRefusal("cloud-key", cloud)).toBeNull();
  expect(cloudNameRefusal("a-stranger's-key", cloud)).toMatch(/not the key of https:\/\/cloud/);
  expect(cloudNameRefusal("cloud-key", { ...cloud, publicKey: null })).toMatch(/gave no key/);
  expect(cloudNameRefusal("cloud-key", null)).toMatch(/names none/);
});

test("a statement names a context by its own path, with no segment the mind would resolve", () => {
  for (const path of ["/", "/integrations/github", "/integrations/github/88001101", "/a.b/c..d"])
    expect(canonicalPath(path)).toBe(true);
  for (const path of [
    "/integrations/../secrets/x",
    "/integrations/./github",
    "/integrations//github",
    "/integrations/github/",
    "/integrations/github/..",
    "integrations/github",
    "",
  ])
    expect(canonicalPath(path)).toBe(false);
});
