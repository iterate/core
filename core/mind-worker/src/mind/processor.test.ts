// The mind's processor and the template's update (template-update.ts): WHEN in an incarnation
// the config repo is compared with the bundled template. The processor runs here with a repo and a
// publisher that record what they are asked.
import { Redacted } from "iterate/app-config";
import type { ItxExpression } from "iterate/expression";
import { identityHashOf, type SignedRecord } from "iterate/mind-identity";
import { ProcessorEngine, type StreamEvent, type StreamEventInput } from "iterate/stream/processor";
import { memoryStorage, memoryStream } from "iterate/stream/test-support";
import { expect, test, vi } from "vitest";
import { newIdentityLog } from "../../../lib/src/test-support/identity-log.ts";
import { rootWakeEvents } from "./context-birth-events.ts";
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
  // main is at another commit when the template's commit is looked at, and that commit's fact came
  const replaced = mindOf({ owes: false, head: "another commit" });
  replaced.deliver(replaced.state);
  await replaced.settled();
  replaced.deliver(replaced.owing("template", 7, { commitOid: "another commit", offset: 8 }));
  await replaced.settled();
  // the template's commit is superseded, and the newer commit does not load: its own failure
  expect(replaced.platformFacts.map((fact) => [fact.type, Object(fact.payload).commitOid])).toEqual(
    [
      ["events.iterate.com/mind/worker-update-failed", "template"],
      ["events.iterate.com/mind/worker-update-failed", "another commit"],
    ],
  );
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

test("a publication keeps the entry module's files after its probe passed and before it appends the pointer", async () => {
  const mind = mindOf({ owes: true, head: "seed", probed: aConfig });
  mind.deliver(mind.state);
  await mind.settled();
  expect({
    published: mind.published,
    facts: mind.platformFacts.map((fact) => fact.type),
  }).toEqual({
    published: ["files", "identity worker.ts", "probe", "keep worker.ts", "append"],
    facts: [
      "events.iterate.com/itx/rewrite-rule-configured",
      "events.iterate.com/itx/rewrite-rule-configured",
      "events.iterate.com/mind/worker-updated",
    ],
  });
});

test("a commit whose class lacks an abstract method is published, and its worker-updated names what it lacks, once for the commit; a commit with all three names nothing", async () => {
  const lacking = mindOf({
    owes: true,
    head: "seed",
    probed: { ...aConfig, missing: ["email", "processEvent"] },
  });
  lacking.deliver(lacking.state);
  await lacking.settled();
  expect(lacking.platformFacts.at(-1)).toMatchObject({
    type: "events.iterate.com/mind/worker-updated",
    idempotencyKey: "mind/publication:5",
    payload: { commitOid: "seed", missing: ["email", "processEvent"] },
  });
  const whole = mindOf({ owes: true, head: "seed", probed: aConfig });
  whole.deliver(whole.state);
  await whole.settled();
  expect(whole.platformFacts.at(-1)).toMatchObject({
    type: "events.iterate.com/mind/worker-updated",
  });
  expect(whole.platformFacts.at(-1)!.payload).not.toHaveProperty("missing");
});

test("a publication whose probe is refused keeps nothing", async () => {
  const mind = mindOf({
    owes: true,
    head: "seed",
    probed: { ...aConfig, configEntrypoint: false },
  });
  mind.deliver(mind.state);
  await mind.settled();
  expect(mind).toMatchObject({
    published: ["files", "identity worker.ts", "probe", "append"],
    platformFacts: [{ type: "events.iterate.com/mind/worker-update-failed" }],
  });
});

test("a head read behind the commit's own fact, its parent, is read again, and the commit publishes", async () => {
  vi.useFakeTimers();
  try {
    const mind = mindOf({ owes: true, head: ["parent", "seed"], probed: aConfig });
    mind.deliver(mind.state);
    await vi.advanceTimersByTimeAsync(6_000);
    await mind.settled();
    expect({
      headReads: mind.headReads,
      facts: mind.platformFacts.map((fact) => fact.type),
    }).toEqual({
      headReads: 2,
      facts: [
        "events.iterate.com/itx/rewrite-rule-configured",
        "events.iterate.com/itx/rewrite-rule-configured",
        "events.iterate.com/mind/worker-updated",
      ],
    });
  } finally {
    vi.useRealTimers();
  }
});

test("a commit whose newer commit's fact came is still a supersession, with its words, and its head is not read", async () => {
  const mind = mindOf({ owes: false, head: "newer", probed: aConfig });
  mind.deliver(mind.owing("seed", 5, { commitOid: "newer", offset: 8 }));
  await mind.settled();
  expect({
    headReads: mind.headReads,
    facts: mind.platformFacts.map((fact) => fact.type),
    first: mind.platformFacts[0],
  }).toEqual({
    // the newer commit's own publication reads it once
    headReads: 1,
    facts: [
      "events.iterate.com/mind/worker-update-failed",
      "events.iterate.com/itx/rewrite-rule-configured",
      "events.iterate.com/itx/rewrite-rule-configured",
      "events.iterate.com/mind/worker-updated",
    ],
    first: superseded("seed", 5, "newer"),
  });
});

test("a commit left owed by its bounded give-up, and overtaken by a newer commit that published, is settled at the next incarnation with one event and no read", async () => {
  vi.useFakeTimers();
  try {
    // nine reads behind the seed's fact, then main at the newer commit
    const heads = [...Array.from({ length: 9 }, () => "parent"), "newer"];
    const mind = mindOf({ owes: true, head: heads, probed: aConfig });
    mind.deliver(mind.state);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await mind.settled();
    expect(mind.current).toMatchObject({ unpublishedCommits: [{ commitOid: "seed", offset: 5 }] });
    // the newer commit's fact, in the same incarnation: it publishes, and the seed stays owed
    mind.deliver({
      ...mind.current,
      configRepoTip: { commitOid: "newer", offset: 8 },
      unpublishedCommits: [...mind.current.unpublishedCommits, { commitOid: "newer", offset: 8 }],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await mind.settled();
    expect(mind.current).toMatchObject({
      publishedCommit: "newer",
      unpublishedCommits: [{ commitOid: "seed", offset: 5 }],
    });
    const before = { reads: mind.headReads, facts: mind.platformFacts.length };
    mind.restart();
    mind.deliver(mind.current);
    await vi.advanceTimersByTimeAsync(1_000);
    await mind.settled();
    expect({
      reads: mind.headReads - before.reads,
      facts: mind.platformFacts.slice(before.facts),
      owed: mind.current.unpublishedCommits,
    }).toEqual({ reads: 0, facts: [superseded("seed", 5, "newer")], owed: [] });
  } finally {
    vi.useRealTimers();
  }
});

test("a checkpoint of the older build that holds an owed commit a newer one overtook settles it at its first wake, with one event and no read", async () => {
  const mind = mindOf({ owes: false, head: "newer", probed: aConfig });
  // a state that owes the seed (offset 5) while a newer commit (offset 8) is the tip and published
  const checkpoint: MindState = {
    ...mind.state,
    configRepoTip: { commitOid: "newer", offset: 8 },
    unpublishedCommits: [{ commitOid: "seed", offset: 5 }],
    publishedCommit: "newer",
  };
  mind.deliver(checkpoint);
  await mind.settled();
  expect({
    reads: mind.headReads,
    facts: mind.platformFacts,
    owed: mind.current.unpublishedCommits,
  }).toEqual({ reads: 0, facts: [superseded("seed", 5, "newer")], owed: [] });
});

test("a head that stays behind is read on the publication's bounded waits, each give-up is said as unavailable, and the commit stays owed", async () => {
  vi.useFakeTimers();
  try {
    const mind = mindOf({ owes: true, head: "parent", probed: aConfig });
    mind.deliver(mind.state);
    // three runs of three reads (0, 5 and 30 s), 30 s apart: 165 s
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await mind.settled();
    const failed = {
      type: "events.iterate.com/mind/worker-update-failed",
      payload: {
        commitOid: "seed",
        generation: 5,
        error: "the config repo's main read parent, not seed, and no newer commit of it is known",
        unavailable: true,
      },
    };
    expect({ headReads: mind.headReads, facts: mind.platformFacts }).toEqual({
      headReads: 9,
      facts: [failed, failed, failed],
    });
  } finally {
    vi.useRealTimers();
  }
});

/** A created mind on `/`, seeded from an older template and untouched since, and the processor
 *  with everything it reaches recorded. `owes`: its newest commit is not published yet. `head`:
 *  the commit main is at when a publication looks (by default the seed). */
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

test("each deploy lands one `mind/stack-deployed` on `/`, with the config's secrets redacted, and the state keeps the latest", async () => {
  const config = {
    mindId: "a".repeat(64),
    controlPlaneHostname: "iterate.example.com",
    zones: ["example.com", "example.org"],
    ownerEmails: ["ada@elsewhere.example"],
    topology: "full-cloudflare",
    signingKey: new Redacted("the-signing-key"),
  };
  const [first] = rootWakeEvents(config, "version-1");
  expect(first).toEqual({
    type: "events.iterate.com/mind/stack-deployed",
    idempotencyKey: "mind/stack-deployed:version-1",
    payload: { config: { ...config, signingKey: "REDACTED" }, versionId: "version-1" },
  });
  expect(JSON.stringify(first)).not.toContain("the-signing-key");
  // a new engine on new storage reduces the whole log, through the contract's own `consumes`
  const root = memoryStream("/");
  const stackAfter = async (events: StreamEventInput[]) => {
    root.stream.append(...events);
    const processor = new MindProcessor(
      () => {
        throw new Error("the reduce reaches no context");
      },
      () => ({}) as MindPublisher,
      { template: async () => undefined, keepTemplate: async () => {} },
      {},
    );
    const engine = new ProcessorEngine(processor, {
      stream: root.stream,
      storage: memoryStorage(),
    });
    return (await engine.snapshot()).state.stack;
  };
  expect(await stackAfter([])).toBeNull();
  expect(await stackAfter(rootWakeEvents(config, "version-1"))).toMatchObject({
    versionId: "version-1",
    config: { zones: ["example.com", "example.org"], signingKey: "REDACTED" },
  });
  const moved = { ...config, zones: ["example.com"] };
  expect(await stackAfter(rootWakeEvents(moved, "version-2"))).toEqual({
    versionId: "version-2",
    config: { ...moved, signingKey: "REDACTED" },
  });
});

test("the root keeps a log for each mind id and never empties one: after one id's genesis, another id's genesis and a further record of the first, it holds both logs, whatever the deploys named", async () => {
  const [first, other] = [await newIdentityLog(), await newIdentityLog()];
  const second = await first.next(first.genesis, { alsoKnownAs: ["did:example:ada"] });
  const third = await first.next(second, { alsoKnownAs: [] });
  const deployed = (mindId: string, versionId: string) =>
    rootWakeEvents(
      {
        mindId,
        controlPlaneHostname: "iterate.example.com",
        zones: ["example.com"],
        ownerEmails: ["ada@elsewhere.example"],
        topology: "full-cloudflare",
      },
      versionId,
    );
  const accepted = async (signed: SignedRecord, mind: string) => ({
    type: "events.iterate.com/mind/identity-record-accepted",
    // as the append boundary stamps the platform's own append
    source: { platform: true as const },
    payload: {
      mind,
      hash: await identityHashOf(signed.record),
      record: signed.record,
      signatures: signed.signatures,
      signedBy: [],
    },
  });
  const root = memoryStream("/");
  // a new engine on new storage reduces the whole log, through the contract's own `consumes`
  const identitiesAfter = async (...events: StreamEventInput[]) => {
    root.stream.append(...events);
    const processor = new MindProcessor(
      () => {
        throw new Error("the reduce reaches no context");
      },
      () => ({}) as MindPublisher,
      { template: async () => undefined, keepTemplate: async () => {} },
      {},
    );
    const engine = new ProcessorEngine(processor, {
      stream: root.stream,
      storage: memoryStorage(),
    });
    return (await engine.snapshot()).state.identities;
  };
  const born = {
    head: first.mind,
    position: 1,
    current: JSON.parse(first.genesis.record),
    refused: null,
  };
  // a record folds into the log of its own mind id, with no deploy before it
  expect(await identitiesAfter(await accepted(first.genesis, first.mind))).toEqual({
    [first.mind]: born,
  });
  // A deploy names the first id, then the other id, then the first again by the Worker's first
  // version, whose record the log holds already. None of that touches a log.
  const otherBorn = {
    head: other.mind,
    position: 1,
    current: JSON.parse(other.genesis.record),
    refused: null,
  };
  expect(
    await identitiesAfter(
      ...deployed(first.mind, "version-1"),
      ...deployed(other.mind, "version-2"),
      await accepted(other.genesis, other.mind),
      ...deployed(first.mind, "version-1"),
    ),
  ).toEqual({ [first.mind]: born, [other.mind]: otherBorn });
  // the third record before the second is not the next: it stays in the log, and is not folded
  expect(await identitiesAfter(await accepted(third, first.mind))).toMatchObject({
    [first.mind]: { position: 1 },
  });
  const grown = {
    head: await identityHashOf(second.record),
    position: 2,
    current: JSON.parse(second.record),
    refused: null,
  };
  expect(await identitiesAfter(await accepted(second, first.mind))).toEqual({
    [first.mind]: grown,
    [other.mind]: otherBorn,
  });
  // an event of either type that the platform did not write is passed over
  const { source: _stamp, ...unstamped } = await accepted(third, first.mind);
  expect(
    await identitiesAfter(unstamped, {
      type: "events.iterate.com/mind/identity-record-refused",
      payload: { mind: first.mind, reason: "forged", message: "a sentence" },
    }),
  ).toEqual({ [first.mind]: grown, [other.mind]: otherBorn });
  const [refusedEvent] = await root.stream.append({
    type: "events.iterate.com/mind/identity-record-refused",
    source: { platform: true },
    payload: { mind: first.mind, reason: "not-next", message: "a sentence" },
  });
  expect(await identitiesAfter()).toEqual({
    [first.mind]: { ...grown, refused: { offset: refusedEvent!.offset, reason: "not-next" } },
    [other.mind]: otherBorn,
  });
  // the same record again, as an append that was not said to be stored: nothing changes
  expect(await identitiesAfter(await accepted(second, first.mind))).toMatchObject({
    [first.mind]: { position: 2 },
  });
});

test("a root born before the identity events gets them: at its first wake its own row takes the contract's types, so an identity event is in the batch that its span of the log is delivered as", async () => {
  const log = await newIdentityLog();
  const deployed = rootWakeEvents(
    {
      mindId: log.mind,
      controlPlaneHostname: "iterate.example.com",
      zones: ["example.com"],
      ownerEmails: ["ada@elsewhere.example"],
      topology: "full-cloudflare",
    },
    "version-2",
  );
  // THE ROOT AS A BUILD BEFORE THE IDENTITY EVENTS LEFT IT: its own row with the event types of
  // its birth, and a checkpoint of contract version 1, whose state has no `identities`.
  const { root, storage, row, pushed } = rootWithRow([
    ...MindContract.consumes.filter(
      (type) =>
        type !== "events.iterate.com/mind/identity-record-accepted" &&
        type !== "events.iterate.com/mind/identity-record-refused",
    ),
    "events.iterate.com/itx/woken",
  ]);
  const before = (await root.stream.append({
    type: "events.iterate.com/mind/sandbox-image-configured",
    payload: { image: null },
  })) as StreamEvent[];
  const { identities: _absent, ...stateOfVersion1 } = MindContract.stateSchema.parse({});
  storage.write(
    "mind",
    { reducerVersion: "1", reducedThroughOffset: before.at(-1)!.offset },
    stateOfVersion1,
    true,
  );
  let incarnation = incarnationOf({ root, storage, row });

  // THE DEPLOY OF THIS CODE: the root wakes, and its row is written once
  await pushed(incarnation, [{ type: "events.iterate.com/itx/woken", payload: {} }, ...deployed]);
  await incarnation.settled();
  expect(row).toMatchObject({
    did: ["processors.enable mind"],
    written: 1,
    consumes: [...MindContract.consumes, "events.iterate.com/itx/woken"],
  });

  // THE GENESIS, THEN AN ORDINARY EVENT, in one span of the log, as a row delivers them. With
  // the row of the root's birth the genesis would not be in the batch, and the checkpoint
  // would pass it.
  await pushed(incarnation, [
    {
      type: "events.iterate.com/mind/identity-record-accepted",
      source: { platform: true },
      payload: {
        mind: log.mind,
        hash: log.mind,
        record: log.genesis.record,
        signatures: log.genesis.signatures,
        signedBy: [],
      },
    },
    { type: "events.iterate.com/mind/sandbox-image-configured", payload: { image: null } },
  ]);
  expect((await incarnation.engine.snapshot()).state.identities).toMatchObject({
    [log.mind]: { head: log.mind, position: 1 },
  });
  // a restart: the checkpoint holds it, and the row is right, so it is not written again
  incarnation = incarnationOf({ root, storage, row });
  await pushed(incarnation, [{ type: "events.iterate.com/itx/woken", payload: {} }]);
  await incarnation.settled();
  expect((await incarnation.engine.snapshot()).state.identities).toMatchObject({
    [log.mind]: { head: log.mind, position: 1 },
  });
  expect(row).toMatchObject({ did: Array(2).fill("processors.enable mind"), written: 1 });
});

test("a root that could not look at its own row looks again at its next pass, and then no more in that incarnation", async () => {
  const { root, storage, row, pushed } = rootWithRow([
    ...MindContract.consumes,
    "events.iterate.com/itx/woken",
  ]);
  row.down = true;
  const incarnation = incarnationOf({ root, storage, row });
  const pass = {
    type: "events.iterate.com/mind/sandbox-image-configured",
    payload: { image: null },
  };
  await pushed(incarnation, [pass]);
  await incarnation.settled();
  expect(row).toMatchObject({ did: [] });
  row.down = false;
  await pushed(incarnation, [pass]);
  await incarnation.settled();
  await pushed(incarnation, [pass]);
  await incarnation.settled();
  expect(row).toMatchObject({ did: ["processors.enable mind"], written: 0 });
});

test("the latest `mind/sandbox-image-configured` on `/` names the image the mind's sandboxes start on, and null gives the stack's own back", async () => {
  const root = memoryStream("/");
  const configured = (image: string | null) => ({
    type: "events.iterate.com/mind/sandbox-image-configured",
    payload: { image },
  });
  // a new engine on new storage reduces the whole log, through the contract's own `consumes`
  const imageAfter = async (event: StreamEventInput) => {
    root.stream.append(event);
    const processor = new MindProcessor(
      () => {
        throw new Error("the reduce reaches no context");
      },
      () => ({}) as MindPublisher,
      { template: async () => undefined, keepTemplate: async () => {} },
      {},
    );
    const engine = new ProcessorEngine(processor, {
      stream: root.stream,
      storage: memoryStorage(),
    });
    return (await engine.snapshot()).state.sandboxImage;
  };
  expect({
    first: await imageAfter(configured("registry.cloudflare.com/account/first@sha256:digest")),
    latest: await imageAfter(configured("registry.cloudflare.com/account/latest@sha256:digest")),
    cleared: await imageAfter(configured(null)),
  }).toEqual({
    first: "registry.cloudflare.com/account/first@sha256:digest",
    latest: "registry.cloudflare.com/account/latest@sha256:digest",
    cleared: null,
  });
});

test("a mind that is not created yet gets no schedule", async () => {
  const mind = mindOf({ owes: false });
  mind.deliver({ ...mind.state, creation: { status: "failed", offset: 2 } });
  await mind.settled();
  expect(mind).toMatchObject({ root: { did: [] } });
});

/** A ROOT WITH ITS OWN SUBSCRIPTION ROW, as the kernel delivers through one: a span of the log
 *  goes to the processor as the events of the span whose types the row names, with the span's
 *  whole range, so the processor's cursor passes an event that the row left out. `row.did` is
 *  what was asked of the row, and `row.written` how often it was written; `row.down`: the root
 *  cannot be asked. */
function rootWithRow(consumes: string[]) {
  const row = { consumes, did: [] as string[], written: 0, down: false };
  const root = memoryStream("/");
  const storage = memoryStorage();
  /** Appends `events` as one span and delivers it through the row. */
  const pushed = async (
    { engine }: Pick<Incarnation, "engine">,
    events: StreamEventInput[],
  ): Promise<void> => {
    const committed = (await root.stream.append(...events)) as StreamEvent[];
    await engine.processEventBatch(
      committed.filter(({ type }) => row.consumes.includes(type)),
      { after: committed[0]!.offset - 1, through: committed.at(-1)!.offset },
    );
  };
  return { root, storage, row, pushed };
}

type Incarnation = { engine: ProcessorEngine<MindState>; settled: () => Promise<void> };

/** ONE INCARNATION OF THE ROOT'S MIND PROCESSOR on the root's log and checkpoint: a new
 *  processor and a new engine, as after a restart. `settled` waits for the work it started in
 *  the background. */
function incarnationOf({
  root,
  storage,
  row,
}: Pick<ReturnType<typeof rootWithRow>, "root" | "storage" | "row">): Incarnation {
  const invoke = async (expression: ItxExpression) => {
    const [registry, last] = [expression[2], expression.at(-1)];
    const [verb, name] = Array.isArray(last) ? last : [];
    if (registry !== "processors" || verb !== "enable" || name !== "mind")
      throw new Error(`the test's root has no ${JSON.stringify(expression)}`);
    if (row.down) throw new Error("the root was not reached");
    row.did.push("processors.enable mind");
    // as the kernel's `processors.enable` does: the row is written when its types are not the
    // contract's (core/itx src/context/built-ins.ts)
    const consumes = [...MindContract.consumes, "events.iterate.com/itx/woken"];
    if (JSON.stringify(row.consumes) === JSON.stringify(consumes)) return { name };
    row.consumes = consumes;
    row.written += 1;
    return { name };
  };
  return {
    engine: new ProcessorEngine(
      new MindProcessor(
        () => ({ invoke, [Symbol.dispose]() {} }) as unknown as ReturnType<ItxScope>,
        () => ({}) as MindPublisher,
        { template: async () => undefined, keepTemplate: async () => {} },
        {},
      ),
      { stream: root.stream, storage, fedByPushes: true },
    ),
    // the engine's own background work
    settled: () => new Promise((resolve) => setTimeout(resolve, 20)),
  };
}

function mindOf({
  owes,
  head = "seed",
  there = {},
  probed = {},
}: {
  owes: boolean;
  /** What each read of main's head answers, in turn; the last answer stays. */
  head?: string | string[];
  /** What the publication's probe answers: by default nothing of a config, so it is refused. */
  probed?: unknown;
  /** What the root holds already under the daily refresh's key and name. The schedule is the
   *  mind's own, every six hours; `failed`: its last fire failed, so it is parked. */
  there?: { schedule?: true | "failed"; row?: true };
}) {
  const asked: string[] = [];
  /** What the publication asked of its publisher, in order. */
  const published: string[] = [];
  const committed: unknown[] = [];
  const facts: StreamEventInput[] = [];
  const platformFacts: StreamEventInput[] = [];
  const background: Promise<unknown>[] = [];
  let kept: TemplateKept | undefined;
  const seeded = { "worker.ts": "the older worker\n" };
  let headReads = 0;
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
    // the root's own row, which every incarnation compares with the contract once
    if (registry === "processors" && verb === "enable") return { answer: { name: argument } };
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
  // the state last delivered, which the platform's facts reduce onto, each at the next offset
  let current = state;
  let nextOffset = 100;
  const deliver = (delivered: MindState) =>
    (current = delivered) &&
    processor.processEvent({
      state: delivered,
      delivery: { caughtUp: true },
      append: async (...events: StreamEventInput[]) => void facts.push(...events),
      runInBackground: (work: () => Promise<unknown>) => void background.push(work()),
    } as unknown as Parameters<MindProcessor["processEvent"]>[0]);
  const publisher: MindPublisher = {
    // A commit that main is at does not load here unless `probed` says so: by default the probe
    // answers nothing of a config, and the publication is refused, an outcome like any other.
    head: async () => {
      headReads += 1;
      return typeof head === "string" ? head : head[Math.min(headReads, head.length) - 1]!;
    },
    files: async () => {
      published.push("files");
      return seeded;
    },
    identityOf: async (_files, mainModule) => {
      published.push(`identity ${mainModule}`);
      return "identity";
    },
    probe: async () => {
      published.push("probe");
      return probed;
    },
    keepModules: async (_files, mainModule) => void published.push(`keep ${mainModule}`),
    // The platform's fact lands on `/` and is delivered to this processor before the publication's
    // own work returns: the order a root's log gives.
    appendAsPlatform: async (...events: StreamEventInput[]) => {
      published.push("append");
      platformFacts.push(...events);
      asked.push("publication:outcome delivered while it runs");
      let reduced = current;
      for (const event of events)
        reduced =
          processor.reduce({
            event: { ...event, offset: nextOffset++ } as unknown as Parameters<
              MindProcessor["reduce"]
            >[0]["event"],
            state: reduced,
          } as Parameters<MindProcessor["reduce"]>[0]) || reduced;
      deliver(reduced);
    },
  };
  const incarnation = () =>
    new MindProcessor(
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
  let processor = incarnation();
  return {
    state,
    asked,
    published,
    committed,
    facts,
    platformFacts,
    root,
    deliver,
    /** The state once the fact of commit `commitOid` arrived at `offset`: its publication is owed.
     *  `newer`: the fact of a commit after it arrived too. */
    owing: (
      commitOid: string,
      offset: number,
      newer?: { commitOid: string; offset: number },
    ): MindState => ({
      ...state,
      configRepoTip: newer || { commitOid, offset },
      unpublishedCommits: [{ commitOid, offset }, ...(newer ? [newer] : [])],
    }),
    get kept() {
      return kept;
    },
    /** The state last delivered, with the platform's facts reduced onto it. */
    get current() {
      return current;
    },
    /** A new incarnation of the root: a new processor over the same repo, publisher and storage. */
    restart() {
      processor = incarnation();
    },
    /** How many times a publication read main's head. */
    get headReads() {
      return headReads;
    },
    /** Every piece of background work the processor started has ended, with what it started. */
    async settled() {
      for (let seen = 0; seen < background.length; seen = background.length)
        await Promise.all(background);
    },
  };
}

type ItxScope = ConstructorParameters<typeof MindProcessor>[0];

// what the probe answers of a config whose entry is an IterateConfigEntrypoint that constructs
const aConfig = { configEntrypoint: true, constructError: null, classes: {} };

// the refusal of a commit that a newer commit superseded
const superseded = (commitOid: string, generation: number, by: string) => ({
  type: "events.iterate.com/mind/worker-update-failed",
  idempotencyKey: `mind/publication:${generation}`,
  payload: {
    commitOid,
    generation,
    error: `main moved on to ${by} before this commit was published`,
  },
});
