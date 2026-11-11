// Keep this a leaf module (zod only): the dash bundles the Mind contract that names this
// catalog, so it must not pull core-processor.ts into a client.
import { z } from "zod";

export const CoreEventCatalog = {
  events: {
    "events.iterate.com/itx/ingress-configured": {
      description:
        "Where the mind's hosts go: an itx expression, or null for nowhere. The core's control event: the append validates it, the core's reduce keeps it, and the edge reads it from the root's snapshot (stream/core-processor.ts). The Mind saga points it at the mind's published config, `itx.config`, once.",
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
        "A context under this one exists: every context appends it to each ancestor up to its root when it wakes (iterate-context-durable-object.ts `announceToAncestors`), keyed by the child's path, so it lands once per child. The Mind processor reduces the ones on `/` into its context registry.",
      payloadSchema: z.object({ childPath: z.string().min(1) }),
    },
  },
};
