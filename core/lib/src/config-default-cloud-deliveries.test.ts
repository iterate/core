// The default config's recogniser of iterate Cloud's deliveries (core/configs/default/
// cloud-deliveries.ts): the key form, the mind form, and what it refuses; and the mind's word to
// the Cloud that it reads the mind form.
import { expect, test, vi } from "vitest";
import {
  cloudDeliveryOf,
  ITERATE_CLOUD,
  mindFormEvent,
  sayMindForm,
  type MindFormItx,
} from "../../configs/default/cloud-deliveries.ts";

const CLOUD_KEY = { signer: { principal: { actor: "iterate-cloud" }, key: "cloud-key" } };
/** The mind that is iterate Cloud, by its control-plane hostname: where the auth Worker publishes its keys. */
const ITERATE_MIND = {
  signer: { principal: { actor: "iterate.iterate.com", kind: "mind" }, key: "iterate-mind-key" },
};
/** A signer named by the bare zone: no mind's name, since no mind's control-plane hostname. */
const BARE_ZONE = {
  signer: { principal: { actor: "iterate.com", kind: "mind" }, key: "another-key" },
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
    name: "the mind form: under /minds/iterate.iterate.com, signed by the mind iterate.iterate.com",
    event: {
      path: "/minds/iterate.iterate.com/integrations/google/ada@example.com",
      source: ITERATE_MIND,
    },
    delivery: ADA,
  },
  {
    name: "a delivery signed as the bare zone iterate.com is refused, on the Cloud mind's path",
    event: {
      path: "/minds/iterate.iterate.com/integrations/google/ada@example.com",
      source: BARE_ZONE,
    },
  },
  {
    name: "and on the bare zone's own path, signed as the bare zone",
    event: { path: "/minds/iterate.com/integrations/google/ada@example.com", source: BARE_ZONE },
  },
  {
    name: "and on the bare zone's path, signed by the Cloud mind",
    event: { path: "/minds/iterate.com/integrations/google/ada@example.com", source: ITERATE_MIND },
  },
  {
    name: "the mind form signed by another mind is not the Cloud's",
    event: {
      path: "/minds/iterate.iterate.com/integrations/google/ada@example.com",
      source: { signer: { principal: { actor: "iterate.example.com", kind: "mind" }, key: "k" } },
    },
  },
  {
    name: "nor the mind form's path with the Cloud key's actor",
    event: {
      path: "/minds/iterate.iterate.com/integrations/google/ada@example.com",
      source: CLOUD_KEY,
    },
  },
  {
    name: "nor the key form signed by a mind",
    event: { path: "/integrations/google/ada@example.com", source: ITERATE_MIND },
  },
  {
    name: "nor the key form signed by a mind that calls itself iterate-cloud",
    event: {
      path: "/integrations/google/ada@example.com",
      source: { signer: { principal: { actor: "iterate-cloud", kind: "mind" }, key: "k" } },
    },
  },
  {
    name: "nor another mind's path signed by the Cloud mind",
    event: {
      path: "/minds/iterate.example.com/integrations/google/ada@example.com",
      source: ITERATE_MIND,
    },
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
      path: "/minds/iterate.iterate.com/integrations/google/ada@example.com/more",
      source: ITERATE_MIND,
    },
  },
  {
    name: "nor the mind form one segment too short",
    event: { path: "/minds/iterate.iterate.com/integrations/google", source: ITERATE_MIND },
  },
  {
    name: "nor the mind's own context for the meld",
    event: { path: "/minds/iterate.iterate.com", source: ITERATE_MIND },
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

test("a mind whose Cloud gives no list, or with no account connected through it, says nothing", async () => {
  for (const mind of [mindWithCloud({ cloud: false }), mindWithCloud({ connected: false })]) {
    await sayMindForm(mind.itx);
    expect([mind.asked.length, mind.kept.size]).toEqual([0, 0]);
  }
});

test("the word goes to the Cloud that the template names, for its own accounts alone: an account of another Cloud is not tried", async () => {
  const mind = mindWithCloud({ connected: false, elsewhere: true });
  await sayMindForm(mind.itx);
  expect([mind.asked.length, mind.kept.size, mind.clouds]).toEqual([0, 0, []]);
  const both = mindWithCloud({ elsewhere: true });
  await sayMindForm(both.itx);
  expect({ asked: both.asked.map(({ url }) => url), clouds: both.clouds }).toEqual({
    asked: [`${CLOUD}/clients/github/ask/mind-form`],
    clouds: [CLOUD],
  });
});

test("the word is said when an account's secret is set, with no publish: for a secret's own fact alone, and never as a failure of that event", async () => {
  const SET = "events.iterate.com/secret/set";
  const mind = mindWithCloud();
  // any other event, and a fact of this type on another context, says nothing
  await mindFormEvent(mind.itx, {
    type: "events.iterate.com/secret/used",
    path: "/secrets/github",
  });
  await mindFormEvent(mind.itx, { type: SET, path: "/" });
  await mindFormEvent(mind.itx, { type: SET, path: "/secrets/github/deeper" });
  expect([mind.asked.length, mind.kept.size]).toEqual([0, 0]);
  await mindFormEvent(mind.itx, { type: SET, path: "/secrets/github" });
  expect({ asked: mind.asked.map(({ url }) => url), kept: [...mind.kept] }).toEqual({
    asked: [`${CLOUD}/clients/github/ask/mind-form`],
    kept: [[WORD, "said"]],
  });
  // a key of the mind's own is no account of the Cloud's: nothing is asked for it
  const alone = mindWithCloud({ connected: false });
  await mindFormEvent(alone.itx, { type: SET, path: "/secrets/openai" });
  expect([alone.asked.length, alone.kept.size]).toEqual([0, 0]);
  // the vault does not answer: the secret's event still ends well
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const broken = mindWithCloud();
  broken.itx.secrets.list = async () => {
    throw new Error("the vault does not answer");
  };
  await expect(
    mindFormEvent(broken.itx, { type: SET, path: "/secrets/github" }),
  ).resolves.toBeUndefined();
  expect(warn.mock.calls.at(-1)?.[0]).toMatchObject({ event: "config.mind-form-word-failed" });
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

/** The Cloud that the template names: a secret of it asks it, and no other Cloud is asked. */
const CLOUD = ITERATE_CLOUD;

/** A mind with one account connected through the Cloud's GitHub app (and with `second`, one
 *  through its Google app), beside a key of its own, and a Cloud that answers each ask with
 *  `answers`, or 403 for an account in `refused`. */
function mindWithCloud({ cloud = true, connected = true, second = false, elsewhere = false } = {}) {
  const kept = new Map<string, string>();
  const mind = {
    kept,
    /** The origins whose clients the mind asked the vault for. */
    clouds: [] as string[],
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
          // an account of another Cloud's client of the same name
          ...(elsewhere
            ? [
                {
                  path: "/secrets/elsewhere",
                  cloud: "github",
                  cloudOrigin: "https://other.example",
                },
              ]
            : []),
          ...(connected ? [{ path: "/secrets/github", cloud: "github", cloudOrigin: CLOUD }] : []),
          ...(second ? [{ path: "/secrets/google", cloud: "google", cloudOrigin: CLOUD }] : []),
        ],
        cloud: async (origin: string) => {
          mind.clouds.push(origin);
          return { origin, clients: cloud ? ["github", "google"] : [] };
        },
      },
      kv: {
        get: async (key: string) => kept.get(key) ?? null,
        put: async (key: string, value: string) => kept.set(key, value),
      },
    } satisfies MindFormItx,
  };
  return mind;
}
