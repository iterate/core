// The mind's processor and the template's update (template-update.ts): WHEN in an incarnation
// the config repo is compared with the bundled template. The processor runs here with a repo and a
// publisher that record what they are asked.
import type { ItxExpression } from "iterate/expression";
import type { StreamEventInput } from "iterate/stream/processor";
import { expect, test, vi } from "vitest";
import { MindContract, type MindState } from "./contract.ts";
import { MindProcessor } from "./processor.ts";
import type { MindPublisher } from "./publication.ts";
import type { TemplateKept } from "./template-update.ts";

test("an incarnation whose first wake still owes a publication compares the template when the publication is over, with no further event", async () => {
  const mind = mindOf({ owes: true });
  // the first wake: a commit is owed, so its publication starts and the template waits
  mind.deliver(mind.state);
  await mind.settled();
  expect(mind).toMatchObject({
    // the publication's outcome was delivered while it still ran, and nothing came after it
    asked: ["publication:outcome delivered while it runs", "log", "files"],
    committed: [
      {
        message: "template: core/configs/default",
        parent: "seed",
        changes: [
          { path: "worker.ts", content: "the newer worker\n" },
          { path: "apps/onboarding/app.ts", content: "the onboarding app\n" },
        ],
      },
    ],
    facts: [
      {
        type: "events.iterate.com/mind/template-applied",
        payload: { added: ["apps/onboarding/app.ts"], replaced: ["worker.ts"], leftAlone: [] },
      },
    ],
    kept: { template: "default" },
  });
});

test("with nothing owed, the first wake compares the template at once, and a second pass of the same incarnation does not again", async () => {
  const mind = mindOf({ owes: false });
  mind.deliver(mind.state);
  mind.deliver(mind.state);
  await mind.settled();
  expect(mind).toMatchObject({ asked: ["log", "files"], committed: [{ parent: "seed" }] });
  expect(mind.committed).toHaveLength(1);
});

test("the platform's own template commit that does not load is said as a fact of its own, with why", async () => {
  // main stays at the template's commit, and the config repo it holds does not load
  const mind = mindOf({ owes: false, head: "template" });
  mind.deliver(mind.state);
  await mind.settled();
  expect(mind.committed).toHaveLength(1);
  // the commit's own fact arrives: its publication is owed
  mind.deliver(mind.owing("template", 7));
  await mind.settled();
  expect(mind.platformFacts).toMatchObject([
    {
      type: "events.iterate.com/mind/worker-update-failed",
      payload: { commitOid: "template", generation: 7 },
    },
    {
      type: "events.iterate.com/mind/template-not-published",
      idempotencyKey: "mind/template-not-published:7",
      payload: { template: "default", commitOid: "template" },
    },
  ]);
  // why: the publication's own words
  const [failed, said] = mind.platformFacts.map((fact) => Object(fact.payload).error);
  expect(said).toBe(failed);
  expect(said).toEqual(expect.stringMatching(/\S/));
  expect(mind.kept).toMatchObject({ commit: "template" });
});

test("a template commit that a newer commit replaced is not said so, and neither is somebody's commit that does not load", async () => {
  // main is at another commit when the template's commit is looked at
  const replaced = mindOf({ owes: false, head: "another commit" });
  replaced.deliver(replaced.state);
  await replaced.settled();
  replaced.deliver(replaced.owing("template", 7));
  await replaced.settled();
  expect(replaced.platformFacts.map((fact) => fact.type)).toEqual([
    "events.iterate.com/mind/worker-update-failed",
  ]);
  // somebody's own commit after the template's: its failure is its own fact alone
  const theirs = mindOf({ owes: false, head: "theirs" });
  theirs.deliver(theirs.state);
  await theirs.settled();
  theirs.deliver(theirs.owing("theirs", 9));
  await theirs.settled();
  expect(theirs.platformFacts.map((fact) => fact.type)).toEqual([
    "events.iterate.com/mind/worker-update-failed",
  ]);
});

/** A created mind on `/`, seeded from an older template and untouched since, and the processor
 *  with everything it reaches recorded. `owes`: its newest commit is not published yet. `head`:
 *  the commit main is at when a publication looks (by default another one: main moved on). */
test("the first wake of an incarnation gives the root what refreshes the persons' grants once a day, and a second pass does not again", async () => {
  const mind = mindOf({ owes: false });
  mind.deliver(mind.state);
  mind.deliver(mind.state);
  await mind.settled();
  expect(mind).toMatchObject({
    root: {
      did: [
        // the row fans out: a day whose refresh fails holds no later day
        "row grant-refresh for events.iterate.com/secret/grants-refresh-due, ordered false: itx.builtins.secrets.refreshGrants",
        "schedule grant-refresh every 24 h: events.iterate.com/secret/grants-refresh-due",
      ],
    },
  });
});

test.for([
  ["a schedule of the mind's own under the key is left as it is", { schedule: true }, "row"],
  ["a row that is there is not written again", { row: true }, "schedule"],
] as const)("%s", async ([, there, written]) => {
  const mind = mindOf({ owes: false, there });
  mind.deliver(mind.state);
  await mind.settled();
  expect(mind.root.did.map((done) => done.split(" ")[0])).toEqual([written]);
});

test("a schedule under the key whose fire failed fires no more, so it is set again as it is defined, with the mind's own period", async () => {
  const mind = mindOf({ owes: false, there: { schedule: "failed", row: true } });
  mind.deliver(mind.state);
  await mind.settled();
  expect(mind).toMatchObject({
    root: {
      did: ["schedule grant-refresh every 6 h: events.iterate.com/secret/grants-refresh-due"],
    },
  });
});

test("a root that stays awake looks again an hour after its last look: a schedule that was cancelled since is set again, and within the hour nothing is asked", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // a mind's own schedule under the key (a hold) and the row: the first look writes nothing
    const mind = mindOf({ owes: false, there: { schedule: true, row: true } });
    mind.deliver(mind.state);
    await mind.settled();
    // the hold is cancelled, and the root's object does not start anew: its bridges keep it awake
    mind.root.schedule = undefined;
    vi.setSystemTime(Date.now() + 59 * 60_000);
    mind.deliver(mind.state);
    await mind.settled();
    const withinTheHour = [...mind.root.did];
    vi.setSystemTime(Date.now() + 2 * 60_000);
    mind.deliver(mind.state);
    await mind.settled();

    expect({ withinTheHour, afterIt: mind.root.did }).toEqual({
      withinTheHour: [],
      afterIt: ["schedule grant-refresh every 24 h: events.iterate.com/secret/grants-refresh-due"],
    });
  } finally {
    vi.useRealTimers();
  }
});

test("a mind that is not created yet gets no schedule", async () => {
  const mind = mindOf({ owes: false });
  mind.deliver({ ...mind.state, creation: { status: "failed", offset: 2 } });
  await mind.settled();
  expect(mind).toMatchObject({ root: { did: [] } });
});

function mindOf({
  owes,
  head = "another commit",
  there = {},
}: {
  owes: boolean;
  head?: string;
  /** What the root holds already under the daily refresh's key and name. The schedule is the
   *  mind's own, every six hours; `failed`: its last fire failed, so it is parked. */
  there?: { schedule?: true | "failed"; row?: true };
}) {
  const asked: string[] = [];
  const committed: unknown[] = [];
  const facts: StreamEventInput[] = [];
  const platformFacts: StreamEventInput[] = [];
  const background: Promise<unknown>[] = [];
  let kept: TemplateKept | undefined;
  const seeded = { "worker.ts": "the older worker\n" };
  const state: MindState = MindContract.stateSchema.parse({
    creation: { status: "created", offset: 2 },
    configRepoTip: { commitOid: "seed", offset: 5 },
    unpublishedCommits: owes ? [{ commitOid: "seed", offset: 5 }] : [],
    lastPublicationFactOffset: owes ? null : 6,
    publishedCommit: owes ? null : "seed",
  });
  // The root's own schedules and rows, as the daily refresh of the grants asks for them: what it
  // read and what it wrote, in order.
  const root = { schedule: there.schedule, row: there.row, did: [] as string[] };
  const ofTheRoot = (expression: ItxExpression): { answer: unknown } | undefined => {
    const [registry, last] = [expression[2], expression.at(-1)];
    const [verb, argument] = Array.isArray(last) ? last : [];
    if (registry === "subscriptions" && verb === "get") return { answer: root.row ? {} : null };
    if (registry === "schedules" && verb === "get")
      return {
        answer: root.schedule
          ? {
              key: "grant-refresh",
              when: { everyMs: 6 * 3_600_000 },
              events: [{ type: "events.iterate.com/secret/grants-refresh-due", payload: {} }],
              ...(root.schedule === "failed" && {
                failure: { error: "the append was refused", offset: 9 },
              }),
            }
          : null,
      };
    if (registry === "schedules" && verb === "set") {
      const { key, when, events } = argument as {
        key: string;
        when: { everyMs: number };
        events: { type: string }[];
      };
      root.did.push(`schedule ${key} every ${when.everyMs / 3_600_000} h: ${events[0]?.type}`);
      return { answer: { key } };
    }
    if (verb === "append") {
      const { payload } = argument as {
        payload: { name: string; consumes: string[]; ordered: boolean; target: string[] };
      };
      root.did.push(
        `row ${payload.name} for ${payload.consumes.join(",")}, ordered ${payload.ordered}: ${payload.target.join(".")}`,
      );
      return { answer: [] };
    }
    return undefined;
  };
  // the config repo's facet, as the template's update asks it
  const invoke = async (expression: ItxExpression) => {
    const rootsOwn = ofTheRoot(expression);
    if (rootsOwn) return rootsOwn.answer;
    const [verb, argument] = expression.at(-1) as [string, Record<string, unknown>];
    if (verb === "commitFiles") {
      committed.push(argument);
      return { commitOid: "template", changedPaths: [] };
    }
    asked.push(verb);
    if (verb === "log")
      return [
        {
          oid: "seed",
          message: "seed: core/configs/default",
          author: { email: "config@iterate.com" },
          parents: [],
        },
      ];
    if (verb === "files") return seeded;
    throw new Error(`the test's repo has no ${verb}`);
  };
  const deliver = (delivered: MindState) =>
    processor.processEvent({
      state: delivered,
      delivery: { caughtUp: true },
      append: async (...events: StreamEventInput[]) => void facts.push(...events),
      runInBackground: (work: () => Promise<unknown>) => void background.push(work()),
    } as unknown as Parameters<MindProcessor["processEvent"]>[0]);
  const publisher: MindPublisher = {
    // by default main moved on: the publication is refused, which is an outcome like any other.
    // A commit that main is at does not load here: the probe below answers nothing of a config.
    head: async () => head,
    files: async () => seeded,
    identityOf: async () => "identity",
    probe: async () => ({}),
    // The platform's fact lands on `/` and is delivered to this processor before the publication's
    // own work returns: the order a root's log gives.
    appendAsPlatform: async (...events: StreamEventInput[]) => {
      platformFacts.push(...events);
      asked.push("publication:outcome delivered while it runs");
      deliver({ ...state, unpublishedCommits: [], lastPublicationFactOffset: 6 });
    },
  };
  const processor = new MindProcessor(
    () => ({ invoke, [Symbol.dispose]() {} }) as unknown as ReturnType<ItxScope>,
    () => publisher,
    {
      template: async () => kept,
      keepTemplate: async (next) => void (kept = next),
    },
    // the build's templates: one, with a file newer than the repo's and a file the repo lacks
    {
      default: [
        { path: "worker.ts", content: "the newer worker\n" },
        { path: "apps/onboarding/app.ts", content: "the onboarding app\n" },
      ],
    },
  );
  return {
    state,
    asked,
    committed,
    facts,
    platformFacts,
    root,
    deliver,
    /** The state once the fact of commit `commitOid` arrived at `offset`: its publication is owed. */
    owing: (commitOid: string, offset: number): MindState => ({
      ...state,
      configRepoTip: { commitOid, offset },
      unpublishedCommits: [{ commitOid, offset }],
    }),
    get kept() {
      return kept;
    },
    /** Every piece of background work the processor started has ended, with what it started. */
    async settled() {
      for (let seen = 0; seen < background.length; seen = background.length)
        await Promise.all(background);
    },
  };
}

type ItxScope = ConstructorParameters<typeof MindProcessor>[0];
