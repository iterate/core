import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { storedPathOf } from "./stored-path.ts";

void test("two deployers keep the same string for the same folder of the repository", () => {
  const cloud = storedPathOf("/stack/core/auth-worker/migrations", "/stack/core/alchemy");
  const laptop = storedPathOf(
    "/Users/someone/src/iterate/core/auth-worker/migrations",
    "/Users/someone/src/iterate/core/alchemy",
  );
  assert.equal(cloud, "../auth-worker/migrations");
  assert.equal(laptop, cloud);
});

void test("the string still names the folder, from any working directory", () => {
  const folder = "/stack/core/auth-worker/migrations";
  for (const from of ["/stack/core/alchemy", "/stack", "/somewhere/else"])
    assert.equal(resolve(from, storedPathOf(folder, from)), folder);
});
