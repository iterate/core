// The Integrations registry's buttons: a link, or a call of ONE function of the mind's config by
// its plain name. A call names no path, no expression, no other root of `itx`, and no member of the
// platform's handle on the config or of the entrypoint's base class.
import { expect, test } from "vitest";
import { InvokeHandle, RESERVED_SEGMENT_NAMES } from "./expression.ts";
import {
  callAnswerLink,
  callText,
  INTEGRATION_CALLS,
  IntegrationCall,
  IntegrationCard,
  IntegrationConnection,
} from "./integrations.ts";
import { IterateConfigEntrypoint } from "./sdk/index.ts";

test("a call button names one config function by an identifier, with JSON arguments", () => {
  expect(cardWith({ label: "Connect", call: { name: "cloudflareConnect" } })).toBe(true);
  expect(
    cardWith({
      label: "Remove",
      call: { name: "removeCloudAccount", args: ["/secrets/x-2"] },
      confirm: "Remove @ada?",
    }),
  ).toBe(true);
});

test.each([
  ["a name that is no identifier", "connect-cloudflare"],
  ["a path", "secrets.delete"],
  ["another root", "itx/secrets"],
  ["an expression", "cloudflareConnect()"],
  ["a template", "${x}"],
  ["an empty name", ""],
  ["the entrypoint's own fetch", "fetch"],
  ["a promise's then", "then"],
  ["the handle's invoke, which hands any steps on", "invoke"],
  ["the handle's applyRoot", "applyRoot"],
  ["the offer itself", INTEGRATION_CALLS],
])("a call button is refused for %s", (_, name) => {
  expect(cardWith({ label: "Go", call: { name } })).toBe(false);
});

test("a call button is refused with another key, with both a url and a call, or with arguments past 2 KB", () => {
  expect(cardWith({ label: "Go", call: { name: "go", code: "x" } })).toBe(false);
  expect(cardWith({ label: "Go", call: { name: "go" }, url: "https://a.example/" })).toBe(false);
  expect(cardWith({ label: "Go", call: { name: "go", args: ["x".repeat(3000)] } })).toBe(false);
  expect(cardWith({ label: "Go", call: { name: "go", args: { a: 1 } } })).toBe(false);
});

test("a row with a url alone is read as before", () => {
  const row = IntegrationConnection.parse({
    account: "@ada",
    actions: [
      { label: "Manage", url: "https://dash.example.com/secrets" },
      { label: "Remove", url: "https://dash.example.com/remove/x?secret=x", confirm: "Remove?" },
    ],
  });
  expect(row).toMatchObject({
    actions: [
      { label: "Manage", url: "https://dash.example.com/secrets" },
      { label: "Remove", url: "https://dash.example.com/remove/x?secret=x", confirm: "Remove?" },
    ],
  });
  expect(cardWith({ label: "Open", url: "javascript:alert(1)" })).toBe(false);
});

test("every member that the platform's handle on the config or the entrypoint's base class declares, and every name a stub answers itself, is refused", () => {
  // walked, not listed: a member added to either later fails here until someone decides
  const declared = new Set<string>(RESERVED_SEGMENT_NAMES);
  const walk = (from: object | null) => {
    for (let at = from; at; at = Object.getPrototypeOf(at))
      for (const name of Object.getOwnPropertyNames(at)) declared.add(name);
  };
  walk(new InvokeHandle(() => null));
  // an entrypoint with no methods of its own: its fields (`auth`, `getItx`, …) and its classes'
  walk(
    new (class extends IterateConfigEntrypoint {
      override async email() {}
      override async processEvent() {}
      override fetch() {
        return new Response("Not found\n", { status: 404 });
      }
    })({} as never, {} as never),
  );
  const callable = [...declared].filter((name) => IntegrationCall.safeParse({ name }).success);
  expect(callable).toEqual([]);
  // the walk found the members that matter
  expect([...declared]).toEqual(
    expect.arrayContaining(["invoke", "applyRoot", "fetch", "getItx", "auth", "catch", "dup"]),
  );
});

test("arguments are checked as text, at most 2 KB and 8 deep, before a schema walks them", () => {
  const nest = (depth: number): unknown => (depth ? [nest(depth - 1)] : 1);
  expect(callable([nest(7)])).toBe(true);
  expect(callable([nest(9)])).toBe(false);
  // a thousand deep fits in 2 KB, and is refused before the JSON schema walks it
  expect(callable([nest(1000)])).toBe(false);
  expect(callable(["[[[[[[[[[[[[x"])).toBe(true);
});

test("what a press calls reads as name(args), whole", () => {
  expect(callText({ name: "removeCloudAccount", args: ["/secrets/x-2"] })).toBe(
    'removeCloudAccount("/secrets/x-2")',
  );
  expect(callText({ name: "cloudflareConnect" })).toBe("cloudflareConnect()");
  // a long harmless first argument does not hide the second
  const long = callText({ name: "go", args: ["x".repeat(2000), "/secrets/github"] });
  expect(long).toHaveLength(2025);
  expect(long.endsWith(', "/secrets/github")')).toBe(true);
});

test("each character outside printable ASCII in what a press calls is escaped", () => {
  // a right-to-left override, a zero-width space, a Cyrillic a, an emoji, a new line
  expect(
    callText({ name: "go", args: ["a\u202eb\u200bc\u0430\u{1f600}\n", { "k\u202e": 1 }] }),
  ).toBe('go("a\\u{202e}b\\u{200b}c\\u{430}\\u{1f600}\\n", {"k\\u{202e}":1})');
  // an argument's own backslash stays its own: JSON writes it doubled
  expect(callText({ name: "go", args: ["\\u{202e}"] })).toBe('go("\\\\u{202e}")');
  expect(callText({ name: "go", args: ["plain ~ text"] })).toMatch(/^[\x20-\x7e]*$/);
});

test("a call's link is followed on the mind's control plane alone", () => {
  for (const link of [
    "https://iterate.example.com/secrets/oauth/start?path=%2Fsecrets%2Fx&nonce=1",
    "https://iterate.example.com/secrets/collect",
    // the URL parser lowers the case of a hostname, and a default port is no port
    "https://ITERATE.EXAMPLE.COM/",
    "https://iterate.example.com:443/",
  ])
    expect({ link, leads: leadsOf(link) }).toEqual({ link, leads: "follow" });
  // a control plane that is a zone's apex: that host alone
  expect(leadsOf("https://example.com/secrets/collect", "example.com")).toBe("follow");
  expect(leadsOf("https://dash.example.com/", "example.com")).toBe(
    "a link on dash.example.com, which is no host of this mind",
  );
});

test("a call's link is refused off the control plane, on a look-alike, with a user name or a port, or not https", () => {
  for (const [link, why] of [
    ["https://iterate.example.com.evil.test/", "a link on iterate.example.com.evil.test"],
    ["https://evil-iterate.example.com/", "a link on evil-iterate.example.com"],
    ["https://iterate.example.com./", "a link on iterate.example.com."],
    ["https://a.iterate.example.com/", "a link on a.iterate.example.com"],
    // the zone and an app of it are no control plane, on an apex page or any other
    ["https://example.com/", "a link on example.com"],
    ["https://dash.example.com/", "a link on dash.example.com"],
    ["https://evil.com/", "a link on evil.com"],
    ["https://dash.cloudflare.com/oauth2/auth", "a link on dash.cloudflare.com"],
  ])
    expect(leadsOf(link)).toBe(`${why}, which is no host of this mind`);
  expect(leadsOf("https://iterate.example.com:8443/")).toBe(
    "a link on iterate.example.com:8443 with a user name, a password or a port",
  );
  expect(leadsOf("https://ada@iterate.example.com/")).toBe(
    "a link on iterate.example.com with a user name, a password or a port",
  );
  expect(leadsOf("http://iterate.example.com/")).toBe("a link that is not https");
  expect(leadsOf("javascript:alert(1)")).toBe("a link that is not https");
  expect(leadsOf("/secrets/collect")).toBe("a link that is no absolute URL");
  // a page that does not know the control plane follows no link
  expect(leadsOf("https://iterate.example.com/", "")).toBe(
    "a link on iterate.example.com, which is no host of this mind",
  );
});

test("a call's answer with no link leads nowhere, and long words are cut, never the link lost", () => {
  expect(callAnswerLink({ said: "Removed." }, CONTROL_PLANE)).toBe(null);
  expect(callAnswerLink("https://iterate.example.com/", CONTROL_PLANE)).toBe(null);
  expect(callAnswerLink(null, CONTROL_PLANE)).toBe(null);
  expect(
    leadsOf("https://iterate.example.com/secrets/collect", CONTROL_PLANE, "x".repeat(500)),
  ).toBe("follow");
});

/** Whether a card with this one button is read. */
function cardWith(action: unknown) {
  return IntegrationCard.safeParse({ title: "X", actions: [action] }).success;
}

/** The control plane of a mind at `iterate.example.com`. */
const CONTROL_PLANE = "iterate.example.com";

/** "follow", or why the link is refused. */
function leadsOf(link: string, controlPlane = CONTROL_PLANE, said?: string) {
  const leads = callAnswerLink({ link, said }, controlPlane);
  if (!leads) return null;
  return "follow" in leads ? "follow" : leads.refused;
}

/** Whether a call of `go` with these arguments is read. */
function callable(args: unknown[]) {
  return IntegrationCall.safeParse({ name: "go", args }).success;
}
