// worker.test.ts — the edge's pure halves as tables: the iterate config (what the one object becomes,
// what is refused by name, the per-env memo, the derived keys), the platform's own endpoints (the public
// protocol origins, `/version`, a preview's admin sign-in through prd, local dev's one click, and under path routing the platform's
// own paths never a project).
// The ingress convention itself (subdomains, paths, custom hostnames) is the SDK's project-ingress
// module and its own table.

import { inspect } from "node:util";
import { expect, test, vi } from "vitest";
import { parse } from "iterate/expression";
import { PROJECT_CONTEXT_BIRTH_EVENTS } from "./project/context-birth-events.ts";
// Routing is under test here: the unit project aliases Start's generated server entry to a stand-in
// page (src/test/start-server-entry-shim.ts); the real entry is exercised by the built-Worker and
// browser suites, where its Vite virtual modules exist.
import worker from "./worker.ts";
import {
  iterateConfigOf,
  atRestKeysOf,
  DEFAULT_CLOUDFLARE_SCOPES,
  DEFAULT_GOOGLE_SIGN_IN_SCOPES,
  parseIterateConfig,
  projectHostOf,
  sessionSigningSecretOf,
  type IterateConfig,
} from "./iterate-config.ts";
import type { Env } from "./env.ts";

// ── iterate config ── THE TABLE for the iterate config: what the vars become, what is refused (by name),
// and the per-env memo. Each row is `{ vars, becomes | throws, warns? }`.

/** prd's origin, and a per-PR preview's. */
const PRD = "https://os.iterate.com";
const PR123 = "https://pr123-os.iterate-dev-preview.workers.dev";

/** The smallest valid configuration: the key and one sign-in mechanism, as two override vars. */
const MINIMAL = {
  ITERATE__SECRETS_ENCRYPTION__KEY: "secrets-key",
  ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD: "password",
  ITERATE__LOGIN__ALLOW: '[{"everyone":{}}]',
};
/** `login.allow` admitting anyone, as a var. */
const EVERYONE = MINIMAL.ITERATE__LOGIN__ALLOW;
/** The same, as the one object. */
const MINIMAL_BLOB = {
  ITERATE: JSON.stringify({
    login: { methods: { password: { password: "password" } }, allow: [{ everyone: {} }] },
    secretsEncryption: { key: "secrets-key" },
  }),
};
/** What MINIMAL becomes: every optional field blank or its default (iterate's dash, projects as
 *  paths), the deploy id defaulted. */
const MINIMAL_CONFIG = {
  urls: { os: "", mcp: "", dash: "https://dash.iterate.com", ingressRouting: { type: "paths" } },
  login: { allow: [{ everyone: {} }], methods: { password: { password: "password" } } },
  posthogProjectKey: "",
  admins: [],
  adminBearer: "",
  secretsEncryption: { key: "secrets-key", previousKey: "" },
  deployId: "unversioned",
};

/** A cloudflare section with only its three required fields, its defaults filled in. */
const ACME_CLOUDFLARE = {
  accountId: "account-1",
  apiToken: "cf-token",
  resourcePrefix: "acme-os",
  workerRoutes: [],
  workersDev: true,
};

const iterateConfigRows: {
  vars: Record<string, unknown>;
  becomes?: unknown;
  throws?: RegExp;
  /** how many warnings the boot prints, once each: an unknown key (inside the object or a stray
   *  var), a provider's sign-in without its client */
  warns?: number;
}[] = [
  // the object alone, and the overrides alone (core/lib/src/app-config.test.ts tests the merge)
  { vars: MINIMAL_BLOB, becomes: MINIMAL_CONFIG },
  { vars: MINIMAL, becomes: MINIMAL_CONFIG },
  // a blank var is unset (a deployment's generated vars may spell a blank), and values are trimmed
  {
    vars: {
      ...MINIMAL,
      ITERATE__SECRETS_ENCRYPTION__KEY: " secrets-key ",
      ITERATE__URLS__OS: "   ",
      ITERATE__URLS__MCP: "",
      ITERATE__URLS__INGRESS_ROUTING: "",
    },
    becomes: MINIMAL_CONFIG,
  },
  // every field read (the ingress hostname lowercased, the custom hostnames a real object);
  // bindings and unrelated vars are ignored
  {
    vars: {
      ...MINIMAL,
      ITERATE__URLS__OS: "https://os.iterate.com",
      ITERATE__URLS__MCP: "https://mcp.iterate.com",
      ITERATE__URLS__DASH: "https://dash.iterate.com",
      ITERATE__URLS__INGRESS_ROUTING: '{"type":"subdomains","hostname":"Iterate.app"}',
      ITERATE__URLS__PROJECT_WILDCARD: '{"hostname":"Iterate.com","project":"iterate"}',
      ITERATE__CUSTOM_HOSTNAMES:
        '{"zone":"iterate.app","zoneId":"zone-1","dcvDelegationUuid":"dcv-1","reservedZones":["iterate.app","iterate.com"]}',
      ITERATE__POSTHOG_PROJECT_KEY: "phc_test",
      ITERATE__LOGIN__METHODS__EMAIL_CODE__FROM: "iterate <login@iterate.com>",
      ITERATE__LOGIN__METHODS__GOOGLE: "{}",
      ITERATE__INTEGRATIONS__GOOGLE__OAUTH_CLIENT_ID: "google-id",
      ITERATE__INTEGRATIONS__GOOGLE__OAUTH_CLIENT_SECRET: "google-secret",
      ITERATE__SECRETS_ENCRYPTION__PREVIOUS_KEY: "the-old-key",
      ITERATE__ADMIN_BEARER: "admin-bearer",
      LOADER: {},
      OTHER: "ignored",
    },
    becomes: {
      urls: {
        os: "https://os.iterate.com",
        mcp: "https://mcp.iterate.com",
        dash: "https://dash.iterate.com",
        ingressRouting: { type: "subdomains", hostname: "iterate.app" },
        projectWildcard: { hostname: "iterate.com", project: "iterate" },
      },
      customHostnames: {
        zone: "iterate.app",
        zoneId: "zone-1",
        dcvDelegationUuid: "dcv-1",
        reservedZones: ["iterate.app", "iterate.com"],
      },
      posthogProjectKey: "phc_test",
      login: {
        allow: [{ everyone: {} }],
        methods: {
          password: { password: "password" },
          emailCode: { from: "iterate <login@iterate.com>" },
          google: { scopes: DEFAULT_GOOGLE_SIGN_IN_SCOPES },
        },
      },
      admins: [],
      adminBearer: "admin-bearer",
      secretsEncryption: { key: "secrets-key", previousKey: "the-old-key" },
      deployId: "unversioned",
    },
  },
  // the ingress routing, narrowed: paths carry no hostname, subdomains must; the type is one of two
  {
    vars: { ...MINIMAL, ITERATE__URLS__INGRESS_ROUTING__TYPE: "paths" },
    becomes: {
      ...MINIMAL_CONFIG,
      urls: { ...MINIMAL_CONFIG.urls, ingressRouting: { type: "paths" } },
    },
  },
  {
    vars: { ...MINIMAL, ITERATE__URLS__INGRESS_ROUTING__TYPE: "subdomains" },
    throws:
      /^ITERATE urls\.ingressRouting\.hostname \(ITERATE__URLS__INGRESS_ROUTING__HOSTNAME\): expected a DNS name/,
  },
  {
    vars: {
      ...MINIMAL,
      ITERATE__URLS__INGRESS_ROUTING: '{"type":"subdomains","hostname":"not a host"}',
    },
    throws: /urls\.ingressRouting\.hostname .*expected a DNS name/,
  },
  {
    vars: {
      ...MINIMAL,
      ITERATE__URLS__INGRESS_ROUTING: '{"type":"paths","hostname":"iterate.app"}',
    },
    throws: /urls\.ingressRouting\.hostname .*not for "paths"/,
  },
  {
    vars: { ...MINIMAL, ITERATE__URLS__INGRESS_ROUTING__TYPE: "wildcards" },
    throws: /urls\.ingressRouting\.type .*expected "subdomains" or "paths"/,
  },
  // how and who may sign in are required: a deployment open to anyone says so
  {
    vars: { ITERATE__SECRETS_ENCRYPTION__KEY: "secrets-key" },
    throws: /^ITERATE login \(ITERATE__LOGIN\): required/,
  },
  {
    vars: {
      ITERATE__SECRETS_ENCRYPTION__KEY: "secrets-key",
      ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD: "password",
    },
    throws: /^ITERATE login\.allow \(ITERATE__LOGIN__ALLOW\): required/,
  },
  // a mechanism to sign in with is required — a deployment nobody can sign in to is refused at boot
  {
    vars: { ITERATE__SECRETS_ENCRYPTION__KEY: "secrets-key", ITERATE__LOGIN__ALLOW: EVERYONE },
    throws: /^ITERATE login\.methods \(ITERATE__LOGIN__METHODS\): no sign-in method/,
  },
  {
    vars: {
      ITERATE__SECRETS_ENCRYPTION__KEY: "secrets-key",
      ITERATE__LOGIN__ALLOW: EVERYONE,
      ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD: "  ",
    },
    // a blank var is unset, so the method is absent
    throws: /no sign-in method/,
  },
  // one of the other two mechanisms alone is enough
  {
    vars: {
      ITERATE__SECRETS_ENCRYPTION__KEY: "secrets-key",
      ITERATE__LOGIN__ALLOW: EVERYONE,
      ITERATE__LOGIN__METHODS__EMAIL_CODE__FROM: "iterate <login@iterate.com>",
    },
    becomes: {
      ...MINIMAL_CONFIG,
      login: {
        ...MINIMAL_CONFIG.login,
        methods: { emailCode: { from: "iterate <login@iterate.com>" } },
      },
    },
  },
  // a provider's sign-in is its integration's client: on with it, off (and so no mechanism) without
  {
    vars: {
      ITERATE__SECRETS_ENCRYPTION__KEY: "secrets-key",
      ITERATE__LOGIN__ALLOW: EVERYONE,
      ITERATE__LOGIN__METHODS__CLOUDFLARE: "{}",
      ITERATE__INTEGRATIONS__CLOUDFLARE__OAUTH_CLIENT_ID: "cf-id",
      ITERATE__INTEGRATIONS__CLOUDFLARE__OAUTH_CLIENT_SECRET: "cf-secret",
    },
    becomes: {
      ...MINIMAL_CONFIG,
      login: {
        ...MINIMAL_CONFIG.login,
        methods: { cloudflare: { scopes: DEFAULT_CLOUDFLARE_SCOPES } },
      },
    },
  },
  {
    vars: {
      ITERATE__SECRETS_ENCRYPTION__KEY: "secrets-key",
      ITERATE__LOGIN__ALLOW: EVERYONE,
      ITERATE__LOGIN__METHODS__CLOUDFLARE: "{}",
    },
    throws: /no sign-in method/,
    warns: 1,
  },
  {
    vars: { ...MINIMAL, ITERATE__LOGIN__METHODS__GITHUB: "{}" },
    becomes: MINIMAL_CONFIG,
    warns: 1,
  },
  // who may sign in: a rule Access does not know, or an empty list, is refused
  {
    vars: { ...MINIMAL, ITERATE__LOGIN__ALLOW: '["*@iterate.com"]' },
    throws: /login\.allow\.0 .*expected a rule/,
  },
  {
    vars: { ...MINIMAL, ITERATE__LOGIN__ALLOW: "[]" },
    throws: /login\.allow .*nobody could sign in/,
  },
  // the platform admins: exact addresses, lowercased; a pattern is refused, never read as one
  {
    vars: {
      ...MINIMAL,
      ITERATE__URLS__OS: "http://localhost:8788",
      ITERATE__ADMINS: '["Jonas@Iterate.com"]',
    },
    becomes: {
      ...MINIMAL_CONFIG,
      urls: { ...MINIMAL_CONFIG.urls, os: "http://localhost:8788" },
      admins: ["jonas@iterate.com"],
    },
  },
  // …but beside the global password only where nobody's real data lives: anyone with the password
  // could sign in as the admin
  {
    vars: {
      ...MINIMAL,
      ITERATE__URLS__OS: "https://os.example.com",
      ITERATE__ADMINS: '["jonas@iterate.com"]',
    },
    throws: /^ITERATE admins \(ITERATE__ADMINS\): not with login\.methods\.password/,
  },
  // …nor beside paths ingress, where a project's own code runs on the issuer's origin
  {
    vars: {
      ITERATE__SECRETS_ENCRYPTION__KEY: "secrets-key",
      ITERATE__LOGIN__ALLOW: EVERYONE,
      ITERATE__LOGIN__METHODS__EMAIL_CODE__FROM: "login@example.com",
      ITERATE__URLS__OS: "https://os.example.com",
      ITERATE__URLS__INGRESS_ROUTING: '{"type":"paths"}',
      ITERATE__ADMINS: '["jonas@iterate.com"]',
    },
    throws: /^ITERATE admins \(ITERATE__ADMINS\): not with paths ingress routing/,
  },
  {
    vars: { ...MINIMAL, ITERATE__ADMINS: '["*@iterate.com"]' },
    throws: /admins\.0 .*expected exact email addresses/,
  },
  // admins sign in through another issuer only on a preview's (or a test's) https origin: a
  // deployment on its own domain takes no other issuer's word, even from a mistaken Doppler value,
  // and that issuer reads this deployment's client metadata document over https
  {
    vars: { ...MINIMAL, ITERATE__URLS__OS: PR123, ITERATE__LOGIN__ADMIN_ISSUER: PRD },
    becomes: {
      ...MINIMAL_CONFIG,
      urls: { ...MINIMAL_CONFIG.urls, os: PR123 },
      login: { ...MINIMAL_CONFIG.login, adminIssuer: PRD },
    },
  },
  ...[PRD, "http://localhost:8788", ""].map((os) => ({
    vars: { ...MINIMAL, ITERATE__URLS__OS: os, ITERATE__LOGIN__ADMIN_ISSUER: PRD },
    throws: /^ITERATE login\.adminIssuer .*only for a preview or a test on https/,
  })),
  // a fake provider signs test people in only where nobody's real data lives: never on prd's own
  // domain, and a blank urls.os (a self-host on each request's own origin) must name one first
  {
    vars: {
      ...MINIMAL,
      ITERATE__URLS__OS: "http://localhost:8788",
      ITERATE__LOGIN__TEST_EMAIL_DOMAIN: "preview.iterate.test",
    },
    becomes: {
      ...MINIMAL_CONFIG,
      urls: { ...MINIMAL_CONFIG.urls, os: "http://localhost:8788" },
      login: { ...MINIMAL_CONFIG.login, testEmailDomain: "preview.iterate.test" },
    },
  },
  ...[PRD, ""].map((os) => ({
    vars: {
      ...MINIMAL,
      ITERATE__URLS__OS: os,
      ITERATE__LOGIN__TEST_EMAIL_DOMAIN: "preview.iterate.test",
    },
    throws: /^ITERATE login\.testEmailDomain .*only for a preview, local dev or a test/,
  })),
  // a client is both halves or neither
  {
    vars: { ...MINIMAL, ITERATE__INTEGRATIONS__CLOUDFLARE__OAUTH_CLIENT_ID: "cf-id" },
    throws:
      /^ITERATE integrations\.cloudflare\.oauthClientSecret \(ITERATE__INTEGRATIONS__CLOUDFLARE__OAUTH_CLIENT_SECRET\): required, but unset or blank$/,
  },
  // the key encrypts every project secret and signs every session: a blank one is refused at
  // first use, not a silent lock-out
  {
    vars: {
      ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD: "password",
      ITERATE__LOGIN__ALLOW: EVERYONE,
    },
    throws:
      /^ITERATE secretsEncryption\.key \(ITERATE__SECRETS_ENCRYPTION__KEY\): required, but unset or blank$/,
  },
  {
    vars: { ...MINIMAL, ITERATE__SECRETS_ENCRYPTION__KEY: "  " },
    throws:
      /^ITERATE secretsEncryption\.key \(ITERATE__SECRETS_ENCRYPTION__KEY\): required, but unset or blank$/,
  },
  // a wrangler var may be a JSON object; the config parser only reads STRING vars, so a non-string
  // is ignored — the field is then unset, and its required-ness is what's refused
  {
    vars: { ...MINIMAL, ITERATE__SECRETS_ENCRYPTION__KEY: { not: "a string" } },
    throws:
      /^ITERATE secretsEncryption\.key \(ITERATE__SECRETS_ENCRYPTION__KEY\): required, but unset or blank$/,
  },
  // the MCP origin, when set, is its own origin without a path
  {
    vars: {
      ...MINIMAL,
      ITERATE__URLS__OS: "https://os.test",
      ITERATE__URLS__MCP: "https://mcp.test/path",
    },
    throws: /urls\.mcp .*origin/,
  },
  {
    vars: {
      ...MINIMAL,
      ITERATE__URLS__OS: "https://os.test",
      ITERATE__URLS__MCP: "https://os.test",
    },
    throws: /^ITERATE urls\.mcp \(ITERATE__URLS__MCP\): must differ from urls\.os$/,
  },
  // where it deploys: the cloudflare section, its defaults filled in
  {
    vars: {
      ...MINIMAL,
      ITERATE__CLOUDFLARE:
        '{"accountId":"account-1","apiToken":"cf-token","resourcePrefix":"acme-os"}',
    },
    becomes: { ...MINIMAL_CONFIG, cloudflare: ACME_CLOUDFLARE },
  },
  // a resource prefix Cloudflare would refuse, by name
  {
    vars: {
      ...MINIMAL,
      ITERATE__CLOUDFLARE:
        '{"accountId":"account-1","apiToken":"cf-token","resourcePrefix":"Acme_OS"}',
    },
    throws:
      /^ITERATE cloudflare\.resourcePrefix \(ITERATE__CLOUDFLARE__RESOURCE_PREFIX\): expected lowercase letters/,
  },
  // the dash and the ingress take what is given over their defaults
  {
    vars: {
      ITERATE: JSON.stringify({
        login: { methods: { password: { password: "password" } }, allow: [{ everyone: {} }] },
        secretsEncryption: { key: "secrets-key" },
        urls: { dash: "", ingressRouting: { type: "subdomains", hostname: "acme.test" } },
      }),
    },
    becomes: {
      ...MINIMAL_CONFIG,
      urls: {
        ...MINIMAL_CONFIG.urls,
        dash: "",
        ingressRouting: { type: "subdomains", hostname: "acme.test" },
      },
    },
  },
];
for (const { vars, becomes, throws, warns } of iterateConfigRows)
  test(`parseIterateConfig: ${JSON.stringify(vars)} → ${throws ? `throws ${throws}` : JSON.stringify(becomes)}`, () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    if (throws) expect(() => parseIterateConfig(vars)).toThrow(throws);
    else expect(expose(parseIterateConfig(vars))).toEqual(becomes);
    if (warns !== undefined) expect(warn).toHaveBeenCalledTimes(warns);
    else expect(warn).not.toHaveBeenCalled();
  });
// THE BIRTH EVENTS, checked at boot (the deploy gate) and stored as the append boundary stores each.
test.for([
  {
    name: "unset: the platform's own, each target parsed as an append stores it",
    vars: MINIMAL,
    becomes: PROJECT_CONTEXT_BIRTH_EVENTS.map((row) => ({
      ...row,
      payload: { ...row.payload, target: parse(row.payload.target) },
    })),
  },
  {
    name: "none, as a suite that runs without them says",
    vars: { ...MINIMAL, ITERATE__CONTEXT_BIRTH_EVENTS: "[]" },
    becomes: [],
  },
  {
    name: "every deployment's rows, each target parsed as an append stores it",
    vars: {
      ...MINIMAL,
      ITERATE__CONTEXT_BIRTH_EVENTS: JSON.stringify(PROJECT_CONTEXT_BIRTH_EVENTS),
    },
    becomes: PROJECT_CONTEXT_BIRTH_EVENTS.map((row) => ({
      ...row,
      payload: { ...row.payload, target: parse(row.payload.target) },
    })),
  },
  {
    name: "a record only the platform appends is refused, naming its entry",
    vars: {
      ...MINIMAL,
      ITERATE__CONTEXT_BIRTH_EVENTS:
        '[{"type":"test/fine"},{"type":"events.iterate.com/itx/woken"}]',
    },
    throws:
      /^ITERATE contextBirthEvents\[1\]: events\.iterate\.com\/itx\/woken is the platform's own record/,
  },
  {
    name: "a subscription whose target does not parse is refused, naming its entry",
    vars: {
      ...MINIMAL,
      ITERATE__CONTEXT_BIRTH_EVENTS: JSON.stringify([
        {
          type: "events.iterate.com/itx/subscription-configured",
          payload: { name: "config", target: "itx.config(" },
        },
      ]),
    },
    throws: /^ITERATE contextBirthEvents\[0\]:/,
  },
  {
    name: "an event with no type is refused, naming the field",
    vars: { ...MINIMAL, ITERATE__CONTEXT_BIRTH_EVENTS: '[{"payload":{}}]' },
    throws: /contextBirthEvents/,
  },
  {
    name: "a key an event does not have is refused",
    vars: { ...MINIMAL, ITERATE__CONTEXT_BIRTH_EVENTS: '[{"type":"x/y","offset":3}]' },
    throws: /contextBirthEvents/,
  },
])("parseIterateConfig contextBirthEvents: $name", ({ vars, becomes, throws }) => {
  if (throws) expect(() => parseIterateConfig(vars)).toThrow(throws);
  else expect(parseIterateConfig(vars)).toMatchObject({ contextBirthEvents: becomes });
});

test("parseIterateConfig: a secret never prints", () => {
  const { secretsEncryption } = parseIterateConfig(MINIMAL);
  expect(String(secretsEncryption.key)).toBe("REDACTED");
  expect(JSON.stringify(secretsEncryption)).not.toContain("secrets-key");
  expect(inspect(secretsEncryption.key)).toBe("Redacted {}");
  expect(secretsEncryption.key.exposeSecret()).toBe("secrets-key");
});
test("parseIterateConfig: the deploy id is handed in", () => {
  expect(parseIterateConfig(MINIMAL, "v-123")).toMatchObject({ deployId: "v-123" });
});

test("the derived keys: the session-signing secret derives from the key under its own label: hex, stable per config, another key another secret, never the key itself", async () => {
  const config = parseIterateConfig(MINIMAL);
  const secret = await sessionSigningSecretOf(config);
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  expect(await sessionSigningSecretOf(config)).toBe(secret);
  expect(await sessionSigningSecretOf(parseIterateConfig(MINIMAL))).toBe(secret);
  expect(
    await sessionSigningSecretOf(
      parseIterateConfig({ ...MINIMAL, ITERATE__SECRETS_ENCRYPTION__KEY: "other" }),
    ),
  ).not.toBe(secret);
  expect(secret).not.toBe(config.secretsEncryption.key.exposeSecret());
});
test("the derived keys: the at-rest keys carry the previous one only while rotating", () => {
  expect(atRestKeysOf(parseIterateConfig(MINIMAL))).toEqual({ current: "secrets-key" });
  expect(
    atRestKeysOf(
      parseIterateConfig({ ...MINIMAL, ITERATE__SECRETS_ENCRYPTION__PREVIOUS_KEY: "the-old-key" }),
    ),
  ).toEqual({ current: "secrets-key", previous: "the-old-key" });
});

const origins = {
  ...MINIMAL,
  ITERATE__URLS__OS: "https://os.iterate.com",
  ITERATE__URLS__MCP: "https://mcp.iterate.com",
};
/** The bindings the edge touches before it answers a public route: the control plane's D1 the edge
 *  is built over (`ControlPlane`, src/control-plane/edge.ts — never queried: these rows never reach
 *  the catalog), the context namespace, and the assets binding the issuer's pages come from (one
 *  placeholder page). */
const bindings = {
  DB: {},
  ITERATE_CONTEXT: { getByName: () => ({}) },
  ASSETS: { fetch: async () => new Response("<!doctype html>the page") },
};

test("public protocol origins: MCP discovery uses its public origin and the platform's issuer", async () => {
  const denied = await request("https://mcp.iterate.com/");
  expect(denied).toMatchObject({ status: 401 });
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(
    denied.headers.get("www-authenticate")!,
  )![1]!;
  expect(metadataUrl).toMatch(/^https:\/\/mcp\.iterate\.com\//);
  expect(await (await request(metadataUrl)).json()).toMatchObject({
    resource: "https://mcp.iterate.com/",
    authorization_servers: ["https://os.iterate.com"],
  });
  expect(
    await (await request("https://os.iterate.com/.well-known/oauth-authorization-server")).json(),
  ).toMatchObject({
    issuer: "https://os.iterate.com",
    authorization_endpoint: "https://os.iterate.com/oauth2/auth",
    token_endpoint: "https://os.iterate.com/oauth2/token",
  });
});

test("public protocol origins: with its own origin configured, /mcp on the platform origin sends the caller there — a 308, so a client's POST survives the hop", async () => {
  const moved = await request("https://os.iterate.com/mcp");
  expect(moved).toMatchObject({ status: 308 });
  expect(moved.headers.get("location")).toBe("https://mcp.iterate.com/");
});

test("public protocol origins: MCP does not acquire a Cap'n Web or console route", async () => {
  expect(await request("https://mcp.iterate.com/api")).toMatchObject({ status: 404 });
  expect(await request("https://mcp.iterate.com/login")).toMatchObject({ status: 404 });
  expect(await request("https://unconfigured.example/api")).toMatchObject({ status: 421 });
});

test("public protocol origins: /version is `<deployId> <platformOrigin>` — the configured issuer, or the request's own origin where none is configured", async () => {
  expect((await (await request("https://os.iterate.com/version")).text()).trim()).toBe(
    "unversioned https://os.iterate.com",
  );
  // no `urls.os`: a deployment with one hostname (workers.dev) — the issuer is whatever it is called
  expect(
    (await (await request("https://iterate.someorg.workers.dev/version", MINIMAL)).text()).trim(),
  ).toBe("unversioned https://iterate.someorg.workers.dev");
  expect(
    await (
      await request(
        "https://iterate.someorg.workers.dev/.well-known/oauth-authorization-server",
        MINIMAL,
      )
    ).json(),
  ).toMatchObject({ issuer: "https://iterate.someorg.workers.dev" });
});

test("public protocol origins: the issuer stays on the control plane when its zone also has a project wildcard", async () => {
  const response = await request("https://os.iterate.com/version", {
    ...origins,
    ITERATE__URLS__PROJECT_WILDCARD: '{"hostname":"iterate.com","project":"iterate"}',
  });
  expect(response).toMatchObject({ status: 200 });
  expect(await response.text()).toBe("unversioned https://os.iterate.com\n");
});

// ── projectHostOf ── the platform and MCP origins are never a project host, even under the wildcard
const subdomains = {
  ...MINIMAL,
  ITERATE__URLS__OS: "https://os.example.com",
  ITERATE__URLS__MCP: "https://mcp.example.com",
  ITERATE__URLS__INGRESS_ROUTING: '{"type":"subdomains","hostname":"example.com"}',
};
const ownHostname = {
  ...MINIMAL,
  ITERATE__URLS__OS: "https://iterate.family.test",
  ITERATE__URLS__INGRESS_ROUTING: '{"type":"subdomains","hostname":"iterate.family.test"}',
  ITERATE__URLS__PROJECT_HOSTNAMES: '[{"hostname":"family.test","project":"family"}]',
};
const pathsRouting = {
  ...MINIMAL,
  ITERATE__URLS__OS: "https://os.test",
  ITERATE__URLS__INGRESS_ROUTING__TYPE: "paths",
};
test.for<{ vars: Record<string, string>; url: string; host: object | null }>([
  { vars: subdomains, url: "https://os.example.com/login", host: null },
  { vars: subdomains, url: "https://os.example.com/api", host: null },
  { vars: subdomains, url: "https://mcp.example.com/", host: null },
  {
    vars: subdomains,
    url: "https://site--acme.example.com/x",
    host: { project: "acme", routingSlug: "site", basePath: "" },
  },
  {
    vars: subdomains,
    url: "https://acme.example.com/",
    host: { project: "acme", routingSlug: null, basePath: "" },
  },
  { vars: pathsRouting, url: "https://os.test/login", host: null },
  {
    vars: pathsRouting,
    url: "https://os.test/projects/acme/site/x",
    host: { project: "acme", routingSlug: "site", basePath: "/projects/acme/site" },
  },
  // a project's own hostname in the config: its apex, and one label under it a routing slug
  {
    vars: ownHostname,
    url: "https://family.test/",
    host: { project: "family", routingSlug: null, basePath: "" },
  },
  {
    vars: ownHostname,
    url: "https://gmail.family.test/push",
    host: { project: "family", routingSlug: "gmail", basePath: "" },
  },
  { vars: ownHostname, url: "https://a.b.family.test/", host: null },
  // the platform origin under that zone stays the platform's, and its projects' hosts its own
  { vars: ownHostname, url: "https://iterate.family.test/login", host: null },
  {
    vars: ownHostname,
    url: "https://notes--acme.iterate.family.test/",
    host: { project: "acme", routingSlug: "notes", basePath: "" },
  },
])("projectHostOf $url → $host", ({ vars, url, host }) => {
  const config = parseIterateConfig(vars);
  expect(projectHostOf(config, new URL(url), config.urls.os)).toEqual(host);
});

test("public protocol origins: under path routing the platform's own paths are never a project (projects live under /projects/): its endpoints answer as themselves", async () => {
  const paths = {
    ...MINIMAL,
    ITERATE__URLS__OS: "https://os.test",
    ITERATE__URLS__INGRESS_ROUTING__TYPE: "paths",
  };
  // the bearer challenges (no session, no project lookup, no 421)
  for (const endpoint of ["/api", "/mcp"]) {
    const answer = await request(`https://os.test${endpoint}`, paths);
    expect(answer, endpoint).toMatchObject({ status: 401 });
    expect(answer.headers.get("www-authenticate"), endpoint).toBeTruthy();
  }
  expect(await request("https://os.test/version", paths)).toMatchObject({ status: 200 });
  expect(
    await (await request("https://os.test/.well-known/oauth-authorization-server", paths)).json(),
  ).toMatchObject({
    issuer: "https://os.test",
    authorization_endpoint: "https://os.test/oauth2/auth",
  });
  // the pages: sign-in and consent are the issuer's, never a project's (projects live under
  // `/projects/`) — the page, or a redirect to it, not a 421 and not a project lookup
  expect(await request("https://os.test/login", paths)).toMatchObject({ status: 200 });
  // the consent page is a Start route too (its sign-in redirect is issuer-bootstrap.test.ts's)
  expect(await request("https://os.test/oauth2/auth?client_id=x", paths)).toMatchObject({
    status: 200,
  });
});

test("public protocol origins: a preview's admin sign-in (admin-sign-in.ts) asks prd who the browser is, for the userinfo resource alone, and signs nobody in yet; prd has no such route", async () => {
  expect(await request(`${PRD}/.auth/admin-sign-in?next=%2Flogin`)).toMatchObject({ status: 404 });
  const started = await request(`${PR123}/.auth/admin-sign-in?next=%2Flogin`, {
    ...MINIMAL,
    ITERATE__URLS__OS: PR123,
    ITERATE__LOGIN__ADMIN_ISSUER: PRD,
  });
  expect(started).toMatchObject({ status: 302 });
  const authorize = new URL(started.headers.get("location")!);
  expect({
    at: `${authorize.origin}${authorize.pathname}`,
    clientId: authorize.searchParams.get("client_id"),
    resource: authorize.searchParams.getAll("resource"),
    cookies: started.headers.getSetCookie().map((cookie) => cookie.split("=")[0]),
  }).toEqual({
    at: `${PRD}/oauth2/auth`,
    clientId: `${PR123}/.auth/admin-sign-in/client.json`,
    resource: [`${PRD}/oauth2/userinfo`],
    cookies: ["__Host-itx-admin-sign-in"],
  });
});

// Local dev's one click (local-sign-in.ts) exists on a laptop's platform alone: a loopback `urls.os`
// with a test email domain. Where it signs in is test/vitest/os-workers/local-sign-in.test.ts's.
test.for<{ name: string; origin: string; vars: Record<string, unknown> }>([
  { name: "prd", origin: PRD, vars: origins },
  {
    name: "a preview, test email domain and all",
    origin: PR123,
    vars: {
      ...MINIMAL,
      ITERATE__URLS__OS: PR123,
      ITERATE__LOGIN__TEST_EMAIL_DOMAIN: "preview.iterate.test",
    },
  },
  {
    name: "a laptop's platform with no test email domain",
    origin: "http://localhost:8788",
    vars: { ...MINIMAL, ITERATE__URLS__OS: "http://localhost:8788" },
  },
  {
    name: "a self-host on a laptop (a blank urls.os)",
    origin: "http://localhost:8787",
    vars: MINIMAL,
  },
])(
  "public protocol origins: local dev's one click is no route on $name",
  async ({ origin, vars }) => {
    const search = new URLSearchParams({ email: "test@preview.iterate.test", next: "/login" });
    expect(await request(`${origin}/.auth/local-sign-in?${search}`, vars)).toMatchObject({
      status: 404,
    });
  },
);

// The issuer's pages admit only their own methods, HTML requests and same-origin posts; beside them
// are the public files, and nothing else.
test.for<{ name: string; path: string; init: RequestInit; status: number }>([
  { name: "a page", path: "/login", init: {}, status: 200 },
  {
    name: "a page asked for JSON",
    path: "/login",
    init: { headers: { accept: "application/json" } },
    status: 406,
  },
  { name: "a POST to the root", path: "/", init: { method: "POST" }, status: 405 },
  { name: "a DELETE of a page", path: "/login", init: { method: "DELETE" }, status: 405 },
  {
    name: "a cross-site POST to a page",
    path: "/login",
    init: { method: "POST", headers: { origin: "https://evil.example" } },
    status: 403,
  },
  {
    name: "a cross-site POST to authorize",
    path: "/oauth2/auth?client_id=x",
    init: { method: "POST", headers: { origin: "https://evil.example" } },
    status: 403,
  },
  { name: "the issuer's stylesheet", path: "/issuer.css", init: {}, status: 200 },
  { name: "a client logo", path: "/client-logos/browser-extension.svg", init: {}, status: 200 },
  { name: "a script that is not a public file", path: "/authorize.js", init: {}, status: 404 },
  { name: "capnweb's script", path: "/capnweb.js", init: {}, status: 404 },
])(
  "public protocol origins, the issuer's pages: $name → $status",
  async ({ path, init, status }) => {
    expect(await request(new Request(`https://os.iterate.com${path}`, init))).toMatchObject({
      status,
    });
  },
);

// The root sends a browser's navigation on to the dash's connect page for this issuer; any other
// request for it, and `/?landing=1`, still gets the landing page.
test("public protocol origins: a browser that opens the root goes on to the dash", async () => {
  const opened = await request(
    new Request("https://os.iterate.com/", {
      headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    }),
  );
  expect(opened).toMatchObject({ status: 302 });
  expect(opened.headers.get("location")).toBe(
    "https://dash.iterate.com/.auth/connect?issuer=https%3A%2F%2Fos.iterate.com",
  );
  const fetched = new Request("https://os.iterate.com/", {
    headers: { accept: "text/html", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
  });
  expect(await request(fetched)).toMatchObject({ status: 200 });
  const landing = new Request("https://os.iterate.com/?landing=1", {
    headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  expect(await request(landing)).toMatchObject({ status: 200 });
});

test("public protocol origins: /favicon.svg is production's logo, and a preview's purple PR badge", async () => {
  const assetPaths: string[] = [];
  const favicon = (origin: string) =>
    worker.fetch(
      new Request(`${origin}/favicon.svg`),
      {
        ...bindings,
        ...origins,
        ITERATE__URLS__OS: origin,
        ASSETS: {
          fetch: async (asset: Request) => {
            assetPaths.push(new URL(asset.url).pathname);
            return new Response("<svg>the logo</svg>");
          },
        },
      } as unknown as Env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
  expect(await (await favicon("https://os.iterate.com")).text()).toBe("<svg>the logo</svg>");
  expect(assetPaths).toEqual(["/iterate-logo.svg"]);
  const preview = await favicon("https://pr2990-os.iterate-dev-preview.workers.dev");
  expect(preview.headers.get("content-type")).toBe("image/svg+xml");
  expect(await preview.text()).toMatch(/fill="#7C3AED".*>2990<\/text>/);
  expect(assetPaths).toEqual(["/iterate-logo.svg"]);
});

test("iterateConfigOf — once per env object: reads the version-metadata binding, blank ⇒ unversioned, and memoizes on the env", () => {
  const deployed = { ...MINIMAL, CF_VERSION_METADATA: { id: "v-9" } };
  const local = { ...MINIMAL, CF_VERSION_METADATA: { id: "" } };
  const bare = { ...MINIMAL_BLOB };
  expect(expose(iterateConfigOf(deployed))).toEqual({ ...MINIMAL_CONFIG, deployId: "v-9" });
  expect(expose(iterateConfigOf(local))).toEqual(MINIMAL_CONFIG);
  expect(expose(iterateConfigOf(bare))).toEqual(MINIMAL_CONFIG);
  expect(iterateConfigOf(deployed)).toBe(iterateConfigOf(deployed)); // the same object, parsed once
  expect(iterateConfigOf(deployed)).not.toBe(iterateConfigOf(local));
});
test("iterateConfigOf — once per env object: a malformed field throws at first use, naming it", () => {
  expect(() => iterateConfigOf({ ...MINIMAL, ITERATE__SECRETS_ENCRYPTION__KEY: "" })).toThrow(
    /^ITERATE secretsEncryption\.key \(ITERATE__SECRETS_ENCRYPTION__KEY\): required, but unset or blank$/,
  );
});

/** A public route's answer from the edge over `bindings` and `env` (the origins by default). */
const request = (url: string | Request, env: Record<string, unknown> = origins) =>
  worker.fetch(
    new Request(url),
    { ...bindings, ...env } as unknown as Env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );

/** Secrets are `Redacted` (they never print); expose them for a value comparison against the plain
 *  strings above. */
const expose = (config: IterateConfig) => ({
  cloudflare: config.cloudflare && {
    ...config.cloudflare,
    apiToken: config.cloudflare.apiToken.exposeSecret(),
  },
  // projects' own hostnames, shown when the config sets any
  urls: (({ projectHostnames, ...urls }) =>
    projectHostnames.length ? { ...urls, projectHostnames } : urls)(config.urls),
  customHostnames: config.customHostnames,
  posthogProjectKey: config.posthogProjectKey,
  admins: config.admins,
  login: {
    ...config.login,
    methods: {
      ...config.login.methods,
      ...(config.login.methods.password && {
        password: { password: config.login.methods.password.password.exposeSecret() },
      }),
    },
  },
  adminBearer: config.adminBearer.exposeSecret(),
  secretsEncryption: {
    key: config.secretsEncryption.key.exposeSecret(),
    previousKey: config.secretsEncryption.previousKey.exposeSecret(),
  },
  deployId: config.deployId,
});
