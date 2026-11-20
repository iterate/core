// The default config's two sections of accounts (core/configs/default/cloud-accounts.ts): when a mind
// has "iterate Cloud", which secrets get a row under which card, and when a row is asked for
// again or goes; and "Keys and accounts", every other secret, by the service it is pinned to.
// The fake registry takes only what the real one takes (the contract's own schemas).
import { expect, test } from "vitest";
import {
  cloudAccountSecret,
  cloudAccountsEvent,
  connectCloudAccount,
  INTEGRATION_CALLABLE,
  removeCloudAccount,
} from "../../configs/default/cloud-accounts.ts";
import { ITERATE_CLOUD } from "../../configs/default/cloud-deliveries.ts";
import {
  callAnswerLink,
  IntegrationCard,
  IntegrationConnection,
  IntegrationRegistryContract,
} from "./integrations.ts";

/** The Cloud that the template names: the one whose accounts stand under "iterate Cloud". */
const CLOUD = ITERATE_CLOUD;
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
    icon: "https://dash.example.com/brands/google.svg",
    status: { kind: "ok", text: "Connected" },
  });
  expect(cards.github).toMatchObject({ status: { text: "2 accounts" } });
  // an app with no account has no status, and its button begins the first connect
  expect(cards.slack).not.toHaveProperty("status");
  expect(cards.slack).toMatchObject({
    actions: [{ label: "Connect", call: { name: "connectCloudAccount", args: ["slack"] } }],
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
        {
          label: "Connect again",
          call: { name: "connectCloudAccount", args: ["google", "google"] },
        },
        { label: "Manage", url: "https://dash.example.com/secrets" },
        removeOf("google"),
      ],
    },
    "github/github": expect.objectContaining({ account: "ada" }),
    // an installation's token is the App's to mint: nothing to connect again
    "github/github-installation-7": expect.objectContaining({
      account: "acme",
      details: { Kind: "App installation", Secret: "/secrets/github-installation-7" },
      actions: [
        { label: "Manage", url: "https://dash.example.com/secrets" },
        removeOf("github-installation-7"),
      ],
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
      { label: "Connect again", call: { name: "connectCloudAccount", args: ["google", "google"] } },
      { label: "Manage" },
      { label: "Remove" },
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

test("a mind whose Cloud never gave a list has no section, an app the Cloud drops loses its card, and a Cloud that gives no list changes nothing", async () => {
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
  const manage = [{ label: "Manage", url: "https://dash.example.com/secrets" }];
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
  const manage = { label: "Manage", url: "https://dash.example.com/secrets" };
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
      { label: "Connect again", call: { name: "connectCloudAccount", args: ["google", "google"] } },
      manage,
      removeOf("google"),
    ],
  });
  // a refusal keeps its words, and gets the same buttons
  expect(rows["github/github"]).toEqual({
    account: "GitHub account",
    status: refused,
    details: { Secret: "/secrets/github" },
    actions: [
      { label: "Connect again", call: { name: "connectCloudAccount", args: ["github", "github"] } },
      manage,
      removeOf("github"),
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

test("several X accounts: each is a row by its handle under X's one card, with 'Add account' for the next", async () => {
  const mind = withX(cloudMind());
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  const { cards, rows } = mind.registry();
  expect(cards.x).toMatchObject({
    status: { text: "2 accounts" },
    actions: [{ label: "Add account", call: { name: "connectCloudAccount", args: ["x"] } }],
  });
  expect(rows["x/x"]).toMatchObject({ account: "@ada", details: { Secret: "/secrets/x" } });
  expect(rows["x/x-2"]).toMatchObject({
    account: "@grace",
    details: { Secret: "/secrets/x-2" },
    actions: [
      { label: "Connect again", call: { name: "connectCloudAccount", args: ["x", "x-2"] } },
      { label: "Manage" },
      removeOf("x-2"),
    ],
  });
  // the Cloud's id of each account is kept, for its deliveries
  expect([mind.kv.get("cloud-account:x/42"), mind.kv.get("cloud-account:x/43")]).toEqual([
    "/secrets/x",
    "/secrets/x-2",
  ]);
});

test("Remove: the Cloud lets go of the account, what the mind kept for the secret goes, then the secret; its row goes at its event", async () => {
  const mind = withX(cloudMind());
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  // a Gmail row that reads through another secret stays
  mind.kv.set(
    "gmail:/integrations/google/ada@example.com",
    JSON.stringify({ secret: "/secrets/google" }),
  );

  const removed = await removeCloudAccount(mind.itx, "/secrets/x-2");

  expect(removed).toEqual({
    secret: "/secrets/x-2",
    app: "x",
    account: "43",
    cloud: "released",
    said: "Removed /secrets/x-2. iterate Cloud stopped its deliveries.",
  });
  expect(mind).toMatchObject({
    cloudAsks: [
      { route: "/clients/x/ask/release", secret: "/secrets/x-2", body: { account: "43" } },
    ],
  });
  expect(mind.secrets.has("/secrets/x-2")).toBe(false);
  expect(mind.kv.has("cloud-account:x/43")).toBe(false);
  expect(mind.kv.has("cloud-account-left:x/43")).toBe(true);
  expect(mind.kv.has("gmail:/integrations/google/ada@example.com")).toBe(true);
  await cloudAccountsEvent(mind.itx, deleted("/secrets/x-2"));
  expect(Object.keys(mind.registry().rows).filter((row) => row.startsWith("x/"))).toEqual(["x/x"]);
  expect(mind.registry().cards.x).toMatchObject({ status: { text: "Connected" } });

  // CONNECTED AGAIN: the mind takes the account back at the Cloud, once
  mind.secrets.set("/secrets/x-2", xSecret());
  await cloudAccountsEvent(mind.itx, set("/secrets/x-2"));
  expect(mind.cloudAsks.at(-1)).toEqual({
    route: "/clients/x/ask/release",
    secret: "/secrets/x-2",
    body: { account: "43", again: true },
  });
  expect(mind.kv.has("cloud-account-left:x/43")).toBe(false);
  await cloudAccountsEvent(mind.itx, set("/secrets/x-2"));
  expect(mind.cloudAsks.length).toBe(2);
});

test("Remove: while another secret holds the same account, the Cloud is not asked, and the mailbox's rows read through that secret", async () => {
  const mind = cloudMind();
  mind.secrets.set("/secrets/google-2", { ...mind.secrets.get("/secrets/google")! });
  mind.accounts.set("/secrets/google-2", { email: "Ada@Example.com" });
  mind.kv.set("cloud-account:google/ada@example.com", "/secrets/google-2");
  mind.kv.set(
    "gmail:/integrations/google/ada@example.com",
    JSON.stringify({ secret: "/secrets/google-2", historyId: "7" }),
  );
  mind.kv.set(
    "calendar:/integrations/google/ada@example.com",
    JSON.stringify({ secret: "/secrets/google-2" }),
  );

  expect(await removeCloudAccount(mind.itx, "/secrets/google-2")).toEqual({
    secret: "/secrets/google-2",
    app: "google",
    account: "ada@example.com",
    cloud: "shared",
    said: "Removed /secrets/google-2. Another secret holds the same account, and its deliveries go on.",
  });
  expect(mind).toMatchObject({ cloudAsks: [] });
  expect(Object.fromEntries(mind.kv)).toEqual({
    "cloud-account:google/ada@example.com": "/secrets/google",
    "gmail:/integrations/google/ada@example.com": JSON.stringify({
      secret: "/secrets/google",
      historyId: "7",
    }),
    "calendar:/integrations/google/ada@example.com": JSON.stringify({ secret: "/secrets/google" }),
  });
  expect(mind.secrets.has("/secrets/google-2")).toBe(false);
});

test("Remove: when the service cannot say whose account another secret of the app holds, nothing changes and the answer says why", async () => {
  const mind = withX(cloudMind());
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  const before = Object.fromEntries(mind.kv);
  // X gives no answer for /secrets/x-2, then refuses its token
  for (const status of [503, 401]) {
    mind.status.set("/secrets/x-2", status);
    await expect(removeCloudAccount(mind.itx, "/secrets/x")).rejects.toThrow(
      "X did not say whose account /secrets/x-2 holds",
    );
  }
  expect(mind).toMatchObject({ cloudAsks: [] });
  expect(mind.secrets.has("/secrets/x")).toBe(true);
  expect(Object.fromEntries(mind.kv)).toEqual(before);
  // X answers again: the Remove goes through
  mind.status.delete("/secrets/x-2");
  expect(await removeCloudAccount(mind.itx, "/secrets/x")).toMatchObject({ cloud: "released" });
});

test("Remove: a Cloud that refuses, a service that gives no answer, GitHub and a key", async () => {
  const mind = withX(cloudMind());
  // the Cloud refuses: the secret goes all the same, and the answer says so
  mind.cloudAnswers.push(new Response("no", { status: 503 }));
  expect(await removeCloudAccount(mind.itx, "/secrets/x")).toEqual({
    secret: "/secrets/x",
    app: "x",
    account: "42",
    cloud: { notReleased: "503 no" },
    said: "Removed /secrets/x. iterate Cloud did not stop its deliveries: 503 no",
  });
  expect(mind.secrets.has("/secrets/x")).toBe(false);
  // X gives no answer: nobody can say which account to let go of
  mind.status.set("/secrets/x-2", 503);
  expect(await removeCloudAccount(mind.itx, "/secrets/x-2")).toMatchObject({
    cloud: { notReleased: "X did not say whose account /secrets/x-2 holds" },
  });
  // GitHub's deliveries are the installations': the Cloud is not asked
  expect(await removeCloudAccount(mind.itx, "/secrets/github-installation-7")).toEqual({
    secret: "/secrets/github-installation-7",
    app: "github",
    cloud: "not-offered",
    said: "Removed /secrets/github-installation-7. iterate Cloud keeps delivering the installations' events.",
  });
  expect(mind.cloudAsks.length).toBe(1);
  // a key, or a secret that is not there: nothing changes
  await expect(removeCloudAccount(mind.itx, "/secrets/openai")).rejects.toThrow(
    "/secrets/openai is no account connected through iterate Cloud",
  );
  await expect(removeCloudAccount(mind.itx, "/secrets/x-9")).rejects.toThrow("no account");
  expect(mind.secrets.has("/secrets/openai")).toBe(true);
});

test("every function a card's button calls is one the config offers to buttons, and nothing else is offered", async () => {
  const mind = withX(cloudMind());
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  const { cards, rows } = mind.registry();
  const actions = [
    ...Object.values(cards).flatMap((card) => IntegrationCard.parse(card).actions),
    ...Object.values(rows).flatMap((row) => IntegrationConnection.parse(row).actions),
  ];
  const called = new Set(actions.flatMap((action) => ("call" in action ? [action.call.name] : [])));
  // cloudflare.ts's card calls cloudflareConnect (config-default-cloudflare-card.test.ts)
  expect([...called, "cloudflareConnect"].toSorted()).toEqual([...INTEGRATION_CALLABLE].toSorted());
});

test("each account connected from a card gets the first free name, 'Connect again' keeps its own, and the answer is the page to approve on", async () => {
  const secrets = new Set<string>();
  const begun: { path: string; options: unknown }[] = [];
  const itx = {
    url: async () => "https://example.com/",
    secrets: {
      list: async () => [...secrets].map((path) => ({ path, urls: [] })),
      beginOAuth: async (path: string, options: unknown) => {
        begun.push({ path, options });
        // as the vault answers: its start page on the mind's control plane
        return {
          authorizationUrl: `https://iterate.example.com/secrets/oauth/start?path=${encodeURIComponent(path)}`,
        };
      },
    },
  };
  const connect = (app: string, again?: string) => connectCloudAccount(itx, app, again);

  const first = await connect("x");
  expect(first).toEqual({
    secret: "/secrets/x",
    link: "https://iterate.example.com/secrets/oauth/start?path=%2Fsecrets%2Fx",
  });
  // the Dash follows the link: it is on the mind's control plane (iterate/integrations)
  expect(callAnswerLink(first, CONTROL_PLANE)).toMatchObject({ follow: expect.any(URL) });
  expect(begun).toEqual([
    {
      path: "/secrets/x",
      options: {
        client: { cloud: "x", origin: CLOUD },
        install: false,
        // back to the Integrations page, where the button was pressed
        next: "https://dash.example.com/integrations",
      },
    },
  ]);
  secrets.add("/secrets/x");
  expect(await connect("x")).toMatchObject({ secret: "/secrets/x-2" });
  secrets.add("/secrets/x-2");
  expect(await connect("x")).toMatchObject({ secret: "/secrets/x-3" });
  expect(await connect("x", "x-2")).toMatchObject({ secret: "/secrets/x-2" });
  // a button never connects again over another app's secret, nor over one that is not set
  secrets.add("/secrets/google");
  expect(await connect("x", "google")).toMatchObject({ secret: "/secrets/x-3" });
  expect(await connect("x", "x-9")).toMatchObject({ secret: "/secrets/x-3" });
  // GitHub's connect is the App's install page
  expect(begun.at(-1)?.options).not.toHaveProperty("install", true);
  await connect("github");
  expect(begun.at(-1)?.options).toMatchObject({ install: true });
  // a name that is no app's
  await expect(connect("../x")).rejects.toThrow("is no name of an app");
});

test("a delivery's account names its secret: the one kept for it, else the one that holds it; none once it was removed", async () => {
  const mind = withX(cloudMind());
  // nothing kept yet: each X secret is asked, and the answer is kept
  expect(await cloudAccountSecret(mind.itx, "x", "43")).toBe("/secrets/x-2");
  expect(mind.kv.get("cloud-account:x/43")).toBe("/secrets/x-2");
  const asked = mind.asked.length;
  expect(await cloudAccountSecret(mind.itx, "x", "43")).toBe("/secrets/x-2");
  expect(mind.asked.length).toBe(asked);
  // no secret holds it
  expect(await cloudAccountSecret(mind.itx, "x", "99")).toBe(null);
  await removeCloudAccount(mind.itx, "/secrets/x-2");
  expect(await cloudAccountSecret(mind.itx, "x", "43")).toBe(null);
  // X gave no answer for a secret: the first, rather than a lost message
  mind.status.set("/secrets/x", 503);
  expect(await cloudAccountSecret(mind.itx, "x", "99")).toBe("/secrets/x");
});

test("a secret connected again as another account no longer answers for the account it held", async () => {
  const mind = withX(cloudMind());
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  expect(await cloudAccountSecret(mind.itx, "x", "43")).toBe("/secrets/x-2");
  // "Connect again" on /secrets/x-2 as @linus (44)
  mind.accounts.set("/secrets/x-2", { data: { id: "44", username: "linus" } });
  await cloudAccountsEvent(mind.itx, set("/secrets/x-2"));
  expect([mind.kv.get("cloud-account:x/43"), mind.kv.get("cloud-account:x/44")]).toEqual([
    undefined,
    "/secrets/x-2",
  ]);
  expect(await cloudAccountSecret(mind.itx, "x", "43")).toBe(null);
  expect(await cloudAccountSecret(mind.itx, "x", "42")).toBe("/secrets/x");
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

/** A row's "Remove": a call of `removeCloudAccount` that the Dash asks about first. */
const removeOf = (name: string) =>
  expect.objectContaining({
    label: "Remove",
    call: { name: "removeCloudAccount", args: [`/secrets/${name}`] },
    confirm: expect.stringContaining(`The mind deletes /secrets/${name}`),
  });

/** A mind whose template names the Cloud at CLOUD (with `cloud: false`, that Cloud gives no list), with a Google grant, a GitHub grant and a GitHub App
 *  installation's secret through the Cloud's apps, a Google grant of an app of its own, and a
 *  key of another service. */
/** An X account's secret, connected through the Cloud's app. */
function xSecret() {
  return {
    urls: ["https://api.x.com"],
    refresh: "oauth-refresh-token",
    cloud: "x",
    cloudOrigin: CLOUD,
  };
}

/** `mind` with the Cloud's X app, and two X accounts: @ada (42) at `/secrets/x` and @grace (43)
 *  at `/secrets/x-2`. */
function withX(mind: ReturnType<typeof cloudMind>) {
  mind.offered = [...mind.offered, "x"];
  mind.secrets.set("/secrets/x", xSecret());
  mind.secrets.set("/secrets/x-2", xSecret());
  mind.accounts.set("/secrets/x", { data: { id: "42", username: "ada" } });
  mind.accounts.set("/secrets/x-2", { data: { id: "43", username: "grace" } });
  return mind;
}

function cloudMind({ cloud = true } = {}) {
  const secrets = new Map<
    string,
    { urls: string[]; refresh?: string; cloud?: string; cloudOrigin?: string }
  >([
    [
      "/secrets/google",
      {
        urls: ["https://www.googleapis.com"],
        refresh: "oauth-refresh-token",
        cloud: "google",
        cloudOrigin: CLOUD,
      },
    ],
    [
      "/secrets/github",
      {
        urls: ["https://api.github.com"],
        refresh: "oauth-refresh-token",
        cloud: "github",
        cloudOrigin: CLOUD,
      },
    ],
    [
      "/secrets/github-installation-7",
      {
        urls: ["https://api.github.com"],
        refresh: "github-app-installation",
        cloud: "github",
        cloudOrigin: CLOUD,
      },
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
  const kv = new Map<string, string>();
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
    kv,
    /** The secrets a service was asked about, in order. */
    asked: [] as string[],
    /** Each ask of iterate Cloud: its route, the secret it names and its body. */
    cloudAsks: [] as { route: string; secret: string; body: unknown }[],
    /** What the Cloud answers the next asks, in order; then 200. */
    cloudAnswers: [] as Response[],
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
      url: async () => "https://example.com/",
      fetch: async (request: Request) => {
        if (request.url.startsWith(`${CLOUD}/clients/`)) {
          mind.cloudAsks.push({
            route: new URL(request.url).pathname,
            secret: /getSecret\("([^"]+)"\)/.exec(request.headers.get("iterate-connection")!)![1]!,
            body: await request.json(),
          });
          return mind.cloudAnswers.shift() || Response.json({ connected: false });
        }
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
        cloud: async (origin: string) => ({ origin, clients: cloud ? mind.offered : [] }),
        delete: async (path: string) => secrets.delete(path),
      },
      kv: {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => kv.set(key, value),
        delete: async (key: string) => kv.delete(key),
        list: async (prefix = "") => ({
          keys: [...kv.keys()].filter((key) => key.startsWith(prefix)),
        }),
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

/** The test mind's control plane. */
const CONTROL_PLANE = "iterate.example.com";
