// cloud-ai.ts — iterate Cloud's AI LENDING, as the step "Connect to iterate Cloud" turns it on and
// off. iterate Cloud lends its own AI Gateway to a mind that a person at iterate let in: the mind
// reaches it over Cap'n Web, as `itx.iterateCloud`, signed as the mind by a secret by proxy. With
// the second rule, `itx.ai` is `itx.iterateCloud.ai`, so every agent, script and the AI test use
// iterate's AI with no change to their calls.
//
// Turning it on, on the root context `/`:
//   1. `/secrets/iterate-cloud`, a secret by proxy: the secrets Worker signs each request and
//      WebSocket upgrade to iterate Cloud as this mind, for iterate's mind (`ITERATE_HOSTNAME`);
//   2. the rule `itx.iterateCloud` -> the Cap'n Web connection to `wss://<Cloud>/api/cloud-ai`;
//   3. `itx.iterateCloud.whoami()`, inside `WHOAMI_MS`: the Cloud recognised this mind;
//   4. only then, the rule `itx.ai` -> `itx.iterateCloud.ai`.
// A refusal at 3 leaves `itx.ai` as it was: a mind that the Cloud does not lend to keeps its own
// AI. `/secrets/openai` is not touched here: the credit (cloud-credit.ts) owns it.
//
// Turning it off removes both rules by a compare-and-set delete (`ifTarget`): a rule that a member
// pointed elsewhere stays. Then `itx.ai` is the platform's own again. Both are idempotent: a
// second call reads what is in place and appends nothing.
import { type ItxExpressionInput, normalizedItxExpression, print } from "iterate/expression";
import { ITERATE_CLOUD, ITERATE_HOSTNAME } from "../../cloud-deliveries.ts";
import type { OnboardingItx } from "./steps.ts";

/** The root context, as the lending uses it. */
export type CloudAiRoot = ReturnType<OnboardingItx["cd"]>;

/** Where the lending's signing secret is. */
export const CLOUD_AI_SECRET = "/secrets/iterate-cloud";

/** The secret by proxy that signs requests to iterate Cloud as this mind. The proxy names the mind
 *  by its control-plane hostname (`SecretProxy`), as iterate Cloud's own connect does. */
const CLOUD_AI_PROXY = { mind: ITERATE_HOSTNAME, url: `${ITERATE_CLOUD}/capnweb` } as const;

/** A rule the lending appends on the root. */
type Rule = { match: string; target: ItxExpressionInput; description: string };

const CLOUD_RULE: Rule = {
  match: "itx.iterateCloud",
  target: [
    "itx",
    ["cd", "/"],
    [
      "connectToCapnweb",
      `wss://${new URL(ITERATE_CLOUD).host}/api/cloud-ai`,
      { headers: { authorization: `Bearer getSecret(${JSON.stringify(CLOUD_AI_SECRET)})` } },
    ],
  ],
  description:
    "Iterate Cloud capabilities over Cap'n Web (`itx.iterateCloud.ai` and `itx.iterateCloud.usage()`).",
};

const AI_RULE: Rule = {
  match: "itx.ai",
  target: "itx.iterateCloud.ai",
  description: "Route `itx.ai` through Iterate Cloud's AI Gateway (`itx.iterateCloud.ai`).",
};

const RULE_TYPE = "events.iterate.com/itx/rewrite-rule-configured";

/** How long the guard asks `itx.iterateCloud.whoami()` for an answer. */
const WHOAMI_MS = 5_000;

/** How much of a refusal's message the answer keeps. */
const REASON_CHARS = 200;

/** Whether `itx.ai` now runs through iterate Cloud, and why not. */
export type CloudAiAnswer = { on: true } | { on: false; reason: string };

/** The target as the root's `rewriteRules.get` prints it. */
const printed = (target: ItxExpressionInput) =>
  print(normalizedItxExpression(target, { holes: true }), { holes: true });

/** Whether the root's own row for the rule's match points where the rule does. */
async function inPlace(root: CloudAiRoot, rule: Rule) {
  const row = await root.rewriteRules.get(rule.match);
  return row?.context === "/" && row.target === printed(rule.target);
}

/** The answer, or a throw after `ms`. */
function inTime<T>(answer: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    answer,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    }),
  ]).finally(() => timer !== null && clearTimeout(timer));
}

/** `ask`'s answer, asked again every half second until `ms` are over, then the last refusal. The
 *  rule that names the Cloud is appended a moment before the first ask, and the root can still
 *  read its rules as they were: on a mind that iterate had let in, the first ask did not answer
 *  and one a few seconds later did. */
async function askedUntil<T>(ask: () => Promise<T>, ms: number): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await inTime(ask(), Math.max(1, until - Date.now()));
    } catch (error) {
      if (Date.now() + 500 >= until) throw error;
      await new Promise((done) => setTimeout(done, 500));
    }
  }
}

/** TURNS THE LENDING ON (the header's four steps), and answers whether `itx.ai` runs through
 *  iterate Cloud now. Never throws: a failure is `{ on: false, reason }`, with `itx.ai` as it was.
 *  `askForMs`: how long the guard asks the Cloud. */
export async function lendCloudAi(root: CloudAiRoot, askForMs = WHOAMI_MS): Promise<CloudAiAnswer> {
  try {
    const described = await root.secrets.describe(CLOUD_AI_SECRET);
    const same =
      described.proxy?.mind === CLOUD_AI_PROXY.mind && described.proxy.url === CLOUD_AI_PROXY.url;
    // a value of the owner's own at the path is never replaced: the guard below then decides
    if (!(described.set && (same || !described.proxy))) {
      if (described.set) await root.secrets.deleteIfProxy(CLOUD_AI_SECRET);
      await root.secrets.set(CLOUD_AI_SECRET, null, {
        urls: [ITERATE_CLOUD],
        placement: "header",
        proxy: CLOUD_AI_PROXY,
      });
    }
    if (!(await inPlace(root, CLOUD_RULE)))
      await root.append({ type: RULE_TYPE, payload: CLOUD_RULE });
    // `iterateCloud` is a name of the rule above, which the root resolves at the call; the
    // context's type lists the platform's names alone
    const cloud = (root as unknown as { iterateCloud: { whoami(): Promise<unknown> } })
      .iterateCloud;
    await askedUntil(() => cloud.whoami(), askForMs);
    if (!(await inPlace(root, AI_RULE))) await root.append({ type: RULE_TYPE, payload: AI_RULE });
    return { on: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { on: false, reason: message.slice(0, REASON_CHARS) };
  }
}

/** Whether `itx.ai` runs through iterate Cloud: the root's own rule for it is the lending's. */
export function cloudAiLent(root: CloudAiRoot): Promise<boolean> {
  return inPlace(root, AI_RULE);
}

/** TURNS THE LENDING OFF: both rules and the secret by proxy go, and `itx.ai` is the platform's
 *  own again. A rule that points elsewhere, and a secret that is not the lending's, stay. */
export async function endCloudAi(root: CloudAiRoot): Promise<void> {
  // `itx.ai` first: it names `itx.iterateCloud`
  const removals = [];
  for (const rule of [AI_RULE, CLOUD_RULE])
    if (await inPlace(root, rule))
      removals.push({
        type: RULE_TYPE,
        payload: { match: rule.match, target: null, ifTarget: rule.target },
      });
  if (removals.length) await root.append(...removals);
  const described = await root.secrets.describe(CLOUD_AI_SECRET);
  if (described.proxy?.mind === CLOUD_AI_PROXY.mind && described.proxy.url === CLOUD_AI_PROXY.url)
    await root.secrets.deleteIfProxy(CLOUD_AI_SECRET);
}
