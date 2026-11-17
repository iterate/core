// The default config's recogniser of iterate Cloud's deliveries (core/configs/default/
// cloud-deliveries.ts): the key form, the mind form, and what it refuses; and the mind's word to
// the Cloud that it reads the mind form.
import { expect, test, vi } from "vitest";
import {
  cloudDeliveryOf,
  sayMindForm,
  type MindFormItx,
} from "../../configs/default/cloud-deliveries.ts";

const CLOUD_KEY = { signer: { principal: { actor: "iterate-cloud" }, key: "cloud-key" } };
const ITERATE_COM = {
  signer: { principal: { actor: "iterate.com", kind: "mind" }, key: "iterate-com-key" },
};
const ADA = {
  provider: "google",
  account: "ada@example.com",
  context: "/integrations/google/ada@example.com",
};

test.for([
  {
    name: "the key form: the mind's own context, signed by the Cloud's key",
    event: { path: "/integrations/google/ada@example.com", source: CLOUD_KEY },
    delivery: ADA,
  },
  {
    name: "the mind form: under /minds/iterate.com, signed by the mind iterate.com",
    event: { path: "/minds/iterate.com/integrations/google/ada@example.com", source: ITERATE_COM },
    delivery: ADA,
  },
  {
    name: "the mind form signed by another mind is not the Cloud's",
    event: {
      path: "/minds/iterate.com/integrations/google/ada@example.com",
      source: { signer: { principal: { actor: "example.com", kind: "mind" }, key: "k" } },
    },
  },
  {
    name: "nor the mind form's path with the Cloud key's actor",
    event: { path: "/minds/iterate.com/integrations/google/ada@example.com", source: CLOUD_KEY },
  },
  {
    name: "nor the key form signed by a mind",
    event: { path: "/integrations/google/ada@example.com", source: ITERATE_COM },
  },
  {
    name: "nor the key form signed by a mind that calls itself iterate-cloud",
    event: {
      path: "/integrations/google/ada@example.com",
      source: { signer: { principal: { actor: "iterate-cloud", kind: "mind" }, key: "k" } },
    },
  },
  {
    name: "nor another mind's path signed by iterate.com",
    event: { path: "/minds/example.com/integrations/google/ada@example.com", source: ITERATE_COM },
  },
  {
    name: "nor an event nobody signed",
    event: { path: "/integrations/google/ada@example.com", source: {} },
  },
  {
    name: "nor a path one segment too long",
    event: { path: "/integrations/google/ada@example.com/more", source: CLOUD_KEY },
  },
  {
    name: "nor one too short, as the Cloud's hand-over on /integrations/cloud",
    event: { path: "/integrations/cloud", source: CLOUD_KEY },
  },
  {
    name: "nor the mind form one segment too long",
    event: {
      path: "/minds/iterate.com/integrations/google/ada@example.com/more",
      source: ITERATE_COM,
    },
  },
  {
    name: "nor the mind form one segment too short",
    event: { path: "/minds/iterate.com/integrations/google", source: ITERATE_COM },
  },
  {
    name: "nor the mind's own context for the meld",
    event: { path: "/minds/iterate.com", source: ITERATE_COM },
  },
] as { name: string; event: Parameters<typeof cloudDeliveryOf>[0]; delivery?: unknown }[])(
  "$name",
  ({ event, delivery = null }) => {
    expect(cloudDeliveryOf(event)).toEqual(delivery);
  },
);

const WORD = "cloud-deliveries:mind-form";

test("a mind with an account connected through the Cloud says once that it reads the mind form", async () => {
  const mind = mindWithCloud();
  await sayMindForm(mind.itx);
  const [asked] = mind.asked;
  expect(asked?.url).toBe(`${CLOUD}/clients/github/ask/mind-form`);
  expect(asked?.method).toBe("POST");
  expect(asked?.headers.get("iterate-connection")).toBe('getSecret("/secrets/github")');
  expect(await asked?.json()).toEqual({ reads: true });
  expect([...mind.kept]).toEqual([[WORD, "said"]]);
  await sayMindForm(mind.itx);
  expect(mind.asked).toHaveLength(1);
});

test("a mind with no Cloud, or no account connected through it, says nothing", async () => {
  for (const mind of [mindWithCloud({ cloud: false }), mindWithCloud({ connected: false })]) {
    await sayMindForm(mind.itx);
    expect([mind.asked.length, mind.kept.size]).toEqual([0, 0]);
  }
});

test("an account that cannot ask is passed over for the next one", async () => {
  const mind = mindWithCloud({ second: true });
  mind.refused.add("/secrets/github");
  await sayMindForm(mind.itx);
  expect(mind.asked.map(({ url }) => url)).toEqual([
    `${CLOUD}/clients/github/ask/mind-form`,
    `${CLOUD}/clients/google/ask/mind-form`,
  ]);
  expect(mind.kept.get(WORD)).toBe("said");
});

test("a word the Cloud did not take is logged, not thrown, and said again an hour later, not before", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const mind = mindWithCloud();
  // a request that a rule holds for a member answers 202: nothing reached the Cloud
  mind.answers = 202;
  await sayMindForm(mind.itx);
  expect(warn.mock.calls.map(([line]) => line)).toEqual([
    { event: "config.mind-form-word-not-taken", accounts: 1, answers: [202] },
  ]);
  expect(Number(mind.kept.get(WORD))).toBeGreaterThan(0);
  // within the hour: no ask, whatever the Cloud would answer
  mind.answers = 200;
  await sayMindForm(mind.itx);
  expect(mind.asked).toHaveLength(1);
  // a failed fetch counts the same; after the hour the word is said again, and taken
  mind.kept.set(WORD, String(Date.now() - 2 * 60 * 60_000));
  mind.answers = "the Cloud does not answer";
  await sayMindForm(mind.itx);
  expect(warn.mock.calls.at(-1)?.[0]).toMatchObject({
    answers: ["Error: the Cloud does not answer"],
  });
  mind.kept.set(WORD, String(Date.now() - 2 * 60 * 60_000));
  mind.answers = 200;
  await sayMindForm(mind.itx);
  expect([mind.asked.length, mind.kept.get(WORD)]).toEqual([3, "said"]);
});

const CLOUD = "https://cloud.example.com";

/** A mind with one account connected through the Cloud's GitHub app (and with `second`, one
 *  through its Google app), beside a key of its own, and a Cloud that answers each ask with
 *  `answers`, or 403 for an account in `refused`. */
function mindWithCloud({ cloud = true, connected = true, second = false } = {}) {
  const kept = new Map<string, string>();
  const mind = {
    kept,
    asked: [] as Request[],
    /** The secrets whose asks the Cloud refuses. */
    refused: new Set<string>(),
    /** What the Cloud answers the next ask; a string is a failed fetch. */
    answers: 200 as number | string,
    itx: {
      fetch: async (request: Request): Promise<Response> => {
        mind.asked.push(request);
        if (typeof mind.answers === "string") throw new Error(mind.answers);
        const secret = /getSecret\("(.*)"\)/.exec(request.headers.get("iterate-connection") || "");
        const status = mind.refused.has(secret?.[1] || "") ? 403 : mind.answers;
        return Response.json(status === 200 ? { ok: true, reads: true } : {}, { status });
      },
      secrets: {
        list: async () => [
          { path: "/secrets/openai" },
          ...(connected ? [{ path: "/secrets/github", cloud: "github" }] : []),
          ...(second ? [{ path: "/secrets/google", cloud: "google" }] : []),
        ],
        cloud: async () => (cloud ? { origin: CLOUD, clients: ["github", "google"] } : null),
      },
      kv: {
        get: async (key: string) => kept.get(key) ?? null,
        put: async (key: string, value: string) => kept.set(key, value),
      },
    } satisfies MindFormItx,
  };
  return mind;
}
