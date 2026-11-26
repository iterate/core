// Keep this a leaf module (zod only): the dash bundles the Mind contract that names this
// catalog, so it must not pull core-processor.ts into a client.
import { z } from "zod";

export const CONTEXT_ACTIVITY_PUSHED_TYPE = "events.iterate.com/itx/activity-pushed";
export const CONTEXT_ACTIVITY_POPPED_TYPE = "events.iterate.com/itx/activity-popped";

/** Maximum number of live items retained on a context's activity stack; older items drop off the bottom. */
export const CONTEXT_ACTIVITY_STACK_LIMIT = 32;

const ContextActivityTag = z.string().trim().min(1).max(40);

export const ContextActivity = z.object({
  key: z.string().min(1).max(120),
  text: z.string().min(1).max(160),
  icon: z.string().min(1).max(500).optional(),
  url: z.string().min(1).max(500).optional(),
  tags: z.array(ContextActivityTag).max(8).optional(),
  pushedAt: z.string().optional(),
  expiresAt: z.string().optional(),
});
export type ContextActivity = z.infer<typeof ContextActivity>;

export const ContextActivityPushedEntry = ContextActivity.omit({ pushedAt: true }).extend({
  ttlMs: z.number().int().positive().max(86_400_000).optional(),
});
export type ContextActivityPushedEntry = z.infer<typeof ContextActivityPushedEntry>;

export const ContextActivityPushedPayload = z.union([
  ContextActivityPushedEntry,
  z.object({ items: z.array(ContextActivityPushedEntry).min(1).max(CONTEXT_ACTIVITY_STACK_LIMIT) }),
]);
export type ContextActivityPushedPayload = z.infer<typeof ContextActivityPushedPayload>;

export const ContextActivityPoppedPayload = z.union([
  z.object({ key: z.string().min(1).max(120) }),
  z.object({ keys: z.array(z.string().min(1).max(120)).min(1).max(CONTEXT_ACTIVITY_STACK_LIMIT) }),
  z.object({ tag: ContextActivityTag }),
]);
export type ContextActivityPoppedPayload = z.infer<typeof ContextActivityPoppedPayload>;

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
    "events.iterate.com/itx/described": {
      description:
        "What this context is for, in its own words, and any metadata about it: the newest one stands, an absent field keeps what stood and null clears it. Every context folds it into the summary it sends to the mind's catalog (context/context-summary.ts), which `itx.contexts.list` answers.",
      payloadSchema: z.object({
        description: z.string().max(2_000).nullable().optional(),
        metadata: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
    },
    [CONTEXT_ACTIVITY_PUSHED_TYPE]: {
      description:
        "One or more live activities were pushed onto this context's in-memory activity stack (context/context-activity-stack.ts). Pushing an existing key updates it in place and promotes it to the top of the stack.",
      payloadSchema: ContextActivityPushedPayload,
    },
    [CONTEXT_ACTIVITY_POPPED_TYPE]: {
      description:
        "Activities were removed from this context's in-memory activity stack by key, keys, or tag (context/context-activity-stack.ts).",
      payloadSchema: ContextActivityPoppedPayload,
    },
    "events.iterate.com/itx/signed-request-sent": {
      description:
        "A request this context's caller asked the built-in fetch to send signed as the mind, after egress answered or threw (context/built-ins.ts `recordSignedRequest`). The platform's alone, written when egress settles. Its `source` names who asked, as any event of that caller. The URL is its origin and path, never its query: a path can itself hold a token.",
      payloadSchema: z.object({
        peer: z.string(),
        method: z.string(),
        url: z.string(),
        callerPath: z.string(),
        principal: z.string().optional(),
        app: z.boolean(),
        outcome: z.union([z.object({ status: z.number().int() }), z.object({ threw: z.string() })]),
      }),
    },
    "events.iterate.com/itx/child-created": {
      description:
        "A context under this one exists: every context appends it to each ancestor up to its root when it wakes (iterate-context-durable-object.ts `announceToAncestors`), keyed by the child's path, so it lands once per child. The Mind processor reduces the ones on `/` into its context registry.",
      payloadSchema: z.object({ childPath: z.string().min(1) }),
    },
  },
};
