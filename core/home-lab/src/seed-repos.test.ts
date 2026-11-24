import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { seedReposEnv } from "./seed-repos.ts";

void test("seedReposEnv names /repos/onboarding only when core/repos/onboarding exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "home-lab-seed-repos-"));
  try {
    assert.deepEqual(seedReposEnv(dir), {});
    const onboarding = path.join(dir, "repos/onboarding");
    mkdirSync(onboarding, { recursive: true });
    assert.deepEqual(seedReposEnv(dir), {
      ITERATE_SEED_REPOS: JSON.stringify({ "/repos/onboarding": onboarding }),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
