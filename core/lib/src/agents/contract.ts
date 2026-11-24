// contract.ts — THE FACTS THAT EVERY KIND OF AGENT SHARES. An agent is a context under `/agents`
// (catalog.ts). What runs it is its kind's business: the mind's own agent is code in the mind's
// config repo (core/configs/default/agent/), and a coding session is a bridge's. The platform runs
// no agent. These three facts are what `itx.agents` and a list need of any of them:
//
//   agent/message-received   words someone sent through `itx.agents.get(path).message(…)`
//   agent/summary-updated    what the agent says about itself, which its rows copy to `/agents`
//   agent/deleted            the death certificate, on `/agents`
//
// A plain catalog, as `RunEventCatalog` is (../stream/run.ts): no processor owns these facts and
// none of them has a state here. A browser loads this file (the Dash reads these facts by these
// schemas), so it imports zod alone.
import { z } from "zod";

/** A file attached to words (an attachment record, minus its signed URL): the mind file it was
 *  stored as (`itx.files`), its content type, original name and size. */
const FileAttachment = z.object({
  contentType: z.string().min(1),
  filename: z.string().min(1),
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
});
export type FileAttachment = z.infer<typeof FileAttachment>;

export const AgentEventCatalog = {
  events: {
    "events.iterate.com/agent/message-received": {
      description:
        "Words someone sent the agent through `itx.agents.get(path).message(…)`: the one input every kind of agent reads. The mind's own agent has it transcribed into its input, `agent/context-added`; another kind's delivery row hands it to whatever runs it.",
      payloadSchema: z.object({
        message: z.string(),
        /** Files stored under the agent's path (`message()` stores them). */
        files: z.array(FileAttachment).optional(),
        /** The context that sent the words, as the collection relays it (collection.ts). Absent:
         *  the words came from the mind's root, a person's or the mind's own code. */
        from: z.string().optional(),
        /** `false`: context only, the words wake nothing (`message(…, { trigger: false })`). Each
         *  kind decides what that means; absent means the words want an answer. */
        trigger: z.literal(false).optional(),
      }),
    },
    "events.iterate.com/agent/summary-updated": {
      description:
        "What the agent says about itself, each field optional and merged: `activity` (what it is doing now), `title` (its own short title), `waitingFor` (what it waits for; null clears it) and `description` (its purpose or conclusions). A row on the agent's context copies it to `/agents`, where a list reads it.",
      payloadSchema: z.object({
        activity: z.string().min(1).optional(),
        title: z.string().min(1).max(200).optional(),
        waitingFor: z.enum(["user_input", "external_event", "timer"]).nullable().optional(),
        description: z.string().min(1).max(1_000).optional(),
      }),
    },
    "events.iterate.com/agent/deleted": {
      description:
        "The death certificate, on `/agents`: the catalog drops the agent's row and keeps the death, so it names the path. Terminal: a deleted agent is not re-creatable.",
      payloadSchema: z.object({ path: z.string().min(1) }),
    },
  },
};
