// A model call that a mind's code makes through an AI Gateway carries the mind's name, whatever
// the caller passed: the gateway's spend rules cap a mind by it.
import { expect, test } from "vitest";
import { ItxAi } from "./itx-ai.ts";

const who = { mindSlug: "example-com", path: "/apps/shop" };

test("a call through a gateway names the mind and the calling context, and keeps the caller's own keys", async () => {
  const { ai, options } = fakeBinding();
  await new ItxAi(ai, who).run(
    "openai/gpt",
    { input: "hi" },
    { gateway: { id: "default", skipCache: true, metadata: { feature: "summary" } } },
  );
  // strictly equal: no key that is undefined
  expect(options).toStrictEqual([
    {
      gateway: {
        id: "default",
        skipCache: true,
        metadata: { mindSlug: "example-com", streamPath: "/apps/shop", feature: "summary" },
      },
    },
  ]);
  // the mind's name is the first of the five entries a gateway keeps
  expect(JSON.stringify(options)).toContain('"metadata":{"mindSlug":"example-com"');
});

test("a caller that names another mind does not win, and one that names its own stream keeps it", async () => {
  const { ai, options } = fakeBinding();
  await new ItxAi(ai, who).run(
    "openai/gpt",
    {},
    {
      gateway: {
        id: "default",
        metadata: {
          mindSlug: "another-mind",
          streamPath: "/agents/web/one",
          context: "agent-turn",
        },
      },
    },
  );
  expect(options).toStrictEqual([
    {
      gateway: {
        id: "default",
        metadata: { mindSlug: "example-com", streamPath: "/agents/web/one", context: "agent-turn" },
      },
    },
  ]);
});

test("a gateway named with no metadata gets the mind's, and a call that names no gateway is sent as it is", async () => {
  const { ai, options } = fakeBinding();
  const itxAi = new ItxAi(ai, who);
  await itxAi.run("openai/gpt", {}, { gateway: { id: "default" } });
  await itxAi.run("@cf/meta/llama", {}, { returnRawResponse: false });
  await itxAi.run("@cf/meta/llama", {});
  expect(options).toStrictEqual([
    { gateway: { id: "default", metadata: { mindSlug: "example-com", streamPath: "/apps/shop" } } },
    { returnRawResponse: false },
    undefined,
  ]);
});

test("the gateway's universal endpoint carries the mind's name too, over what the caller passed", async () => {
  const { ai, universal } = fakeBinding();
  const gateway = new ItxAi(ai, who).gateway("default");
  await gateway.run({ provider: "openai", endpoint: "responses", headers: {}, query: {} });
  await gateway.run(
    { provider: "openai", endpoint: "responses", headers: {}, query: {} },
    { gateway: { id: "default", metadata: { mindSlug: "another-mind", feature: "summary" } } },
  );
  expect(universal).toStrictEqual([
    { gateway: { id: "default", metadata: { mindSlug: "example-com", streamPath: "/apps/shop" } } },
    {
      gateway: {
        id: "default",
        metadata: { mindSlug: "example-com", streamPath: "/apps/shop", feature: "summary" },
      },
    },
  ]);
});

test("a mind with no name sends none, and still sends the calling context", async () => {
  const { ai, options } = fakeBinding();
  await new ItxAi(ai, { path: "/" }).run("openai/gpt", {}, { gateway: { id: "default" } });
  expect(options).toStrictEqual([{ gateway: { id: "default", metadata: { streamPath: "/" } } }]);
});

/** The Workers AI binding, keeping the options each `run` was given, and each run of a gateway's
 *  universal endpoint. */
function fakeBinding() {
  const options: unknown[] = [];
  const universal: unknown[] = [];
  const ai = {
    run: async (_model: string, _inputs: unknown, given: unknown) => {
      options.push(given);
      return {};
    },
    gateway: () => ({
      run: async (_data: unknown, given: unknown) => {
        universal.push(given);
        return Response.json({ ok: true });
      },
    }),
  };
  // the fake has the two members under test, of the binding's many
  return { ai: ai as unknown as Ai, options, universal };
}
