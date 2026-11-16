// Loaded code's `cd(path)`: every call goes through the table of the context it came from, and the
// verbs that lend a live stub (`subscribe`, `provide`) stay methods, never table expressions.
import type { ItxExpression } from "iterate/expression";
import { expect, test } from "vitest";
import type { Caller } from "./caller.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import { RPC_STUB_PAGER_WEBSOCKET_HEADER } from "./context/rpc-stubs.ts";
import { defineItxHost } from "./host.ts";
import { IterateContextRpcTarget, type IterateContextNamespace } from "./iterate-context.ts";
import { SessionTeardown } from "./session.ts";

test("loaded code's cd(path).subscribe with a live callback writes its row through its own table and lends at that context", async () => {
  const mind = loadedCodeAt("/");

  await expect(
    mind.itx.cd("/rooms/one").subscribe({ name: "feed", consumes: ["*"], target: liveCallback() }),
  ).rejects.toThrow("pager refused in test");

  expect({ walked: mind.walked, lends: mind.lends }).toEqual({
    walked: [
      [
        "itx",
        ["cd", "/rooms/one"],
        [
          "append",
          {
            type: "events.iterate.com/itx/subscription-configured",
            payload: {
              name: "feed",
              target: ["itx", "builtins", "rpcStubs", ["get", "subscription:feed"]],
              consumes: ["*"],
            },
          },
        ],
      ],
    ],
    lends: [{ at: "/rooms/one", rpcStubKey: "subscription:feed", appendEvents: [] }],
  });
});

test("loaded code's cd(path).subscribe lends nothing where a rule sent its row elsewhere", async () => {
  const mind = loadedCodeAt("/", () => "/jail");

  await expect(
    mind.itx.cd("/rooms/one").subscribe({ name: "feed", consumes: ["*"], target: liveCallback() }),
  ).rejects.toThrow('a rule sent this row to "/jail", not "/rooms/one"');

  expect(mind).toMatchObject({ lends: [] });
});

test("any other call on loaded code's cd(path) is still one expression through its own table", async () => {
  const mind = loadedCodeAt("/");

  await mind.itx.cd("/rooms/one").readEvents(1);

  expect({ walked: mind.walked, lends: mind.lends }).toEqual({
    walked: [["itx", ["cd", "/rooms/one"], ["readEvents", 1]]],
    lends: [],
  });
});

test("a lend that takes the name only from itself sends its lender in the attach, and writes it on the rule", async () => {
  const key = loadedCodeAt("/", undefined, { principal: { actor: "bridge" }, grant: "key:k1" });

  await expect(
    key.itx.provide("itx.whatsapp.jonas", liveCallback() as never, { onlyFromItself: true }),
  ).rejects.toThrow("pager refused in test");

  expect(key).toMatchObject({
    walked: [],
    lends: [
      {
        at: "/",
        rpcStubKey: "itx.whatsapp.jonas",
        onlyFrom: "key:k1",
        appendEvents: [
          {
            type: "events.iterate.com/itx/rewrite-rule-configured",
            payload: {
              match: "itx.whatsapp.jonas",
              target: ["itx", "builtins", "rpcStubs", ["get", "itx.whatsapp.jonas"]],
              lentBy: "key:k1",
            },
          },
        ],
      },
    ],
  });
});

test.for([
  { who: "loaded code", caller: { principal: null, app: true } },
  { who: "a caller with no grant", caller: { principal: { actor: "bridge" } } },
] as const)(
  "a lend that takes the name only from itself is refused from $who, which cannot say who lends",
  async ({ caller }) => {
    const mind = loadedCodeAt("/", undefined, caller);
    await expect(
      mind.itx.provide("itx.whatsapp.jonas", liveCallback() as never, { onlyFromItself: true }),
    ).rejects.toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(mind).toMatchObject({ walked: [], lends: [] });
  },
);

/** Loaded code's itx at `path`: its table records what it walks, and each context refuses a pager.
 *  `caller`: whose session it is, loaded code's by default. */
function loadedCodeAt(
  path: string,
  landsAt = (cdPath: string) => cdPath,
  caller: Caller = { principal: null, app: true },
) {
  const walked: ItxExpression[] = [];
  const lends: {
    at: string;
    rpcStubKey: string;
    appendEvents: unknown[];
    onlyFrom?: string;
  }[] = [];
  const namespace = {
    getByName: (name: string) => ({
      fetch: async (_url: string, init: { headers: Record<string, string> }) => {
        const attach = JSON.parse(
          decodeURIComponent(init.headers[RPC_STUB_PAGER_WEBSOCKET_HEADER]!),
        ) as { rpcStubKey: string; appendEvents: unknown[]; onlyFrom?: string };
        lends.push({
          at: name,
          rpcStubKey: attach.rpcStubKey,
          appendEvents: attach.appendEvents,
          onlyFrom: attach.onlyFrom,
        });
        return Response.json({ code: "TEST", message: "pager refused in test" }, { status: 409 });
      },
    }),
  } as unknown as IterateContextNamespace;
  const itx = new IterateContextRpcTarget(
    namespace,
    DurableObjectNameCodec.address(path),
    new SessionTeardown(),
    () => {},
    caller,
    () =>
      ({
        invoke: async (expression: ItxExpression) => {
          walked.push(expression);
          // where the row lands: the cd's own path, or where a rule sends it
          const cd = expression[1] as [string, string];
          return [{ offset: 1, path: landsAt(cd[1]) }];
        },
      }) as never,
    true,
  );
  return { itx, walked, lends };
}

// `provide` reads the names that are the platform's at the root, which the host defines
defineItxHost({ firstPartyFacets: {} });

function liveCallback() {
  return Object.assign(() => {}, {
    dup() {
      return this;
    },
    [Symbol.dispose]() {},
  });
}
