// cloud-deliveries.ts — WHAT COUNTS AS iterate Cloud's DELIVERY: GitHub's, Slack's, Gmail's,
// Calendar's and X's events, and the Cloud's own words such as `google/gmail-connected`. They
// come in one of two forms, with the same type and payload (accounts.md):
//
//   the key form    on `/integrations/<provider>/<account>`, signed by the Cloud's key: the
//                   signer's actor is `iterate-cloud`, the stack's own name for that key. It
//                   reaches `processEvent`.
//   the mind form   on `/minds/iterate.com/integrations/<provider>/<account>`, signed by the mind
//                   iterate.com with the key it publishes. A mind gets this form once its owner
//                   let iterate.com in (minds.md). It reaches `processMindEvent`.
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
