import { existsSync } from "node:fs";
import path from "node:path";

/** The same `ITERATE_SEED_REPOS` env as `seedReposEnvOf` in `core/lib/src/cli/deploy.ts`,
 *  so a home-lab mind is born with `/repos/onboarding` when `core/repos/onboarding` exists. */
export function seedReposEnv(coreDir: string): { ITERATE_SEED_REPOS?: string } {
  const onboarding = path.join(coreDir, "repos/onboarding");
  if (!existsSync(onboarding)) return {};
  return { ITERATE_SEED_REPOS: JSON.stringify({ "/repos/onboarding": onboarding }) };
}
