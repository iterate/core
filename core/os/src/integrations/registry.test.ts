// src/integrations/registry.test.ts — the IntegrationRegistryProcessor's executable spec:
// `{ events → state }` rows on the shared processor harness (iterate/stream/test-support
// `reduceProcessor`). What the engine refuses before the fold (a malformed payload) is the harness's
// to skip, as the engine does.
import { expect, test } from "vitest";
import { INTEGRATION_STATE_MAX_BYTES } from "iterate/integrations";
import { reduceProcessor } from "iterate/stream/test-support";
import { IntegrationRegistryProcessor } from "./registry.ts";

const telegram = {
  title: "Telegram",
  description: "A bot for private chats and groups.",
  status: { kind: "ok" as const },
  actions: [{ label: "Connect", routingSlug: "telegram", path: "/" }],
};
const bot = {
  account: "@jeeves_bot",
  status: { kind: "ok" as const },
  actions: [{ label: "Open", url: "https://t.me/jeeves_bot" }],
  details: { "Let in": "3 people" },
};

test.for([
  {
    name: "a card registered again replaces the first, whole",
    events: [
      card("telegram", telegram),
      card("telegram", { title: "Telegram", status: { kind: "attention", text: "Reconnect" } }),
    ],
    state: {
      integrations: {
        telegram: {
          title: "Telegram",
          status: { kind: "attention", text: "Reconnect" },
          actions: [],
        },
      },
      connections: {},
    },
  },
  {
    name: "a null card unregisters it, and takes its connections with it — another card's stay",
    events: [
      card("telegram", telegram),
      card("other", { title: "Other" }),
      connection("telegram", "jeeves", bot),
      connection("other", "x", { account: "x" }),
      card("telegram", null),
    ],
    state: {
      integrations: { other: { title: "Other", actions: [] } },
      connections: { "other/x": { account: "x", actions: [] } },
    },
  },
  {
    name: "a connection's row is keyed by integration and connection, needs its card, and a null row removes it",
    events: [
      card("telegram", telegram),
      connection("telegram", "jeeves", bot),
      connection("telegram", "other", { account: "@other_bot" }),
      // `constructor` is a valid name and no card of ours: nothing off the prototype counts as one
      connection("constructor", "cardless", { account: "+44" }),
      connection("telegram", "jeeves", null),
    ],
    state: {
      integrations: { telegram },
      connections: { "telegram/other": { account: "@other_bot", actions: [] } },
    },
  },
  {
    name: "a malformed payload (a label too long, an unknown key, a bad target, a name too long) is not folded",
    events: [
      card("telegram", telegram),
      card("telegram", { title: "x".repeat(81), actions: [] }),
      card("telegram", { title: "Telegram", colour: "blue" }),
      card("telegram", { title: "Telegram", actions: [{ label: "Go", path: "/", extra: 1 }] }),
      card("a".repeat(64), telegram),
      connection("telegram", "jeeves", {
        account: "@jeeves_bot",
        actions: [{ label: "Go", url: "javascript:alert(1)" }],
      }),
      card("Not A Slug", telegram),
      // `//host/…` would read as an authority when the Dash composes the URL
      card("evil", { title: "Evil", actions: [{ label: "Go", path: "//evil.example/x" }] }),
    ],
    state: { integrations: { telegram }, connections: {} },
  },
])("the registry — $name", ({ events, state }) =>
  // exact: the fold holds what it was given and nothing else
  expect(reduceProcessor(new IntegrationRegistryProcessor(), events)).toEqual(state),
);

test("the registry — a card or row that would take the state past its budget is left out; what fits still lands", () => {
  const heavyCards = Array.from({ length: 150 }, (_, index) =>
    card(`app${index + 1}`, heavy(`App ${index + 1}`)),
  );
  const state = reduceProcessor(new IntegrationRegistryProcessor(), [
    card("app0", { title: "App 0" }),
    ...heavyCards,
    // a replacement that would grow the state past the budget is left out: the card stays as it was
    card("app0", heavy("App 0, again")),
    // a row at every cap is larger than any card, so larger than what the cards left: left out
    connection("app0", "big", heavyRow()),
    // a row that fits in what is left lands
    connection("app0", "c0", { account: "small" }),
  ]);
  expect({
    some: Object.keys(state.integrations).length > 1,
    notAll: Object.keys(state.integrations).length < 151,
    withinBudget:
      new TextEncoder().encode(JSON.stringify(state)).length <= INTEGRATION_STATE_MAX_BYTES,
    first: state.integrations.app0,
    lastLeftOut: state.integrations.app150,
    connections: state.connections,
  }).toEqual({
    some: true,
    notAll: true,
    withinBudget: true,
    first: { title: "App 0", actions: [] },
    lastLeftOut: undefined,
    connections: { "app0/c0": { account: "small", actions: [] } },
  });
});

/** A card at every cap, its description two bytes a character: about 9 KiB serialized, so some 115
 *  of them fill the state's budget. */
function heavy(title: string) {
  return {
    title,
    description: "é".repeat(400),
    actions: Array.from({ length: 4 }, (_, index) => ({
      label: `Open ${index}`,
      url: `https://example.com/${"a".repeat(2000)}`,
    })),
  };
}

/** A row at every cap: about 11 KiB serialized, more than any card. */
function heavyRow() {
  return {
    account: "a".repeat(200),
    actions: heavy("").actions,
    details: Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `detail ${index}`.padEnd(40, "."),
        "v".repeat(200),
      ]),
    ),
  };
}

function card(integration: string, card: Record<string, unknown> | null) {
  return { type: "events.iterate.com/integration/configured", payload: { integration, card } };
}

function connection(integration: string, connection: string, row: Record<string, unknown> | null) {
  return {
    type: "events.iterate.com/integration/connection-configured",
    payload: { integration, connection, row },
  };
}
