// What a smoke run leaves in a mind's config repo (config-repo.ts): nothing, whatever its checks
// found, against a repo held in memory whose publications can fail.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoFileChange } from "iterate/api";
import {
  HOMEPAGE,
  leftoverChanges,
  markedFile,
  markedHomepage,
  withChange,
} from "./config-repo.ts";

void test("a change whose publication fails is taken out of the repo, and the failure is the one reported", async () => {
  const repo = repoOf({ "worker.ts": WORKER });
  await assert.rejects(
    withChange({
      land: repo.land,
      published: async (commitOid) => {
        throw new Error(`commit ${commitOid} was not published: the tip does not load`);
      },
      change: { message: "add", changes: [{ path: markedFile(MARKER), content: "bytes" }] },
      back: { message: "remove", changes: [{ path: markedFile(MARKER), delete: true }] },
      during: async () => assert.fail("the check reads nothing of a change that is not live"),
    }),
    /commit 1 was not published: the tip does not load/,
  );
  assert.deepEqual(repo.files, { "worker.ts": WORKER });
  assert.deepEqual(repo.messages, ["add", "remove"]);
});

void test("a check that throws while its change is live leaves the homepage as it was", async () => {
  const repo = repoOf({ "worker.ts": WORKER });
  const waitedFor: string[] = [];
  await assert.rejects(
    withChange({
      land: repo.land,
      published: async (commitOid) => void waitedFor.push(commitOid),
      change: {
        message: "change",
        changes: [{ path: "worker.ts", content: WORKER.replace(HOMEPAGE, markedHomepage(MARKER)) }],
      },
      back: { message: "back", changes: [{ path: "worker.ts", content: WORKER }] },
      during: async () => {
        assert.match(repo.files["worker.ts"]!, /Homepage \(smoke 0a1b2c3d\) of mind /);
        throw new Error("the page never showed the change");
      },
    }),
    /the page never showed the change/,
  );
  assert.deepEqual(repo.files, { "worker.ts": WORKER });
  // the way back's publication is not waited for after a failure
  assert.deepEqual(waitedFor, ["1"]);
});

void test("a check that passes answers what it read, with its change out and the way back published", async () => {
  const repo = repoOf({ "worker.ts": WORKER });
  const waitedFor: string[] = [];
  const read = await withChange({
    land: repo.land,
    published: async (commitOid) => void waitedFor.push(commitOid),
    change: { message: "add", changes: [{ path: markedFile(MARKER), content: "bytes" }] },
    back: { message: "remove", changes: [{ path: markedFile(MARKER), delete: true }] },
    during: async (commitOid) => `${commitOid}: ${Object.keys(repo.files).join(" ")}`,
  });
  assert.equal(read, "1: worker.ts smoke-0a1b2c3d.bin");
  assert.deepEqual(repo.files, { "worker.ts": WORKER });
  assert.deepEqual(waitedFor, ["1", "2"]);
});

void test("what earlier runs left is found by its marker: each marked file, and the marked homepage", () => {
  const left = WORKER.replace(HOMEPAGE, markedHomepage("feedc0de"));
  assert.deepEqual(
    leftoverChanges({
      paths: ["worker.ts", markedFile(MARKER), markedFile("feedc0de"), "apps/dash/app.ts"],
      worker: left,
    }),
    [
      { path: "smoke-0a1b2c3d.bin", delete: true },
      { path: "smoke-feedc0de.bin", delete: true },
      { path: "worker.ts", content: WORKER },
    ],
  );
});

void test("a repo with nothing of a smoke run is left alone, a file with a smoke-like name included", () => {
  assert.deepEqual(
    leftoverChanges({
      // not a marker: too long, not hexadecimal, in a folder, another extension
      paths: [
        "worker.ts",
        "smoke-0a1b2c3d4.bin",
        "smoke-nothexxx.bin",
        "notes/smoke-0a1b2c3d.bin",
        "smoke-0a1b2c3d.txt",
      ],
      worker: WORKER,
    }),
    [],
  );
  assert.deepEqual(leftoverChanges({ paths: [], worker: undefined }), []);
});

// ── the fixture ──────────────────────────────────────────────────────────────────────────────────

const MARKER = "0a1b2c3d";
const WORKER = `export default { fetch: () => new Response("${HOMEPAGE}ada") };\n`;

/** A config repo held in memory: `land` applies a commit to `files` and answers its number. */
function repoOf(files: Record<string, string>) {
  const messages: string[] = [];
  const land = async (message: string, changes: RepoFileChange[]) => {
    for (const change of changes) {
      if ("delete" in change) delete files[change.path];
      else files[change.path] = "content" in change ? change.content : "(bytes)";
    }
    return String(messages.push(message));
  };
  return { files, messages, land };
}
