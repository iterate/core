// The default config's "iterate Cloud" section (core/configs/default/cloud-accounts.ts): when a
// mind has it, which secrets get a row under which card, and when a row is asked for again or
// goes. The fake registry takes only what the real one takes (the contract's own schemas).
import { expect, test } from "vitest";
import { cloudAccountsEvent } from "../../configs/default/cloud-accounts.ts";
import { IntegrationRegistryContract } from "./integrations.ts";

const CLOUD = "https://cloud.example.com";
const PUBLISHED = { type: "events.iterate.com/mind/worker-updated", path: "/" };

test("a mind that the Cloud enrolled gets the section: a card for each app the Cloud offers, and a row for each account connected through one", async () => {
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
      actions: [{ label: "Manage", routingSlug: "dash", path: "/?page=secrets" }],
    },
    "github/github": expect.objectContaining({ account: "ada" }),
    "github/github-installation-7": expect.objectContaining({
      account: "acme",
      details: { Kind: "App installation", Secret: "/secrets/github-installation-7" },
    }),
  });

  // A PUBLISH THAT CHANGES NOTHING adds nothing to the log, and asks no service again
  const [appended, asked] = [mind.appended.length, mind.asked.length];
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  expect([mind.appended.length, mind.asked.length]).toEqual([appended, asked]);

  // an event that is none of the four, or a secret's fact on another log than the root's
  await cloudAccountsEvent(mind.itx, { type: "events.iterate.com/secret/used", path: "/" });
  await cloudAccountsEvent(mind.itx, { ...set("/secrets/google"), path: "/secrets/google" });
  expect(mind.asked.length).toBe(asked);
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
  await cloudAccountsEvent(mind.itx, {
    type: "events.iterate.com/secret/deleted",
    path: "/",
    payload: { path: "/secrets/google" },
  });
  const { cards, rows } = mind.registry();
  expect(Object.keys(rows)).toEqual(["github/github", "github/github-installation-7"]);
  // the card stays, with its first button again
  expect(cards.google).not.toHaveProperty("status");
  expect(cards.google).toMatchObject({ actions: [{ label: "Connect" }] });
});

test("a mind that no Cloud enrolled has no section, an app the Cloud drops loses its card, and a Cloud that gives no list changes nothing", async () => {
  const alone = cloudMind({ enrolled: false });
  await cloudAccountsEvent(alone.itx, PUBLISHED);
  expect([alone.registry().heading, alone.appended]).toEqual([undefined, []]);

  // the enrolment itself brings the section
  alone.enrol();
  await cloudAccountsEvent(alone.itx, {
    type: "events.iterate.com/cloud/deployment-enrolled",
    path: "/integrations/cloud",
  });
  expect(Object.keys(alone.registry().cards)).toEqual(["google", "github", "slack"]);

  const mind = cloudMind();
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  mind.offered = ["google"];
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  expect(Object.keys(mind.registry().cards)).toEqual(["google"]);
  expect(Object.keys(mind.registry().rows)).toEqual(["google/google"]);

  const before = mind.registry();
  mind.cloudIsDown = true;
  mind.secrets.clear();
  await cloudAccountsEvent(mind.itx, PUBLISHED);
  expect(mind.registry()).toEqual(before);
});

/** The root's fact that the secret at `path` was set. */
const set = (path: string) => ({
  type: "events.iterate.com/secret/set",
  path: "/",
  payload: { path },
});

/** A mind that the Cloud at CLOUD enrolled, with a Google grant, a GitHub grant and a GitHub App
 *  installation's secret through the Cloud's apps, a Google grant of an app of its own, and a
 *  key of another service. */
function cloudMind({ enrolled = true } = {}) {
  const secrets = new Map<string, { refresh?: string; cloud?: string }>([
    ["/secrets/google", { refresh: "oauth-refresh-token", cloud: "google" }],
    ["/secrets/github", { refresh: "oauth-refresh-token", cloud: "github" }],
    ["/secrets/github-installation-7", { refresh: "github-app-installation", cloud: "github" }],
    ["/secrets/google-own-app", { refresh: "oauth-refresh-token" }],
    ["/secrets/openai", {}],
  ]);
  /** What each service answers for the account of a secret, and a status it answers instead. */
  const accounts = new Map<string, unknown>([
    ["/secrets/google", { email: "ada@example.com" }],
    ["/secrets/github", { login: "ada" }],
    ["/secrets/github-installation-7", { repositories: [{ owner: { login: "acme" } }] }],
  ]);
  const status = new Map<string, number>();
  const cloudEvents: { type: string; payload?: unknown }[] = [];
  const enrol = () =>
    cloudEvents.push({
      type: "events.iterate.com/cloud/deployment-enrolled",
      payload: { cloud: CLOUD, key: "a-key" },
    });
  if (enrolled) enrol();
  const appended: { type: string; payload: unknown }[] = [];
  const state = {
    integrations: {} as Record<string, unknown>,
    connections: {} as Record<string, unknown>,
    sections: {} as Record<string, unknown>,
  };
  const events = IntegrationRegistryContract.events;
  const short = (key: string) => key.replace("iterate-cloud-", "");
  const mind = {
    secrets,
    accounts,
    status,
    appended,
    enrol,
    cloudIsDown: false,
    /** The clients the Cloud publishes; `unknown` is one this file has no words for. */
    offered: ["google", "github", "slack", "unknown"],
    /** The secrets a service was asked about, in order. */
    asked: [] as string[],
    /** The section's heading, its cards by app, and its rows by `<app>/<secret's name>`. */
    registry() {
      return structuredClone({
        heading: state.sections["iterate-cloud"],
        cards: Object.fromEntries(
          Object.entries(state.integrations).map(([key, card]) => [short(key), card]),
        ) as Record<string, unknown>,
        rows: Object.fromEntries(
          Object.entries(state.connections).map(([key, row]) => [short(key), row]),
        ),
      });
    },
    itx: {
      fetch: async (request: Request) => {
        if (request.url === `${CLOUD}/.well-known/iterate-cloud`)
          return mind.cloudIsDown
            ? new Response("down", { status: 503 })
            : Response.json({
                clients: Object.fromEntries(mind.offered.map((name) => [name, {}])),
              });
        const secret = /getSecret\("([^"]+)"/.exec(request.headers.get("authorization") || "")?.[1];
        if (!secret) return new Response("no placeholder", { status: 400 });
        mind.asked.push(secret);
        const refused = status.get(secret);
        return refused
          ? new Response("no", { status: refused })
          : Response.json(accounts.get(secret));
      },
      secrets: { list: async () => [...secrets].map(([path, secret]) => ({ path, ...secret })) },
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
          } else if (event.type === "events.iterate.com/integration/section-configured") {
            const { section, heading } = events[
              "events.iterate.com/integration/section-configured"
            ].payloadSchema.parse(event.payload);
            state.sections[section] = heading;
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
        readEvents: async () => ({ events: path === "/integrations/cloud" ? cloudEvents : [] }),
        facets: {
          get: <T>() => ({ snapshot: async () => ({ state: structuredClone(state) }) }) as T,
        },
      }),
    },
  };
  return mind;
}
