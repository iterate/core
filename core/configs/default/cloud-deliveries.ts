// cloud-deliveries.ts — WHAT COUNTS AS iterate Cloud's DELIVERY: GitHub's, Slack's, Gmail's,
// Calendar's and X's events, and the Cloud's own words such as `google/gmail-connected`. They
// come in one of two forms, with the same type and payload (accounts.md):
//
//   the key form    on `/integrations/<provider>/<account>`, signed by the Cloud's key: the
//                   signer's actor is `iterate-cloud`, the stack's own name for that key. It
//                   reaches `processEvent`.
//   the mind form   on `/minds/<iterate's id>/integrations/<provider>/<account>`, signed by
//                   the mind iterate.iterate.com with the key it publishes. A mind gets this form
//                   once its owner let iterate.iterate.com in (minds.md), AND the mind said
//                   that it reads it (`sayMindForm`). It reaches `processMindEvent`. While
//                   iterate's mind signs in the hostname form, under a rule by hostname
//                   it lands on `/minds/iterate.iterate.com/…` instead, still
//                   signed by iterate's id: `iterateContextOf` takes both.
//
// Every reader of a delivery asks `cloudDeliveryOf`, and nothing else in this repo tests the
// Cloud's signer for one. What this mind makes of a delivery (a message, a watch, a sync) stays on
// the mind's own context for the account, `context`, whichever form the delivery came in.

/** WHERE iterate Cloud IS: its origin, an `https:` address with no path. This constant is the one
 *  place in the mind that names it. No config of the stack does: the code that makes a secret
 *  names the Cloud (`client: { cloud: "google", origin: ITERATE_CLOUD }`), and the secret keeps
 *  that origin for every later request (accounts.md). Every file of this template that names the
 *  Cloud imports it from here. */
export const ITERATE_CLOUD = "https://cloud.iterate.com";

/** The mind that is iterate Cloud, when it signs as a mind: by its id, the hash of its genesis
 *  record, which its log at `ITERATE_HOSTNAME` proves. The id decides: a hostname can move to
 *  another mind, the id cannot. */
// allow-high-entropy-next-line: a public mind id, the SHA-256 of iterate.iterate.com's genesis record
export const ITERATE_MIND = "7780b12cd895879475d1b5d01974de09b23b6b9a15d518b534bd7f314b11ac95";

/** Where iterate's mind is: its control-plane hostname, an address and a label. */
export const ITERATE_HOSTNAME = "iterate.iterate.com";

/** An event as `processEvent` and `processMindEvent` hand it, as far as this file reads it. */
export type CloudDeliveryEvent = {
  path: string;
  source?: { signer?: { principal: { actor?: string; kind?: string } } };
};

/** `/integrations/<provider>/<account>`, and no segment more or less. */
const ACCOUNT_PATH = /^\/integrations\/([^/]+)\/([^/]+)$/;
/** iterate's context on this mind: by its id, where it lands its events, and by its hostname,
 *  where a sender in the hostname form lands them under a rule by hostname
 *  (core/auth-worker/src/minds.ts). The platform stamps iterate's id as the signer in both. */
const ITERATE_CONTEXTS = [`/minds/${ITERATE_MIND}`, `/minds/${ITERATE_HOSTNAME}`];

/** The path below iterate's context on this mind, in either form (`/cloud`,
 *  `/integrations/<provider>/<account>`), or `/` for the context itself; null for any other
 *  path. Every reader of iterate's events asks this, never one form alone. */
export function iterateContextOf(path: string): string | null {
  for (const prefix of ITERATE_CONTEXTS)
    if (path === prefix || path.startsWith(`${prefix}/`)) return path.slice(prefix.length) || "/";
  return null;
}

/** Whether iterate's mind signed `event`, by its id. */
export function signedByIterate(event: CloudDeliveryEvent): boolean {
  const principal = event.source?.signer?.principal;
  return principal?.kind === "mind" && principal.actor === ITERATE_MIND;
}

/** The provider, the account and the mind's own context for it, when `event` is iterate Cloud's
 *  delivery in either form; else null. */
export function cloudDeliveryOf(
  event: CloudDeliveryEvent,
): { provider: string; account: string; context: string } | null {
  const principal = event.source?.signer?.principal;
  const below = iterateContextOf(event.path);
  // `below` is never empty: iterate's context itself is `/`
  const signed = below
    ? signedByIterate(event)
    : !principal?.kind && principal?.actor === "iterate-cloud";
  if (!signed) return null;
  const context = below || event.path;
  const [, provider, account] = ACCOUNT_PATH.exec(context) || [];
  return provider && account ? { provider, account, context } : null;
}

/** The part of `itx` that `sayMindForm` uses. */
export type MindFormItx = {
  fetch(request: Request): Promise<Response>;
  whoami(): { mindSlug?: string } | Promise<{ mindSlug?: string }>;
  secrets: {
    list(): Promise<{ path: string; cloud?: string; cloudOrigin?: string }[]>;
    cloud(origin: string): Promise<{ origin: string; clients: string[] }>;
  };
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
  };
};

/** The one kv key: `said <name>` once the Cloud took the word from the mind under the name
 *  `<name>` (its control-plane hostname, `itx.whoami()`'s `mindSlug`), else the time of the last
 *  try. The Cloud keeps the word by the mind's name: a mind that moved to a new name is another
 *  mind there, and gets the key form until it says the word again under the new one. So a word
 *  kept for another name, or a bare `said` that names none, counts as not said. */
const MIND_FORM_KEY = "cloud-deliveries:mind-form";
/** How long after a try that the Cloud did not take the next one waits. */
const TRY_AGAIN_MS = 60 * 60_000;

/** THE MIND TELLS THE CLOUD THAT IT READS THE MIND FORM. Call it only from the file that reads
 *  that form (`init.ts`, `every-event.ts` and `deliveries.ts`: the init step, `mindFormEvent` when a secret is set, and
 *  `cloudDeliveryEvent` at each delivery): a
 *  `worker.ts` without `processMindEvent` must never say it, or its deliveries would be taken
 *  and read by nothing. The Cloud sends the mind form to no mind that has not said so.
 *
 *  The word is an ask of the Cloud (core/secrets-worker cloud-client.ts `askOf`), in the name of
 *  an account a member connected through the Cloud at `ITERATE_CLOUD`: each such account is
 *  tried in turn until the Cloud takes the word, since not every kind of connection can ask. A
 *  secret asks its own Cloud alone, so an account of another Cloud is not tried. With no such
 *  account it does nothing: such a mind gets no delivery either. Said once for each name of the
 *  mind (`MIND_FORM_KEY`); after a try that was not taken, the next one waits an hour. */
export async function sayMindForm(itx: MindFormItx): Promise<void> {
  const said = `said ${(await itx.whoami()).mindSlug ?? ""}`;
  const kept = await itx.kv.get(MIND_FORM_KEY);
  if (kept === said || Number(kept) > Date.now() - TRY_AGAIN_MS) return;
  // the catalog first: a mind with no account of the Cloud's asks the Cloud nothing
  const connected = (await itx.secrets.list()).filter(
    (secret) => secret.cloud && secret.cloudOrigin === ITERATE_CLOUD,
  );
  if (connected.length === 0) return;
  const cloud = await itx.secrets.cloud(ITERATE_CLOUD);
  const accounts = connected.filter((secret) => cloud.clients.includes(secret.cloud!));
  if (accounts.length === 0) return;
  const answers: (string | number)[] = [];
  for (const account of accounts) {
    const answer = await itx
      .fetch(
        new Request(`${ITERATE_CLOUD}/clients/${account.cloud}/ask/mind-form`, {
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
      await itx.kv.put(MIND_FORM_KEY, said);
      return;
    }
    answers.push(typeof answer === "string" ? answer : answer.status);
  }
  await itx.kv.put(MIND_FORM_KEY, String(Date.now()));
  console.warn({ event: "config.mind-form-word-not-taken", accounts: accounts.length, answers });
}

/** A SECRET WAS SET (its fact is on the secret's own log, `/secrets/<name>`): the mind says the
 *  word now, when the secret is an account of iterate Cloud's (`sayMindForm` reads the catalog,
 *  and does nothing once the word is said). A publish says the word for the accounts that exist
 *  then. A mind trusts no key of the Cloud's, so the key form does not land on it, and the Cloud
 *  sends the mind form only after the word: without this, an account that a member connects
 *  after the last publish gets no delivery until the next one. `every-event.ts` hands every event
 *  here. A word that could not be said is logged, and never fails the secret's event. */
export async function mindFormEvent(
  itx: MindFormItx,
  event: { type: string; path: string },
): Promise<void> {
  if (event.type !== "events.iterate.com/secret/set" || !/^\/secrets\/[^/]+$/.test(event.path))
    return;
  await sayMindForm(itx).catch((error: unknown) =>
    console.warn({ event: "config.mind-form-word-failed", error: String(error) }),
  );
}
