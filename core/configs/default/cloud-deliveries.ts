// cloud-deliveries.ts — WHAT COUNTS AS iterate Cloud's DELIVERY: GitHub's, Slack's, Gmail's,
// Calendar's and X's events, and the Cloud's own words such as `google/gmail-connected`. They
// come in one of two forms, with the same type and payload (accounts.md):
//
//   the key form    on `/integrations/<provider>/<account>`, signed by the Cloud's key: the
//                   signer's actor is `iterate-cloud`, the stack's own name for that key. It
//                   reaches `processEvent`.
//   the mind form   on `/minds/iterate.com/integrations/<provider>/<account>`, signed by the mind
//                   iterate.com with the key it publishes. A mind gets this form once its owner
//                   let iterate.com in (minds.md), AND the mind said that it reads it
//                   (`sayMindForm`). It reaches `processMindEvent`.
//
// Every reader of a delivery asks `cloudDeliveryOf`, and nothing else in this repo tests the
// Cloud's signer for one. What this mind makes of a delivery (a message, a watch, a sync) stays on
// the mind's own context for the account, `context`, whichever form the delivery came in.

/** The mind that is iterate Cloud, when it signs as a mind. */
export const ITERATE_MIND = "iterate.com";

/** An event as `processEvent` and `processMindEvent` hand it, as far as this file reads it. */
export type CloudDeliveryEvent = {
  path: string;
  source?: { signer?: { principal: { actor?: string; kind?: string } } };
};

/** `/integrations/<provider>/<account>`, and no segment more or less. */
const ACCOUNT_PATH = /^\/integrations\/([^/]+)\/([^/]+)$/;
const MIND_PREFIX = `/minds/${ITERATE_MIND}`;

/** The provider, the account and the mind's own context for it, when `event` is iterate Cloud's
 *  delivery in either form; else null. */
export function cloudDeliveryOf(
  event: CloudDeliveryEvent,
): { provider: string; account: string; context: string } | null {
  const principal = event.source?.signer?.principal;
  const inMindForm = event.path.startsWith(`${MIND_PREFIX}/`);
  const signed = inMindForm
    ? principal?.kind === "mind" && principal.actor === ITERATE_MIND
    : !principal?.kind && principal?.actor === "iterate-cloud";
  if (!signed) return null;
  const context = inMindForm ? event.path.slice(MIND_PREFIX.length) : event.path;
  const [, provider, account] = ACCOUNT_PATH.exec(context) || [];
  return provider && account ? { provider, account, context } : null;
}

/** The part of `itx` that `sayMindForm` uses. */
export type MindFormItx = {
  fetch(request: Request): Promise<Response>;
  secrets: {
    list(): Promise<{ path: string; cloud?: string }[]>;
    cloud(): Promise<{ origin: string; clients: string[] } | null>;
  };
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
  };
};

/** The one kv key: `"said"` once the Cloud took the word, else the time of the last try. */
const MIND_FORM_KEY = "cloud-deliveries:mind-form";
/** How long after a try that the Cloud did not take the next one waits. */
const TRY_AGAIN_MS = 60 * 60_000;

/** THE MIND TELLS THE CLOUD THAT IT READS THE MIND FORM. Call it only from the file that reads
 *  that form (`worker.ts`: its init step, and `cloudDeliveryEvent` at each delivery): a
 *  `worker.ts` without `processMindEvent` must never say it, or its deliveries would be taken
 *  and read by nothing. The Cloud sends the mind form to no mind that has not said so.
 *
 *  The word is an ask of the Cloud (core/secrets-worker cloud-client.ts `askOf`), in the name of
 *  an account a member connected through the Cloud: each such account is tried in turn until
 *  the Cloud takes the word, since not every kind of connection can ask. With no Cloud or no
 *  account it does nothing: such a mind gets no delivery either. Said once; after a try that
 *  was not taken, the next one waits an hour. */
export async function sayMindForm(itx: MindFormItx): Promise<void> {
  const kept = await itx.kv.get(MIND_FORM_KEY);
  if (kept === "said" || Number(kept) > Date.now() - TRY_AGAIN_MS) return;
  const cloud = await itx.secrets.cloud();
  if (!cloud) return;
  const accounts = (await itx.secrets.list()).filter(
    (secret) => secret.cloud && cloud.clients.includes(secret.cloud),
  );
  if (accounts.length === 0) return;
  const answers: (string | number)[] = [];
  for (const account of accounts) {
    const answer = await itx
      .fetch(
        new Request(`${cloud.origin}/clients/${account.cloud}/ask/mind-form`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "iterate-connection": `getSecret(${JSON.stringify(account.path)})`,
          },
          body: JSON.stringify({ reads: true }),
        }),
      )
      .catch((error: unknown) => String(error));
    // Taken only when the Cloud itself says so: a request that a rule holds for a member answers
    // 202, and nothing has reached the Cloud then.
    const taken =
      typeof answer !== "string" &&
      answer.status === 200 &&
      ((await answer.json().catch(() => null)) as { ok?: unknown } | null)?.ok === true;
    if (taken) {
      await itx.kv.put(MIND_FORM_KEY, "said");
      return;
    }
    answers.push(typeof answer === "string" ? answer : answer.status);
  }
  await itx.kv.put(MIND_FORM_KEY, String(Date.now()));
  console.warn({ event: "config.mind-form-word-not-taken", accounts: accounts.length, answers });
}
