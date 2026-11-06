// context/worker-loader.test.ts — the Worker Loader id is an authority boundary (two callers who
// compose one id share an isolate), a producer runs inside `getCode`, the dead-id WORKAROUND
// (worker-loader.ts `loaderIdGenerations`), and `workers.get`'s recovery from the loader defect
// (built-ins.ts), over a fake loader; the real one is the Workers suite's.
import { createHash } from "node:crypto";
import { waitUntil } from "cloudflare:workers";
import type { ItxExpression, ItxExpressionStep } from "iterate/expression";
import { codedError, errorCode } from "iterate/lib";
import { failureKind } from "iterate/platform-retry";
import { transform } from "sucrase";
import { expect, test, vi } from "vitest";
import type { Caller } from "../caller.ts";
import { workersRoot } from "./built-ins.ts";
import { SOURCE_MAX_CHARS } from "./itx-expression-rewriting.ts";
import { DurableObjectNameCodec } from "./paths.ts";
import {
  assertFacetSourceWithinCeiling,
  isLoadedWorkerPlatformFailure,
  LOADED_CODE_FORMAT,
  loadedIdentityChanges,
  moduleIdentityOf,
  prepareConfinedWorker,
} from "./worker-loader.ts";

// sucrase's transform, counted: a load that reads the resolved memo runs none. The resolver takes
// no transform to inject, and that CPU is what the memo saves, so the count is of sucrase itself.
// oxlint-disable-next-line iterate/no-vi-mock -- the one way to observe that no transform ran
vi.mock("sucrase", async (original) => {
  const sucrase = await original<typeof import("sucrase")>();
  return { ...sucrase, transform: vi.fn(sucrase.transform) };
});

test("two literal sources whose djb2 hashes collide never share one Worker Loader cacheKey", async () => {
  // djb2("Aa") === djb2("B@") — one 32-bit hash, two sources.
  const { env, keys } = fakeLoaderEnv();
  await loadConfined(env, {
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "Aa" },
  });
  await loadConfined(env, {
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "B@" },
  });
  expect(new Set(keys)).toMatchObject({ size: 2 });
});

test("a worker's package.json `compatibilityFlags` set the loaded isolate's flags; the default keeps Node compat off; the SDK's flags are always present", async () => {
  const on = fakeLoaderEnv();
  await loadConfined(on.env, {
    source: {
      "package.json": '{"main":"worker.js","compatibilityFlags":["nodejs_compat"]}',
      "worker.js": "export default 1;",
    },
  });
  const onConfig = (await on.warm.get(on.keys[0]!)) as { compatibilityFlags: string[] };
  expect(onConfig.compatibilityFlags).toContain("nodejs_compat");
  expect(onConfig.compatibilityFlags).not.toContain("no_nodejs_compat");
  // the SDK's required flags are force-added whatever the worker declares
  expect(onConfig).toMatchObject({
    compatibilityFlags: expect.arrayContaining(["nodejs_als", "allow_irrevocable_stub_storage"]),
  });

  const off = fakeLoaderEnv();
  await loadConfined(off.env, {
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default 1;" },
  });
  const offConfig = (await off.warm.get(off.keys[0]!)) as { compatibilityFlags: string[] };
  expect(offConfig.compatibilityFlags).toContain("no_nodejs_compat");
  expect(offConfig.compatibilityFlags).not.toContain("nodejs_compat");
  expect(offConfig.compatibilityFlags).toContain("nodejs_als");
});

test("a worker whose compatibilityFlags disable a flag the SDK needs is refused", async () => {
  const { env, warm, keys } = fakeLoaderEnv();
  await loadConfined(env, {
    source: {
      "package.json": '{"main":"worker.js","compatibilityFlags":["no_nodejs_als"]}',
      "worker.js": "export default 1;",
    },
  });
  await expect(warm.get(keys[0]!)).rejects.toThrow(/nodejs_als/);
});

test("an owner and a caller's cacheKey that concatenate alike never share one Worker Loader cacheKey", async () => {
  // owner "…/x" + key "y:z" vs owner "…/x:y" + key "z": joined with ":" they would spell ONE id.
  const { env, keys } = fakeLoaderEnv();
  const source = {
    "package.json": '{"main":"worker.js"}',
    "worker.js": "export default class W {}",
  };
  await loadConfined(env, { owner: "prj_u.iterate/x", cacheKey: "y:z", source });
  await loadConfined(env, { owner: "prj_u.iterate/x:y", cacheKey: "z", source });
  expect(new Set(keys)).toMatchObject({ size: 2 });
});

test("two DIFFERENT facet identities never share one Worker Loader cacheKey", async () => {
  // context "/x:y" + class "Tally" vs context "/x" + class "y:Tally": a naive `${context}:${class}`
  // owner composes the IDENTICAL "prj_u.iterate/x:y:Tally" — the second caller would reuse the
  // first's isolate, a silent cross-context authority transfer. Same shared source (identical
  // contentHash), as in prod.
  const { env, keys } = fakeLoaderEnv();
  const modules = {
    "package.json": '{"main":"worker.js"}',
    "worker.js": "export default class Tally {}",
  };
  const load = (iterateContextName: string, className: string) =>
    loadConfined(env, {
      kind: "facet",
      owner: [iterateContextName, className],
      source: modules,
      where: `facet "${className}"`,
    });
  await load(DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x:y" }), "Tally");
  await load(DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x" }), "y:Tally");
  // distinct — each half is its own JSON string in the id
  const [first, second] = keys;
  expect(keys).toHaveLength(2);
  expect(first).not.toBe(second);
});

test("a producer source runs INSIDE getCode — once per cold isolate, never on a warm key — and needs a cacheKey", async () => {
  const { env, keys } = fakeLoaderEnv();
  let produced = 0;
  const invoke = async () => {
    produced++;
    return { "package.json": '{"main":"worker.js"}', "worker.js": "export default class Built {}" };
  };
  const load = (cacheKey?: string) =>
    loadConfined(env, { source: "itx.build('todo')", cacheKey, invoke });
  // refused without a key: hashing the expression would be the stale-code trap
  await expect(load()).rejects.toThrow(/needs a cacheKey/);
  expect(produced).toBe(0);
  // with a key: the producer runs when the key is cold …
  const first = await load("todo@3f2a1c");
  expect(JSON.parse(first.loaderId)).toEqual([
    "worker",
    PLATFORM_ID,
    null,
    "prj_u.iterate/",
    "key:todo@3f2a1c",
  ]);
  expect(keys.at(-1)).toBe(first.loaderId);
  await vi.waitFor(() => expect(produced).toBe(1)); // getCode's async body runs, its key digested first
  // … and NOT when it is warm — "same key ⇒ same code" is the caller's contract
  await load("todo@3f2a1c");
  await settled();
  expect(produced).toBe(1);
  // a new key is a new isolate: the producer runs again
  await load("todo@4b7d");
  await vi.waitFor(() => expect(produced).toBe(2));
});

test("a producer's modules are read once per commit, not once per cold isolate: a cold isolate under the same key reads ITX_KV and never asks the producer again", async () => {
  const { kv, values, puts } = fakeKv();
  const producer = fakeProducer();
  const coldIsolate = async () => {
    forgetResolved(values); // as after a platform change: the files' memo alone
    const { env, warm } = fakeLoaderEnv({ kv }); // the last isolate idled out: nothing warm
    const { loaderId } = await loadConfined(env, {
      owner: "prj_kv_cold.iterate/",
      source: site,
      cacheKey: "c0ffee",
      ...producer,
    });
    return warm.get(loaderId);
  };
  await expect(coldIsolate()).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default 1") },
  });
  expect(producer.produced()).toBe(1);
  await vi.waitFor(() => expect(puts).toHaveLength(1)); // kept off the load's path
  await expect(coldIsolate()).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default 1") },
  });
  expect(producer.produced()).toBe(1);
});

test("what a producer answered is kept for a day under its owner, key and expression: no other caller reads it", async () => {
  const shared = fakeKv();
  const producer = fakeProducer();
  const load = (overrides: Partial<ConfinedWorkerOptions> = {}) =>
    loadConfined(fakeLoaderEnv({ kv: shared.kv }).env, {
      owner: "prj_kv_scope.iterate/",
      source: site,
      cacheKey: "c0ffee",
      ...producer,
      ...overrides,
    });
  const before = Math.floor(Date.now() / 1000);
  await load();
  await vi.waitFor(() => expect(shared.puts).toHaveLength(1));
  expect(shared).toMatchObject({
    puts: [{ key: expect.stringMatching(/^produced-modules-2\//) }],
  });
  // a day from now, written as its metadata too, so what is made from it can expire with it
  const { expiration, metadata } = shared.puts[0]!.options!;
  expect(expiration! - before).toBeGreaterThanOrEqual(86_400);
  expect(expiration! - before).toBeLessThanOrEqual(86_401);
  expect(metadata).toEqual({ expiresAt: expiration });
  const others: Partial<ConfinedWorkerOptions>[] = [
    { owner: "prj_other.iterate/" },
    { cacheKey: "decade" },
    { source: ["itx", "repos", ["get", "/repos/config"], ["modules", { commitOid: "decade" }]] },
  ];
  for (const other of others) {
    const before = producer.produced();
    await load(other);
    await vi.waitFor(() => expect(producer.produced()).toBe(before + 1));
  }
  expect(new Set(shared.puts.map((put) => put.key))).toMatchObject({ size: 4 });
});

test("what a producer answered under a published module identity is kept under the identity alone: a later commit that publishes it reads ITX_KV, and the producer runs once", async () => {
  const shared = fakeKv();
  const producer = fakeProducer();
  const coldIsolate = async (commitOid: string, moduleIdentity: string) => {
    forgetResolved(shared.values); // as after a platform change: the files' memo alone
    const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
    const { loaderId } = await loadConfined(env, {
      kind: "facet",
      owner: ["prj_kv_module.iterate/", "Agents"],
      source: ["itx", "config", ["modules", { commitOid }]],
      cacheKey: commitOid,
      mainModule: "worker.js",
      moduleIdentity,
      ...producer,
    });
    await warm.get(loaderId);
    // what the producer answered is kept before the next cold isolate asks
    await vi.waitFor(() => expect(shared.puts).toHaveLength(producer.produced()));
    return loaderId;
  };
  const [a, b] = [
    await workerIdentityOf(producedFiles(1)),
    await workerIdentityOf(producedFiles(2)),
  ];
  const first = await coldIsolate("commit-1", a);
  // an AGENTS.md commit: agents.ts publishes the same identity, so the same id and the same answer
  expect(await coldIsolate("commit-2", a)).toBe(first);
  expect(producer.produced()).toBe(1);
  // agents.ts changed: a new identity, produced once more
  expect(await coldIsolate("commit-3", b)).not.toBe(first);
  expect(producer.produced()).toBe(2);
});

test("what a producer answered under a published module identity is kept for every context of its project: a new context's cold load reads ITX_KV and runs no producer, in an isolate of its own; another project's context runs its own", async () => {
  const shared = fakeKv();
  let produced = 0;
  // every commit of the identity answers the same files
  const invoke = async () => {
    produced += 1;
    return producedFiles(1);
  };
  const identity = await workerIdentityOf(producedFiles(1));
  const coldIsolate = async (iterateContextName: string) => {
    const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
    const { loaderId } = await loadConfined(env, {
      kind: "facet",
      owner: [iterateContextName, "AgentDurableObject"],
      source: ["itx", "config", ["modules", { commitOid: "commit-1" }]],
      cacheKey: "commit-1",
      mainModule: "worker.js",
      moduleIdentity: identity,
      invoke,
    });
    await warm.get(loaderId);
    await vi.waitFor(() => expect(shared.puts).toHaveLength(produced));
    return JSON.parse(loaderId) as unknown[];
  };
  const owners = [
    "prj_u.iterate/agents/first",
    "prj_u.iterate/agents/second",
    "prj_other.iterate/agents/first",
  ];
  const ids: unknown[][] = [];
  for (const owner of owners) ids.push(await coldIsolate(owner));
  // prj_u's second context read the memo; prj_other never reads prj_u's files
  expect({ produced, puts: shared.puts.length }).toEqual({
    produced: 2,
    puts: 2,
  });
  // the isolate is still each context's own (confinement): the ids differ in the owner alone
  expect(ids).toEqual(
    owners.map((owner) => [
      "facet",
      PLATFORM_ID,
      null,
      [owner, "AgentDurableObject"],
      `module:${identity}`,
      "worker.js",
    ]),
  );
});

test("under a published module identity ITX_KV keeps the files its main module's graph read, not the commit's tree: a cold load that reads them loads what the producer's cold load did, under the same id", async () => {
  const tree = {
    "package.json": '{"main":"worker.ts"}',
    "worker.ts": 'import "./site.ts"; export default {};',
    "site.ts": "export const site = 1;",
    "agents.ts":
      'import { greeting } from "./greeting.ts"; export class Agents { hi() { return greeting; } }',
    "greeting.ts": 'export const greeting = "hi";',
    "AGENTS.md": "# How to work here\n".repeat(1_000),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n".repeat(10_000),
  };
  const identityOf = (files: Record<string, string>) =>
    moduleIdentityOf(files, "agents.ts", { ITX_KV: fakeKv().kv }, "agents.ts");
  const identity = await identityOf(tree);
  const shared = fakeKv();
  let produced = 0;
  const coldIsolate = async () => {
    forgetResolved(shared.values); // as after a platform change: the files' memo alone
    const { env, warm } = fakeLoaderEnv({ kv: shared.kv }); // the last isolate idled out
    const { loaderId } = await loadConfined(env, {
      kind: "facet",
      owner: ["prj_u.iterate/agents/first", "Agents"],
      source: ["itx", "config", ["modules", { commitOid: "commit-1" }]],
      cacheKey: "commit-1",
      mainModule: "agents.ts",
      moduleIdentity: identity,
      invoke: async () => {
        produced += 1;
        return tree;
      },
    });
    return { loaderId, code: await warm.get(loaderId) };
  };
  const fromProducer = await coldIsolate();
  await vi.waitFor(() => expect(shared.puts).toHaveLength(1));
  const kept = JSON.parse(shared.values.get(shared.puts[0]!.key)!) as Record<string, string>;
  expect(kept).toEqual({
    "package.json": tree["package.json"],
    "worker.ts": tree["worker.ts"], // package.json's main, which the loader reads for the entry
    "agents.ts": tree["agents.ts"],
    "greeting.ts": tree["greeting.ts"],
  });
  expect(await identityOf(kept)).toBe(identity);
  const fromMemo = await coldIsolate();
  expect({ produced, ...fromMemo }).toEqual({ produced: 1, ...fromProducer });
});

test("a module identity's memo is read only under the LOADED_CODE_FORMAT that kept it: a memo of another format, or one kept before the format joined the key, is never read, so a resolver that reads more never loads an older resolver's files", async () => {
  const tree = {
    "package.json": '{"main":"worker.ts"}',
    "worker.ts": "export default {};",
    "agents.ts": "export class Agents {}",
  };
  const context = "prj_u.iterate/agents/first";
  const identity = await moduleIdentityOf(tree, "agents.ts", { ITX_KV: fakeKv().kv }, "agents.ts");
  const parts = (...format: number[]) => [
    ...format,
    DurableObjectNameCodec.parse(context).projectId,
    `module:${identity}`,
    "agents.ts",
  ];
  const keyOf = (keyParts: unknown[]) =>
    `produced-modules-2/${createHash("sha256").update(JSON.stringify(keyParts)).digest("hex")}`;
  // A memo another resolver kept: it loads, but not what this resolver produces from the tree.
  const otherResolvers = JSON.stringify({ ...tree, "agents.ts": "export class Other {}" });
  const coldIsolate = async (kept: [string, string] | undefined) => {
    const memo = fakeKv();
    if (kept) memo.values.set(...kept);
    const { env, warm } = fakeLoaderEnv({ kv: memo.kv });
    let produced = 0;
    const { loaderId } = await loadConfined(env, {
      kind: "facet",
      owner: [context, "Agents"],
      source: ["itx", "config", ["modules", { commitOid: "commit-1" }]],
      cacheKey: "commit-1",
      mainModule: "agents.ts",
      moduleIdentity: identity,
      invoke: async () => {
        produced += 1;
        return tree;
      },
    });
    const code = await warm.get(loaderId);
    if (produced) await vi.waitFor(() => expect(memo.puts).toHaveLength(1));
    return { produced, loaderId, code, keptUnder: memo.puts.map((put) => put.key) };
  };
  const fromProducer = await coldIsolate(undefined);
  expect(fromProducer).toMatchObject({ keptUnder: [keyOf(parts(LOADED_CODE_FORMAT))] });
  // The key this format reads: a memo there is believed, under the same id, so the loads below
  // would load it too if they read it.
  const believed = await coldIsolate([keyOf(parts(LOADED_CODE_FORMAT)), otherResolvers]);
  expect(believed).toMatchObject({
    produced: 0,
    loaderId: fromProducer.loaderId,
    code: { modules: { "agents.js": expect.stringContaining("export class Other {}") } },
  });
  for (const keyParts of [
    parts(LOADED_CODE_FORMAT - 1),
    parts(LOADED_CODE_FORMAT + 1),
    parts(), // the key before the format joined it
  ])
    await expect(coldIsolate([keyOf(keyParts), otherResolvers])).resolves.toEqual(fromProducer);
});

test("under a caller's key ITX_KV keeps every file the producer answered: the key names no main module, so another entry of the source reads the same memo", async () => {
  const tree = {
    "package.json": '{"main":"worker.ts"}',
    "worker.ts": "export default {};",
    "agents.ts": "export class Agents {}",
    "voice.ts": "export class Voice {}",
  };
  const shared = fakeKv();
  let produced = 0;
  const coldIsolate = async (mainModule: string) => {
    const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
    const { loaderId } = await loadConfined(env, {
      source: site,
      cacheKey: "c0ffee",
      mainModule,
      invoke: async () => {
        produced += 1;
        return tree;
      },
    });
    const code = await warm.get(loaderId);
    await vi.waitFor(() => expect(shared.puts).toHaveLength(1));
    return code;
  };
  await expect(coldIsolate("agents.ts")).resolves.toMatchObject({ mainModule: "agents.js" });
  await expect(coldIsolate("voice.ts")).resolves.toMatchObject({ mainModule: "voice.js" });
  expect({ produced, kept: JSON.parse(shared.values.get(shared.puts[0]!.key)!) }).toEqual({
    produced: 1,
    kept: tree,
  });
});

test("one identity whose main module two sources spell `worker.ts` and `worker.js` is two memos: a tree kept for one spelling never loads for the other", async () => {
  // the agents e2e config's worker.ts and freshPublishedCtx's worker.js: the same code, one identity
  const code =
    'import { IterateConfigEntrypoint } from "iterate/sdk";\nexport default class extends IterateConfigEntrypoint {}\n';
  const spelled = {
    "worker.ts": { "package.json": '{"main":"worker.ts"}', "worker.ts": code },
    "worker.js": { "package.json": '{"main":"worker.js"}', "worker.js": code },
  };
  const kv = fakeKv().kv;
  const identity = await moduleIdentityOf(spelled["worker.ts"], "worker.ts", { ITX_KV: kv }, "t");
  expect(await workerIdentityOf(spelled["worker.js"])).toBe(identity);
  const shared = fakeKv();
  let produced = 0;
  const coldIsolate = async (mainModule: keyof typeof spelled) => {
    const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
    const { loaderId } = await loadConfined(env, {
      owner: `prj_u.iterate/${mainModule}`, // one project: only the spelling differs
      source: ["itx", "config", ["modules", { commitOid: "commit-1" }]],
      cacheKey: "commit-1",
      mainModule,
      moduleIdentity: identity,
      invoke: async () => {
        produced += 1;
        return spelled[mainModule];
      },
    });
    const config = await warm.get(loaderId);
    await vi.waitFor(() => expect(shared.puts).toHaveLength(produced));
    return config;
  };
  await expect(coldIsolate("worker.ts")).resolves.toMatchObject({ mainModule: "worker.js" });
  await expect(coldIsolate("worker.js")).resolves.toMatchObject({ mainModule: "worker.js" });
  expect({ produced, keys: new Set(shared.puts.map((put) => put.key)).size }).toEqual({
    produced: 2,
    keys: 2,
  });
});

test("files a producer answers under an identity they are not are never kept under it: the load runs them, ITX_KV gets nothing, and a warning names both identities", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const shared = fakeKv();
  const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
  const published = await workerIdentityOf(producedFiles(0));
  const { loaderId } = await loadConfined(env, {
    kind: "facet",
    owner: ["prj_u.iterate/agents/first", "AgentDurableObject"],
    source: ["itx", "config", ["modules", { commitOid: "commit-1" }]],
    cacheKey: "commit-1",
    mainModule: "worker.js",
    moduleIdentity: published,
    ...fakeProducer(), // answers `export default 1`, not the published `export default 0`
  });
  await expect(warm.get(loaderId)).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default 1") },
  });
  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  expect(warn.mock.calls.map(([line]) => line)).toEqual([
    {
      event: "worker-loader.module-identity-mismatch",
      name: ["prj_u.iterate/agents/first", "AgentDurableObject"],
      where: "workers.get",
      mainModule: "worker.js",
      expected: published,
      produced: await workerIdentityOf(producedFiles(1)),
    },
  ]);
  expect(shared).toMatchObject({ puts: [] });
});

test.for([
  { name: "never settles", put: () => new Promise<never>(() => {}), warned: [] },
  {
    name: "fails",
    put: () => Promise.reject(new Error("KV PUT failed")),
    // the producer's answer, then the resolved memo
    warned: [
      {
        event: "worker-loader.platform-failure-module-cache",
        action: "put",
        message: "KV PUT failed",
      },
      {
        event: "worker-loader.platform-failure-module-cache",
        action: "put",
        message: "KV PUT failed",
      },
    ],
  },
  {
    // KV takes one write per key per second: another isolate kept the key within it
    name: "is refused 429",
    put: () => Promise.reject(new Error("KV PUT failed: 429 Too Many Requests")),
    warned: [],
  },
])(
  "a cold load waits for no KV write: one that $name holds nothing, and the load answers",
  async ({ name, put, warned }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = {
      get: async () => null,
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put,
    } as unknown as KVNamespace;
    const { env, warm } = fakeLoaderEnv({ kv });
    const { loaderId } = await loadConfined(env, {
      // a key of its own: a write that never settles stays this isolate's write in flight
      owner: `prj_kv_put.iterate/${name.replaceAll(" ", "-")}`,
      source: site,
      cacheKey: "c0ffee",
      ...fakeProducer(),
    });
    await expect(warm.get(loaderId)).resolves.toMatchObject({
      modules: { "worker.js": loaded("export default 1") },
    });
    await settled();
    expect(warn.mock.calls.map(([line]) => line)).toMatchObject(warned);
  },
);

test("an isolate writes a key once at a time: cold loads that all missed it start one write while it is in flight", async () => {
  const shared = fakeKv();
  let release!: () => void;
  const landed = new Promise<void>((resolve) => (release = resolve));
  const slowKv = {
    get: async () => null,
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (...args: Parameters<KVNamespace["put"]>) => {
      await landed;
      return shared.kv.put(...args);
    },
  } as unknown as KVNamespace;
  const producer = fakeProducer();
  const coldIsolate = async () => {
    const { env, warm } = fakeLoaderEnv({ kv: slowKv });
    const { loaderId } = await loadConfined(env, {
      owner: "prj_kv_single.iterate/",
      source: site,
      cacheKey: "c0ffee",
      ...producer,
    });
    return warm.get(loaderId);
  };
  await Promise.all([coldIsolate(), coldIsolate(), coldIsolate()]);
  expect(producer.produced()).toBe(3);
  release();
  await vi.waitFor(() => expect(shared.puts).toHaveLength(1));
  await settled();
  expect(shared.puts).toHaveLength(1);
});

test("a module's identity is its graph: an AGENTS.md or a module it does not import leaves it, and a module it imports or its compatibility flags move it", async () => {
  const kv = fakeKv().kv;
  const config = {
    "package.json": '{"main":"worker.ts"}',
    "worker.ts": "export default {};",
    "agents.ts":
      'import { greeting } from "./greeting.ts"; export class Agents { hi() { return greeting; } }',
    "greeting.ts": 'export const greeting = "hi";',
    "AGENTS.md": "# How to work here",
  };
  const identityOf = (files: Record<string, string>) =>
    moduleIdentityOf(files, "agents.ts", { ITX_KV: kv }, "agents.ts");
  const identity = await identityOf(config);
  expect({
    agentsMd: await identityOf({ ...config, "AGENTS.md": "# How to work here, edited" }),
    worker: await identityOf({ ...config, "worker.ts": "export default { edited: true };" }),
  }).toEqual({ agentsMd: identity, worker: identity });
  expect(
    new Set([
      identity,
      await identityOf({ ...config, "greeting.ts": 'export const greeting = "hello";' }),
      await identityOf({
        ...config,
        "package.json": '{"main":"worker.ts","compatibilityFlags":["nodejs_compat"]}',
      }),
    ]),
  ).toMatchObject({ size: 3 });
});

test("the config pointer's worker, reached through the pointer, loads under its main module's identity: a commit that leaves that module's graph asks for the same isolate and, cold, reads ITX_KV; one that changes it is built again; the same spec no route vouched for loads under its commit", async () => {
  const shared = fakeKv();
  const { kv } = shared;
  const worker = { "package.json": '{"main":"worker.js"}', "worker.js": "export default {}" };
  const commits: Record<string, Record<string, string>> = {
    c1: worker,
    c2: { ...worker, "AGENTS.md": "# How to work here, edited" },
    c3: { ...worker, "worker.js": "export default { edited: true }" },
  };
  let produced = 0;
  /** The config repo's files at the commit the producer names (`itx.config.modules`). */
  const invoke = async (call: ItxExpression) => {
    produced += 1;
    const [, , [, { commitOid }]] = call as [string, string, [string, { commitOid: string }]];
    return commits[commitOid];
  };
  const [a, b] = [await workerIdentityOf(commits.c1!), await workerIdentityOf(commits.c3!)];
  expect(await workerIdentityOf(commits.c2!)).toBe(a); // AGENTS.md is no module of worker.js's
  /** The pointer of commit `commitOid`, whose worker.js publishes `identity` (publication.ts). */
  const pointer = (commitOid: string, identity: string) => ({
    source: ["itx", "config", ["modules", { commitOid }]] satisfies ItxExpression,
    cacheKey: commitOid,
    mainModule: "worker.js",
    manifest: { generation: 1, modules: { "worker.js": { identity, classes: [] } } },
  });
  const one = configWorkerOver({ kv, invoke, vouched: true });
  await one.call(pointer("c1", a));
  // an AGENTS.md commit: the same id, so the warm isolate answers
  await one.call(pointer("c2", a));
  expect({ ids: new Set(one.ids).size, built: one.built(), produced }).toEqual({
    ids: 1,
    built: 1,
    produced: 1,
  });
  expect(JSON.parse(one.ids[0]!)).toEqual([
    "worker",
    PLATFORM_ID,
    null,
    "prj_u.iterate/",
    `module:${a}`,
    "worker.js",
  ]);
  // that isolate idled out (or a deploy): the cold load reads the answer ITX_KV kept
  await vi.waitFor(() => expect(shared.puts).toHaveLength(1));
  await vi.waitFor(() => expect(shared.resolvedPuts).toHaveLength(1));
  forgetResolved(shared.values); // as after a platform change: the files' memo alone
  const cold = configWorkerOver({ kv, invoke, vouched: true });
  await cold.call(pointer("c2", a));
  expect({ id: cold.ids[0], built: cold.built(), produced }).toEqual({
    id: one.ids[0],
    built: 1,
    produced: 1,
  });
  // a commit to a module worker.js imports: a new identity, produced and built once more
  await one.call(pointer("c3", b));
  expect({ ids: new Set(one.ids).size, built: one.built(), produced }).toEqual({
    ids: 2,
    built: 2,
    produced: 2,
  });
  // the same spec where no route vouched for it: its manifest names nothing
  const unvouched = configWorkerOver({ kv, invoke, vouched: false });
  await unvouched.call(pointer("c2", a));
  expect(JSON.parse(unvouched.ids[0]!)).toMatchObject({ 4: "key:c2" });
});

test("a loaded identity that moved says which of its parts moved: the platform's code, the source, the dead-load generation, or every part of a row an older spelling wrote", () => {
  const id = (platform: string, source: string, generation = "") =>
    JSON.stringify(["facet", platform, null, ["prj_u.iterate/", "Agents"], source, "agents.ts"]) +
    generation;
  expect({
    same: loadedIdentityChanges(id("p1", "module:a"), id("p1", "module:a")),
    deploy: loadedIdentityChanges(id("p1", "module:a"), id("p2", "module:a")),
    commit: loadedIdentityChanges(id("p1", "module:a"), id("p1", "module:b")),
    deadLoad: loadedIdentityChanges(id("p1", "module:a"), id("p1", "module:a", "#1.0a1b2c3d")),
  }).toEqual({ same: [], deploy: ["platform"], commit: ["source"], deadLoad: ["generation"] });
  expect(loadedIdentityChanges("facet:prj_u.iterate/:Agents", id("p1", "module:a"))).toEqual([
    "kind",
    "platform",
    "platformOrigin",
    "owner",
    "source",
    "mainModule",
    "generation",
  ]);
});

test("a KV that cannot be read or written costs the producer's run and a logged warning, never the load", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const broken = {
    get: () => Promise.reject(new Error("KV GET failed")),
    getWithMetadata: () => Promise.reject(new Error("KV GET failed")),
    put: () => Promise.reject(new Error("KV PUT failed")),
  } as unknown as KVNamespace;
  const { env, warm } = fakeLoaderEnv({ kv: broken });
  const producer = fakeProducer();
  const { loaderId } = await loadConfined(env, {
    owner: "prj_kv_broken.iterate/",
    source: site,
    cacheKey: "c0ffee",
    ...producer,
  });
  await expect(warm.get(loaderId)).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default 1") },
  });
  // the resolved memo and the producer's answer, each read and each written
  await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(4));
  expect(warn.mock.calls.map(([line]) => line)).toMatchObject([
    { event: "worker-loader.platform-failure-module-cache", action: "get" },
    { event: "worker-loader.platform-failure-module-cache", action: "get" },
    { event: "worker-loader.platform-failure-module-cache", action: "put" },
    { event: "worker-loader.platform-failure-module-cache", action: "put" },
  ]);
});

test("a cold load resolves its source once: while its module lock's read is held, keeping the answer starts no second resolution", async () => {
  const files = {
    "package.json": '{"main":"worker.js","dependencies":{"left-pad":"1.3.0"}}',
    "worker.js": 'import leftPad from "left-pad"; export default leftPad;',
  };
  // the dependency set's lock, as module-resolution.ts keeps it: no network
  const lock = JSON.stringify({
    modules: { "node_modules/left-pad.js": "export default (text) => text;" },
    platformModules: [],
  });
  const isLock = (key: string) => key.startsWith("module-lock-");
  const locked = { get: async (key: string) => (isLock(key) ? lock : null) };
  const identity = await moduleIdentityOf(
    files,
    "worker.js",
    { ITX_KV: locked as unknown as KVNamespace },
    "worker.js",
  );
  const shared = fakeKv();
  let lockReads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const kv = {
    get: async (key: string, type?: "json") => {
      if (!isLock(key)) return shared.kv.get(key, type as "json");
      lockReads += 1;
      await held;
      return lock;
    },
    getWithMetadata: shared.kv.getWithMetadata,
    put: shared.kv.put,
  } as unknown as KVNamespace;
  const { env, warm } = fakeLoaderEnv({ kv });
  const { loaderId } = await loadConfined(env, {
    kind: "facet",
    owner: ["prj_lock_held.iterate/agents/first", "AgentDurableObject"],
    source: ["itx", "config", ["modules", { commitOid: "commit-1" }]],
    cacheKey: "commit-1",
    mainModule: "worker.js",
    moduleIdentity: identity,
    invoke: async () => files,
  });
  await vi.waitFor(() => expect(lockReads).toBe(1));
  // timers' turns while the read is held: a check that resolves the files again reads the lock here
  await settled();
  await settled();
  release();
  await expect(warm.get(loaderId)).resolves.toMatchObject({ mainModule: "worker.js" });
  await vi.waitFor(() => expect(shared.puts).toHaveLength(1));
  expect(lockReads).toBe(1);
});

test("a cold load reads the resolved memo an earlier cold load kept and transforms nothing; the built line says which it was", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const shared = fakeKv();
  const files = {
    "package.json": '{"main":"worker.ts"}',
    "worker.ts":
      'import { greeting } from "./greeting.ts"; export default greeting satisfies string;',
    "greeting.ts": 'export const greeting: string = "hi";',
  };
  const producer = { invoke: async () => files };
  const coldIsolate = async (options: Partial<ConfinedWorkerOptions> = {}) => {
    vi.mocked(transform).mockClear();
    const { env, warm } = fakeLoaderEnv({ kv: shared.kv }); // the last isolate idled out
    const { loaderId } = await loadConfined(env, {
      owner: "prj_resolved_memo.iterate/",
      source: site,
      cacheKey: "c0ffee",
      ...producer,
      ...options,
    });
    const code = await warm.get(loaderId);
    const built = info.mock.calls
      .map(([line]) => line as { event?: string; loaderId?: string })
      .findLast((line) => line.event === "worker-loader.built" && line.loaderId === loaderId);
    return { code, transforms: vi.mocked(transform).mock.calls.length, built };
  };
  const first = await coldIsolate();
  expect(first).toMatchObject({
    transforms: 2,
    built: { modules: "transformed", resolveMs: expect.any(Number) },
  });
  await vi.waitFor(() => expect(shared.resolvedPuts).toHaveLength(1));
  // kept without the platform's own modules, which this build has
  const kept = unsealed(shared.values.get(shared.resolvedPuts[0]!.key)!) as {
    modules: Record<string, string>;
    platformModules: string[];
  };
  expect(Object.keys(kept.modules).sort()).toEqual(["greeting.js", "worker.js"]);
  expect(kept.platformModules).toContain("node_modules/.platform/loaded-worker.js");
  // the next cold load: the same modules, read whole, no transform
  const second = await coldIsolate();
  expect(second).toEqual({
    code: first.code,
    transforms: 0,
    built: { ...first.built, modules: "resolved-memo", resolveMs: expect.any(Number) },
  });
  // a literal source is its own key: the second load of the same files reads the memo too
  await coldIsolate({ source: files, cacheKey: undefined });
  await vi.waitFor(() => expect(shared.resolvedPuts).toHaveLength(2));
  await expect(coldIsolate({ source: files, cacheKey: undefined })).resolves.toMatchObject({
    transforms: 0,
    built: { modules: "resolved-memo" },
  });
});

test("the resolved memo's key names the platform's code: a memo kept under another platform identity is never read, one under this one is", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const owner = "prj_resolved_platform.iterate/";
  const producedKey = `produced-modules-2/${createHash("sha256")
    .update(JSON.stringify([owner, "key:c0ffee", site]))
    .digest("hex")}`;
  const keyOf = (platform: string) =>
    `resolved-modules-2/${createHash("sha256")
      .update(JSON.stringify([platform, null, producedKey, null]))
      .digest("hex")}`;
  const memoOf = (code: string) =>
    sealed({
      mainModule: "worker.js",
      modules: { "worker.js": code },
      platformModules: ["node_modules/.platform/loaded-worker.js"],
      compatibilityFlags: null,
      locks: {},
    });
  const coldIsolate = async (kept: [string, string]) => {
    const memo = fakeKv();
    memo.values.set(...kept);
    const { env, warm } = fakeLoaderEnv({ kv: memo.kv });
    const producer = fakeProducer();
    const { loaderId } = await loadConfined(env, {
      owner,
      source: site,
      cacheKey: "c0ffee",
      ...producer,
    });
    return { code: await warm.get(loaderId), produced: producer.produced() };
  };
  await expect(
    coldIsolate([keyOf(PLATFORM_ID), memoOf("export default 'kept'")]),
  ).resolves.toMatchObject({
    code: { modules: { "worker.js": "export default 'kept'" } },
    produced: 0,
  });
  await expect(
    coldIsolate([keyOf(`${PLATFORM_ID.slice(0, -1)}0`), memoOf("export default 'kept'")]),
  ).resolves.toMatchObject({
    code: { modules: { "worker.js": loaded("export default 1") } },
    produced: 1,
  });
  expect(info).toHaveBeenCalled();
});

test("a resolved memo whose module lock moved, or that is corrupt or partial, is a miss: the load resolves again, and says what it rejected", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const files = {
    "package.json": '{"main":"worker.ts","dependencies":{"left-pad":"1.3.0"}}',
    "worker.ts": 'import leftPad from "left-pad"; export default leftPad;',
  };
  const lockOf = (body: string) =>
    JSON.stringify({ modules: { "node_modules/left-pad.js": body }, platformModules: [] });
  const shared = fakeKv();
  let lock = lockOf("export default (text) => text;");
  const kv = {
    get: async (key: string, type?: "json") =>
      key.startsWith("module-lock-") ? lock : shared.kv.get(key, type as "json"),
    getWithMetadata: shared.kv.getWithMetadata,
    put: shared.kv.put,
  } as unknown as KVNamespace;
  const coldIsolate = async () => {
    vi.mocked(transform).mockClear();
    const { env, warm } = fakeLoaderEnv({ kv });
    const { loaderId } = await loadConfined(env, {
      owner: "prj_resolved_lock.iterate/",
      source: files,
    });
    const code = (await warm.get(loaderId)) as { modules: Record<string, string> };
    return {
      leftPad: code.modules["node_modules/left-pad.js"],
      transforms: vi.mocked(transform).mock.calls.length,
    };
  };
  const rejections = () =>
    info.mock.calls
      .map(([line]) => line as { event?: string; reason?: string })
      .filter((line) => line.event === "worker-loader.resolved-memo-rejected")
      .map((line) => line.reason);
  await expect(coldIsolate()).resolves.toEqual({
    leftPad: "export default (text) => text;",
    transforms: 1,
  });
  await vi.waitFor(() => expect(shared.resolvedPuts).toHaveLength(1));
  const memoKey = shared.resolvedPuts[0]!.key;
  const kept = shared.values.get(memoKey)!;
  // the lock the resolution read, by its value's hash
  expect(Object.keys((unsealed(kept) as { locks: object }).locks)).toEqual([
    expect.stringMatching(/^module-lock-3\//),
  ]);
  await expect(coldIsolate()).resolves.toMatchObject({ transforms: 0 });
  // the lock the resolution read is no longer there: resolved again, with the lock that is
  lock = lockOf("export default (text) => `${text}`;");
  await expect(coldIsolate()).resolves.toEqual({
    leftPad: "export default (text) => `${text}`;",
    transforms: 1,
  });
  expect(rejections()).toEqual(["lock"]);
  await vi.waitFor(() => expect(shared.resolvedPuts).toHaveLength(2)); // kept again, with that lock
  // changed after its write — cut short, a module dropped, the platform's modules dropped — is
  // not what its seal names; sealed again, partial (no main module, no platform entry), naming a
  // platform module this build lacks, or of another shape
  const memo = unsealed(kept) as { modules: Record<string, string> } & Record<string, unknown>;
  const { "node_modules/left-pad.js": _leftPad, ...withoutLeftPad } = memo.modules;
  for (const value of [
    kept.slice(0, kept.length / 2),
    `${kept.slice(0, 64)}\n${JSON.stringify({ ...memo, modules: withoutLeftPad })}`,
    `${kept.slice(0, 64)}\n${JSON.stringify({ ...memo, platformModules: [] })}`,
    kept.slice(kept.indexOf("\n") + 1), // no seal at all
    sealed({ ...memo, modules: {} }),
    sealed({ ...memo, platformModules: [] }),
    sealed({ ...memo, platformModules: ["node_modules/.platform/gone.js"] }),
    sealed({ ...memo, locks: undefined }),
  ]) {
    const writes = shared.resolvedPuts.length;
    shared.values.set(memoKey, value);
    await expect(coldIsolate()).resolves.toMatchObject({ transforms: 1 });
    await vi.waitFor(() => expect(shared.resolvedPuts).toHaveLength(writes + 1));
  }
  expect(rejections()).toEqual([
    "lock",
    ...Array<string>(4).fill("integrity"),
    ...Array<string>(4).fill("shape"),
  ]);
});

test("a resolved memo expires with the files it was made from: fresh files give both memos one new day; files read back give it their memo's expiry, not a new day; files of unknown expiry give it none", async () => {
  const shared = fakeKv();
  const producer = fakeProducer();
  const coldIsolate = async () => {
    const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
    const { loaderId } = await loadConfined(env, {
      owner: "prj_resolved_expiry.iterate/",
      source: site,
      cacheKey: "c0ffee",
      ...producer,
    });
    await warm.get(loaderId);
  };
  await coldIsolate();
  await vi.waitFor(() => expect(shared.resolvedPuts).toHaveLength(1));
  const filesKey = shared.puts[0]!.key;
  const fresh = shared.puts[0]!.options!.expiration;
  expect(shared.resolvedPuts[0]!).toMatchObject({
    options: {
      expiration: fresh,
      metadata: { expiresAt: fresh },
    },
  });
  // the files' memo, kept an hour short of a day ago: a platform change moved the resolved key
  const keptLongAgo = Math.floor(Date.now() / 1000) + 3_600;
  shared.metadata.set(filesKey, { expiresAt: keptLongAgo });
  forgetResolved(shared.values);
  await coldIsolate();
  await vi.waitFor(() => expect(shared.resolvedPuts).toHaveLength(2));
  expect(shared.resolvedPuts[1]!).toMatchObject({
    options: {
      expiration: keptLongAgo,
      metadata: { expiresAt: keptLongAgo },
    },
  });
  // a files' memo written before its expiry was: no resolved memo, which might outlive it
  shared.metadata.delete(filesKey);
  forgetResolved(shared.values);
  await coldIsolate();
  await settled();
  expect({ produced: producer.produced(), resolvedPuts: shared.resolvedPuts.length }).toEqual({
    produced: 1,
    resolvedPuts: 2,
  });
});

test("an expiry that falls under KV's minute while the write is deferred keeps nothing and logs no platform failure", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const shared = fakeKv();
  const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
  const { loaderId } = await loadConfined(env, {
    owner: "prj_resolved_expiring.iterate/",
    source: site,
    cacheKey: "c0ffee",
    ...fakeProducer(),
  });
  await warm.get(loaderId);
  // the load answered and both writes wait for their turn: the clock then reaches 30 s before
  // the day they were given ends
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + (86_400 - 30) * 1000);
  try {
    await settled();
    await settled();
    expect({ puts: shared.puts, resolvedPuts: shared.resolvedPuts }).toEqual({
      puts: [],
      resolvedPuts: [],
    });
    expect(warn).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

test("what is kept is what this load resolved: a producer that changes the map it answered, after the load, changes neither memo", async () => {
  const shared = fakeKv();
  const answered: Record<string, string> = {
    "package.json": '{"main":"worker.js"}',
    "worker.js": 'import "./two.js"; export default 1',
    "two.js": "export const two = 2;",
  };
  const coldIsolate = async () => {
    const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
    const { loaderId } = await loadConfined(env, {
      owner: "prj_resolved_snapshot.iterate/",
      source: site,
      cacheKey: "c0ffee",
      invoke: async () => answered,
    });
    return warm.get(loaderId) as Promise<{ modules: Record<string, string> }>;
  };
  const first = await coldIsolate();
  // the producer keeps its map and changes it before the memos' writes start
  answered["worker.js"] = "export default 2";
  delete answered["two.js"];
  await vi.waitFor(() => expect(shared.puts).toHaveLength(1));
  await vi.waitFor(() => expect(shared.resolvedPuts).toHaveLength(1));
  expect(await coldIsolate()).toEqual(first); // from the resolved memo
  forgetResolved(shared.values);
  expect(await coldIsolate()).toEqual(first); // from the files' memo, resolved again
});

test("a source file named like a platform module keeps its own text in the resolved memo: a hit loads what the miss loaded", async () => {
  const shared = fakeKv();
  const platformName = "node_modules/.platform/loaded-worker.js";
  const files = {
    "package.json": '{"main":"worker.js"}',
    "worker.js": 'import "./node_modules/.platform/loaded-worker.js"; export default 1;',
    [platformName]: "export const authors = true;",
  };
  const coldIsolate = async () => {
    const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
    const { loaderId } = await loadConfined(env, {
      owner: "prj_resolved_platform_name.iterate/",
      source: files,
    });
    return warm.get(loaderId);
  };
  const miss = await coldIsolate();
  await vi.waitFor(() => expect(shared.resolvedPuts).toHaveLength(1));
  const kept = unsealed(shared.values.get(shared.resolvedPuts[0]!.key)!) as {
    modules: Record<string, string>;
    platformModules: string[];
  };
  expect(kept.modules[platformName]).toBe("export const authors = true;");
  expect(kept.platformModules).not.toContain(platformName);
  expect(await coldIsolate()).toEqual(miss);
});

test("a waitUntil that throws (no invocation to hold) leaves the cold load answered and the write running detached", async () => {
  const hold = vi.spyOn(waitUntil as unknown as { hold: () => void }, "hold");
  hold.mockImplementation(() => {
    throw new Error("waitUntil() called outside an invocation");
  });
  const shared = fakeKv();
  const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
  const { loaderId } = await loadConfined(env, {
    owner: "prj_wait_until_throws.iterate/",
    source: site,
    cacheKey: "c0ffee",
    ...fakeProducer(),
  });
  await expect(warm.get(loaderId)).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default 1") },
  });
  expect(hold).toHaveBeenCalledTimes(2); // the producer's answer and the resolved memo
  await vi.waitFor(() => expect(shared.puts).toHaveLength(1));
  await vi.waitFor(() => expect(shared.resolvedPuts).toHaveLength(1));
});

test("an answer that cannot load is never kept or believed: the dead-id recovery asks the producer again", async () => {
  const owner = "prj_kv_unloadable.iterate/";
  const shared = fakeKv();
  const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
  let produced = 0;
  const invoke = async () =>
    ++produced === 1
      ? {} // the build has not landed: no entry
      : { "package.json": '{"main":"worker.js"}', "worker.js": "export default class Site {}" };
  const load = () => loadConfined(env, { owner, source: site, cacheKey: "c0ffee", invoke });
  const first = await load();
  await expect(warm.get(first.loaderId)).rejects.toThrow(/no entry/);
  expect(shared).toMatchObject({ puts: [] });
  const recovered = await load();
  await expect(warm.get(recovered.loaderId)).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default class Site {}") },
  });
  expect(produced).toBe(2);
  await vi.waitFor(() => expect(shared.puts).toHaveLength(1));
  // a value under the key that is not a loadable module map is a miss, and the producer's answer replaces it
  for (const key of shared.values.keys()) shared.values.set(key, "{}");
  const cold = fakeLoaderEnv({ kv: shared.kv });
  await loadConfined(cold.env, { owner, source: site, cacheKey: "c0ffee", invoke });
  await vi.waitFor(() => expect(produced).toBe(3));
});

test("a key: producer's answer with a missing import is never kept: the next load runs the producer again and loads once its answer resolves", async () => {
  const shared = fakeKv();
  const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
  let produced = 0;
  const invoke = async () => {
    produced += 1;
    // the first answer has an entry, so it reads as loadable, but its import names no file
    return produced === 1
      ? {
          "package.json": '{"main":"worker.js"}',
          "worker.js": 'import "./missing.js"; export default 1',
        }
      : producedFiles(2);
  };
  const load = () =>
    loadConfined(env, {
      owner: "prj_kv_missing_import.iterate/",
      source: site,
      cacheKey: "c0ffee",
      invoke,
    });
  const first = await load();
  await expect(warm.get(first.loaderId)).rejects.toThrow(/no such file/);
  await settled();
  expect(shared).toMatchObject({ puts: [] });
  const recovered = await load();
  await expect(warm.get(recovered.loaderId)).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default 2") },
  });
  expect(produced).toBe(2);
  await vi.waitFor(() => expect(shared.puts).toHaveLength(1));
});

test("an answer over KV's value limit is not kept, and costs no warning, only a line that says so: the worker still loads", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const shared = fakeKv();
  const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
  const invoke = async () => ({
    "package.json": '{"main":"worker.js"}',
    "worker.js": "export default class Site {}",
    "assets/big.txt": "x".repeat(26 * 1024 * 1024),
  });
  const { loaderId } = await loadConfined(env, {
    owner: "prj_kv_oversize.iterate/",
    source: site,
    cacheKey: "c0ffee",
    invoke,
  });
  await expect(warm.get(loaderId)).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default class Site {}") },
  });
  expect(shared).toMatchObject({ puts: [] });
  expect(warn).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "worker-loader.module-cache-too-large",
        key: "produced-modules-2",
      }),
    ),
  );
});

test("literal modules: the key is their content hash unless the caller names a cacheKey", async () => {
  const { env, keys } = fakeLoaderEnv();
  const a = await loadConfined(env, {
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default 1" },
  });
  const b = await loadConfined(env, {
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default 2" },
  });
  expect(a).not.toMatchObject({ loaderId: b.loaderId }); // content decides
  const named = await loadConfined(env, {
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default 1" },
    cacheKey: "v7",
  });
  expect(JSON.parse(named.loaderId)).toEqual([
    "worker",
    PLATFORM_ID,
    null,
    "prj_u.iterate/",
    "key:v7",
  ]);
  expect(keys.at(-1)).toBe(named.loaderId);
  await expect(loadConfined(env, { source: { "lib.js": "export default 1" } })).rejects.toThrow(
    /no entry/,
  );
});

test("a main module is one more element of the key, and a module identity names the code in place of the cacheKey: every source that answers it loads the same code for that module", async () => {
  const { env } = fakeLoaderEnv();
  const source = "itx.repos.get('/repos/config').modules()";
  // the id past its kind, platform, origin and owner
  const keyOf = async (cacheKey: string, moduleIdentity?: string) => {
    const options = workerOptions(env, {
      source,
      cacheKey,
      mainModule: "agents.ts",
      moduleIdentity,
    });
    return JSON.parse((await prepareConfinedWorker(options)).loaderId).slice(4);
  };
  expect(await keyOf("commit-1")).toEqual(["key:commit-1", "agents.ts"]);
  // two commits whose agents.ts is one identity: one isolate identity
  expect(await keyOf("commit-1", "a1")).toEqual(["module:a1", "agents.ts"]);
  expect(await keyOf("commit-2", "a1")).toEqual(["module:a1", "agents.ts"]);
  // a cacheKey spelled as that identity is still a cacheKey: it never takes the module's id
  expect(await keyOf("a1")).toEqual(["key:a1", "agents.ts"]);
});

test("WORKAROUND: a producer that threw marks its id dead; the next attempt produces OUTSIDE the loader and loads literally under the id's next generation; a producer that keeps failing mints nothing", async () => {
  const { env, keys, warm } = fakeLoaderEnv();
  let artifactLanded = false;
  let produced = 0;
  const invoke = async () => {
    produced++;
    if (!artifactLanded) throw new Error("build artifact not landed yet");
    return { "package.json": '{"main":"worker.js"}', "worker.js": "export default class Built {}" };
  };
  const load = () =>
    loadConfined(env, { source: "itx.build('todo')", cacheKey: "todo@dead", invoke });
  // 1. the producer throws INSIDE getCode — workerd keeps that rejection under the id forever
  const first = await load();
  expect(first).toMatchObject({
    loaderId: JSON.stringify(["worker", PLATFORM_ID, null, "prj_u.iterate/", "key:todo@dead"]),
  });
  await expect(warm.get(first.loaderId)).rejects.toThrow(/not landed/);
  expect(produced).toBe(1);
  // 2. still failing: the producer now runs OUTSIDE the loader — the failure reaches no map entry
  //    and mints no id, however many times it is tried
  await expect(load()).rejects.toThrow(/not landed/);
  await expect(load()).rejects.toThrow(/not landed/);
  expect(produced).toBe(3);
  expect(keys).toHaveLength(1);
  // 3. the artifact lands: produced outside once more, loaded LITERALLY under the next generation
  artifactLanded = true;
  const recovered = await load();
  expect(recovered).toMatchObject({
    loaderId: expect.stringContaining(
      `${JSON.stringify(["worker", PLATFORM_ID, null, "prj_u.iterate/", "key:todo@dead"])}#1.`,
    ),
  });
  await expect(warm.get(recovered.loaderId)).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default class Built {}") },
  });
  expect(produced).toBe(4);
  // 4. …and from here the generation is warm: no producer run, no new id
  await load();
  expect(produced).toBe(4);
  expect(new Set(keys)).toMatchObject({ size: 2 }); // the dead id and its one recovered generation
});

test("a source that keeps failing to resolve mints one loader id, not one per retry: the recovery resolves outside the loader", async () => {
  const { env, keys, warm } = fakeLoaderEnv();
  const retry = () =>
    loadConfined(env, {
      source: { "package.json": '{"main":"worker.js"}', "worker.js": `import "./missing.js";` },
    });
  // the cold load resolves inside getCode, fails, and marks the id dead; its rejection is the
  // mark's, however many turns the resolved memo's read takes first
  const { loaderId } = await retry();
  await warm.get(loaderId)!.catch(() => undefined);
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(retry()).rejects.toThrow(/no such file/);
  expect(new Set(keys)).toMatchObject({ size: 1 });
});

test("WORKAROUND, under load: every caller that finds the id dead while its recovery runs waits on that one recovery — 50 concurrent callers run the producer once, not 50 times", async () => {
  // prd, 2026-09-24 14:36 UTC: the config worker's first load after a deploy failed, a scanner sent
  // 4,502 requests in 31 s, and each ran its own producer — ~915 `repo.modules` calls at once.
  const { env, keys, warm } = fakeLoaderEnv();
  const host = {} as Fetcher; // a context's one `itxEntrypoint` stub per incarnation
  let produced = 0;
  let failures = 2;
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const invoke = async () => {
    produced++;
    if (failures > 0) {
      failures--;
      throw new Error("Network connection lost.");
    }
    await slow; // a cold repo fetch: 1–2 s on prd, 40–60 s under the herd
    return { "package.json": '{"main":"worker.js"}', "worker.js": "export default class Site {}" };
  };
  const load = (itxEntrypoint = host) =>
    loadConfined(env, {
      itxEntrypoint,
      source: ["itx", "repos", ["get", "/repos/config"], ["modules", { commitOid: "c0ffee" }]],
      cacheKey: "c0ffee",
      invoke,
    });
  const dead = JSON.stringify(["worker", PLATFORM_ID, null, "prj_u.iterate/", "key:c0ffee"]);
  // the first load's producer loses its connection, and again on its one repeat, inside getCode:
  // the id is dead
  await load();
  await expect(warm.get(dead)).rejects.toThrow(/Network connection lost/);
  expect(produced).toBe(2);
  const herd = Array.from({ length: 50 }, () => load());
  await vi.waitFor(() => expect(produced).toBe(3));
  await settled();
  expect(produced).toBe(3); // one recovery, however many callers
  release();
  const recovered = await Promise.all(herd);
  const [recoveredId, ...others] = new Set(recovered.map((r) => r.loaderId));
  expect({ recoveredId, others }).toEqual({
    recoveredId: expect.stringContaining(`${dead}#1.`),
    others: [],
  });
  expect(produced).toBe(3);
  expect(new Set(keys)).toEqual(new Set([dead, recoveredId]));
});

test("a producer that loses its connection once inside getCode is read once more, and the id stays live: no dead mark, no next generation", async () => {
  const { env, keys, warm } = fakeLoaderEnv();
  let produced = 0;
  const invoke = async () => {
    produced++;
    if (produced === 1) throw new Error("Network connection lost.");
    return { "package.json": '{"main":"worker.js"}', "worker.js": "export default class Site {}" };
  };
  const load = () =>
    loadConfined(env, {
      owner: "prj_lost_once.iterate/",
      source: "itx.build('site')",
      cacheKey: "site@lost-once",
      invoke,
    });
  const first = await load();
  await expect(warm.get(first.loaderId)).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default class Site {}") },
  });
  expect(produced).toBe(2);
  // warm under the same id: the lost connection marked nothing dead
  await expect(load()).resolves.toMatchObject({ loaderId: first.loaderId });
  expect(produced).toBe(2);
  expect(new Set(keys)).toEqual(new Set([first.loaderId]));
});

test("WORKAROUND, under load: a recovery that fails fails every caller waiting on it, and the next caller starts a fresh one; a recovery another incarnation started is never waited on", async () => {
  const { env } = fakeLoaderEnv();
  let produced = 0;
  let outcome: "fail" | "hang" | "ok" = "fail";
  const invoke = async () => {
    produced++;
    if (outcome === "fail") throw new Error("Durable Object is overloaded.");
    if (outcome === "hang") return new Promise<never>(() => {}); // its incarnation died mid-call
    return { "package.json": '{"main":"worker.js"}', "worker.js": "export default class Site {}" };
  };
  const load = (itxEntrypoint: Fetcher) =>
    loadConfined(env, {
      itxEntrypoint,
      owner: "prj_v.iterate/",
      source: "itx.build('site')",
      cacheKey: "site@1",
      invoke,
    });
  const incarnation1 = {} as Fetcher;
  await load(incarnation1); // dies inside getCode
  await vi.waitFor(() => expect(produced).toBe(1));
  await settled();
  // a failing recovery: every caller waiting on it fails with it, the producer ran once for them
  const failing = await Promise.allSettled([load(incarnation1), load(incarnation1)]);
  expect(failing.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  expect(produced).toBe(2);
  // an incarnation that dies with its recovery in flight leaves a promise that never settles …
  outcome = "hang";
  void load(incarnation1);
  await vi.waitFor(() => expect(produced).toBe(3));
  // … and the next incarnation (a new stub) starts its own instead of waiting on it forever
  outcome = "ok";
  const incarnation2 = {} as Fetcher;
  await expect(load(incarnation2)).resolves.toMatchObject({
    loaderId: expect.stringContaining(
      `${JSON.stringify(["worker", PLATFORM_ID, null, "prj_v.iterate/", "key:site@1"])}#1.`,
    ),
  });
  expect(produced).toBe(4);
});

test("retire(): a burst of calls that failed on one identity retires it once, and a late retire from a replaced identity never sends the next generation back to it", async () => {
  const { env } = fakeLoaderEnv();
  const opts = workerOptions(env, {
    owner: "prj_retire.iterate/",
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default {}" },
  });
  // two calls on generation 0 meet the clone-version failure together: one retirement
  const [a, b] = await Promise.all([prepareConfinedWorker(opts), prepareConfinedWorker(opts)]);
  a.retire();
  b.retire();
  const recovered = await prepareConfinedWorker(opts);
  expect(recovered).toMatchObject({ loaderId: expect.stringContaining(`${a.loaderId}#1.`) });
  // generation 1 fails too; a call still in flight on generation 0 fails late
  recovered.retire();
  a.retire();
  expect(await prepareConfinedWorker(opts)).toMatchObject({
    loaderId: expect.stringContaining(`${a.loaderId}#2.`),
  });
});

test("two isolates that retire one identity load its next generation under two ids, never each other's entry", async () => {
  // The Worker Loader shares an entry by id across a machine's isolates, and each isolate, its own
  // evaluation of worker-loader.ts, counts generations from 0.
  const opts = workerOptions(fakeLoaderEnv().env, {
    owner: "prj_two_isolates.iterate/",
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default {}" },
  });
  vi.resetModules();
  const sibling = await import("./worker-loader.ts");
  const nextGenerationIn = async (isolate: Pick<typeof sibling, "prepareConfinedWorker">) => {
    (await isolate.prepareConfinedWorker(opts)).retire();
    return (await isolate.prepareConfinedWorker(opts)).loaderId;
  };
  const base = (await prepareConfinedWorker(opts)).loaderId;
  const ids = [await nextGenerationIn({ prepareConfinedWorker }), await nextGenerationIn(sibling)];
  expect(new Set(ids)).toMatchObject({ size: 2 });
  expect(ids).toEqual([
    expect.stringContaining(`${base}#1.`),
    expect.stringContaining(`${base}#1.`),
  ]);
});

test("prepare resolves the identity without asking the loader; load() is the one call that does, and a repeat is the loader's cache to answer", async () => {
  const { env, keys, warm } = fakeLoaderEnv();
  const prepared = await prepareConfinedWorker(
    workerOptions(env, {
      kind: "facet",
      owner: ["prj_u.iterate/", "Counter"],
      source: {
        "package.json": '{"main":"worker.js"}',
        "worker.js": "export default class Counter {}",
      },
      where: 'facet "counter"',
    }),
  );
  expect(keys).toEqual([]); // `FacetHost#callFacet` stores this identity before any isolate exists
  // the stored restart marker: respelling it restarts every facet once on its next wake
  expect(JSON.parse(prepared.loaderId)).toEqual([
    "facet",
    PLATFORM_ID,
    null,
    ["prj_u.iterate/", "Counter"],
    expect.stringMatching(/^content:[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/),
  ]);
  prepared.load();
  expect(keys).toEqual([prepared.loaderId]);
  prepared.load();
  expect(keys).toEqual([prepared.loaderId, prepared.loaderId]);
  expect(warm).toMatchObject({ size: 1 }); // one isolate under the id, however often it is asked for
});

test("a facet's literal source over the ceiling is refused, coded; a producer expression is never measured", () => {
  const big = {
    "package.json": '{"main":"worker.js"}',
    "worker.js": "x".repeat(SOURCE_MAX_CHARS + 1),
  };
  expect(() =>
    assertFacetSourceWithinCeiling({ source: big, className: "W" }, 'facet "w"'),
  ).toThrowError(/FACET_SOURCE_TOO_LARGE|over the/);
  expect(() =>
    assertFacetSourceWithinCeiling(
      { source: { "package.json": '{"main":"worker.js"}', "worker.js": "ok" }, className: "W" },
      'facet "w"',
    ),
  ).not.toThrow();
  expect(() =>
    assertFacetSourceWithinCeiling(
      { source: "itx.kv.get('src')", cacheKey: "v1", className: "W" },
      'facet "w"',
    ),
  ).not.toThrow();
});

test("the platform origin the ITX stub was minted with is part of the loader id: an isolate minted before a self-host learned its origin is never reused after", async () => {
  const { env } = fakeLoaderEnv();
  const opts = workerOptions(env, {
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default class A {}" },
  });
  const before = await prepareConfinedWorker({ ...opts, platformOrigin: null });
  const after = await prepareConfinedWorker({ ...opts, platformOrigin: "https://os.example" });
  const again = await prepareConfinedWorker({ ...opts, platformOrigin: "https://os.example" });
  expect(before).not.toMatchObject({ loaderId: after.loaderId });
  expect(again).toMatchObject({ loaderId: after.loaderId });
});

// The Worker Loader defect's two spellings, and every look-alike that is not it: code's own error,
// an overload, a coded hop.
test.for([
  {
    name: "V8's clone-version text",
    error: new Error("Unable to deserialize cloned data due to invalid or unsupported version."),
    retired: true,
  },
  {
    name: "the runtime's opaque internal error",
    error: new Error("internal error; reference = h0v550femca1l7qboin7l1f1"),
    retired: true,
  },
  {
    name: "the same text thrown by the loaded code (remote)",
    error: Object.assign(new Error("internal error; reference = h0v550femca1l7qboin7l1f1"), {
      remote: true,
    }),
    retired: false,
  },
  {
    name: "an overload the runtime spelled opaquely",
    error: Object.assign(new Error("internal error; reference = h0v550femca1l7qboin7l1f1"), {
      overloaded: true,
    }),
    retired: false,
  },
  {
    name: "a hop below's coded failure carrying the opaque text",
    error: codedError("UNAVAILABLE", "internal error; reference = h0v550femca1l7qboin7l1f1", {
      kind: "disconnected",
    }),
    retired: false,
  },
  { name: "a lost connection", error: new Error("Network connection lost."), retired: false },
  { name: "the loaded code's own failure", error: new Error("recipe: 503"), retired: false },
  { name: "not an Error", error: "internal error; reference = x", retired: false },
])("isLoadedWorkerPlatformFailure: $name → $retired", ({ error, retired }) => {
  expect(isLoadedWorkerPlatformFailure(error)).toBe(retired);
});

// `workers.get` over a loader whose first `failingEntries` entries fail every call with `failure`,
// then one more GET: what each call settled as, and the generation of every entry it was served.
const defect = new Error("internal error; reference = defect");
const unavailable = {
  rejected: {
    code: "UNAVAILABLE",
    kind: "disconnected",
    message: "workers.get(spec).fetch: internal error; reference = defect",
  },
};
test.for([
  {
    name: "a GET the defect fails is replayed once, on the next generation, and answers",
    step: ["fetch", new Request("https://site.test/")],
    failingEntries: 1,
    failure: defect,
    expected: { first: { answered: "GET" }, next: { answered: "GET" }, generations: [0, 1, 1] },
  },
  {
    name: "a GET whose replay the defect fails too is UNAVAILABLE, disconnected: a 503 with Retry-After",
    step: ["fetch", new Request("https://site.test/")],
    failingEntries: 2,
    failure: defect,
    expected: { first: unavailable, next: { answered: "GET" }, generations: [0, 1, 2] },
  },
  {
    name: "a POST the defect fails is never replayed: UNAVAILABLE, and the next call loads fresh",
    step: ["fetch", new Request("https://site.test/", { method: "POST", body: "form=1" })],
    failingEntries: 1,
    failure: defect,
    expected: { first: unavailable, next: { answered: "GET" }, generations: [0, 1] },
  },
  {
    name: "an RPC method the defect fails is never replayed: UNAVAILABLE, and the next call loads fresh",
    step: ["hello"],
    failingEntries: 1,
    failure: defect,
    expected: {
      first: {
        rejected: {
          ...unavailable.rejected,
          message: "workers.get(spec).hello: internal error; reference = defect",
        },
      },
      next: { answered: "GET" },
      generations: [0, 1],
    },
  },
  {
    name: "the loaded code's own failure is its own: no retire, no replay, not recoded",
    step: ["fetch", new Request("https://site.test/")],
    failingEntries: 1,
    failure: Object.assign(new Error("internal error; reference = thrown-by-code"), {
      remote: true,
    }),
    expected: {
      first: {
        rejected: { kind: "failed", message: "internal error; reference = thrown-by-code" },
      },
      next: {
        rejected: { kind: "failed", message: "internal error; reference = thrown-by-code" },
      },
      generations: [0, 0],
    },
  },
] satisfies { step: ItxExpressionStep; [key: string]: unknown }[])(
  "workers.get and the loader defect: $name",
  async ({ step, failingEntries, failure, expected }) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { call, generations } = workersGetOverFailingLoader(failingEntries, failure);
    const first = await settle(call(step));
    const next = await settle(call(["fetch", new Request("https://site.test/")]));
    expect({ first, next, generations }).toEqual(expected);
  },
);

test("an RPC method is called through callWithCause with the context the call came from: the caller's stamped path, else the context the worker speaks for; never on fetch", async () => {
  const fromChild = workersGetOverFailingLoader(0, defect, {
    principal: null,
    app: true,
    path: "/child",
  });
  expect(await fromChild.call(["hello"])).toBe("hello");
  await fromChild.call(["fetch", new Request("https://site.test/")]);
  const fromHere = workersGetOverFailingLoader(0, defect);
  expect(await fromHere.call(["hello"])).toBe("hello");
  expect({ fromChild: fromChild.callerPaths, fromHere: fromHere.callerPaths }).toEqual({
    fromChild: ["/child"],
    fromHere: ["/"],
  });
});

/** The site ingress's producer expression: the config repo's tree at one commit. */
const site: ItxExpression = [
  "itx",
  "repos",
  ["get", "/repos/config"],
  ["modules", { commitOid: "c0ffee" }],
];

/** A producer that answers valid modules and counts its runs: its n-th answer is
 *  `producedFiles(n)`. */
const fakeProducer = () => {
  let produced = 0;
  return {
    produced: () => produced,
    invoke: async () => producedFiles(++produced),
  };
};

/** The files `fakeProducer` answers on its `n`-th run. */
const producedFiles = (n: number) => ({
  "package.json": '{"main":"worker.js"}',
  "worker.js": `export default ${n}`,
});

/** The identity a publication gives `files`' worker.js (worker-loader.ts `moduleIdentityOf`): what
 *  a vouched manifest names, so the loader keeps a producer's answer under it. */
const workerIdentityOf = (files: Record<string, string>) =>
  moduleIdentityOf(files, "worker.js", { ITX_KV: fakeKv().kv }, "worker.js");

/** A resolved memo's value as worker-loader.ts seals it: the payload's SHA-256, a newline, the
 *  payload. */
const sealed = (memo: unknown) => {
  const payload = JSON.stringify(memo);
  return `${createHash("sha256").update(payload).digest("hex")}\n${payload}`;
};

/** A sealed resolved memo's payload, parsed. */
const unsealed = (value: string): unknown => JSON.parse(value.slice(value.indexOf("\n") + 1));

/** Drop every resolved memo `values` keeps: a cold load then reads only the producer's memo, as
 *  it does after a platform change moved the resolved memo's key. */
const forgetResolved = (values: Map<string, string>) => {
  for (const key of [...values.keys()]) if (key.startsWith("resolved-modules-")) values.delete(key);
};

/** A fake `env.ITX_KV` that keeps every value and its metadata, and records each `put`'s options:
 *  a resolved memo's in `resolvedPuts`, every other in `puts`. */
const fakeKv = () => {
  const values = new Map<string, string>();
  const metadata = new Map<string, unknown>();
  const puts: { key: string; options?: KVNamespacePutOptions }[] = [];
  const resolvedPuts: { key: string; options?: KVNamespacePutOptions }[] = [];
  const kv = {
    get: async (key: string, type?: "json") => {
      const value = values.get(key) ?? null;
      return type === "json" && value ? JSON.parse(value) : value;
    },
    getWithMetadata: async (key: string, type?: "json") => {
      const value = values.get(key) ?? null;
      return {
        value: type === "json" && value ? JSON.parse(value) : value,
        metadata: (value && metadata.get(key)) ?? null,
      };
    },
    put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
      values.set(key, value);
      metadata.set(key, options?.metadata);
      (key.startsWith("resolved-modules-") ? resolvedPuts : puts).push({ key, options });
    },
  } as unknown as KVNamespace;
  return { kv, values, metadata, puts, resolvedPuts };
};

/** A fake `env.LOADER` that records every key and — like workerd — runs `getCode` once per NEW key
 *  and keeps whatever came of it under the key, a rejection included (a handler is attached so a
 *  rejection kept in `warm` is not an unhandled one). Its `ITX_KV` is a fresh fake unless a row
 *  shares one across two fake loaders: two isolate lifetimes of ONE platform. */
const fakeLoaderEnv = ({ kv = fakeKv().kv }: { kv?: KVNamespace } = {}) => {
  const keys: string[] = [];
  const warm = new Map<string, Promise<unknown>>();
  const env = {
    LOADER: {
      get: (key: string, getCode: () => Promise<unknown>) => {
        keys.push(key);
        if (!warm.has(key)) {
          const code = getCode();
          code.catch(() => undefined);
          warm.set(key, code);
        }
        return {};
      },
    },
    ITX_KV: kv,
  } as unknown as Parameters<typeof prepareConfinedWorker>[0]["env"];
  return { env, keys, warm };
};

type ConfinedWorkerOptions = Parameters<typeof prepareConfinedWorker>[0];

/** A confined worker's options over `env`: a worker of `prj_u.iterate/` with no platform origin, a
 *  fresh `itxEntrypoint` stand-in (the one cast) and literal modules nothing invokes, with what a
 *  row varies in `overrides`. */
const workerOptions = (
  env: ConfinedWorkerOptions["env"],
  overrides: Partial<ConfinedWorkerOptions> & Pick<ConfinedWorkerOptions, "source">,
): ConfinedWorkerOptions => ({
  env,
  platformOrigin: null,
  itxEntrypoint: {} as Fetcher,
  kind: "worker",
  owner: "prj_u.iterate/",
  invoke: () => Promise.reject(new Error("literal modules — nothing to invoke")),
  where: "workers.get",
  ...overrides,
});

/** Prepare AND load at once — the shape `itx.workers.get` takes; the rows above count what reached
 *  `env.LOADER`, and only `load()` reaches it. */
const loadConfined = async (...args: Parameters<typeof workerOptions>) => {
  const prepared = await prepareConfinedWorker(workerOptions(...args));
  prepared.load();
  return prepared;
};

/** Let every promise chain started so far settle (a producer's failure reaches the dead marker
 *  through the resolve step's awaits), whatever its depth in microtasks. */
const settled = async () => {
  // a memo's write waits one timer turn before it starts (worker-loader.ts `keepInKv`): three
  // turns see it through
  for (let turn = 0; turn < 3; turn++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

/** `itx.workers.get(spec)` of a fresh context at `/`, one `call(step)` per call by `caller`, over a
 *  Worker Loader whose first `failingEntries` entries (by id, in the order it was asked for them)
 *  reject every call with `failure`, and whose later ones answer: a fetch with its request's method,
 *  an RPC `hello` with "hello". `generations` is the generation of each entry a call was served, in
 *  order; `callerPaths` the path each RPC method's `callWithCause` was handed. */
const workersGetOverFailingLoader = (
  failingEntries: number,
  failure: Error,
  caller: Caller = { principal: null, app: true },
) => {
  const entries: string[] = [];
  const generations: number[] = [];
  const callerPaths: unknown[] = [];
  const env = {
    LOADER: {
      get: (id: string) => {
        if (!entries.includes(id)) entries.push(id);
        generations.push(Number(/#(\d+)\.[0-9a-f]{8}$/.exec(id)?.[1] ?? 0));
        const answer = async (value: string) => {
          if (entries.indexOf(id) < failingEntries) throw failure;
          return value;
        };
        const methods: Record<string, () => Promise<string>> = { hello: () => answer("hello") };
        return {
          getEntrypoint: () => ({
            fetch: async (request: Request) => new Response(await answer(request.method)),
            ...methods,
            // as loaded-worker.ts gives every loaded WorkerEntrypoint, for the one-step walks here
            callWithCause: (_cause: unknown, [[method]]: [string][], callerPath: unknown) => {
              callerPaths.push(callerPath);
              return methods[method]!();
            },
          }),
        };
      },
    },
    ITX_KV: fakeKv().kv,
  } as unknown as ConfinedWorkerOptions["env"];
  const itxEntrypoint = {} as Fetcher; // one stub per context incarnation, as the platform mints it
  const workers = workersRoot({
    env,
    projectId: "prj_u",
    path: "/",
    iterateContextName: `prj_u.iterate/${crypto.randomUUID()}`,
    platformOrigin: () => null,
    itxEntrypoint: () => itxEntrypoint,
    invoke: () => Promise.reject(new Error("literal modules — nothing to invoke")),
    caller: () => caller,
    delivery: () => undefined,
    cause: () => undefined,
    namedWorker: () => Promise.reject(new Error("a literal source names no worker")),
  });
  const source = { "package.json": '{"main":"worker.js"}', "worker.js": "export default {}" };
  return {
    generations,
    callerPaths,
    call: (step: ItxExpressionStep) => workers.get({ source }).invoke([step]),
  };
};

/** `itx.workers.get(spec).ids()` on `/` of one project, over a fake Worker Loader that runs
 *  `getCode` once per new id (`built`, `ids`) and answers every call: the platform's isolate
 *  lifetime, with `kv` its ITX_KV and `invoke` the producer's dispatch. `vouched`: the resolver's
 *  route ran through the config pointer (itx-expression-rewriting.ts `runsThePublishedConfig`). */
const configWorkerOver = ({
  kv,
  invoke,
  vouched,
}: {
  kv: KVNamespace;
  invoke: (call: ItxExpression) => Promise<unknown>;
  vouched: boolean;
}) => {
  const ids: string[] = [];
  const warm = new Map<string, Promise<unknown>>();
  const env = {
    LOADER: {
      get: (id: string, getCode: () => Promise<unknown>) => {
        ids.push(id);
        if (!warm.has(id)) warm.set(id, getCode());
        const answer = async () => warm.get(id); // the call waits for the isolate's code
        return { getEntrypoint: () => ({ ids: answer, callWithCause: answer }) };
      },
    },
    ITX_KV: kv,
  } as unknown as ConfinedWorkerOptions["env"];
  const itxEntrypoint = {} as Fetcher;
  const workers = workersRoot({
    env,
    projectId: "prj_u",
    path: "/",
    iterateContextName: "prj_u.iterate/",
    platformOrigin: () => null,
    itxEntrypoint: () => itxEntrypoint,
    invoke,
    caller: () => ({ principal: null }),
    delivery: () => undefined,
    cause: () => undefined,
    namedWorker: () => Promise.reject(new Error("the pointer's spec names no worker")),
    vouched,
  });
  return {
    ids,
    built: () => warm.size,
    call: (spec: Parameters<typeof workers.get>[0]) => workers.get(spec).invoke([["ids"]]),
  };
};

/** What a call settled as: a Response's text or the value it answered, or the failure's code, kind
 *  and message. */
const settle = (call: unknown) =>
  Promise.resolve(call).then(
    async (answer) => ({ answered: answer instanceof Response ? await answer.text() : answer }),
    (error: unknown) => ({
      rejected: {
        code: errorCode(error),
        kind: failureKind(error),
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );

/** An author's main module as the loader starts it: the platform's module imported first. */
const loaded = (code: string) => `import "./node_modules/.platform/loaded-worker.js"; ${code}`;

/** This build's part of every loader id (worker-loader.ts `platformCodeIdentity`): a SHA-256 of the
 *  platform's code, the same for every load. */
const PLATFORM_ID = JSON.parse(
  (
    await prepareConfinedWorker(
      workerOptions(fakeLoaderEnv().env, {
        source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default 1" },
      }),
    )
  ).loaderId,
)[1] as string;
