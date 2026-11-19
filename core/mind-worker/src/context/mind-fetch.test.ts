// `itx.minds.get(hostname).fetch(request)` (./minds.ts `signedMindFetch`): the calling context's
// own `itx.fetch`, as its caller, with one more argument, `{ signFor }`; the context's rules decide
// it (core/itx/src/context/signed-fetch.test.ts proves that on the real resolver).
import type { Caller, ItxHostRootContext } from "core-itx";
import type { InvokeHandle } from "iterate/expression";
import { expect, test } from "vitest";
import { mindsRoot } from "./minds.ts";

test("fetch is the calling context's own itx.fetch, as its caller, with the peer as a second argument: never the root's, never itx.builtins", async () => {
  const mind = mindFetching("peer-one.net");
  const answer = (await mind.handle.invoke([
    [
      "fetch",
      new Request("https://app.peer-one.net/v1/thing?x=1", {
        method: "post",
        body: "the body",
        headers: { "x-plain": "kept" },
      }),
    ],
  ])) as Response;
  expect(await answer.text()).toBe("the context's own fetch");
  expect(mind.invoked).toMatchObject([
    {
      caller: CALLER,
      root: "itx",
      verb: "fetch",
      url: "https://app.peer-one.net/v1/thing?x=1",
      method: "POST",
      body: "the body",
      redirect: "manual",
      headers: { "x-plain": "kept" },
      options: { signFor: "peer-one.net" },
    },
  ]);
  expect(mind).toMatchObject({ rootFetches: 0 });
});

test("fetch sends a GET with no body, and refuses a URL that is not https, anything that is no Request and a WebSocket, before any fetch", async () => {
  const mind = mindFetching("peer-two.net");
  await mind.handle.invoke([["fetch", new Request("https://peer-two.net/x")]]);
  expect(mind.invoked).toMatchObject([{ method: "GET", body: "" }]);
  await expect(
    mind.handle.invoke([["fetch", new Request("http://peer-two.net/x")]]),
  ).rejects.toThrow("an https URL");
  await expect(mind.handle.invoke([["fetch", "https://peer-two.net/x"]])).rejects.toThrow(
    "one Request",
  );
  await expect(
    mind.handle.invoke([
      ["fetch", new Request("https://peer-two.net/socket", { headers: { upgrade: "websocket" } })],
    ]),
  ).rejects.toThrow("no WebSocket");
  // one Request and nothing more: a fetch row back to this wrapper ends at its first turn
  await expect(
    mind.handle.invoke([["fetch", new Request("https://peer-two.net/x"), { signFor: "x.net" }]]),
  ).rejects.toThrow("takes one Request and nothing more");
  expect(mind.invoked).toHaveLength(1);
});

const CALLER: Caller = { principal: null, app: true, path: "/agents/a" };

/** `itx.minds.get(domain)` on the mind `example.com`, at a context whose `invokeAs` records each
 *  call it is asked to make and answers it, and whose root's `itx.fetch` counts its calls. */
function mindFetching(domain: string) {
  const invoked: Record<string, unknown>[] = [];
  let rootFetches = 0;
  const scope = {
    path: "/agents/a",
    caller: () => CALLER,
    invokeAs: async (caller: Caller, [root, [verb, request, options]]: [string, unknown[]]) => {
      // the cast: the one call signedMindFetch makes is `itx.fetch(request, options)`
      const sent = request as Request;
      invoked.push({
        caller,
        root,
        verb,
        url: sent.url,
        method: sent.method,
        body: await sent.text(),
        redirect: sent.redirect,
        headers: Object.fromEntries(sent.headers),
        options,
      });
      return new Response("the context's own fetch");
    },
    context: () => ({
      invoke: async () => {
        rootFetches += 1;
        return new Response("the root's");
      },
    }),
  } as unknown as ItxHostRootContext;
  const root = mindsRoot(scope, {
    mind: "example.com",
    boundary: () => ({
      signForMind: async () => {
        throw new Error("fetch signs nothing here");
      },
    }),
  });
  return {
    handle: root.get(domain) as InvokeHandle,
    invoked,
    get rootFetches() {
      return rootFetches;
    },
  };
}
