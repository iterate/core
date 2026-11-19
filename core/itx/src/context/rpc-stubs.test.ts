import { expect, test, vi } from "vitest";
import { type ItxExpression, parseItxExpressionPrefix } from "iterate/expression";
import { codedError } from "iterate/lib";
import type { StreamEventInput } from "iterate/stream/processor";
import type { Caller } from "../caller.ts";
import type { ItxExpressionRewriteRule } from "./itx-expression-rewriting.ts";
import {
  appendAtAttach,
  eventsOfARedial,
  RpcStubDirectory,
  callerOfStampedRequest,
  stampCallerHeaders,
  unsetByClose,
  type UnsetByClose,
} from "./rpc-stubs.ts";

const LEND: ItxExpression = ["itx", "builtins", "rpcStubs", ["get", "itx.bridge"]];
const ELSEWHERE: ItxExpression = ["itx", "config", "bridge"];
const RULE: StreamEventInput = {
  type: "events.iterate.com/itx/rewrite-rule-configured",
  payload: { match: "itx.bridge", target: LEND, description: "a bridge" },
};
const ROUTE: StreamEventInput = {
  type: "events.iterate.com/itx/fetch-route-configured",
  payload: { fetchRouteName: "bridge", target: LEND },
};
const HEARS: StreamEventInput = {
  type: "events.iterate.com/itx/subscription-configured",
  payload: { name: "bridge-hears", target: LEND },
};
const ALL = [RULE, ROUTE, HEARS];
/** The close un-set all three rows of the lend. */
const UNSET = { rules: ["itx.bridge"], subscriptions: ["bridge-hears"], fetchRoutes: ["bridge"] };
const NOTHING = unsetByClose(undefined);

test.for([
  { when: "the context un-set each row at the close", now: {}, unset: UNSET, sets: ALL },
  {
    when: "each row is still this lend's",
    now: { rule: LEND, route: LEND, hears: LEND },
    unset: NOTHING,
    sets: ALL,
  },
  {
    when: "someone pointed the name elsewhere",
    now: { rule: ELSEWHERE, route: LEND, hears: LEND },
    unset: UNSET,
    sets: [ROUTE, HEARS],
  },
  {
    when: "someone masked the name",
    now: { rule: null, route: LEND, hears: LEND },
    unset: UNSET,
    sets: [ROUTE, HEARS],
  },
  // no row, and the context has no record that it un-set one: somebody removed it
  { when: "someone removed every row", now: {}, unset: NOTHING, sets: [] },
  {
    when: "someone removed the route and the subscription, and the close un-set the rule",
    now: {},
    unset: { ...NOTHING, rules: ["itx.bridge"] },
    sets: [RULE],
  },
  {
    when: "someone gave the route and the subscription another target",
    now: { rule: LEND, route: ELSEWHERE, hears: ELSEWHERE },
    unset: UNSET,
    sets: [RULE],
  },
  {
    when: "the record is another name's, and someone removed this lend's rows",
    now: {},
    unset: { rules: ["itx.other"], subscriptions: ["other"], fetchRoutes: ["other"] },
    sets: [],
  },
])("a redial sets a row again only where it is still its own: $when", ({ now, unset, sets }) => {
  expect(eventsOfARedial(ALL, rows(now), unset)).toEqual(sets);
});

test("a record from before it held more than rules is read as rules alone", () => {
  expect(unsetByClose(["itx.bridge"])).toEqual({
    rules: ["itx.bridge"],
    subscriptions: [],
    fetchRoutes: [],
  });
});

test("an attach that the stream refuses leaves the record of the close, and the redial after it sets the rows again", () => {
  // the close un-set the lend's rows: nothing holds their names, and the record names them
  let record: UnsetByClose | undefined = UNSET;
  const appended: StreamEventInput[][] = [];
  let refuses = true;
  const attach = () =>
    appendAtAttach({
      events: ALL,
      redial: true,
      rows: rows({}),
      record: { read: () => record, end: () => void (record = undefined) },
      append: (events) => {
        if (refuses) throw new Error("the stream is paused");
        appended.push(events);
      },
    });
  expect(attach).toThrow("the stream is paused");
  expect({ record, appended }).toEqual({ record: UNSET, appended: [] });
  refuses = false;
  attach();
  expect({ record, appended }).toEqual({ record: undefined, appended: [ALL] });
});

test("a first dial appends its events as they are and ends an older record", () => {
  let record: UnsetByClose | undefined = { ...NOTHING, rules: ["itx.other"] };
  const appended: StreamEventInput[][] = [];
  appendAtAttach({
    events: [RULE, ROUTE],
    redial: false,
    rows: rows({ rule: ELSEWHERE }),
    record: { read: () => record, end: () => void (record = undefined) },
    append: (events) => void appended.push(events),
  });
  expect({ record, appended }).toEqual({ record: undefined, appended: [[RULE, ROUTE]] });
});

test.for([
  { lender: "a member's sign-in", lentBy: "grant:member" },
  { lender: "another key", lentBy: "key:k2" },
])(
  "a first dial that takes the name only from itself is refused where $lender lends the name, and changes nothing",
  ({ lentBy }) => {
    const attach = attachOnlyFromKeyOne({ rows: rows({ rule: LEND, lentBy }) });
    expect(attach.run).toThrow(
      expect.objectContaining({
        code: "FORBIDDEN",
        message:
          "itx.bridge is lent by another lender, and this lend takes the name only from itself: stop that lend, then lend again",
      }),
    );
    expect(attach.state()).toEqual({ record: UNSET, appended: [] });
  },
);

test.for([
  { when: "the key itself lends the name", now: { rule: LEND, lentBy: "key:k1" } },
  { when: "the name's lend records no lender", now: { rule: LEND } },
  { when: "no row holds the name", now: {} },
  {
    when: "the row at the name is no lend of it",
    now: { rule: ELSEWHERE, lentBy: "grant:member" },
  },
])("a first dial that takes the name only from itself appends where $when", ({ now }) => {
  const attach = attachOnlyFromKeyOne({ rows: rows(now) });
  attach.run();
  expect(attach.state()).toEqual({ record: undefined, appended: [ALL] });
});

test("a redial is not refused where another lender's row holds the name", () => {
  const attach = attachOnlyFromKeyOne({
    redial: true,
    rows: rows({ rule: LEND, lentBy: "grant:member", route: LEND, hears: LEND }),
  });
  attach.run();
  expect(attach.state()).toEqual({ record: undefined, appended: [ALL] });
});

test("a lend that takes the name from anyone (a member's) takes it from another lender", () => {
  let record: UnsetByClose | undefined = UNSET;
  const appended: StreamEventInput[][] = [];
  appendAtAttach({
    events: ALL,
    redial: false,
    rows: rows({ rule: LEND, lentBy: "key:k1" }),
    record: { read: () => record, end: () => void (record = undefined) },
    append: (events) => void appended.push(events),
  });
  expect({ record, appended }).toEqual({ record: undefined, appended: [ALL] });
});

test("a hop names its own caller on a request, over every caller that the request named itself", () => {
  const carried = {
    "x-itx-principal": JSON.stringify({ actor: "user_2" }),
    "x-itx-mind": JSON.stringify({ actor: "cd".repeat(32), kind: "mind", hostname: "a.example" }),
    "x-itx-grant": "grant_2",
    "x-itx-person": JSON.stringify({ userId: "user_2", email: "b@example.net" }),
    "x-itx-expires": "2000000000",
    "x-itx-caller-path": "/elsewhere",
    "x-itx-app": "1",
    // a mind's signed statement that code wrote goes on from no hop
    "iterate-auth-statement": "a statement code wrote",
    accept: "*/*",
  };
  const nobody = new Headers(carried);
  stampCallerHeaders(nobody, null);
  const person = { userId: "user_1", email: "a@example.com", name: "a", method: "email" as const };
  const visitor = new Headers(carried);
  stampCallerHeaders(visitor, { principal: null, app: true, person });
  expect({ nobody: Object.fromEntries(nobody), visitor: Object.fromEntries(visitor) }).toEqual({
    nobody: { accept: "*/*" },
    visitor: { accept: "*/*", "x-itx-app": "1", "x-itx-person": JSON.stringify(person) },
  });
});

// The request that a mind's code gets names another mind that asks in `x-itx-principal`, so the
// code can decide by its id; never beside a member, and never with a grant.
test("a hop names another mind that asks in x-itx-mind, with no grant, and a member over it", () => {
  const mind = { actor: "ab".repeat(32), kind: "mind" as const, hostname: "iterate.peer.example" };
  const member = { actor: "user_1", email: "a@example.com" };
  const byMind = new Headers({ "x-itx-grant": "grant_forged" });
  stampCallerHeaders(byMind, { principal: null, mind, grant: "grant_1" });
  const both = new Headers();
  stampCallerHeaders(both, { principal: member, mind, grant: "grant_1" });
  expect({ byMind: Object.fromEntries(byMind), both: Object.fromEntries(both) }).toEqual({
    byMind: { "x-itx-mind": JSON.stringify(mind) },
    both: { "x-itx-principal": JSON.stringify(member), "x-itx-grant": "grant_1" },
  });
});

// A grant rides a caller with no principal (a key's session, whose lend names no member) as it
// rides a member; beside a mind it is never written.
test("a hop writes a grant with no principal, and no grant beside a mind", () => {
  const mind = { actor: "ab".repeat(32), kind: "mind" as const, hostname: "iterate.peer.example" };
  const byKey = new Headers();
  stampCallerHeaders(byKey, { principal: null, grant: "key:x" });
  const byMind = new Headers();
  stampCallerHeaders(byMind, { principal: null, mind, grant: "key:x" });
  expect({ byKey: Object.fromEntries(byKey), byMind: Object.fromEntries(byMind) }).toEqual({
    byKey: { "x-itx-grant": "key:x" },
    byMind: { "x-itx-mind": JSON.stringify(mind) },
  });
});

// The context's expression fetch reads back what a hop stamped: another mind comes back as `mind`,
// never as the principal, and with no grant; a member comes back as the principal.
test("a context's expression fetch reads another mind that a hop stamped as mind, never as the principal", () => {
  const mind = { actor: "ab".repeat(32), kind: "mind" as const, hostname: "iterate.peer.example" };
  const readBack = (caller: Caller) => {
    const headers = new Headers();
    stampCallerHeaders(headers, caller);
    const request = new Request("https://context.example/", { headers });
    const { principal, mind, grant } = callerOfStampedRequest(request, headers, false);
    return { principal, mind, grant };
  };
  expect([
    readBack({ principal: null, mind, grant: "grant_1" }),
    readBack({ principal: { actor: "user_1" }, grant: "grant_1" }),
  ]).toEqual([
    { principal: null, mind, grant: undefined },
    { principal: { actor: "user_1" }, mind: undefined, grant: "grant_1" },
  ]);
});

// The expression fetch reads as ingress does: a grant or a person beside a mind is a defect there
// too, though no hop of the kernel writes one (`stampCallerHeaders` drops the grant).
test.for([
  {
    beside: "a grant",
    header: "x-itx-grant",
    value: "grant_1",
    refusal: /grant is stamped beside a mind/,
  },
  {
    beside: "a person",
    header: "x-itx-person",
    value: JSON.stringify({ userId: "user_1", email: "a@example.com", name: "a", method: "email" }),
    refusal: /person is stamped beside a mind/,
  },
])("a context's expression fetch refuses $beside beside a mind", ({ header, value, refusal }) => {
  const mind = { actor: "ab".repeat(32), kind: "mind", hostname: "iterate.peer.example" };
  const headers = new Headers({ "x-itx-mind": JSON.stringify(mind), [header]: value });
  const request = new Request("https://context.example/", { headers });
  expect(() => callerOfStampedRequest(request, headers, false)).toThrow(refusal);
});

const member = { actor: "user_1", email: "a@example.com" };
const person = { actor: "user_2", email: "b@example.com" };

test.for([
  {
    name: "a member's stamp",
    lenderStamp: { principal: member, grant: "grant:1", via: { appPage: "chat.example.com" } },
    attached: { principal: member, grant: "grant:1", via: { appPage: "chat.example.com" } },
  },
  {
    name: "a person's stamp beside the unnamed caller",
    lenderStamp: { principal: null, onBehalfOf: { principal: person } },
    attached: { principal: null, onBehalfOf: { principal: person } },
  },
  {
    name: "a person's stamp with the name to show",
    lenderStamp: { principal: null, onBehalfOf: { principal: { ...person, name: "Bob" } } },
    attached: { principal: null, onBehalfOf: { principal: { ...person, name: "Bob" } } },
  },
  {
    name: "a stamp with what gives a caller power",
    lenderStamp: {
      principal: member,
      platform: true,
      app: true,
      config: true,
      signer: { principal: member, key: "k1" },
      approvedAct: "itx.secrets.get('x')",
      runsRow: true,
      path: "/",
      delivery: "aaaaabbbbbccccc111112222233333aaaaabbbbb",
    },
    attached: { principal: member },
  },
])("an attach hands on $name, and only who it names", ({ lenderStamp, attached }) => {
  // `toEqual`: a key that gives power must not survive
  expect(lendOfAttach({ rpcStubKey: "k", appendEvents: [], lenderStamp })).toEqual({
    rpcStubKey: "k",
    redial: false,
    lenderStamp: attached,
  });
});

// A lender's session from before the stamp sends none.
test("an attach with no stamp stamps nobody", () => {
  // `toEqual`: a key that holds undefined is no stamp
  expect(lendOfAttach({ rpcStubKey: "k", appendEvents: [] })).toEqual({
    rpcStubKey: "k",
    redial: false,
  });
});

// Only the kernel writes the header: a stamp that does not parse is a defect, and is never taken
// for an absent one.
test.for([
  { name: "a stamp that is no object", lenderStamp: "user_1" },
  { name: "a stamp that is null", lenderStamp: null },
  { name: "a stamp with no principal field", lenderStamp: { grant: "grant:1" } },
  { name: "a principal with no actor", lenderStamp: { principal: { email: "a@example.com" } } },
  { name: "an actor that is no string", lenderStamp: { principal: { actor: 7 } } },
  { name: "a grant that is no string", lenderStamp: { principal: member, grant: 7 } },
  { name: "a via with no page", lenderStamp: { principal: member, via: {} } },
  {
    name: "an onBehalfOf with no principal",
    lenderStamp: { principal: null, onBehalfOf: { via: { appPage: "chat.example.com" } } },
  },
])("an attach with $name is refused with 400, and appends nothing", async ({ lenderStamp }) => {
  const { answer, lends } = attach({ rpcStubKey: "k", appendEvents: [], lenderStamp });
  expect({ status: answer?.status, lends }).toEqual({ status: 400, lends: [] });
  expect(await answer?.text()).toContain("malformed x-itx-rpc-stub-pager header: a lenderStamp");
});

// The attach stamps what it appends with who lends, and a reader trusts that stamp by the
// event's type: so it appends its lend's own rows, and nothing else.
test.for<{ name: string; rpcStubKey: string; event: StreamEventInput }>([
  {
    name: "a run's request",
    rpcStubKey: "itx.bridge",
    event: { type: "events.iterate.com/itx/run-requested", payload: { script: "itx.secrets" } },
  },
  {
    name: "a message to an agent",
    rpcStubKey: "itx.bridge",
    event: { type: "events.iterate.com/agent/message-received", payload: { message: "hi" } },
  },
  {
    name: "a rule at another name",
    rpcStubKey: "itx.bridge",
    event: {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.secrets", target: LEND },
    },
  },
  {
    name: "a rule at the key with another target",
    rpcStubKey: "itx.bridge",
    event: {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.bridge", target: ELSEWHERE },
    },
  },
  {
    name: "a subscription under another name",
    rpcStubKey: "subscription:sub-1",
    event: {
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "sub-2",
        target: ["itx", "builtins", "rpcStubs", ["get", "subscription:sub-1"]],
      },
    },
  },
  {
    name: "a subscription with an expression target",
    rpcStubKey: "subscription:sub-1",
    event: {
      type: "events.iterate.com/itx/subscription-configured",
      payload: { name: "sub-1", target: ["itx", ["cd", "/"], ["append"]] },
    },
  },
  {
    name: "a fetch route to another target",
    rpcStubKey: "itx.bridge",
    event: {
      type: "events.iterate.com/itx/fetch-route-configured",
      payload: { fetchRouteName: "bridge", target: ELSEWHERE },
    },
  },
])(
  "an attach that would append $name is refused with 400, and appends nothing",
  async ({ rpcStubKey, event }) => {
    const { answer, lends } = attach({
      rpcStubKey,
      appendEvents: [event],
      lenderStamp: { principal: member },
    });
    expect({ status: answer?.status, lends }).toEqual({ status: 400, lends: [] });
    expect(await answer?.text()).toContain("no row of the lend");
  },
);

test("an attach appends its lend's own rows: the rule, the route to its name, the subscription", () => {
  const provide = [
    RULE,
    {
      type: "events.iterate.com/itx/fetch-route-configured",
      payload: { fetchRouteName: "bridge", target: ["itx", "bridge"] },
    },
  ];
  const subscribe = [
    {
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "sub-1",
        target: ["itx", "builtins", "rpcStubs", ["get", "subscription:sub-1"]],
      },
    },
  ];
  expect(attach({ rpcStubKey: "itx.bridge", appendEvents: provide })).toMatchObject({
    appended: [provide],
  });
  expect(attach({ rpcStubKey: "subscription:sub-1", appendEvents: subscribe })).toMatchObject({
    appended: [subscribe],
  });
});

test("a redial hands on the same stamp as the first dial", () => {
  const lenderStamp = { principal: member, grant: "grant:1" };
  expect(lendOfAttach({ rpcStubKey: "k", appendEvents: [], redial: true, lenderStamp })).toEqual({
    rpcStubKey: "k",
    redial: true,
    lenderStamp,
  });
});

/** An attach of all three rows by the key `key:k1`, which takes the name only from itself. */
function attachOnlyFromKeyOne(input: { rows: ReturnType<typeof rows>; redial?: boolean }) {
  let record: UnsetByClose | undefined = UNSET;
  const appended: StreamEventInput[][] = [];
  const run = () =>
    appendAtAttach({
      events: ALL,
      redial: input.redial === true,
      onlyFrom: "key:k1",
      rows: input.rows,
      record: { read: () => record, end: () => void (record = undefined) },
      append: (events) => void appended.push(events),
    });
  return { run, state: () => ({ record, appended }) };
}

/** A context's rows: the rule at `itx.bridge` (null: a mask) with its lender, the fetch route
 *  `bridge` and the subscription `bridge-hears`, each only when given. */
function rows(now: {
  rule?: ItxExpressionRewriteRule["target"];
  lentBy?: string;
  route?: ItxExpression;
  hears?: ItxExpression;
}) {
  const fetchRouteTargets: Record<string, ItxExpression> = now.route ? { bridge: now.route } : {};
  const subscriptionTargets: Record<string, ItxExpression> = now.hears
    ? { "bridge-hears": now.hears }
    : {};
  return {
    rules:
      "rule" in now
        ? [
            {
              match: parseItxExpressionPrefix("itx.bridge"),
              target: now.rule!,
              lentBy: now.lentBy,
            },
          ]
        : [],
    fetchRouteTargets,
    subscriptionTargets,
  };
}

/** What the context's directory hands its append for one pager dial with `request` in the header.
 *  The append refuses after it looked, so the attach answers 409: Node's Response has no 101. */
function lendOfAttach(request: Record<string, unknown>) {
  const { answer, lends } = attach(request);
  expect(answer).toMatchObject({ status: 409 });
  return lends[0];
}

/** One pager dial with `request` in the header: the directory's answer, each lend it handed its
 *  append, and the events of each. */
function attach(request: Record<string, unknown>) {
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = {};
      1 = { serializeAttachment: () => {}, close: () => {} };
    },
  );
  const lends: unknown[] = [];
  const appended: StreamEventInput[][] = [];
  const directory = new RpcStubDirectory({
    ctx: { acceptWebSocket: () => {}, getWebSockets: () => [] },
    onPresence: () => {},
    // only its type is read here: no stub is fetched through
    rpcStubFetch: {} as ConstructorParameters<typeof RpcStubDirectory>[0]["rpcStubFetch"],
    appendEvents: (events, lend) => {
      lends.push(lend);
      appended.push(events);
      throw codedError("STREAM_PAUSED", "the test reads the lend alone");
    },
  });
  const answer = directory.acceptRpcStubPagerWebSocket(
    new Request("https://rpc-stub-pager.internal/", {
      headers: { "x-itx-rpc-stub-pager": encodeURIComponent(JSON.stringify(request)) },
    }),
  );
  return { answer, lends, appended };
}
