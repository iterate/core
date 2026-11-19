import { type Caller, type ItxHostRootContext, sha256Hex } from "core-itx";
import type { InvokeHandle } from "iterate/expression";
import { errorCode } from "iterate/lib";
import type { StreamEvent } from "iterate/stream/processor";
import { expect, test } from "vitest";
import { newIdentityLog } from "../../../lib/src/test-support/identity-log.ts";
import { mindsRoot } from "./minds.ts";

/** This mind's id, an obvious fake. */
const OWN_ID = "a".repeat(64);

test("deliverEvents reads the other mind's identity log, signs each event for it and posts it to its statements address, past the platform's and the rule's types", async () => {
  const { handle, signed, posted, log } = await peer("peer-one.net", () => new Response("{}"));
  const events = [
    event("events.iterate.com/test/note-added", 3),
    event("events.iterate.com/itx/subscription-configured", 4),
    event("events.iterate.com/mind-meld/configured", 5),
  ];
  await handle.invoke([["deliverEvents", events, { from: 3, to: 5 }]]);
  expect(signed).toEqual([
    {
      mind: log.mind,
      path: `/minds/${OWN_ID}/notes`,
      type: "events.iterate.com/test/note-added",
      payload: { text: "note 3" },
      about: ["/notes@3"],
    },
  ]);
  expect(posted).toEqual([
    "GET https://peer-one.net/.well-known/iterate",
    `POST https://peer-one.net/statements {"statement":"for ${log.mind}","signature":{"format":"p256","key":"k","sig":"s"}}`,
  ]);
});

test("any answer but a 200 throws with the other mind's words, so the row tries again", async () => {
  const { handle } = await peer("peer-two.net", () =>
    Response.json({ refused: "peer-two.net is not let in here" }, { status: 403 }),
  );
  await expect(
    handle.invoke([["deliverEvent", event("events.iterate.com/test/note-added", 7)]]),
  ).rejects.toThrow(
    'peer-two.net answered 403 to /notes@7: {"refused":"peer-two.net is not let in here"}',
  );
});

test("while this mind may not sign yet, a delivery fails with the auth Worker's words and no code, so its row tries again and is not halted", async () => {
  const { handle, posted } = await peer("peer-four.net", () => new Response("{}"), {
    signing: new Error(
      "the mind's identity lists no working key of this stack yet, so the mind signs nothing as itself",
    ),
  });
  const failed: unknown = await Promise.resolve(
    handle.invoke([["deliverEvent", event("events.iterate.com/test/note-added", 2)]]),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(String(failed)).toContain("lists no working key of this stack yet");
  // delivery halts a row at once on a coded refusal such as FORBIDDEN (core/itx
  // subscription-delivery.ts `deterministicFailure`): this one has no code
  expect(errorCode(failed)).toBeUndefined();
  expect(posted).toEqual(["GET https://peer-four.net/.well-known/iterate"]);
});

test("only the delivery loop's own call sends", async () => {
  const { handle, posted } = await peer("peer-three.net", () => new Response("{}"), {
    forged: true,
  });
  await expect(
    handle.invoke([["deliverEvent", event("events.iterate.com/test/note-added", 1)]]),
  ).rejects.toThrow("the delivery loop's own call");
  expect(posted).toEqual([]);
});

test("at(path) lands every event at that context of the other mind, whatever context it is from", async () => {
  // its own hostname: a reader keeps a log for a minute by its hostname
  const { handle, signed, log } = await peer("peer-seven.net", () => new Response("{}"));
  await handle.invoke([
    ["at", "/agents/talk/example.com/plans"],
    ["deliverEvents", [event("events.iterate.com/agent/message-received", 9)], { from: 9, to: 9 }],
  ]);
  expect(signed).toEqual([
    {
      mind: log.mind,
      path: "/agents/talk/example.com/plans",
      type: "events.iterate.com/agent/message-received",
      payload: { text: "note 9" },
      about: ["/notes@9"],
    },
  ]);
});

test("at(path) alone answers a handle that delivers there, and only the delivery loop's call sends through it", async () => {
  const { handle, signed } = await peer("peer-five.net", () => new Response("{}"));
  const there = (await handle.invoke([["at", "/inbox"]])) as InvokeHandle;
  await expect(
    there.invoke([["deliverEvent", event("events.iterate.com/test/note-added", 2)]]),
  ).rejects.toThrow("the delivery loop's own call");
  expect(signed).toEqual([]);
});

test("at refuses a path that is no context's own, a second at, and anything but a delivery after it", async () => {
  const { handle, posted } = await peer("peer-six.net", () => new Response("{}"));
  const note = event("events.iterate.com/test/note-added", 1);
  for (const path of ["notes", "/notes/", "/notes/../secrets", "/a//b", 7])
    await expect(
      handle.invoke([
        ["at", path],
        ["deliverEvent", note],
      ]),
    ).rejects.toThrow("a context's own path");
  await expect(
    handle.invoke([
      ["at", "/a"],
      ["at", "/b"],
      ["deliverEvent", note],
    ]),
  ).rejects.toThrow("a mind answers deliverEvents(events) and deliverEvent(event)");
  await expect(handle.invoke([["at", "/a"], ["readEvents"]])).rejects.toThrow(
    "a mind answers deliverEvents(events) and deliverEvent(event)",
  );
  expect(posted).toEqual([]);
});

test("get refuses this mind's own name and id, and a name that is no hostname or id", () => {
  const { root } = minds(
    () => new Response("{}"),
    () => ({ principal: null }),
  );
  for (const name of ["example.com", OWN_ID, "Peer.net", "B".repeat(64)])
    expect(() => root.get(name)).toThrow(/another mind's control-plane hostname, or its id/);
});

test("get(<id>) sends no events: an id says who, and the hostname says where", async () => {
  const { root, posted } = minds(
    () => new Response("{}"),
    () => ({ principal: null }),
  );
  const handle = root.get("b".repeat(64)) as InvokeHandle;
  await expect(
    handle.invoke([["deliverEvent", event("events.iterate.com/test/note-added", 1)]]),
  ).rejects.toThrow("name the mind by its control-plane hostname to send it events");
  expect(posted).toEqual([]);
});

/** The root at `/`, with a delivery caller that carries the hash of whatever is delivered (or a
 *  forged one), and a fake `itx.fetch` that serves the identity log of the mind at `domain`,
 *  truly signed, and answers each post with `answer`. */
async function peer(
  domain: string,
  answer: () => Response,
  { forged = false, signing }: { forged?: boolean; signing?: Error } = {},
) {
  let delivery: string | undefined;
  const log = await newIdentityLog([domain]);
  const { root, signed, posted } = minds(
    answer,
    () => ({ principal: null, delivery }),
    { version: 1, mind: log.mind, head: log.mind, records: [log.genesis] },
    signing,
  );
  const handle = root.get(domain) as InvokeHandle;
  const invoke = handle.invoke.bind(handle);
  handle.invoke = async (steps) => {
    // the delivery is the last step: `at(path)` may come before it
    const [, sent] = (steps as [string, unknown][]).at(-1)!;
    delivery = forged ? "forged" : await sha256Hex(JSON.stringify(sent));
    return invoke(steps);
  };
  return { handle, signed, posted, log };
}

function minds(
  answer: () => Response,
  caller: () => Caller,
  publishedLog: object = {},
  signing?: Error,
) {
  const signed: unknown[] = [];
  const posted: string[] = [];
  const scope = {
    path: "/",
    caller,
    context: () => ({
      invoke: async (_steps: unknown, [request]: [Request]) => {
        posted.push(
          `${request.method} ${request.url}${request.method === "POST" ? ` ${await request.text()}` : ""}`,
        );
        if (request.method === "POST") return answer();
        return Response.json(publishedLog);
      },
    }),
  } as unknown as ItxHostRootContext;
  const root = mindsRoot(scope, {
    mind: "example.com",
    mindId: OWN_ID,
    boundary: () => ({
      signForMind: async (input) => {
        if (signing) throw signing;
        signed.push(input);
        return {
          statement: `for ${input.mind}`,
          signature: { format: "p256" as const, key: "k", sig: "s" },
        };
      },
      fetchForMind: async () => {
        throw new Error("no delivery sends by fetchForMind");
      },
    }),
  });
  return { root, signed, posted };
}

function event(type: string, offset: number) {
  return {
    type,
    path: "/notes",
    offset,
    payload: { text: `note ${offset}` },
    createdAt: "2026-11-17T00:00:00.000Z",
    source: { origin: "test" },
  } as StreamEvent;
}
