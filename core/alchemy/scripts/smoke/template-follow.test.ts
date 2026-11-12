import assert from "node:assert/strict";
import { test } from "node:test";
import { type Compared, templateFollowed } from "./template-follow.ts";

const ABSENT = Symbol("absent");
const file = (path: string, repo: string | typeof ABSENT = "new"): Compared => ({
  path,
  template: "new",
  repo: repo === ABSENT ? undefined : repo,
});
const DOCS = [file("apps/docs/app.ts"), file("apps/docs/public/app.js")];

void test("a repo whose apps are the template's is settled with no fact at all", () => {
  assert.deepEqual(templateFollowed([...DOCS, file("worker.ts")], undefined), {
    settled: true,
    detail: "every app is the template's",
  });
});

void test("an app that differs with no fact that says why is not settled: the mind has not compared yet", () => {
  const files = [file("apps/docs/app.ts", "old"), file("apps/docs/public/app.js")];
  const { settled, detail } = templateFollowed(files, undefined);
  assert.equal(settled, false);
  assert.match(detail, /apps\/docs differs .* apps\/docs\/app\.ts .* not compared yet/);
});

void test("an older deploy's fact does not explain an app: its owner's file is the template's again", () => {
  const files = [file("apps/docs/app.ts", "old"), file("apps/docs/public/app.js")];
  const stale = {
    appsLeftOld: [{ app: "docs", yours: ["apps/docs/public/app.js"], lacksPackages: [] }],
    leftAlone: [{ path: "apps/docs/public/app.js", lacks: [] }],
  };
  assert.equal(templateFollowed(files, stale).settled, false);
});

void test("an app the mind left old is named with the owner's file and what was not written", () => {
  const files = [file("apps/docs/app.ts", "old"), file("apps/docs/public/app.js", "mine")];
  const fact = {
    appsLeftOld: [{ app: "docs", yours: ["apps/docs/public/app.js"], lacksPackages: [] }],
    leftAlone: [{ path: "apps/docs/public/app.js", lacks: ["a line"] }],
  };
  assert.deepEqual(templateFollowed(files, fact), {
    settled: true,
    detail:
      "apps/docs: left at the version it has (the owner's: apps/docs/public/app.js); not written: apps/docs/app.ts. to follow again: commit the template's file over each of the owner's",
  });
});

void test("an app that is the template's but for the owner's own files, and a worker of the owner's, are said and settled", () => {
  const files = [
    file("apps/agents/app.ts", "mine"),
    file("apps/agents/backend.ts", ABSENT),
    file("apps/agents/index.html"),
    file("worker.ts", "mine"),
  ];
  const fact = {
    appsLeftOld: [],
    heldBack: [],
    leftAlone: [
      { path: "apps/agents/app.ts", lacks: ["x"] },
      { path: "apps/agents/backend.ts", lacks: [] },
      { path: "worker.ts", lacks: ["a", "b"] },
    ],
  };
  assert.deepEqual(templateFollowed(files, fact), {
    settled: true,
    detail:
      "apps/agents: the template's but for the owner's apps/agents/app.ts, apps/agents/backend.ts. the owner's own, not the template's: worker.ts (lacks 1 of the template's lines; the mind's fact lists them)",
  });
});

void test("an app the mind left old because its newer files import a file held back is explained by that", () => {
  const files = [file("apps/docs/app.ts", "old"), file("apps/dash/app.ts", "old")];
  const fact = {
    appsLeftOld: [
      {
        app: "docs",
        yours: ["apps/docs/page.js"],
        lacksPackages: [],
        notWritten: ["apps/docs/app.ts"],
      },
      {
        app: "dash",
        yours: [],
        lacksPackages: [],
        imports: ["apps/docs/app.ts"],
        notWritten: ["apps/dash/app.ts"],
      },
    ],
    leftAlone: [{ path: "apps/docs/page.js", lacks: [] }],
    heldBack: [],
  };
  const { settled, detail } = templateFollowed([...files, file("apps/docs/page.js", "mine")], fact);
  assert.equal(settled, true);
  assert.match(
    detail,
    /apps\/dash: left at the version it has \(its newer files import apps\/docs\/app\.ts, which was not written\)/,
  );
});

void test("a worker that differs is the owner's only when the fact says so: before the comparison it is not settled, and held back it is named so", () => {
  const worker = [file("worker.ts", "old")];
  const before = templateFollowed(worker, undefined);
  assert.equal(before.settled, false);
  assert.match(before.detail, /worker\.ts differs .* not compared yet/);
  // held back for a file of an app left old, which still differs
  const held = templateFollowed(
    [...worker, file("apps/docs/app.ts", "old"), file("apps/docs/page.js", "mine")],
    {
      appsLeftOld: [
        {
          app: "docs",
          yours: ["apps/docs/page.js"],
          lacksPackages: [],
          notWritten: ["apps/docs/app.ts"],
        },
      ],
      leftAlone: [{ path: "apps/docs/page.js", lacks: [] }],
      heldBack: [{ path: "worker.ts", imports: ["apps/docs/app.ts"] }],
    },
  );
  assert.equal(held.settled, true);
  assert.match(
    held.detail,
    /worker\.ts: held back \(it imports apps\/docs\/app\.ts, which was not written\)/,
  );
});

void test("an older fact's held-back reason explains nothing once the file it names is the template's again", () => {
  // the fact says the Dash and worker.ts were held back for apps/docs/app.ts, which now matches
  const files = [
    file("apps/docs/app.ts"),
    file("apps/dash/app.ts", "old"),
    file("worker.ts", "old"),
  ];
  const stale = {
    appsLeftOld: [
      {
        app: "dash",
        yours: [],
        lacksPackages: [],
        imports: ["apps/docs/app.ts"],
        notWritten: ["apps/dash/app.ts"],
      },
    ],
    leftAlone: [],
    heldBack: [{ path: "worker.ts", imports: ["apps/docs/app.ts"] }],
  };
  const { settled, detail } = templateFollowed(files, stale);
  assert.equal(settled, false);
  assert.match(detail, /apps\/dash differs .* not compared yet/);
  assert.match(detail, /worker\.ts differs .* not compared yet/);
});

void test("a package the fact says is lacking explains an app only while the repo's package.json still lacks it", () => {
  const files = [file("apps/docs/app.ts", "old")];
  const fact = {
    appsLeftOld: [
      { app: "docs", yours: [], lacksPackages: ["yjs"], notWritten: ["apps/docs/app.ts"] },
    ],
    leftAlone: [],
  };
  assert.equal(templateFollowed(files, fact, new Set(["diff"])).settled, true);
  assert.equal(templateFollowed(files, fact, new Set(["diff", "yjs"])).settled, false);
  // a package.json that could not be read proves nothing
  assert.equal(templateFollowed(files, fact).settled, false);
});
