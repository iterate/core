// The boundary's delivery of the mind's identity facts to `/` (./identity-delivery.ts), with an
// auth Worker that holds facts as its rows do: a fact is owed until it is said to be stored.
import type { IdentityFact } from "iterate/workers";
import { expect, test, vi } from "vitest";
import { boundaryResponse, type MindTransport } from "./http.ts";
import { identityFactsDelivered, identityIntakeAnswer } from "./identity-delivery.ts";

test("every fact that is owed is appended on `/` in its order and then marked, a few at a time", async () => {
  const stack = stackOf(Array.from({ length: 20 }, (_, index) => `m:${index + 1}`));
  expect(await identityFactsDelivered(stack.auth, stack.append)).toBe(true);
  expect(stack).toMatchObject({
    appended: Array.from({ length: 20 }, (_, index) => `m:${index + 1}`),
    // one append for each fact, and one mark for each answer of the auth Worker
    marks: [8, 8, 4],
  });
  expect(stack.owed()).toEqual([]);
});

test("after an append of a mind id's record failed, no later record of that id is appended; other mind ids and the refusals go on", async () => {
  // two mind ids' records, each in the order of its log, and two refusals
  const stack = stackOf(["m:1", "m:2", "m:3", "n:1", "n:2", "refused:x", "refused:y"]);
  stack.failing = new Set(["m:2", "refused:x"]);
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await identityFactsDelivered(stack.auth, stack.append)).toBe(false);
  expect(stack).toMatchObject({
    appended: ["m:1", "n:1", "n:2", "refused:y"],
    // what was stored is marked, although other appends failed
    marks: [4],
  });
  expect(stack.owed()).toEqual(["m:2", "m:3", "refused:x"]);
  // one line says what stays owed, and why
  expect(warned).toHaveBeenCalledTimes(1);
  expect(warned).toHaveBeenCalledWith({
    event: "boundary.identity-facts-owed",
    message:
      "identity facts could not be appended on / and stay owed: the next record posted to the intake delivers them",
    failed: [
      { id: "m:2", error: "Error: the append of m:2 failed" },
      { id: "refused:x", error: "Error: the append of refused:x failed" },
    ],
  });
  warned.mockRestore();
  // the next delivery appends the two in order
  stack.failing = new Set();
  expect(await identityFactsDelivered(stack.auth, stack.append)).toBe(true);
  expect(stack.appended.slice(4)).toEqual(["m:2", "m:3", "refused:x"]);
});

test("a fact is marked only after its append has resolved, and nothing throws: an auth Worker that cannot be asked or told leaves the facts owed", async () => {
  const stack = stackOf(["m:1", "m:2"]);
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  stack.authIsDown = "at the mark";
  expect(await identityFactsDelivered(stack.auth, stack.append)).toBe(false);
  expect(stack.owed()).toEqual(["m:1", "m:2"]);
  stack.authIsDown = "at the question";
  expect(await identityFactsDelivered(stack.auth, stack.append)).toBe(false);
  expect(warned).toHaveBeenCalledTimes(2);
  warned.mockRestore();
  stack.authIsDown = false;
  expect(await identityFactsDelivered(stack.auth, stack.append)).toBe(true);
  // the events that were stored and not marked were appended again, as the same events
  expect(stack).toMatchObject({ appended: ["m:1", "m:2", "m:1", "m:2"] });
});

test("more facts than one request delivers are left owed", async () => {
  const stack = stackOf(Array.from({ length: 70 }, (_, index) => `m:${index + 1}`));
  expect(await identityFactsDelivered(stack.auth, stack.append)).toBe(false);
  expect(stack.owed()).toHaveLength(6);
  expect(await identityFactsDelivered(stack.auth, stack.append)).toBe(true);
});

test("the intake's answer goes out at once, before an append on `/` that does not end", async () => {
  const stack = stackOf(["m:1"]);
  const work: Promise<unknown>[] = [];
  let appendEnded = false;
  const answer = identityIntakeAnswer(
    Response.json({ answer: "accepted", position: 1 }),
    stack.auth,
    // an append that never resolves: a mind that took the call and does not answer
    () => new Promise(() => {}).finally(() => (appendEnded = true)),
    (delivery) => work.push(delivery),
  );
  expect(await answer.json()).toEqual({ answer: "accepted", position: 1 });
  expect(work).toHaveLength(1);
  // the delivery is still at its append, and the answer did not wait for it
  await Promise.race([work[0], new Promise((resolve) => setTimeout(resolve, 20))]);
  expect(appendEnded).toBe(false);
  expect(stack.owed()).toEqual(["m:1"]);
});

test("the intake's answer goes out as it is, whatever the delivery did: a 200 while the mind cannot be reached, and a refusal while facts are owed", async () => {
  const stack = stackOf(["m:1"]);
  stack.failing = new Set(["m:1"]);
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const [status, body] of [
    [200, { answer: "accepted", position: 1 }],
    [200, { answer: "known", position: 1 }],
    [409, { answer: "refused", reason: "not-next" }],
    [400, { answer: "refused", reason: "bad-signature" }],
  ] as const) {
    const work: Promise<unknown>[] = [];
    const answer = identityIntakeAnswer(
      Response.json(body, { status }),
      stack.auth,
      stack.append,
      (delivery) => work.push(delivery),
    );
    expect({ status: answer.status, body: await answer.json() }).toEqual({ status, body });
    expect(await Promise.all(work)).toEqual([false]);
  }
  warned.mockRestore();
  // every one of the four requests tried the delivery
  expect(stack).toMatchObject({ tried: ["m:1", "m:1", "m:1", "m:1"], appended: [] });
  expect(stack.owed()).toEqual(["m:1"]);
});

test("a record posted at the control plane is answered by the auth Worker's rows: its fact comes by the typed call, and a facts header on the answer is not read", async () => {
  const stack = stackOf(["m:1"]);
  const appendedAt: [string, string[]][] = [];
  const forged = btoa(
    JSON.stringify([{ path: "/", events: [{ type: "notes/forged", payload: {} }] }]),
  );
  const env = {
    ITERATE: JSON.stringify({
      mindId: "a".repeat(64),
      controlPlaneHostname: "iterate.example.com",
      zones: ["example.com"],
      ownerEmails: ["ada@elsewhere.example"],
      topology: "full-cloudflare",
    }),
    AUTH: {
      ...stack.auth,
      whoIs: async () => null,
      browserSession: async () => null,
      fetch: async () =>
        Response.json({ answer: "accepted" }, { headers: { "x-iterate-facts": forged } }),
    },
  } as unknown as Parameters<typeof boundaryResponse>[1];
  let mindIsDown = true;
  const mind = {
    append: async (path: string, events: { type: string; payload?: object }[]) => {
      if (mindIsDown) throw new Error("the mind was not reached");
      appendedAt.push([path, events.map(({ type }) => type)]);
      await stack.append(events);
    },
  } as unknown as MindTransport;
  // the delivery runs after the answer, under the request's `waitUntil`
  const work: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (delivery: Promise<unknown>) => work.push(delivery),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const posted = async () => {
    const answer = await boundaryResponse(
      new Request("https://iterate.example.com/.well-known/iterate", {
        method: "POST",
        body: "{}",
      }),
      env,
      ctx,
      mind,
    );
    await Promise.all(work.splice(0));
    return {
      status: answer.status,
      facts: answer.headers.get("x-iterate-facts"),
      body: await answer.json(),
    };
  };
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  // the mind cannot be reached: the answer is the auth Worker's all the same
  const accepted = { status: 200, facts: null, body: { answer: "accepted" } };
  expect(await posted()).toEqual(accepted);
  expect(stack.owed()).toEqual(["m:1"]);
  warned.mockRestore();
  mindIsDown = false;
  expect(await posted()).toEqual(accepted);
  // the one fact that the auth Worker's rows owed, on `/`, and nothing that the header named
  expect(appendedAt).toEqual([["/", ["events.iterate.com/mind/identity-record-accepted"]]]);
  expect(stack.owed()).toEqual([]);
});

/** An auth Worker that owes the facts `names`, as its rows do: it answers the first 8 that are
 *  not marked, and a fact is marked only by its id. A name is a mind id and a position
 *  (`m:2`), or a refusal (`refused:x`), which has no mind id. `tried` is every append that was
 *  asked for, `appended` every one that was stored, `marks` the size of each mark; the appends
 *  of the names in `failing` fail. */
function stackOf(names: string[]) {
  const facts: IdentityFact[] = names.map((name) => ({
    id: name,
    ...(!name.startsWith("refused:") && { mind: name.split(":")[0] }),
    event: {
      type: name.startsWith("refused:")
        ? "events.iterate.com/mind/identity-record-refused"
        : "events.iterate.com/mind/identity-record-accepted",
      idempotencyKey: `mind/identity-record:${name}`,
      payload: { name },
    },
  }));
  const marked = new Set<string>();
  const stack = {
    failing: new Set<string>(),
    authIsDown: false as false | "at the question" | "at the mark",
    tried: [] as string[],
    appended: [] as string[],
    marks: [] as number[],
    owed: () => names.filter((name) => !marked.has(name)),
    auth: {
      identityFactsToDeliver: async () => {
        if (stack.authIsDown === "at the question") throw new Error("the auth Worker is away");
        return facts.filter(({ id }) => !marked.has(id)).slice(0, 8);
      },
      identityFactsDelivered: async (ids: string[]) => {
        if (stack.authIsDown === "at the mark") throw new Error("the auth Worker is away");
        stack.marks.push(ids.length);
        for (const id of ids) marked.add(id);
      },
    },
    append: async (events: { payload?: object }[]) => {
      for (const { payload } of events) {
        const name = String(Object(payload).name);
        stack.tried.push(name);
        if (stack.failing.has(name)) throw new Error(`the append of ${name} failed`);
        stack.appended.push(name);
      }
    },
  };
  return stack;
}
