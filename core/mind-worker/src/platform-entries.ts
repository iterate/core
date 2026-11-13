// THE MODULES A LOADED WORKER HAS from the platform: scripts/build.ts bundles each into the
// platform's modules, and src/context/module-resolution.ts refuses any other subpath of these
// packages. A config's file may import these and its own relative files, nothing else of them
// (platform-entries.test.ts checks core/configs).

/** One zod per isolate, so a schema made by user code is the schema the SDK checks. */
export const PLATFORM_ENTRIES = [
  "iterate/sdk",
  "iterate/stream/processor",
  "iterate/stream/contract",
  "iterate/stream/run",
  "iterate/email",
  "iterate/integrations",
  "iterate/api",
  "iterate/lib",
  "iterate/expression",
  "iterate/principal",
  "iterate/agents",
  "iterate/agents/install",
  "iterate/agents/kinds",
  "iterate/agents/contract",
  "iterate/agents/processor",
  "iterate/agents/codemode-format",
  "iterate/standalone-page",
  "zod",
] as const;
