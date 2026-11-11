// The mind's processor and the template's update (template-update.ts): WHEN in an incarnation
// the config repo is compared with the bundled template. The processor runs here with a repo and a
// publisher that record what they are asked.
import type { ItxExpression } from "iterate/expression";
import type { StreamEventInput } from "iterate/stream/processor";
import { expect, test } from "vitest";
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

/** A created mind on `/`, seeded from an older template and untouched since, and the processor
 *  with everything it reaches recorded. `owes`: its newest commit is not published yet. */
function mindOf({ owes }: { owes: boolean }) {
  const asked: string[] = [];
  const committed: unknown[] = [];
  const facts: StreamEventInput[] = [];
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
  // the config repo's facet, as the template's update asks it
  const invoke = async (expression: ItxExpression) => {
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
    // main moved on: the publication is refused, which is an outcome like any other
    head: async () => "another commit",
    files: async () => seeded,
    identityOf: async () => "identity",
    probe: async () => ({}),
    // The platform's fact lands on `/` and is delivered to this processor before the publication's
    // own work returns: the order a root's log gives.
    appendAsPlatform: async () => {
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
    deliver,
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
