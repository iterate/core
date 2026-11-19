// The default config's recogniser of iterate Cloud's deliveries (core/configs/default/
// cloud-deliveries.ts): the key form, the mind form, and what it refuses; and the mind's word to
// the Cloud that it reads the mind form.
import { expect, test, vi } from "vitest";
import { ITERATE_MIND as ITERATE_ID } from "../../configs/default/cloud-deliveries.ts";
import {
  cloudDeliveryOf,
  ITERATE_CLOUD,
  mindFormEvent,
  sayMindForm,
  type MindFormItx,
} from "../../configs/default/cloud-deliveries.ts";
import Config from "../../configs/default/worker.ts";

const CLOUD_KEY = { signer: { principal: { actor: "iterate-cloud" }, key: "cloud-key" } };
/** The mind that is iterate Cloud, by its control-plane hostname: where the auth Worker publishes its keys. */
const ITERATE_MIND = {
  signer: { principal: { actor: ITERATE_ID, kind: "mind" }, key: "iterate-mind-key" },
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
    name: "the mind form: under /minds/<iterate's id>, signed by the mind iterate.iterate.com",
    event: {
      path: `/minds/${ITERATE_ID}/integrations/google/ada@example.com`,
      source: ITERATE_MIND,
    },
    delivery: ADA,
  },
  {
    name: "the mind form under a rule by hostname: under /minds/iterate.iterate.com, signed by iterate's id (its mind in the hostname form)",
    event: {
      path: "/minds/iterate.iterate.com/integrations/google/ada@example.com",
      source: ITERATE_MIND,
    },
    delivery: ADA,
  },
  {
    name: "nor that path signed by another mind",
    event: {
      path: "/minds/iterate.iterate.com/integrations/google/ada@example.com",
      source: { signer: { principal: { actor: "b".repeat(64), kind: "mind" }, key: "k" } },
    },
  },
  {
    name: "a delivery signed as the bare zone iterate.com is refused, on the Cloud mind's path",
    event: {
      path: `/minds/${ITERATE_ID}/integrations/google/ada@example.com`,
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
      path: `/minds/${ITERATE_ID}/integrations/google/ada@example.com`,
      source: { signer: { principal: { actor: "iterate.example.com", kind: "mind" }, key: "k" } },
    },
  },
  {
    name: "nor the mind form's path with the Cloud key's actor",
    event: {
      path: `/minds/${ITERATE_ID}/integrations/google/ada@example.com`,
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
      path: `/minds/${ITERATE_ID}/integrations/google/ada@example.com/more`,
      source: ITERATE_MIND,
    },
  },
  {
    name: "nor the mind form one segment too short",
    event: { path: `/minds/${ITERATE_ID}/integrations/google`, source: ITERATE_MIND },
  },
  {
    name: "nor the mind's own context for the meld",
    event: { path: `/minds/${ITERATE_ID}`, source: ITERATE_MIND },
  },
] as { name: string; event: Parameters<typeof cloudDeliveryOf>[0]; delivery?: unknown }[])(
  "$name",
  ({ event, delivery = null }) => {
    expect(cloudDeliveryOf(event)).toEqual(delivery);
  },
);

test("iterate's own event that no case of the config takes is logged with why, in either form; another mind's is not", async () => {
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  // nothing is read for such an event: any read throws
  const itx = new Proxy(
    {},
    {
      get: () => {
        throw new Error("read");
      },
    },
  );
  const config = Object.create(Config.prototype) as Config;
  for (const path of [`/minds/${ITERATE_ID}/notes`, "/minds/iterate.iterate.com/notes"])
    await config.processMindEvent({
      event: { type: "events.iterate.com/test/note-added", path, offset: 3, source: ITERATE_MIND },
      mind: ITERATE_ID,
      itx,
    } as never);
  await config.processMindEvent({
    event: {
      type: "events.iterate.com/test/note-added",
      path: `/minds/${"b".repeat(64)}/notes`,
      offset: 4,
      source: { signer: { principal: { actor: "b".repeat(64), kind: "mind" }, key: "k" } },
    },
    mind: "b".repeat(64),
    itx,
  } as never);
  expect(warned.mock.calls.map(([line]) => (line as { path: string }).path)).toEqual([
    `/minds/${ITERATE_ID}/notes`,
    "/minds/iterate.iterate.com/notes",
  ]);
  expect(warned).toHaveBeenCalledWith(
    expect.objectContaining({ event: "config.iterate-event-skipped", why: expect.any(String) }),
  );
  warned.mockRestore();
});

const WORD = "cloud-deliveries:mind-form";

test("a mind with an account connected through the Cloud says once that it reads the mind form", async () => {
  const mind = mindWithCloud();
  await sayMindForm(mind.itx);
  const [asked] = mind.asked;
  expect(asked?.url).toBe(`${CLOUD}/clients/github/ask/mind-form`);
  expect(asked?.method).toBe("POST");
  expect(asked?.headers.get("iterate-connection")).toBe('getSecret("/secrets/github")');
  expect(await asked?.json()).toEqual({ reads: true });
  expect([...mind.kept]).toEqual([[WORD, SAID]]);
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
    kept: [[WORD, SAID]],
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
  expect(mind.kept.get(WORD)).toBe(SAID);
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
  expect([mind.asked.length, mind.kept.get(WORD)]).toEqual([3, SAID]);
});

test("the word is kept with the mind's name: a word for another name, or one that names none, is said again", async () => {
  // a word that names no mind, and a word for another name
  for (const before of ["said", "said templestein.family"]) {
    const mind = mindWithCloud();
    mind.kept.set(WORD, before);
    await sayMindForm(mind.itx);
    expect([mind.asked.length, mind.kept.get(WORD)]).toEqual([1, SAID]);
  }
  // the word for this very name: nothing is asked
  const mind = mindWithCloud();
  mind.kept.set(WORD, SAID);
  await sayMindForm(mind.itx);
  expect(mind.asked).toHaveLength(0);
});

/** The mind's control-plane hostname, and the word kept once the Cloud took it under that name. */
const NAME = "iterate.templestein.family";
const SAID = `said ${NAME}`;

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
      whoami: () => ({ mindSlug: NAME }),
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
