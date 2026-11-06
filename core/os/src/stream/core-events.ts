// core-events.ts — the core's events that a domain processor also consumes. A leaf module (zod only):
// the Project contract names this catalog in its `processorDeps`, and the dash bundles that
// contract, so it must not pull core-processor.ts's facet and rewrite-rule code into a client.
// The core validates these at the append boundary and reduces them (core-processor.ts).
import { z } from "zod";

/** The core events a processor may consume without owning them. */
export const CoreEventCatalog = {
  events: {
    "events.iterate.com/itx/ingress-configured": {
      description:
        "Where the project's hosts go: an itx expression, or null for nowhere. The core's control event: the append validates it, the core's reduce keeps it, and the edge reads it from the root's snapshot (stream/core-processor.ts). The Project saga points it at the project's published config, `itx.config`, once.",
      // Stored as the parsed expression: the append boundary normalizes a string target.
      payloadSchema: z.object({ target: z.array(z.unknown()).nullable() }),
    },
    "events.iterate.com/itx/file-set": {
      description:
        "A file was written: the evidence every write through `itx.files` or `itx.r2` lands on the context that made it, and a signed upload on `/`. Its bytes stay in the bucket.",
      payloadSchema: z.object({
        path: z.string().min(1),
        size: z.number().int().nonnegative(),
        contentType: z.string().min(1),
        etag: z.string().min(1),
      }),
    },
    "events.iterate.com/itx/file-deleted": {
      description:
        "A file was deleted through `itx.files` or `itx.r2`, on the context that did it.",
      payloadSchema: z.object({ path: z.string().min(1) }),
    },
    "events.iterate.com/itx/child-created": {
      description:
        "A context under this one exists: every context appends it to each ancestor up to its root when it wakes (iterate-context-durable-object.ts `announceToAncestors`), keyed by the child's path, so it lands once per child. The Project processor reduces the ones on `/` into its context registry.",
      payloadSchema: z.object({ childPath: z.string().min(1) }),
    },
  },
};
