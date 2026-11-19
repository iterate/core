// The core reduce's subscription rows: who holds a live callback (`heldBy`), read from the
// platform's stamp on the row's event. How the stamp gets there is iterate-context.test.ts's subject.
import type { StreamEvent } from "iterate/stream/processor";
import { expect, test } from "vitest";
import { defineItxHost } from "../host.ts";
import { CoreContract, normalizeControlEvent, reduceCoreEventBatch } from "./core-processor.ts";

const member = { actor: "user_1", email: "a@example.com" };
const person = { actor: "user_2", email: "b@example.com" };
const liveCallback = ["itx", "builtins", "rpcStubs", ["get", "subscription:sub-1"]];

test.for([
  {
    name: "a member's live callback names the member, and the page they came through",
    target: liveCallback,
    source: { principal: member, grant: "grant:1", via: { appPage: "chat.example.com" } },
    heldBy: { principal: member, via: { appPage: "chat.example.com" } },
  },
  {
    name: "a person's live callback names the person beside the unnamed caller",
    target: liveCallback,
    source: { onBehalfOf: { principal: person, via: { appPage: "chat.example.com" } } },
    heldBy: { principal: person, via: { appPage: "chat.example.com" } },
  },
  {
    name: "a member beside a person: the member holds it",
    target: liveCallback,
    source: { principal: member, onBehalfOf: { principal: person } },
    heldBy: { principal: member },
  },
])("$name", ({ target, source, heldBy }) => {
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exact: no other key of the stamp may reach the row
  expect(rowOf({ name: "sub-1", target }, source).heldBy).toEqual(heldBy);
});

test.for([
  { name: "a live callback that nobody named lent", target: liveCallback, source: {} },
  // code that ran for someone holds its callback itself: they have no page open here
  {
    name: "a live callback that a script lent while it ran for someone",
    target: liveCallback,
    source: { onBehalfOf: { principal: person, run: "/@4" } },
  },
  {
    name: "a live callback that a facet lent in someone's call",
    target: liveCallback,
    source: { onBehalfOf: { principal: person, call: "/agents/a#agent.message" } },
  },
  {
    name: "a hosted processor that a member enabled",
    target: ["itx", "builtins", "facets", ["get", "agent"], "processEventBatch"],
    source: { principal: member },
  },
  {
    name: "an expression target that a member wrote",
    target: ["itx", ["cd", "/agents/a"], ["append"]],
    source: { principal: member },
  },
  {
    name: "a copy row that a member wrote",
    target: { path: "/agents/b" },
    source: { principal: member },
  },
  {
    name: "a live callback's target under another row's name",
    target: ["itx", "builtins", "rpcStubs", ["get", "subscription:sub-2"]],
    source: { principal: member },
  },
])("no one holds $name", ({ target, source }) => {
  expect(rowOf({ name: "sub-1", target }, source)).not.toHaveProperty("heldBy");
});

test("a payload that names a holder names none: the stamp alone does", () => {
  const claimed = { principal: { actor: "user_9" } };
  expect(rowOf({ name: "sub-1", target: liveCallback, heldBy: claimed }, {})).not.toHaveProperty(
    "heldBy",
  );
  expect(
    rowOf({ name: "sub-1", target: liveCallback, heldBy: claimed }, { principal: member }),
  ).toMatchObject({ heldBy: { principal: member } });
});

test("the row's un-set removes it, holder and all", () => {
  const state = reduced([
    subscriptionEvent(1, { name: "sub-1", target: liveCallback }, { principal: member }),
    subscriptionEvent(2, { name: "sub-1", target: null }, {}),
  ]);
  expect(state).not.toHaveProperty(["subscriptions", "sub-1"]);
});

test("an append of a row with no `target` is refused in words that name the field", () => {
  const event = {
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "sub-1", expression: liveCallback }, // a wrong key: no `target`
  };
  expect(() => normalizeControlEvent(event, "/")).toThrowError(
    "a subscription needs a `target`: an itx expression, { path } for a copy, or null to remove the row",
  );
});

defineItxHost({ firstPartyFacets: {} });

function rowOf(payload: Record<string, unknown>, source: Partial<StreamEvent["source"]>) {
  return reduced([subscriptionEvent(1, payload, source)]).subscriptions["sub-1"];
}

function reduced(events: StreamEvent[]) {
  return reduceCoreEventBatch(events, CoreContract.initialState(), (error) => {
    throw error;
  });
}

function subscriptionEvent(
  offset: number,
  payload: Record<string, unknown>,
  source: Partial<StreamEvent["source"]>,
): StreamEvent {
  return {
    offset,
    path: "/",
    createdAt: "2026-01-01T00:00:00.000Z",
    source: { origin: "/", ...source },
    type: "events.iterate.com/itx/subscription-configured",
    payload,
  };
}
