// The config templates a mind is born with — written by core/mind-worker/scripts/build.ts as
// config-templates.js (git ignores it: ../../.gitignore); this declaration lets `tsc` resolve the
// import without it.
/** Each folder of core/configs by its name (`default`, `minimal`), its files as git tracks them. */
export const templates: Record<string, { path: string; content: string }[]>;
/** The repos a new mind starts with beside its config, each by its path in the mind
 *  (`/repos/onboarding`), its files as git tracks them: those the deploy named in
 *  `ITERATE_SEED_REPOS`, and none when it named none. */
export const seedRepos: Record<string, { path: string; content: string }[]>;
