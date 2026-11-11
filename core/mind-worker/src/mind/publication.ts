// The probe admits a commit: its main module's default export is an `IterateConfigEntrypoint` that
// constructs. Only the platform writes the pointer, `itx.config` (caller.ts `refuseNonPlatformWrites`).
import type { ItxExpression } from "iterate/expression";
import type { StreamEventInput } from "iterate/stream/processor";
import { z } from "zod";
import type { WorkerManifest } from "core-itx";
import { readPackage } from "../context/module-resolution.ts";

// The config repo's files at a commit: text, or `{ base64 }` for a file that is not text.
type RepoFiles = Record<string, string | { base64: string }>;

export type MindPublisher = {
  head(): Promise<string | null>;
  files(commitOid: string): Promise<RepoFiles>;
  // throws when it does not resolve
  identityOf(files: RepoFiles, mainModule: string): Promise<string>;
  probe(files: RepoFiles, mainModule: string): Promise<unknown>;
  appendAsPlatform(...events: StreamEventInput[]): Promise<unknown>;
};

// A platform failure on the way (a module lock, the probe's load) throws as itself: the follower
// meets it again.
export async function probedConfig(
  files: RepoFiles,
  publisher: Pick<MindPublisher, "identityOf" | "probe">,
): Promise<{ mainModule: string; modules: WorkerManifest["modules"] }> {
  const { entry } = readPackage(files, "the config repo");
  if (Object.hasOwn(files, PROBE_MODULE))
    throw new Error(`${PROBE_MODULE} is the platform's publication probe: rename that file`);
  const modules = [...new Set([entry, ...publishedModules(files)])];
  const identities = await Promise.all(
    modules.map(async (module) => [module, await publisher.identityOf(files, module)] as const),
  );
  const probeSource = { ...files, [PROBE_MODULE]: probeModule(entry, modules) };
  const answer = ProbeAnswer.parse(await publisher.probe(probeSource, PROBE_MODULE));
  if (!answer.configEntrypoint)
    throw new Error(
      `${entry}'s default export is not an IterateConfigEntrypoint (iterate/sdk): every context's events are delivered to its deliverEvent`,
    );
  if (answer.constructError)
    throw new Error(
      `${entry}'s default export does not construct: ${answer.constructError} — every delivery and every request constructs it`,
    );
  return {
    mainModule: entry,
    modules: Object.fromEntries(
      identities.map(([module, identity]) => [
        module,
        { identity, classes: answer.classes[module] ?? [] },
      ]),
    ),
  };
}

// At the fixed point: through `itx.repos` a hop reads `/`'s rule table first, and a read in the
// SNAPSHOT_TTL_MS before a publication's commit would hold that commit's answer as long.
const CONFIG_REPO_FACET: ItxExpression = [
  "itx",
  "builtins",
  ["cd", "/repos/config"],
  "builtins",
  "facets",
  ["get", "repo"],
];

export const configRepoCall = (verb: string, ...args: unknown[]): ItxExpression => [
  ...CONFIG_REPO_FACET,
  [verb, ...args],
];

// `itx.config.modules` names the repo facet at the fixed point, and a row on `itx.config…` is the
// platform's alone, so no rule anyone appends re-points what loads under the published identity.
export function configPointer(
  commitOid: string,
  mainModule: string,
  manifest: WorkerManifest,
): StreamEventInput[] {
  const rule = (match: string, key: string, target: unknown, description: string) => ({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    idempotencyKey: `mind/${key}:${manifest.generation}`,
    payload: { match, target, description },
  });
  return [
    rule(
      "itx.config.modules",
      "config-modules",
      [...CONFIG_REPO_FACET, "files"],
      "the config repo's files at a commit, as the published config's producer reads them",
    ),
    rule(
      "itx.config",
      "config-pointer",
      [
        "itx",
        "builtins",
        "workers",
        [
          "get",
          {
            source: ["itx", "config", ["modules", { commitOid }]],
            cacheKey: commitOid,
            mainModule,
            manifest,
          },
        ],
      ],
      `the mind's published config: /repos/config at ${commitOid.slice(0, 12)}, publication ${manifest.generation}`,
    ),
  ];
}

const PROBE_MODULE = ".iterate-publication-probe.js";

const ProbeAnswer = z.object({
  configEntrypoint: z.boolean(),
  constructError: z.string().nullable(),
  classes: z.record(z.string(), z.array(z.string())),
});

// The modules a facet's class may live in: those at the root, and each app's backend
// (`apps/<name>/backend.ts`). Not every file: the probe loads each one, and a page's script is not
// a Worker's module.
function publishedModules(files: RepoFiles): string[] {
  return Object.keys(files)
    .filter((path) => /\.(ts|mts|js|mjs)$/.test(path) && !path.endsWith(".d.ts"))
    .filter((path) => !path.includes("/") || /^apps\/[^/]+\/backend\.[a-z]+$/.test(path))
    .sort();
}

function probeModule(entry: string, modules: string[]): string {
  const others = modules.filter((module) => module !== entry);
  const guarded = others.map(
    (module) =>
      `  try { classes[${JSON.stringify(module)}] = classesOf(await import(${JSON.stringify(`./${module}`)})); } catch {}`,
  );
  return [
    `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";`,
    `import { IterateConfigEntrypoint } from "iterate/sdk";`,
    `import * as main from ${JSON.stringify(`./${entry}`)};`,
    `const classesOf = (module) => Object.keys(module).filter((key) => typeof module[key] === "function" && module[key].prototype instanceof DurableObject);`,
    `const messageOf = (error) => (error instanceof Error ? error.message : String(error));`,
    `export default class extends WorkerEntrypoint {`,
    `  async probe() {`,
    `    const Entry = main.default;`,
    `    const configEntrypoint = typeof Entry === "function" && Entry.prototype instanceof IterateConfigEntrypoint;`,
    `    let constructError = null;`,
    `    if (configEntrypoint) try { new Entry(this.ctx, this.env); } catch (error) { constructError = messageOf(error); }`,
    `    const classes = { ${JSON.stringify(entry)}: classesOf(main) };`,
    ...guarded,
    `    return { configEntrypoint, constructError, classes };`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
}
