import { type Caller, type ItxHostRootContext, sha256Hex } from "core-itx";
import type { InvokeHandle } from "iterate/expression";
import type { StreamEvent } from "iterate/stream/processor";
import { expect, test } from "vitest";
import { mindsRoot } from "./minds.ts";

test("deliverEvents signs each event for the other mind and posts it to the statements address it publishes, past the platform's and the rule's types", async () => {
  const { handle, signed, posted } = await peer("peer-one.net", () => new Response("{}"));
  const events = [
    event("events.iterate.com/test/note-added", 3),
    event("events.iterate.com/itx/subscription-configured", 4),
    event("events.iterate.com/mind-meld/configured", 5),
  ];
  await handle.invoke([["deliverEvents", events, { from: 3, to: 5 }]]);
  expect(signed).toEqual([
    {
      mind: "peer-one.net",
      path: "/minds/example.com/notes",
      type: "events.iterate.com/test/note-added",
      payload: { text: "note 3" },
      about: ["/notes@3"],
    },
  ]);
  expect(posted).toEqual([
    "GET https://peer-one.net/.well-known/iterate",
    'POST https://iterate.peer-one.net/statements {"statement":"for peer-one.net","signature":{"format":"p256","key":"k","sig":"s"}}',
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

test("only the delivery loop's own call sends", async () => {
  const { handle, posted } = await peer("peer-three.net", () => new Response("{}"), {
    forged: true,
  });
  await expect(
    handle.invoke([["deliverEvent", event("events.iterate.com/test/note-added", 1)]]),
  ).rejects.toThrow("the delivery loop's own call");
  expect(posted).toEqual([]);
});

test("get refuses this mind's own domain and a name that is no domain", () => {
  const { root } = minds(
    () => new Response("{}"),
    () => ({ principal: null }),
  );
  expect(() => root.get("example.com")).toThrow(/another mind's domain/);
  expect(() => root.get("Peer.net")).toThrow(/another mind's domain/);
});

/** The root at `/`, with a delivery caller that carries the hash of whatever is delivered (or a
 *  forged one), and a fake `itx.fetch` that serves `domain`'s document and answers each post with
 *  `answer`. */
async function peer(domain: string, answer: () => Response, { forged = false } = {}) {
  let delivery: string | undefined;
  const { root, signed, posted } = minds(answer, () => ({ principal: null, delivery }), domain);
  const handle = root.get(domain) as InvokeHandle;
  const invoke = handle.invoke.bind(handle);
  handle.invoke = async (steps) => {
    const [[, sent]] = steps as [[string, unknown]];
    delivery = forged ? "forged" : await sha256Hex(JSON.stringify(sent));
    return invoke(steps);
  };
  return { handle, signed, posted };
}

function minds(answer: () => Response, caller: () => Caller, domain = "peer.net") {
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
        return Response.json({
          mind: domain,
          issuer: `https://iterate.${domain}`,
          statements: `https://iterate.${domain}/statements`,
          keys: [],
        });
      },
    }),
  } as unknown as ItxHostRootContext;
  const root = mindsRoot(scope, {
    domain: "example.com",
    boundary: () => ({
      signForMind: async (input) => {
        signed.push(input);
        return {
          statement: `for ${input.mind}`,
          signature: { format: "p256" as const, key: "k", sig: "s" },
        };
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
