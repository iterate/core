// The default config's two sections of accounts (core/configs/default/cloud-accounts.ts): when a mind
// has "iterate Cloud", which secrets get a row under which card, and when a row is asked for
// again or goes; and "Keys and accounts", every other secret, by the service it is pinned to.
// The fake registry takes only what the real one takes (the contract's own schemas).
import { expect, test } from "vitest";
import { cloudAccountsEvent } from "../../configs/default/cloud-accounts.ts";
import { IntegrationRegistryContract } from "./integrations.ts";

const CLOUD = "https://cloud.example.com";
const PUBLISHED = { type: "events.iterate.com/mind/worker-updated", path: "/" };

test("a mind whose stack names a Cloud gets the section: a card for each app the Cloud offers, and a row for each account connected through one", async () => {
  const mind = cloudMind();

  await cloudAccountsEvent(mind.itx, PUBLISHED);

  const { heading, cards, rows } = mind.registry();
  expect(heading).toMatchObject({
    title: "iterate Cloud",
    icon: `${CLOUD}/iterate-logo.svg`,
  });
  // the apps are the Cloud's own list: no card for an app this Cloud does not offer (X), nor
  // for one this file does not know
  expect(Object.keys(cards)).toEqual(["google", "github", "slack"]);
  expect(cards.google).toMatchObject({
    title: "Google",
    section: "iterate-cloud",
    icon: { routingSlug: "dash", path: "/brands/google.svg" },
    status: { kind: "ok", text: "Connected" },
  });
  expect(cards.github).toMatchObject({ status: { text: "2 accounts" } });
  // an app with no account has no status, and its button begins the first connect
  expect(cards.slack).not.toHaveProperty("status");
  expect(cards.slack).toMatchObject({
    actions: [{ label: "Connect", routingSlug: "dash", path: "/connect/slack" }],
  });
  expect(cards.google).toMatchObject({ actions: [{ label: "Add account" }] });
  // a person's grant and an installation's token; nothing for a key of another service, nor for
  // a Google grant of an app of the mind's own
  expect(rows).toEqual({
    "google/google": {
      account: "ada@example.com",
      status: { kind: "ok" },
      details: { Secret: "/secrets/google" },
      // a person's grant is connected again to bring new scopes in (cloud-scopes.ts)
      actions: [
        { label: "Connect again", routingSlug: "dash", path: "/connect/google?secret=google" },
        { label: "Manage", routingSlug: "dash", path: "/?page=secrets" },
      ],
    },
    "github/github": expect.objectContaining({ account: "ada" }),
    // an installation's token is the App's to mint: nothing to connect again
    "github/github-installation-7": expect.objectContaining({
      account: "acme",
      details: { Kind: "App installation", Secret: "/secrets/github-installation-7" },
      actions: [{ label: "Manage", routingSlug: "dash", path: "/?page=secrets" }],
    }),
  });

  // A PUBLISH THAT CHANGES NOTHING adds nothing to the log, and asks no service again
  const [appended, asked] = [mind.appended.length, mind.asked.length];
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  expect([mind.appended.length, mind.asked.length]).toEqual([appended, asked]);

  // an event that is none of the four, or a secret's fact on another log than the secret's own
  // (the root's, or one below it)
  await cloudAccountsEvent(mind.itx, {
    ...set("/secrets/google"),
    type: "events.iterate.com/secret/used",
  });
  await cloudAccountsEvent(mind.itx, { ...set("/secrets/google"), path: "/" });
  await cloudAccountsEvent(mind.itx, { ...set("/secrets/google"), path: "/secrets/google/x" });
  expect([mind.appended.length, mind.asked.length]).toEqual([appended, asked]);
  // on its own log, the fact asks the service again
  await cloudAccountsEvent(mind.itx, set("/secrets/google"));
  expect(mind.asked.length).toBe(asked + 1);
});

test("a secret set again is asked for again, one that the service refuses says so, and a deleted one loses its row", async () => {
  const mind = cloudMind();
  await cloudAccountsEvent(mind.itx, PUBLISHED);

  // the same path now holds another account's grant
  mind.accounts.set("/secrets/google", { email: "grace@example.com" });
  await cloudAccountsEvent(mind.itx, set("/secrets/google"));
  expect(mind.registry().rows["google/google"]).toMatchObject({ account: "grace@example.com" });

  // a service that gives no answer leaves the row as it was
  mind.status.set("/secrets/google", 503);
  await cloudAccountsEvent(mind.itx, set("/secrets/google"));
  expect(mind.registry().rows["google/google"]).toMatchObject({ account: "grace@example.com" });

  // a service that refuses the token: the row says what to ask the agent
  mind.status.set("/secrets/google", 401);
  await cloudAccountsEvent(mind.itx, set("/secrets/google"));
  expect(mind.registry().rows["google/google"]).toMatchObject({
    account: "Google account",
    status: { kind: "attention", text: "Google refused the token. Connect the account again." },
    actions: [
      { label: "Connect again", routingSlug: "dash", path: "/connect/google?secret=google" },
      { label: "Manage" },
    ],
  });

  mind.secrets.delete("/secrets/google");
  await cloudAccountsEvent(mind.itx, deleted("/secrets/google"));
  const { cards, rows } = mind.registry();
  expect(Object.keys(rows)).toEqual(["github/github", "github/github-installation-7"]);
  // the card stays, with its first button again
  expect(cards.google).not.toHaveProperty("status");
  expect(cards.google).toMatchObject({ actions: [{ label: "Connect" }] });
});

test("a mind whose stack names no Cloud has no section, an app the Cloud drops loses its card, and a Cloud that gives no list changes nothing", async () => {
  const alone = cloudMind({ cloud: false });
  await cloudAccountsEvent(alone.itx, PUBLISHED);
  expect(alone.registry()).toEqual({ heading: undefined, cards: {}, rows: {} });

  const mind = cloudMind();
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  mind.offered = ["google"];
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  expect(Object.keys(mind.registry().cards)).toEqual(["google"]);
  expect(Object.keys(mind.registry().rows)).toEqual(["google/google"]);

  const before = mind.registry();
  mind.offered = [];
  mind.secrets.clear();
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  expect(mind.registry()).toEqual(before);
});

test("every other secret stands under 'Keys and accounts', Cloud or none: one list, a row for each secret in path order, and no service asked", async () => {
  const mind = cloudMind({ cloud: false });
  // a second key of the same service, a key with no pin, a webhook's secret pinned to a made-up
  // host, and the stack's own Cloudflare token
  mind.secrets.set("/secrets/openai-backup", { urls: ["https://api.openai.com/v1/"] });
  mind.secrets.set("/secrets/scratch", { urls: [] });
  mind.secrets.set("/secrets/hook", { urls: ["https://webhook.invalid"] });
  mind.secrets.set("/secrets/cloudflare", { urls: ["https://api.cloudflare.com"] });

  await cloudAccountsEvent(mind.itx, PUBLISHED);

  const { heading, cards, rows } = mind.section("keys");
  expect(heading).toEqual({
    title: "Keys and accounts",
    description: expect.stringContaining("ask your agent to connect"),
    actions: [],
  });
  // one card: no icon, no description, no status, no button; each row has its own dot
  expect(cards).toEqual({ secrets: { title: "Secrets (5)", section: "keys", actions: [] } });
  const manage = [{ label: "Manage", routingSlug: "dash", path: "/?page=secrets" }];
  expect(rows).toEqual({
    // a grant through an app of the mind's own says so
    "secrets/google-own-app": {
      account: "/secrets/google-own-app",
      status: { kind: "ok" },
      details: {
        Kind: "OAuth grant",
        Hosts: "oauth2.googleapis.com, www.googleapis.com",
      },
      actions: manage,
    },
    // a `.invalid` host says nothing to a person
    "secrets/hook": {
      account: "/secrets/hook",
      status: { kind: "ok" },
      details: {},
      actions: manage,
    },
    "secrets/openai": {
      account: "/secrets/openai",
      status: { kind: "ok" },
      details: { Hosts: "api.openai.com" },
      actions: manage,
    },
    "secrets/openai-backup": expect.objectContaining({ account: "/secrets/openai-backup" }),
    "secrets/scratch": {
      account: "/secrets/scratch",
      status: { kind: "ok" },
      details: {},
      actions: manage,
    },
  });
  // appended in path order, the order the page draws them in
  expect(Object.keys(rows)).toEqual([
    "secrets/google-own-app",
    "secrets/hook",
    "secrets/openai",
    "secrets/openai-backup",
    "secrets/scratch",
  ]);
  // the catalog alone: no service is asked whose account a key is
  expect(mind).toMatchObject({ asked: [] });

  // A RUN THAT CHANGES NOTHING adds nothing to the log
  const appended = mind.appended.length;
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  expect(mind.appended.length).toBe(appended);

  // a deleted secret loses its row
  mind.secrets.delete("/secrets/openai-backup");
  await cloudAccountsEvent(mind.itx, deleted("/secrets/openai-backup"));
  expect(Object.keys(mind.section("keys").rows)).not.toContain("secrets/openai-backup");

  // the card and the heading go with the last row: a mind with no key shows no empty heading
  for (const path of ["/secrets/google-own-app", "/secrets/hook", "/secrets/openai"])
    mind.secrets.delete(path);
  mind.secrets.delete("/secrets/scratch");
  await cloudAccountsEvent(mind.itx, deleted("/secrets/scratch"));
  expect(mind.section("keys")).toEqual({ heading: undefined, cards: {}, rows: {} });
  const none = mind.appended.length;
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  expect(mind.appended.length).toBe(none);
});

test("a row an older template made gets today's buttons at the next publish, with no service asked, once", async () => {
  const mind = cloudMind();
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  const manage = { label: "Manage", routingSlug: "dash", path: "/?page=secrets" };
  // what the template before "Connect again" left: a person's rows with "Manage" alone, one of
  // them a refusal
  const registry = mind.itx.cd("/integrations");
  const old = (integration: string, connection: string, row: Record<string, unknown>) =>
    registry.append({
      type: "events.iterate.com/integration/connection-configured",
      payload: { integration, connection, row },
    });
  await old("iterate-cloud-google", "google", {
    account: "ada@example.com",
    status: { kind: "ok" },
    details: { Secret: "/secrets/google" },
    actions: [manage],
  });
  const refused = {
    kind: "attention",
    text: "GitHub refused the token. Connect the account again.",
  };
  await old("iterate-cloud-github", "github", {
    account: "GitHub account",
    status: refused,
    details: { Secret: "/secrets/github" },
    actions: [manage],
  });
  const installation = mind.registry().rows["github/github-installation-7"];
  const [appended, asked] = [mind.appended.length, mind.asked.length];

  await cloudAccountsEvent(mind.itx, PUBLISHED);

  const { rows } = mind.registry();
  expect(rows["google/google"]).toEqual({
    account: "ada@example.com",
    status: { kind: "ok" },
    details: { Secret: "/secrets/google" },
    actions: [
      { label: "Connect again", routingSlug: "dash", path: "/connect/google?secret=google" },
      manage,
    ],
  });
  // a refusal keeps its words, and gets the same buttons
  expect(rows["github/github"]).toEqual({
    account: "GitHub account",
    status: refused,
    details: { Secret: "/secrets/github" },
    actions: [
      { label: "Connect again", routingSlug: "dash", path: "/connect/github?secret=github" },
      manage,
    ],
  });
  expect(rows["github/github-installation-7"]).toEqual(installation);
  // each changed row once, and no service asked
  expect([mind.appended.length - appended, mind.asked.length]).toEqual([2, asked]);

  await cloudAccountsEvent(mind.itx, PUBLISHED);
  expect([mind.appended.length - appended, mind.asked.length]).toEqual([2, asked]);
});

test("a mind that had a card for each service gets the one list at the next event", async () => {
  const mind = cloudMind({ cloud: false });
  const registry = mind.itx.cd("/integrations");
  await registry.append({
    type: "events.iterate.com/integration/configured",
    payload: { integration: "keys", card: { title: "Keys and accounts" } },
  });
  await registry.append({
    type: "events.iterate.com/integration/configured",
    payload: { integration: "keys-openai-com", card: { title: "openai.com", section: "keys" } },
  });
  await registry.append({
    type: "events.iterate.com/integration/connection-configured",
    payload: {
      integration: "keys-openai-com",
      connection: "openai",
      row: { account: "openai" },
    },
  });

  await cloudAccountsEvent(mind.itx, PUBLISHED);

  const { heading, cards, rows } = mind.section("keys");
  expect(heading).toMatchObject({ description: expect.stringContaining("ask your agent") });
  expect(Object.keys(cards)).toEqual(["secrets"]);
  expect(Object.keys(rows)).toEqual(["secrets/google-own-app", "secrets/openai"]);
});

test("a secret whose account a package of the mind shows already has no row under 'Keys and accounts'", async () => {
  const mind = cloudMind({ cloud: false });
  // a package's own Google connection, its grant, and its client's secret
  mind.secrets.set("/secrets/own-google-042a1be3", {
    urls: ["https://www.googleapis.com"],
    refresh: "oauth-refresh-token",
  });
  mind.secrets.set("/secrets/own-google-app", { urls: ["https://oauth2.googleapis.com"] });
  await mind.itx.cd("/integrations").append({
    type: "events.iterate.com/integration/configured",
    payload: { integration: "google", card: { title: "Google" } },
  });
  await mind.itx.cd("/integrations").append({
    type: "events.iterate.com/integration/connection-configured",
    payload: {
      integration: "google",
      connection: "042a1be3",
      row: { account: "ada@example.com" },
    },
  });

  await cloudAccountsEvent(mind.itx, PUBLISHED);

  expect(Object.keys(mind.section("keys").rows)).toEqual([
    "secrets/google-own-app",
    "secrets/openai",
    "secrets/own-google-app",
  ]);
});

test("each value a computer lends gets a card under 'Lent by a computer', and loses it when the lend ends", async () => {
  const mind = cloudMind({ cloud: false });
  mind.rules.push(
    {
      match: "itx.whatsapp.jeeves",
      target: "itx.builtins.rpcStubs.get('itx.whatsapp.jeeves')",
      description: `Jeeves's own WhatsApp account, +44 7700 900000. Send with send(to, text); ${"more ".repeat(60)}`,
      context: "/",
    },
    {
      match: "itx.phone",
      target: "itx.builtins.rpcStubs.get('itx.phone')",
      description: "A phone line ".repeat(30),
      context: "/",
    },
  );

  await cloudAccountsEvent(mind.itx, PUBLISHED);

  const { heading, cards, rows } = mind.section("lent");
  expect(heading).toMatchObject({ title: "Lent by a computer", actions: [] });
  // the platform's own names are no lends: two cards, and no rows
  expect(cards).toEqual({
    "whatsapp-jeeves": {
      title: "itx.whatsapp.jeeves",
      description: "Jeeves's own WhatsApp account, +44 7700 900000.",
      section: "lent",
      status: { kind: "ok", text: "Connected" },
      actions: [],
    },
    phone: expect.objectContaining({
      title: "itx.phone",
      description: `${"A phone line ".repeat(30).slice(0, 199)}…`,
    }),
  });
  expect(rows).toEqual({});

  // a bridge that signs in again sets the same rule again: nothing is appended
  const appended = mind.appended.length;
  await cloudAccountsEvent(mind.itx, ruleConfigured("itx.phone"));
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  expect(mind.appended.length).toBe(appended);

  // a lend that ends loses its card, and the last one takes the heading with it
  mind.rules = mind.rules.filter((rule) => rule.match !== "itx.phone");
  await cloudAccountsEvent(mind.itx, ruleConfigured("itx.phone"));
  expect(Object.keys(mind.section("lent").cards)).toEqual(["whatsapp-jeeves"]);
  mind.rules = mind.rules.filter((rule) => rule.match !== "itx.whatsapp.jeeves");
  await cloudAccountsEvent(mind.itx, ruleConfigured("itx.whatsapp.jeeves"));
  expect(mind.section("lent")).toEqual({ heading: undefined, cards: {}, rows: {} });
});

/** The root's fact that the rule for `match` was set or unset. */
const ruleConfigured = (match: string) => ({
  type: "events.iterate.com/itx/rewrite-rule-configured",
  path: "/",
  payload: { match, target: null },
});

/** The fact that the secret at `path` was set, on the secret's own log, where the secrets root
 *  records it. */
const set = (path: string) => ({
  type: "events.iterate.com/secret/set",
  path,
  payload: { path },
});

/** The fact that the secret at `path` was deleted, on the secret's own log. */
const deleted = (path: string) => ({
  type: "events.iterate.com/secret/deleted",
  path,
  payload: { path },
});

/** A mind whose stack names the Cloud at CLOUD, with a Google grant, a GitHub grant and a GitHub App
 *  installation's secret through the Cloud's apps, a Google grant of an app of its own, and a
 *  key of another service. */
function cloudMind({ cloud = true } = {}) {
  const secrets = new Map<string, { urls: string[]; refresh?: string; cloud?: string }>([
    [
      "/secrets/google",
      { urls: ["https://www.googleapis.com"], refresh: "oauth-refresh-token", cloud: "google" },
    ],
    [
      "/secrets/github",
      { urls: ["https://api.github.com"], refresh: "oauth-refresh-token", cloud: "github" },
    ],
    [
      "/secrets/github-installation-7",
      { urls: ["https://api.github.com"], refresh: "github-app-installation", cloud: "github" },
    ],
    [
      "/secrets/google-own-app",
      {
        urls: ["https://oauth2.googleapis.com", "https://www.googleapis.com"],
        refresh: "oauth-refresh-token",
      },
    ],
    ["/secrets/openai", { urls: ["https://api.openai.com"] }],
  ]);
  /** What each service answers for the account of a secret, and a status it answers instead. */
  const accounts = new Map<string, unknown>([
    ["/secrets/google", { email: "ada@example.com" }],
    ["/secrets/github", { login: "ada" }],
    ["/secrets/github-installation-7", { repositories: [{ owner: { login: "acme" } }] }],
  ]);
  const status = new Map<string, number>();
  const appended: { type: string; payload: unknown }[] = [];
  const state = {
    integrations: {} as Record<string, unknown>,
    connections: {} as Record<string, unknown>,
  };
  const events = IntegrationRegistryContract.events;
  const mind = {
    secrets,
    accounts,
    status,
    appended,
    /** The clients the Cloud publishes; `unknown` is one this file has no words for. */
    offered: ["google", "github", "slack", "unknown"],
    /** The secrets a service was asked about, in order. */
    asked: [] as string[],
    /** The root's rewrite rules, as `rewriteRules.list()` answers them: the platform's own names
     *  alone, until a test lends one. */
    rules: [
      { match: "itx.secrets", target: "itx.builtins.secrets", context: "/" },
      { match: "itx.config", target: "itx.builtins.config", context: "/" },
    ] as { match: string; target: string | null; description?: string; context: string }[],
    /** The heading `name`, the cards under it by the rest of their names, and their rows by
     *  `<rest of the card's name>/<secret's name>`. */
    section(name: string) {
      const under = (key: string) => key.startsWith(`${name}-`);
      const short = (key: string) => key.slice(name.length + 1);
      return structuredClone({
        heading: state.integrations[name],
        cards: Object.fromEntries(
          Object.entries(state.integrations)
            .filter(([key]) => under(key))
            .map(([key, card]) => [short(key), card]),
        ) as Record<string, unknown>,
        rows: Object.fromEntries(
          Object.entries(state.connections)
            .filter(([key]) => under(key))
            .map(([key, row]) => [short(key), row]),
        ),
      });
    },
    /** The "iterate Cloud" section, its cards by app. */
    registry: () => mind.section("iterate-cloud"),
    itx: {
      fetch: async (request: Request) => {
        // every secret here keeps its token as `accessToken`: a placeholder for another field
        // finds nothing, as the vault answers
        const secret = /getSecret\("([^"]+)", \{ field: "accessToken" \}\)/.exec(
          request.headers.get("authorization") || "",
        )?.[1];
        if (!secret) return new Response("no such field", { status: 401 });
        mind.asked.push(secret);
        const refused = status.get(secret);
        return refused
          ? new Response("no", { status: refused })
          : Response.json(accounts.get(secret));
      },
      secrets: {
        list: async () => [...secrets].map(([path, secret]) => ({ path, ...secret })),
        cloud: async () => (cloud ? { origin: CLOUD, clients: mind.offered } : null),
      },
      rewriteRules: { list: async () => structuredClone(mind.rules) },
      cd: (path: string) => ({
        // the registry's own fold, as far as this file uses it
        append: async (event: { type: string; payload: Record<string, unknown> }) => {
          expect(path).toBe("/integrations");
          appended.push(event);
          if (event.type === "events.iterate.com/integration/configured") {
            const { integration, card } = events[
              "events.iterate.com/integration/configured"
            ].payloadSchema.parse(event.payload);
            if (card) state.integrations[integration] = card;
            else {
              delete state.integrations[integration];
              for (const key of Object.keys(state.connections))
                if (key.startsWith(`${integration}/`)) delete state.connections[key];
            }
          } else {
            const { integration, connection, row } = events[
              "events.iterate.com/integration/connection-configured"
            ].payloadSchema.parse(event.payload);
            // a row stands under a card that exists
            expect(state.integrations).toHaveProperty(integration);
            if (row) state.connections[`${integration}/${connection}`] = row;
            else delete state.connections[`${integration}/${connection}`];
          }
        },
        facets: {
          get: <T>() => ({ snapshot: async () => ({ state: structuredClone(state) }) }) as T,
        },
      }),
    },
  };
  return mind;
}
