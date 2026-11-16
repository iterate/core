// Loaded code's `cd(path)`: every call goes through the table of the context it came from, and the
// verbs that lend a live stub (`subscribe`, `provide`) stay methods, never table expressions.
import type { ItxExpression } from "iterate/expression";
import { expect, test } from "vitest";
import type { Caller } from "./caller.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import { RPC_STUB_PAGER_WEBSOCKET_HEADER } from "./context/rpc-stubs.ts";
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

/** Loaded code's itx at `path`: its table records what it walks, and each context refuses a pager. */
function loadedCodeAt(path: string, landsAt = (cdPath: string) => cdPath) {
  const walked: ItxExpression[] = [];
  const lends: { at: string; rpcStubKey: string; appendEvents: unknown[] }[] = [];
  const namespace = {
    getByName: (name: string) => ({
      fetch: async (_url: string, init: { headers: Record<string, string> }) => {
        const attach = JSON.parse(
          decodeURIComponent(init.headers[RPC_STUB_PAGER_WEBSOCKET_HEADER]!),
        ) as { rpcStubKey: string; appendEvents: unknown[] };
        lends.push({ at: name, rpcStubKey: attach.rpcStubKey, appendEvents: attach.appendEvents });
        return Response.json({ code: "TEST", message: "pager refused in test" }, { status: 409 });
      },
    }),
  } as unknown as IterateContextNamespace;
  const caller: Caller = { principal: null, app: true };
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

function liveCallback() {
  return Object.assign(() => {}, {
    dup() {
      return this;
    },
    [Symbol.dispose]() {},
  });
}
