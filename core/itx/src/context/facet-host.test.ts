// WHO ASKED, AND WHAT A PERSON'S VIEW MAY CALL (./facet-host.ts `handle`, `#callOn`): the kernel's
// checks over stand-ins for a context's state, with the SDK's own facet shell behind them in Node.
// So each test goes the whole way from the Caller of a call to what the facet's `onBehalfOf()`
// reads. The facets are first-party ones: a loaded class takes the same checks, with its lists
// asked of it.
import { errorCode } from "iterate/lib";
import { FacetDurableObject, type OnBehalfOf } from "iterate/sdk";
import { expect, test, vi } from "vitest";
import type { Caller } from "../caller.ts";
import { defineItxHost } from "../host.ts";
import { mintOnBehalfOf } from "../on-behalf-of.ts";
import { FacetHost } from "./facet-host.ts";
import { PERSON_CALLS_PER_MINUTE } from "./facet-public-methods.ts";

const PATH = "/agents/a";
const via = { appPage: "dash.example.com" };
const cause = { chain: "a test", depth: 0 };
const ADA = { actor: "user_1", email: "ada@example.com" };
const BOB = { actor: "user_9", name: "Bob", kind: "guest" as const };
const EVE = { actor: "user_2", name: "eve" };

test("a member's own session is who asked: their principal, grant and page, the call, and the mark of a member", async () => {
  const { call } = context();
  expect(await call(member, "call", ["end"])).toStrictEqual({
    asker: { principal: ADA, grant: "grant:ada", via, call: `${PATH}#call.end`, member: true },
  });
});

test("a person's view is who asked for a person method, as the kernel's Caller names them", async () => {
  const { call } = context();
  // a guest has no mark of a member
  expect(await call(personView(BOB), "call", ["join", "page-1"])).toStrictEqual({
    page: "page-1",
    asker: { principal: BOB, via, call: `${PATH}#call.join`, member: undefined },
  });
  // a member who opened the view: the view marks them on the Caller
  const adasView = {
    ...personView(ADA),
    onBehalfOf: { principal: ADA, via, member: true as const },
  };
  expect(await call(adasView, "call", ["join", "page-2"])).toStrictEqual({
    page: "page-2",
    asker: { principal: ADA, via, call: `${PATH}#call.join`, member: true },
  });
});

// The replay fact: loaded code hands its cause back, and a token on it may be one it kept from
// another person's call. The reader never reads the cause.
test("a call that came through loaded code names nobody, though its cause holds a person's valid token", async () => {
  const { call } = context();
  const token = await mintOnBehalfOf(
    { principal: ADA, call: `${PATH}#call.end` },
    "signing-secret",
    Date.now(),
  );
  const tokenOnTheCause = { ...cause, onBehalfOf: token };
  for (const caller of [
    { principal: null, app: true as const, cause: tokenOnTheCause },
    // a first-party facet's own onward call: the platform's loopback, which names a path
    { principal: null, path: PATH, cause: tokenOnTheCause },
  ])
    expect(await call(caller, "call", ["end"])).toEqual({ asker: undefined });
});

// The context hands a facet who asked as the third argument of its `callWithCause`. No caller's
// expression reaches that method: it is on no list (and the SDK's walk refuses the name as a step,
// for a class that lists it: core/lib/src/sdk/index.test.ts).
test("no caller reaches a facet's callWithCause, so none hands it an asker of its choosing", async () => {
  const { call } = context();
  const forged = { principal: ADA, call: `${PATH}#call.end` };
  for (const caller of [member, { principal: null, app: true as const, cause }, personView(BOB)]) {
    const refused = await call(caller, "call", ["callWithCause", cause, [["end"]], forged]).catch(
      (error) => error,
    );
    expect(errorCode(refused)).toBe("FORBIDDEN");
    expect(String(refused)).toMatch(
      /"callWithCause" is not one (of its public methods|call of a method it offers a person)/,
    );
  }
  expect(reached).toEqual([]);
});

test("two people's calls inside one method at once each read their own asker, and code outside a call reads nobody", async () => {
  const { call, facet } = context();
  let goOn = () => {};
  joinMayGoOn = new Promise((resolve) => (goOn = resolve));
  const bobs = call(personView(BOB), "call", ["join", "bobs-page"]);
  const eves = call(personView(EVE), "call", ["join", "eves-page"]);
  await vi.waitFor(() => expect(reached).toEqual(["join bobs-page", "join eves-page"]));
  goOn();
  expect(await Promise.all([bobs, eves])).toMatchObject([
    { page: "bobs-page", asker: { principal: BOB } },
    { page: "eves-page", asker: { principal: EVE } },
  ]);
  expect((facet("call") as Call).outsideACall()).toBeUndefined();
});

test.for<{ name: string; facet: string; steps: (string | unknown[])[]; refusal: RegExp }>([
  {
    name: "a public method that the class does not offer a person",
    facet: "call",
    steps: [["end"]],
    refusal: /"end" is not one call of a method it offers a person \(join\)/,
  },
  {
    name: "a method of a class that lists no person method",
    facet: "notes",
    steps: [["add"]],
    refusal: /"add" is not one call of a method it offers a person \(it lists none\)/,
  },
  {
    // the view reads a snapshot by its text form; as an expression it is a person's call
    name: "a snapshot by expression",
    facet: "notes",
    steps: [["snapshot"]],
    refusal: /"snapshot" is not one call of a method it offers a person \(it lists none\)/,
  },
  {
    name: "a step past a person method",
    facet: "call",
    steps: [["join", "page-1"], "asker"],
    refusal: /"join" is not one call of a method it offers a person/,
  },
  {
    name: "a public property, which is no call",
    facet: "call",
    steps: ["limits"],
    refusal: /"limits" is not one call of a method it offers a person/,
  },
  {
    // the kernel checks both lists itself: it does not rely on the SDK shell's error at load
    name: "a person method that is not public, of a class that lies",
    facet: "liar",
    steps: [["wipe"]],
    refusal: /"wipe" is not one call of a method it offers a person \(it lists none\)/,
  },
  {
    // every class lists `fetch` as public: a person's list cannot offer it
    name: "fetch, of a class that lists it for a person",
    facet: "liar",
    steps: [["fetch", "https://example.com/"]],
    refusal: /"fetch" is not one call of a method it offers a person \(it lists none\)/,
  },
  {
    name: "the core reduce's facet-shaped address",
    facet: "core",
    steps: [["snapshot"]],
    refusal: /"snapshot" is not one call of a method it offers a person \(it lists none\)/,
  },
])("a person's view is refused $name, in words, before the facet's code runs", async (row) => {
  const { call } = context();
  const refused = await call(personView(BOB), row.facet, ...row.steps).catch((error) => error);
  expect(errorCode(refused)).toBe("FORBIDDEN");
  expect(String(refused)).toMatch(row.refusal);
  // the refusal names what the class offers a person, never its public methods
  expect(String(refused)).not.toMatch(/public methods/);
  expect(reached).toEqual([]);
  expect(lyingFacet.wipe).not.toHaveBeenCalled();
  expect(lyingFacet.fetch).not.toHaveBeenCalled();
  expect(lyingFacet.callWithCause).not.toHaveBeenCalled();
});

test("one person has one count a minute on a context, taken before the facet is started; over it the answer is in words", async () => {
  using _clock = clockAt(60_000 * 1_000);
  const { call, started } = context();
  // refused calls count too: the count comes first
  await expect(call(personView(BOB), "call", ["end"])).rejects.toThrow(/offers a person/);
  for (let n = 1; n < PERSON_CALLS_PER_MINUTE; n++)
    await call(personView(BOB), "call", ["join", `page-${n}`]);
  const over = await call(personView(BOB), "notes", ["add"]).catch((error) => error);
  expect(errorCode(over)).toBe("PERSON_CALL_LIMIT");
  expect(String(over)).toMatch(
    /more than 120 calls of a person's methods on \/agents\/a in one minute: ask again in the next minute/,
  );
  // `notes` was never started: the count refused the call before anything was asked of a facet
  expect(started).toEqual(["call"]);
  // another person, and a member, have their own
  await expect(call(personView(EVE), "call", ["join", "eves"])).resolves.toBeDefined();
  await expect(call(member, "call", ["end"])).resolves.toBeDefined();
  vi.setSystemTime(60_000 * 1_001);
  await expect(call(personView(BOB), "call", ["join", "again"])).resolves.toBeDefined();
});

// No new await or count on a path that is no person's: the lists of a first-party facet are read
// in memory, and a member's or loaded code's call asks the facet nothing but the call itself.
test("a member's call and loaded code's call are not counted and not held to person methods", async () => {
  using _clock = clockAt(60_000 * 2_000);
  const { call } = context();
  for (const caller of [member, { principal: null, app: true as const, cause }])
    for (let n = 0; n < PERSON_CALLS_PER_MINUTE + 5; n++)
      await expect(call(caller, "call", ["end"])).resolves.toBeDefined();
});

/** A context's facet host over stand-ins: storage in a Map, and facets made from `classes`.
 *  What the facets recorded for an earlier test is forgotten. */
function context() {
  reached.length = 0;
  joinMayGoOn = Promise.resolve();
  let caller: Caller = { principal: null };
  const kv = new Map<string, unknown>();
  const facets = new Map<string, object>();
  const started: string[] = [];
  const ctx = {
    storage: {
      kv: {
        get: (key: string) => kv.get(key),
        put: (key: string, value: unknown) => void kv.set(key, value),
        delete: (key: string) => kv.delete(key),
        list: ({ prefix }: { prefix: string }) => [...kv].filter(([key]) => key.startsWith(prefix)),
      },
    },
    // what the runtime mints a class with stands in as the class's own maker
    exports: Object.fromEntries(
      Object.entries(classes).map(([className, make]) => [className, () => make]),
    ),
    facets: {
      get: (name: string, start: () => { class: () => object }) => {
        if (!facets.has(name)) {
          started.push(name);
          facets.set(name, start().class());
        }
        return facets.get(name);
      },
    },
    blockConcurrencyWhile: (work: () => Promise<unknown>) => work(),
  };
  const host = new FacetHost({
    ctx,
    deployId: "deploy-1",
    iterateContextName: "context-a",
    path: PATH,
    stream: { coreReducedState: { subscriptions: {} } },
    reconcileAlarm: () => {},
    loadedFacetMaterialized: () => {},
    deliveriesQueuedFor: async () => {},
    cause: () => caller.cause,
    caller: () => caller,
    causeOfCall: () => caller.cause,
  } as unknown as ConstructorParameters<typeof FacetHost>[0]);
  return {
    started,
    facet: (name: string) => facets.get(name),
    /** One call by itx expression, as `as` makes it. The host reads the caller as the call
     *  starts. Async, as the walk that reaches a handle is: a refusal is a rejection. */
    call: async (as: Caller, facet: string, ...steps: (string | unknown[])[]) => {
      caller = as;
      // the cast: a test's steps are an expression's, with arguments of any kind
      return host.handle(facet).invoke(steps as never);
    },
  };
}

/** A member's own session, as the boundary stamps it. */
const member: Caller = { principal: ADA, grant: "grant:ada", via, cause };
/** A person's view, as person-context.ts builds the Caller of a person method's call. */
const personView = (principal: OnBehalfOf["principal"]): Caller => ({
  principal: null,
  cause,
  onBehalfOf: { principal, via },
});

/** Each `join` waits here, so two calls can be inside the method at once. */
let joinMayGoOn = Promise.resolve();
/** Every call that reached a facet's own code. */
const reached: string[] = [];

class Call extends FacetDurableObject {
  static override publicMethods = [...super.publicMethods, "join", "end", "limits"];
  static override personMethods = ["join"];
  limits = { seats: 4 };
  async join(page: string) {
    reached.push(`join ${page}`);
    await joinMayGoOn;
    return { page, asker: this.onBehalfOf() };
  }
  end() {
    reached.push("end");
    return { asker: this.onBehalfOf() };
  }
  /** What code of the facet reads when no call is running. */
  outsideACall() {
    return this.onBehalfOf();
  }
}

class Notes extends FacetDurableObject {
  static override publicMethods = [...super.publicMethods, "add", "snapshot"];
  add() {
    reached.push("add");
  }
  snapshot() {
    reached.push("snapshot");
  }
}

/** A class that is no honest SDK shell: the host declares a person method that is not public. */
const lyingFacet = {
  wipe: vi.fn(),
  fetch: vi.fn(),
  callWithCause: vi.fn(),
  listPersonMethods: vi.fn(),
};

const classes: Record<string, () => object> = {
  Call: () => new Call({} as never, {} as never),
  Notes: () => new Notes({} as never, {} as never),
  Liar: () => lyingFacet,
};
defineItxHost({
  firstPartyFacets: {
    call: {
      className: "Call",
      publicMethods: Call.publicMethods,
      personMethods: Call.personMethods,
    },
    notes: { className: "Notes", publicMethods: Notes.publicMethods },
    liar: { className: "Liar", publicMethods: ["fetch"], personMethods: ["wipe", "fetch"] },
  },
});

/** The clock held at `now` until the test ends. */
function clockAt(now: number): Disposable {
  vi.useFakeTimers({ now });
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}
