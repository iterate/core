// sdk/index.test.ts — `IterateConfigEntrypoint` in Node, on the `cloudflare:workers` shim's base class.
import { expect, test } from "vitest";
import type { EmailHookArgs } from "../email.ts";
import { codedError, errorCode } from "../lib.ts";
import type { StreamEvent } from "../stream/processor.ts";
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
  expect(await entrypoint.deliverEmail({ mail: {} as never, forward: async () => {} })).toBe(
    "missing",
  );
});

test("deliverEmail hands email the mail and the forward, and its throw is the caller's", async () => {
  const forwarded: string[] = [];
  const entrypoint = configEntrypoint([]);
  const args = {
    mail: { subject: "hello" } as never,
    forward: async (to: string) => void forwarded.push(to),
  };
  expect(await entrypoint.deliverEmail(args)).toBe("done");
  expect(forwarded).toEqual(["team@elsewhere.example"]);
  await expect(
    entrypoint.deliverEmail({ ...args, mail: { subject: "throw" } as never }),
  ).rejects.toThrow("the hook failed");
});

test("a forward that the config calls after the delivery ended throws EXPIRED in the config's own runtime, with the runtime's words", async () => {
  let kept: EmailHookArgs["forward"] | undefined;
  const entrypoint = new (class extends IterateConfigEntrypoint {
    override processEvent() {}
    override fetch() {
      return new Response("Not found\n", { status: 404 });
    }
    override async email({ forward }: EmailHookArgs) {
      kept = forward;
    }
  })({} as never, {} as never);
  const lateCallOf = async (lent: EmailHookArgs["forward"]) => {
    await entrypoint.deliverEmail({ mail: {} as never, forward: lent });
    return await kept!("team@elsewhere.example").catch((error: unknown) => error);
  };
  // the lent stub is gone once the mind's call has returned: workerd throws at the call itself
  const disposed = await lateCallOf(() => {
    throw new Error("RPC stub used after being disposed.");
  });
  expect(errorCode(disposed)).toBe("EXPIRED");
  expect((disposed as Error).message).toContain("RPC stub used after being disposed.");
  // the boundary's invocation ended under the call: a rejection
  const lost = await lateCallOf(() => Promise.reject(new Error("Network connection lost.")));
  expect(errorCode(lost)).toBe("EXPIRED");
  // a refusal with a code of its own, and any other failure, stay as they are
  const refused = await lateCallOf(() =>
    Promise.reject(codedError("REFUSED", "destination address not verified")),
  );
  expect(errorCode(refused)).toBe("REFUSED");
  const other = await lateCallOf(() => Promise.reject(new Error("something else")));
  expect(errorCode(other)).toBeUndefined();
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
    override async email({ mail, forward }: EmailHookArgs) {
      if (mail.subject === "throw") throw new Error("the hook failed");
      await forward("team@elsewhere.example");
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
