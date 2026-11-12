// A MODEL CALL BY THE MIND'S OWN CODE NAMES THE MIND TO THE AI GATEWAY. The gateway's spend rules
// give each mind a budget by the key `mindSlug` of a request's metadata, and a rule passes over a
// request that lacks the key (docs/api-keys.md). An agent's turn names its mind itself; a call a
// mind's code makes with `itx.ai.run` passes whatever its author wrote, so the mind Worker puts the
// name on every such call (core/mind-worker/src/itx-ai.ts). This check makes that call with no
// metadata of its own and reads what the gateway logged for it.
//
// It reads the call's own log by its id, not the gateway's analytics: the log could be read one
// second after the answer, and the analytics came a minute later (measured 2026-11-12).
import { z } from "zod";
import { attempt, mindRoot, type Check } from "./lib.ts";

/** What the check's script answers: the model call's status, whether the gateway's log of the call
 *  was read (in `tries` tries, a second apart), and the metadata that log holds. `logId` is null
 *  when the gateway's answer named no log. */
const Logged = z.object({
  status: z.number(),
  logId: z.string().nullable(),
  read: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  tries: z.number(),
});

export async function modelChecks(domain: string): Promise<Check[]> {
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token) return [];
  const root = () => mindRoot(domain, token);
  return [
    await attempt(
      "ai: a model call by the mind's own code names the mind to the AI Gateway",
      async () => {
        const { mindSlug } = await root().whoami();
        const logged = Logged.parse(
          // The agents' default model (core/lib/src/agents/contract.ts) and the fewest output
          // tokens the provider takes: the answer is not read.
          await root().run(`async (itx) => {
  const answer = await itx.ai.run("openai/gpt-6.1-sol", { input: "Reply with the one word: ok", max_output_tokens: 16 }, { returnRawResponse: true, gateway: { id: "default", skipCache: true } });
  const logId = answer.headers.get("cf-aig-log-id");
  await answer.body?.cancel();
  let log = null;
  let tries = 0;
  while (logId && !log && tries < 10) {
    tries += 1;
    log = await itx.ai.gateway("default").getLog(logId).catch(() => null);
    if (!log) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const metadata = typeof log?.metadata === "string" ? JSON.parse(log.metadata) : log?.metadata;
  return { status: answer.status, logId, read: Boolean(log), metadata: metadata || null, tries };
}`),
        );
        // An account with no credit for unified billing: the gateway refuses the call (402) and may
        // keep no log of it. The mind's agents then pay with a key of the mind's own, and no
        // gateway rule is in their way.
        if (logged.status === 402 && !logged.read)
          return {
            pass: true,
            detail: "skipped: the account's AI Gateway has no credit (402), and kept no log",
          };
        return {
          pass: Boolean(mindSlug) && logged.metadata?.mindSlug === mindSlug,
          detail: `the call answered ${logged.status}; the gateway's log ${logged.logId} (${logged.read ? `read in ${logged.tries} tries` : `not read in ${logged.tries} tries`}) holds the metadata ${JSON.stringify(logged.metadata)}; the mind is ${mindSlug}`,
        };
      },
    ),
  ];
}
