// sdk/index.test.ts — `IterateConfigEntrypoint` in Node, on the `cloudflare:workers` shim's base class.
import { expect, test, vi } from "vitest";
import { codedError } from "../lib.ts";
import type { StreamEvent, StreamEventInput } from "../stream/processor.ts";
import {
  FacetDurableObject,
  IterateConfigEntrypoint,
  type IterateConfigProcessEventArgs,
  type OnBehalfOf,
} from "./index.ts";

const event = {
  type: "events.iterate.com/test/ping-sent",
  path: "/child",
  offset: 7,
  createdAt: "2026-09-28T00:00:00.000Z",
  source: { origin: "test" },
} as StreamEvent;

test("deliverEvent hands processEvent the event and the root in one round trip, releasing every call the handler made once it settles, even when it throws", async () => {
  const log: string[] = [];
  const handled: string[] = [];
  const entrypoint = configEntrypoint(log, async ({ event, itx }) => {
    handled.push(`${event.path}@${event.offset}`);
    await itx.cd(event.path).append({ type: "events.iterate.com/test/pong-sent" });
    expect(log).toEqual(["get", `cd(${event.path}).append`]); // nothing released mid-handler
    throw new Error("the handler failed");
  });
  await expect(entrypoint.deliverEvent(event)).rejects.toThrow("the handler failed");
  expect(handled).toEqual(["/child@7"]);
  expect(log).toEqual([
    "get",
    "cd(/child).append",
    "dispose cd(/child).append",
    "dispose cd(/child)",
    "dispose root",
  ]);
});

test("a config that lacks the three abstract methods, as the loader never type-checks: an event is taken as handled without opening its context, each request gets a page that says so, and a mail answers missing", async () => {
  // the casts: the type system refuses such a class, and the loader is what lets one through
  abstract class Lacking extends IterateConfigEntrypoint {}
  const log: string[] = [];
  const entrypoint = new (Lacking as unknown as new (ctx: never, env: never) => Lacking)(
    {} as never,
    {} as never,
  );
  const ITX = {
    get: () => {
      log.push("get");
      return {};
    },
  };
  Object.assign(entrypoint, { env: { ITX } });
  await entrypoint.deliverEvent(event);
  expect(log).toEqual([]);
  const page = await entrypoint.fetch(new Request("https://mind.example/"));
  expect({ status: page.status, text: await page.text() }).toEqual({
    status: 501,
    text: "This mind's config has no fetch method, so it serves no page.\n",
  });
});

test("an event another mind signed reaches processMindEvent alone, with that mind's domain", async () => {
  const seen: string[] = [];
  const entrypoint = new (class extends IterateConfigEntrypoint {
    override processEvent({ event }: IterateConfigProcessEventArgs) {
      seen.push(`processEvent ${event.path}`);
    }
    override async email() {}
    override fetch() {
      return new Response("Not found\n", { status: 404 });
    }
    override processMindEvent({ event, mind }: IterateConfigProcessEventArgs & { mind: string }) {
      seen.push(`processMindEvent ${mind} ${event.path}`);
    }
  })({} as never, {} as never);
  Object.assign(entrypoint, { env: { ITX: { get: () => ({ [Symbol.dispose]: () => {} }) } } });
  const signedBy = (principal: { actor: string; kind?: "mind" }) =>
    ({ ...event, source: { origin: "x", signer: { principal, key: "k" } } }) as StreamEvent;
  await entrypoint.deliverEvent(signedBy({ actor: "peer.net", kind: "mind" }));
  await entrypoint.deliverEvent(signedBy({ actor: "bridge" }));
  expect(seen).toEqual(["processMindEvent peer.net /child", "processEvent /child"]);
});

test("`using itx = this.getItx()` releases the scope and every call made through it as its block ends", async () => {
  const log: string[] = [];
  await configEntrypoint(log).appendThroughGetItx("/child");
  expect(log).toEqual([
    "get",
    "cd(/child).append",
    "dispose cd(/child).append",
    "dispose cd(/child)",
    "dispose root",
  ]);
});

test("callWithCause refuses getItx: no caller gets the scope", async () => {
  await expect(configEntrypoint([]).callWithCause(undefined, [["getItx"]])).rejects.toMatchObject({
    code: "NOT_A_METHOD",
  });
});

test("callerPath() names the context the platform handed callWithCause, for that call alone, and is unknown outside one", async () => {
  const entrypoint = configEntrypoint([]);
  const [child, root] = await Promise.all([
    entrypoint.callWithCause(undefined, [["whoAsked"]], "/child"),
    entrypoint.callWithCause(undefined, [["whoAsked"]], "/"),
  ]);
  expect({ child, root }).toEqual({ child: "/child", root: "/" });
  await expect(entrypoint.whoAsked()).rejects.toThrow(/only inside a method the platform called/);
  await expect(entrypoint.callWithCause(undefined, [["whoAsked"]])).rejects.toThrow(
    /only inside a method the platform called/,
  );
});

test("onBehalfOf() answers who the platform named for the call, for that call alone, and nobody outside one", async () => {
  const call = facet(Call);
  const asked = (actor: string): OnBehalfOf => ({ principal: { actor }, call: "/a#call.join" });
  const [ada, bob, nobody] = await Promise.all([
    call.callWithCause(undefined, [["join"]], asked("user_1")),
    call.callWithCause(undefined, [["join"]], asked("user_9")),
    call.callWithCause(undefined, [["join"]]),
  ]);
  expect({ ada, bob, nobody }).toEqual({
    ada: asked("user_1"),
    bob: asked("user_9"),
    nobody: undefined,
  });
  expect(await call.join()).toBeUndefined();
  // a step cannot be `callWithCause` itself, with another asker as its third argument
  await expect(
    call.callWithCause(
      undefined,
      [["callWithCause", undefined, [["join"]], asked("user_9")]],
      asked("user_1"),
    ),
  ).rejects.toMatchObject({ code: "NOT_A_METHOD" });
  // the reader is a field: no step of a caller's walk reaches it
  await expect(
    call.callWithCause(undefined, [["onBehalfOf"]], asked("user_1")),
  ).rejects.toMatchObject({ code: "NOT_A_METHOD" });
});

// The asker belongs to the call's async context, which a timer of the call keeps.
test("work that a call started and nobody awaited reads that call's asker after the call ended", async () => {
  const call = facet(Call);
  const asked: OnBehalfOf = { principal: { actor: "user_1" }, call: "/a#call.joinLater" };
  await call.callWithCause(undefined, [["joinLater"]], asked);
  expect(await call.later).toEqual(asked);
  expect(await call.join()).toBeUndefined();
});

test("a person method that is not a public method is an error as the class loads, in words", () => {
  class Mistaken extends FacetDurableObject {
    static override publicMethods = [...super.publicMethods, "join"];
    static override personMethods = ["join", "end", "wipe"];
  }
  expect(() => facet(Mistaken)).toThrow(
    "Mistaken: static personMethods lists end, wipe, which static publicMethods does not list. A person may call only what a member's session may call: list it in both",
  );
  // every class lists `fetch` as public; a person's list may not
  class Fetched extends FacetDurableObject {
    static override personMethods = ["fetch"];
  }
  expect(() => facet(Fetched)).toThrow(
    "Fetched: static personMethods lists fetch. A person's view calls a method, never fetch: a Request names nobody",
  );
  expect(facet(Call).listPersonMethods()).toEqual(["join"]);
  // a class that names none offers a person nothing
  expect(facet(class extends FacetDurableObject {}).listPersonMethods()).toEqual([]);
});

test("a throw of the config's fetch reaches the caller unchanged, and one mind/code-failed on / is appended after the answer, with the request's method and path alone", async () => {
  minute(29_000_000);
  const thrown = new TypeError("the page broke\nsecond line");
  const config = failingConfig((request) => {
    if (new URL(request.url).pathname === "/sync") throw thrown;
    return Promise.reject(new RangeError("later"));
  });
  let release!: () => void;
  config.ready = new Promise<void>((resolve) => (release = resolve));
  const sync = await config.answerOf(
    new Request("https://mind.example/sync?token=abc#x", { headers: { cookie: "a=b" } }),
  );
  const later = await config.answerOf(
    new Request("https://mind.example/later", { method: "POST", body: "secret" }),
  );
  expect(sync).toBe(thrown);
  expect(later).toMatchObject({ name: "RangeError", message: "later" });
  // the answers did not wait for the appends: the runtime's waitUntil holds them
  expect({ held: config.held.length, appended: config.appended.length }).toEqual({
    held: 2,
    appended: 0,
  });
  release();
  await Promise.all(config.held);
  const key = expect.stringMatching(/^code-failed:[0-9a-z]+:29000000$/);
  expect(config.appended.map((event) => [event.type, event.idempotencyKey])).toEqual([
    ["events.iterate.com/mind/code-failed", key],
    ["events.iterate.com/mind/code-failed", key],
  ]);
  // nothing more than these: no header, body, host or query string
  expect(config.appended.map((event) => event.payload)).toEqual([
    {
      where: "fetch",
      method: "GET",
      path: "/sync",
      error: {
        name: "TypeError",
        message: "the page broke\nsecond line",
        stack: expect.any(String),
      },
    },
    {
      where: "fetch",
      method: "POST",
      path: "/later",
      error: { name: "RangeError", message: "later", stack: expect.any(String) },
    },
  ]);
  // a fetch that answers records nothing
  const answered = failingConfig(() => new Response("ok"));
  const page = await answered.entrypoint.fetch(new Request("https://mind.example/"));
  expect({ text: await page.text(), held: answered.held }).toEqual({ text: "ok", held: [] });
});

test("the fact is scrubbed before its first append: a URL keeps its path alone, a token is cut, and a new token is no new kind of error", async () => {
  minute(29_000_005);
  const config = failingConfig((request) => {
    const n = new URL(request.url).searchParams.get("n");
    const error = new Error(
      `GET https://api.example/a/b?token=SECRET${n} failed, Bearer abc.${n}, Cookie: a=b; sid=s${n}`,
    );
    error.stack = `Error: x\n    at f (https://blog.example.com/app.js?key=SECRET${n}:12:34)`;
    throw error;
  });
  const token = "AbCd".repeat(5);
  await config.answerOf(new Request(`https://mind.example/reset/${token}?n=1`));
  await config.answerOf(new Request(`https://mind.example/reset/${token}?n=2`));
  await Promise.all(config.held);
  expect(config.appended.map((event) => event.payload)).toEqual([
    {
      where: "fetch",
      method: "GET",
      path: "/reset/<id>",
      error: {
        name: "Error",
        message: "GET /a/b failed, <cut>, Cookie: [cut]",
        stack: "Error: x\n    at f (/app.js:12:34)",
      },
    },
  ]);
});

test("a rejection of a promise handed to this.ctx.waitUntil is caught, reported and recorded; a promise that resolves is held as it is", async () => {
  minute(29_000_001);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const config = failingConfig(() => new Response("ok"));
  config.entrypoint.later(Promise.resolve("done"));
  config.entrypoint.later(Promise.reject(new Error("rejected in waitUntil")));
  config.entrypoint.later(Promise.reject("a string"));
  config.entrypoint.later(
    Promise.reject(codedError("INVALID_INPUT", "GET https://x.example/a?token=SECRET failed")),
  );
  expect(await Promise.all(config.held)).toEqual(["done", undefined, undefined, undefined]);
  await Promise.all(config.held); // the facts' appends, held as the rejections were caught
  expect(config.appended.map((event) => event.payload)).toEqual([
    {
      where: "waitUntil",
      error: { name: "Error", message: "rejected in waitUntil", stack: expect.any(String) },
    },
    { where: "waitUntil", error: { name: "stringThrown", message: "a string" } },
    { where: "waitUntil", error: expect.objectContaining({ message: "GET /a failed" }) },
  ]);
  // the log line is scrubbed as the fact is, and has no code: nothing tells a platform code from
  // text that a config's code put there
  expect(
    errors.mock.calls.map(([line]) => [
      line.failureSite,
      line.error.message ?? line.error.type,
      line.code,
    ]),
  ).toEqual([
    ["config.wait-until", "rejected in waitUntil", undefined],
    ["config.wait-until", "a string", undefined],
    ["config.wait-until", "GET /a failed", undefined],
  ]);
  expect(JSON.stringify(errors.mock.calls)).not.toContain("SECRET");
});

test("a rejection that cannot be read is still logged and recorded, and its code is never in the log line", async () => {
  minute(29_000_006);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const config = failingConfig(() => new Response("ok"));
  const unreadable = new Error("x");
  Object.defineProperty(unreadable, "stack", {
    get() {
      throw new Error("the stack getter threw");
    },
  });
  const codeThrows = new Error("its code getter throws");
  Object.defineProperty(codeThrows, "code", {
    get() {
      throw new Error("the code getter threw");
    },
  });
  config.entrypoint.later(Promise.reject(unreadable));
  config.entrypoint.later(
    Promise.reject(Object.assign(new Error("odd code"), { code: { response: "SECRET" } })),
  );
  config.entrypoint.later(Promise.reject(Object.assign(new Error("caps"), { code: "SECRET_X" })));
  config.entrypoint.later(Promise.reject(codeThrows));
  // the wrapper's promises resolve: nothing of the diagnostic throws out of the handler
  expect(await Promise.all(config.held)).toEqual([undefined, undefined, undefined, undefined]);
  await Promise.all(config.held);
  expect(config.appended.map((event) => event.payload?.error)).toEqual([
    { name: "UnreadableThrown", message: "" },
    expect.objectContaining({ name: "Error", message: "odd code" }),
    expect.objectContaining({ name: "Error", message: "caps" }),
    expect.objectContaining({ name: "Error", message: "its code getter throws" }),
  ]);
  expect(errors.mock.calls.map(([line]) => [line.failureSite, line.error.type, line.code])).toEqual(
    [
      ["config.wait-until", "UnreadableThrown", undefined],
      ["config.wait-until", "Error", undefined],
      ["config.wait-until", "Error", undefined],
      ["config.wait-until", "Error", undefined],
    ],
  );
  expect(JSON.stringify(errors.mock.calls)).not.toContain("SECRET");
});

test("one fact for each kind of error a minute, 30 a minute from one isolate, and a new minute starts again; a refusal at the loop limit is no fact", async () => {
  minute(29_000_002);
  const config = failingConfig((request) => {
    throw new Error(
      `failure ${new URL(request.url).searchParams.get("n")}\nat a line that differs`,
    );
  });
  const fetchFailing = (n: number) => config.answerOf(new Request(`https://mind.example/?n=${n}`));
  for (let n = 0; n < 40; n++) await fetchFailing(n % 35);
  await Promise.all(config.held);
  expect(config.appended.map((event) => event.payload?.error)).toEqual(
    Array.from({ length: 30 }, (_, n) =>
      expect.objectContaining({ message: `failure ${n}\nat a line that differs` }),
    ),
  );
  expect([...new Set(config.appended.map((event) => event.idempotencyKey))]).toHaveLength(30);
  minute(29_000_003);
  await fetchFailing(0);
  await Promise.all(config.held);
  expect(config.appended.at(-1)?.idempotencyKey).toMatch(/:29000003$/);
  const looped = failingConfig(() => {
    throw codedError("LOOP_LIMIT", "the chain is too deep", { recorded: true });
  });
  await looped.answerOf(new Request("https://mind.example/"));
  expect(looped).toMatchObject({ held: [] });
});

test("an append that fails is reported once and dropped; a key another isolate wrote first is no failure", async () => {
  minute(29_000_004);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const refusal of [
    new Error("append refused"),
    codedError("IDEMPOTENCY_CONFLICT", "the key is on the log with another body"),
  ]) {
    const config = failingConfig(() => {
      throw new Error(`the page broke: ${refusal.message}`);
    });
    config.refuse = refusal;
    await config.answerOf(new Request("https://mind.example/"));
    await Promise.all(config.held);
  }
  expect(errors.mock.calls.map(([line]) => [line.failureSite, line.error.message])).toEqual([
    ["config.code-failed", "append refused"],
  ]);
});

/** The minute that `Date.now` answers, for the bounds of ./code-failed.ts. */
const minute = (at: number) => vi.spyOn(Date, "now").mockReturnValue(at * 60_000);

/** A config whose `fetch` is `serve` and whose `later` hands a promise to `this.ctx.waitUntil`,
 *  over a ctx that keeps what it holds and a root that keeps what is appended: once `ready`
 *  settles, and refused with `refuse` when it is set. `answerOf` is its answer to a request, or
 *  what its `fetch` threw. */
function failingConfig(serve: (request: Request) => Response | Promise<Response>) {
  const held: Promise<unknown>[] = [];
  const appended: StreamEventInput[] = [];
  const control: { ready: Promise<unknown>; refuse?: Error } = { ready: Promise.resolve() };
  const root = {
    append: async (event: StreamEventInput) => {
      await control.ready;
      if (control.refuse) throw control.refuse;
      appended.push(event);
    },
    [Symbol.dispose]: () => {},
  };
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      held.push(promise);
    },
  };
  const env = { ITX: { get: () => root } };
  const entrypoint = new (class extends IterateConfigEntrypoint {
    override processEvent() {}
    override async email() {}
    override fetch(request: Request) {
      return serve(request);
    }
    later(promise: Promise<unknown>) {
      this.ctx.waitUntil(promise);
    }
  })(ctx as never, env as never);
  // the shim's base class keeps no constructor arguments; the runtime's sets both from them
  Object.assign(entrypoint, { env, ctx });
  const answerOf = async (request: Request): Promise<unknown> => {
    try {
      return await entrypoint.fetch(request);
    } catch (error) {
      return error;
    }
  };
  return Object.assign(control, { held, appended, entrypoint, answerOf });
}

/** A config entrypoint over a fake `env.ITX` whose root logs each call and each release; `handler`
 *  overrides `processEvent` when given. */
function configEntrypoint(
  log: string[],
  handler?: (args: IterateConfigProcessEventArgs) => Promise<void>,
) {
  const step = (name: string): any => {
    const answer = Promise.resolve(undefined);
    return {
      then: answer.then.bind(answer),
      append: () => {
        log.push(`${name}.append`);
        return step(`${name}.append`);
      },
      [Symbol.dispose]: () => log.push(`dispose ${name}`),
    };
  };
  const root = {
    cd: (path: string) => step(`cd(${path})`),
    [Symbol.dispose]: () => log.push("dispose root"),
  };
  const env = {
    ITX: {
      get: () => {
        log.push("get");
        return root;
      },
    },
  };
  const entrypoint = new (class extends IterateConfigEntrypoint {
    override processEvent(args: IterateConfigProcessEventArgs) {
      return handler?.(args);
    }
    override fetch() {
      return new Response("Not found\n", { status: 404 });
    }
    async appendThroughGetItx(path: string) {
      using itx = this.getItx();
      await itx.cd(path).append({ type: "events.iterate.com/test/pong-sent" });
    }
    async whoAsked() {
      await Promise.resolve(); // across an await, as a method that calls out first reads it
      return this.callerPath();
    }
  })({} as never, env as never);
  // the shim's base class keeps no constructor arguments; the runtime's sets `env` from them
  Object.assign(entrypoint, { env });
  return entrypoint;
}

/** A facet with one person method, which answers who asked for its call. */
class Call extends FacetDurableObject {
  static override publicMethods = [...super.publicMethods, "join", "joinLater"];
  static override personMethods = ["join"];
  /** What a timer of `joinLater` read, after its call ended. */
  later?: Promise<OnBehalfOf | undefined>;
  async join() {
    await Promise.resolve(); // across an await, as a method that calls out first reads it
    return this.onBehalfOf();
  }
  joinLater() {
    this.later = new Promise((resolve) => setTimeout(() => resolve(this.onBehalfOf()), 5));
  }
}
const facet = <Facet>(Class: new (ctx: never, env: never) => Facet) =>
  new Class({} as never, {} as never);
