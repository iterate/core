import { expect, test } from "vitest";
import {
  controlPlaneRouteOf,
  mindAddressAsTyped,
  mindAddressGiven,
  mindAddressOf,
  ownSandboxOf,
  sandboxSessionRefusal,
  sandboxVariablesOf,
} from "./mind-api.ts";

test.for([
  ["example.com", "iterate.example.com"],
  ["  Example.COM.  ", "iterate.example.com"],
  // the shorthand is for a bare name alone: a URL, a path or a port keeps the hostname as typed
  ["https://example.com/minds/x", "example.com"],
  ["https://example.com", "example.com"],
  ["example.com/", "example.com"],
  ["example.com:443", "example.com"],
  ["iterate.example.com", "iterate.example.com"],
  ["https://iterate.example.com/", "iterate.example.com"],
  ["mind.example.com", "mind.example.com"],
  ["example.co.uk", "example.co.uk"],
  ["iterate.sub.example.com", "iterate.sub.example.com"],
  ["mind.localhost", "mind.localhost"],
] as const)("%s is the mind at %s", ([typed, address]) => {
  expect(mindAddressOf(typed)).toEqual({ address });
});

test.for(["example.com", "iterate.example.com", "a.b.example.co.uk", "mind.localhost"])(
  "the address %s, spelled for a field and read again, is itself: the shorthand is applied once",
  (address) => {
    expect(mindAddressOf(mindAddressAsTyped(address))).toEqual({ address });
  },
);

test.for([
  ["example.com", "example.com"],
  ["Example.COM", "example.com"],
  ["iterate.example.com", "iterate.example.com"],
  ["localhost", "localhost"],
  ["https://example.com", null],
  ["example.com.", null],
  ["example", null],
] as const)("%s, handed on by code, is the address %s: no shorthand", ([given, address]) => {
  expect(mindAddressGiven(given)).toBe(address);
});

test.for([
  "",
  "example",
  "192.0.2.1",
  "https://[2001:db8::1]/",
  ".com",
  "foo_bar.com",
  "a..example.com",
  "-a.example.com",
])("%s is no address", (typed) => {
  expect(mindAddressOf(typed)).toHaveProperty("error");
});

test.for([
  ["/", "auth"],
  ["/oauth2/token", "auth"],
  ["/api", "api"],
  ["/api/files/a.txt", "api"],
  // the path of the egress gateway's providers is a route of the API, and has no metadata document
  ["/api/egress-gateway", "api"],
  ["/.well-known/oauth-protected-resource/api/egress-gateway", "auth"],
  ["/apiary", "auth"],
  ["/.well-known/oauth-protected-resource/api", "api"],
  ["/mcp", "mcp"],
  ["/.well-known/oauth-protected-resource/mcp", "mcp"],
  ["/secrets/approvals", "secrets"],
] as const)("%s on the control-plane hostname is for %s", ([path, route]) => {
  expect(controlPlaneRouteOf(new URL(path, "https://iterate.example.com"))).toBe(route);
});

// A SANDBOX'S OWN SESSION, as the `iterate` CLI decides it (./mind-api.ts): when no bearer goes,
// and what a refusal says.
const BOX = "/agents/ada/box";

test("in a sandbox of the mind, with no token named, the connection is the sandbox's own", () => {
  expect(ownSandboxOf(sandboxVariablesOf("iterate.example.com", BOX), "iterate.example.com")).toBe(
    BOX,
  );
});

test.for<{ name: string; env: Record<string, string | undefined> }>([
  { name: "a laptop", env: {} },
  { name: "the mind named and no sandbox", env: { ITERATE_MIND: "iterate.example.com" } },
  { name: "a sandbox and no mind named", env: { ITERATE_SANDBOX: BOX } },
  {
    name: "a sandbox of another mind",
    env: { ITERATE_MIND: "iterate.other.com", ITERATE_SANDBOX: BOX },
  },
  {
    name: "a token named, which wins",
    env: {
      ...sandboxVariablesOf("iterate.example.com", BOX),
      ITERATE_MIND_TOKEN: 'getSecret("/secrets/iterate-mind")',
    },
  },
])("the sign-in is as ever on $name", ({ env }) => {
  expect(ownSandboxOf(env, "iterate.example.com")).toBeNull();
});

test("a refused session says why, in the egress's words when it gave them", () => {
  const input = { sandbox: BOX, address: "iterate.example.com", status: 401 };
  expect(
    sandboxSessionRefusal({
      ...input,
      why: `the mind filters what it sends (the rule for itx.fetch at ${BOX})`,
    }),
  ).toBe(
    `The sandbox ${BOX} gets no session of its own with iterate.example.com: the mind filters what it sends (the rule for itx.fetch at ${BOX}). Its owner removes that rule to give it one. To act as a member instead, set ITERATE_MIND_TOKEN.`,
  );
  expect(sandboxSessionRefusal({ ...input, why: undefined })).toBe(
    `iterate.example.com answered 401 and served no session for the sandbox ${BOX}: its stack may be older than this CLI, or this is no sandbox of that mind. To act as a member instead, set ITERATE_MIND_TOKEN.`,
  );
});
