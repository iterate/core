// names.ts — WHAT A DEPLOYMENT IS CALLED ON CLOUDFLARE, from the `cloudflare` section of its iterate
// config: the Worker, and each resource it binds. core/os's iterate config holds the section
// (src/iterate-config.ts) and takes its names from here.

/** Where a D1's primary may run: Cloudflare's location hints, which the D1 resource takes. */
export const D1_LOCATIONS = ["wnam", "enam", "weur", "eeur", "apac", "oc"] as const;

/** The `cloudflare` section of an iterate config, as the stack reads it (./stack.ts): where it
 *  deploys and what it is called. core/os's own schema has more (the API token among it); the stack
 *  needs none of that. */
export type CloudflareSection = {
  /** The account, 32 hex characters, which the credentials must reach. */
  accountId: string;
  /** The prefix of the D1 `<prefix>-db`, the R2 bucket `<prefix>-files` and the Artifacts
   *  namespace `<prefix>-repos`. */
  resourcePrefix: string;
  /** The Worker's name, and the stage. Unset ⇒ the prefix. */
  workerName?: string;
  /** Where the D1's primary runs, fixed when it is made. */
  d1Location?: (typeof D1_LOCATIONS)[number];
  /** A destroy deletes none of the data. */
  protectData?: boolean;
  /** The Worker's routes, each a pattern on a zone of the account. */
  workerRoutes?: { pattern: string; zone: string }[];
  /** Whether the Worker answers on workers.dev. */
  workersDev?: boolean;
  /** The telemetry warehouse the Worker sends to, which another deploy owns. */
  telemetry?: { workerName: string; eventsStream: string };
};

/** The names a deployment's Worker and the resources it binds go by. */
export function resourceNamesOf(
  cloudflare: Pick<CloudflareSection, "resourcePrefix" | "workerName">,
) {
  const prefix = cloudflare.resourcePrefix;
  const worker = cloudflare.workerName || prefix;
  return {
    worker,
    db: `${prefix}-db`,
    files: `${prefix}-files`,
    repos: `${prefix}-repos`,
    oauthKv: `${worker}-oauth-kv`,
    itxKv: `${worker}-itx-kv`,
  };
}
