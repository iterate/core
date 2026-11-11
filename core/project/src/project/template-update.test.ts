// The rule by which a newer template reaches a config repo that exists (template-update.ts): what
// the platform may write, and what it must leave alone.
import { expect, test } from "vitest";
import { seedOf, templateChanges } from "./template-update.ts";

test("a repo untouched since its seed gets the whole newer template: new files added, the platform's own files replaced", () => {
  const current = { "worker.ts": "old worker\n", "AGENTS.md": "old guide\n" };
  expect(
    templateChanges({ template: newer(), current, ...platformWrote(current, current) }),
  ).toEqual({
    changes: newer(),
    added: ["apps/onboarding/app.ts"],
    replaced: ["worker.ts", "AGENTS.md"],
    platforms: ["worker.ts", "AGENTS.md", "apps/onboarding/app.ts"],
    leftAlone: [],
  });
});

test("a file somebody changed is never written: it is named, with the template's lines it lacks", () => {
  const seed = { "worker.ts": "old worker\n", "AGENTS.md": "old guide\n" };
  const current = { ...seed, "worker.ts": "old worker\nmy own line\n" };
  const { changes, added, replaced, platforms, leftAlone } = templateChanges({
    template: newer(),
    current,
    ...platformWrote(seed, current),
  });
  expect(changes.map((change) => change.path)).toEqual(["AGENTS.md", "apps/onboarding/app.ts"]);
  expect({ added, replaced, platforms }).toEqual({
    added: ["apps/onboarding/app.ts"],
    replaced: ["AGENTS.md"],
    platforms: ["AGENTS.md", "apps/onboarding/app.ts"],
  });
  expect(leftAlone).toEqual([
    {
      path: "worker.ts",
      lacks: ["import { onboardingApp } from './apps/onboarding/app.ts';", "new worker"],
    },
  ]);
});

test("a file left alone once is left alone at the next update too: it is in the repo's tree, and still not the platform's", () => {
  // the first update left the owner's worker.ts alone and wrote the rest: the record keeps what
  // the platform wrote there at the seed, which the owner's file is not
  const seed = { "worker.ts": "old worker\n", "AGENTS.md": "old guide\n" };
  const afterFirst = {
    "worker.ts": "old worker\nmy own line\n",
    "AGENTS.md": "new guide\n",
    "apps/onboarding/app.ts": "the app\n",
  };
  const next = [
    { path: "worker.ts", content: "newest worker\n" },
    { path: "AGENTS.md", content: "newest guide\n" },
    { path: "apps/onboarding/app.ts", content: "the app\n" },
  ];
  const wrote = { ...seed, "AGENTS.md": "new guide\n", "apps/onboarding/app.ts": "the app\n" };
  const { changes, leftAlone } = templateChanges({
    template: next,
    current: afterFirst,
    ...platformWrote(wrote, afterFirst),
  });
  expect(changes).toEqual([{ path: "AGENTS.md", content: "newest guide\n" }]);
  expect(leftAlone.map((file) => file.path)).toEqual(["worker.ts"]);
});

test("with no record of the platform's, a file the repo has is somebody's: only what it lacks is added", () => {
  const current = { "worker.ts": "theirs\n", "AGENTS.md": "new guide\n" };
  const { changes, platforms, leftAlone } = templateChanges({
    template: newer(),
    current,
    ...platformWrote({}, current),
  });
  expect(changes.map((change) => change.path)).toEqual(["apps/onboarding/app.ts"]);
  // a file that is the template's bytes already is the platform's from now on
  expect(platforms).toEqual(["AGENTS.md", "apps/onboarding/app.ts"]);
  expect(leftAlone.map((file) => file.path)).toEqual(["worker.ts"]);
});

test("a file the platform wrote and somebody deleted is not put back", () => {
  const seed = { "worker.ts": "old worker\n", "AGENTS.md": "old guide\n" };
  const current = { "worker.ts": "old worker\n" };
  const { changes, added, leftAlone } = templateChanges({
    template: newer(),
    current,
    ...platformWrote(seed, current),
  });
  expect(changes.map((change) => change.path)).toEqual(["worker.ts", "apps/onboarding/app.ts"]);
  expect(added).toEqual(["apps/onboarding/app.ts"]);
  expect(leftAlone).toEqual([{ path: "AGENTS.md", lacks: [] }]);
});

test("a repo that is the template already changes nothing, and nothing is ever deleted", () => {
  const template = Object.fromEntries(newer().map((file) => [file.path, file.content]));
  const current = {
    ...template,
    "agents.ts": "a module an older template had\n",
    "logo.png": { base64: "iVBORw0KGgo=" },
  };
  const { changes, leftAlone } = templateChanges({
    template: newer(),
    current,
    ...platformWrote(template, current),
  });
  expect({ changes, leftAlone }).toEqual({ changes: [], leftAlone: [] });
});

test("the seed is the commit with no parent that the platform authored as a seed, and no other", () => {
  const platform = { email: "config@iterate.com" };
  const seed = { oid: "c1", message: "seed: core/configs/default", author: platform, parents: [] };
  const later = [
    { oid: "c3", message: "my change", author: { email: "ada@example.com" }, parents: ["c2"] },
    // on a born main the platform authors a member's commit that names no author, whatever it
    // says: a tree with somebody's files in it
    { oid: "c2", message: "seed: core/configs/default", author: platform, parents: ["c1"] },
  ];
  expect(seedOf([...later, seed], platform.email)).toEqual({ oid: "c1", template: "default" });
  // out of the log's reach
  expect(seedOf(later, platform.email)).toBeUndefined();
  // a first commit somebody else made, or one that is no seed
  expect(
    seedOf([{ ...seed, author: { email: "ada@example.com" } }], platform.email),
  ).toBeUndefined();
  expect(seedOf([{ ...seed, message: "first" }], platform.email)).toBeUndefined();
});

function newer() {
  return [
    {
      path: "worker.ts",
      content: "import { onboardingApp } from './apps/onboarding/app.ts';\nnew worker\n",
    },
    { path: "AGENTS.md", content: "new guide\n" },
    { path: "apps/onboarding/app.ts", content: "the app\n" },
  ];
}

/** The platform's record as the processor hands it over: the paths it `wrote`, and those of them
 *  that `current` still has byte for byte. */
function platformWrote(wrote: Record<string, string>, current: Record<string, unknown>) {
  return {
    written: new Set(Object.keys(wrote)),
    untouched: new Set(Object.keys(wrote).filter((path) => current[path] === wrote[path])),
  };
}
