// cloud-credit.ts — THE CALLS OF THE STEP "Connect to iterate Cloud" THAT LEAVE ITS OWN LOG: the
// grant and the balance at iterate Cloud's secret proxy, the two secrets by proxy, and whether this
// mind's stack can sign a request as the mind. steps/connect-iterate-cloud.ts calls nothing else
// outside the onboarding log, so its tests replace this one object.
//
// What it needs of the stack (the secret proxy's contract, iterate-config apps/cloud/secret-proxy.ts):
//   - the mind signs a request to another mind: `itx.minds.get(mind).fetch(request)`;
//   - a secret by proxy: `itx.secrets.set(path, null, { urls, proxy })`, and `describe(path).proxy`;
//   - its own key listed in `/keys/stack.json` (`listed: true`), or the proxy answers 502.
// A stack without them answers `canSign() === false`, or a set that throws, and the card says so.
import { z } from "zod";
import { ITERATE_CLOUD, ITERATE_MIND } from "../../cloud-deliveries.ts";
import type { OnboardingItx } from "./steps.ts";

/** iterate's secret proxy: what a secret by proxy names, and where the grant is asked for. */
export const ITERATE_PROXY = { mind: ITERATE_MIND, url: `${ITERATE_CLOUD}/secret-proxy` } as const;

/** The two secrets the credit pays for, and where each may go. */
export const CREDIT_SECRETS = [
  { path: "/secrets/openai", urls: ["https://api.openai.com"], name: "OpenAI" },
  { path: "/secrets/exa", urls: ["https://api.exa.ai"], name: "Exa" },
] as const;

/** How long the step waits for iterate Cloud or the stack's key document. */
const ANSWER_MS = 5_000;

export const Balance = z.object({
  grantedUsd: z.number(),
  spentUsd: z.number(),
  remainingUsd: z.number(),
  /** This mind's charged estimates that a correction can still replace (an interrupted request,
   *  for up to 15 minutes). Absent from a proxy older than it. */
  pendingUsd: z.number().optional(),
});
export type Balance = z.infer<typeof Balance>;

/** Why a call to iterate Cloud gave no balance. */
export type CreditFailure =
  | "none-today" // 402 iterate_credit_none_today: no new grant today
  | "paused" // 402 iterate_credit_paused: iterate's total for the day is spent
  | "not-connected" // 402 iterate_credit_not_connected: this mind has no grant (a balance)
  | "not-approved" // 403 iterate_credit_not_approved: an owner of iterate has not let this mind in yet
  | "ended" // 403 iterate_credit_ended: a person at iterate ended this mind's credit, for good
  | "hostname-enrolled" // 409 iterate_credit_hostname_enrolled: another mind id at this hostname has it
  | "not-recognised" // 401: the Cloud did not recognise this mind's signature
  | "no-working-key" // 502: the Cloud could not use this mind's key
  | "stack-without-proxy" // the stack keeps no secret by proxy
  | "cloud-unreachable"; // no answer, or one of no known shape

type CreditRefusal = { ok: false; reason: CreditFailure; message?: string };

export type CreditAnswer = { ok: true; balance: Balance } | CreditRefusal;

/** The token that opens this mind's page on iterate Cloud: one use, 5 minutes. */
export type OpenAnswer = { ok: true; token: string } | CreditRefusal;

/** What a secret path holds, for the step: nothing, the owner's own value, iterate's proxy, or a
 *  proxy of someone else's. */
export type SecretKind = "unset" | "own" | "iterate-proxy" | "other-proxy";

export type SetAnswer =
  | "set"
  | "own"
  | "other-proxy"
  | "no-proxy-layer"
  | "approval-rule"
  | "being-set";

export type CloudCredit = {
  /** Whether this mind's stack signs requests as the mind: its key document says `listed`. The
   *  document is the mind's own: no request goes to iterate. */
  canSign(): Promise<boolean>;
  /** The grant: once for each mind id, the same balance on a second call. */
  connect(): Promise<CreditAnswer>;
  /** The balance, with no write. */
  balance(): Promise<CreditAnswer>;
  /** A token that opens this mind's page on iterate Cloud (`POST /secret-proxy/open`, signed as
   *  `connect`). One use, 5 minutes: open-cloud.ts posts it once, and nothing stores it. */
  open(): Promise<OpenAnswer>;
  secret(path: string): Promise<SecretKind>;
  /** A secret by iterate's proxy at `path`, where the path holds no value: "own" when it holds
   *  the owner's own (the platform refuses to replace it), "no-proxy-layer" when the stack has no
   *  secret by proxy, and the vault's two refusals: "approval-rule" (the path has one, and no use
   *  by proxy passes it) and, for a path set since the read, what it now holds: "set" when a
   *  concurrent connect made it iterate's proxy, "own", "other-proxy" (another proxy the owner
   *  chose, which stays), or "being-set" while a write is still in flight. */
  setByProxy(path: string, urls: readonly string[]): Promise<SetAnswer>;
  /** Deletes the secret at `path` when it is iterate's proxy, and nothing else. */
  deleteProxy(path: string): Promise<boolean>;
};

/** The secrets Worker's refusal of `null` material: a stack without the secret by proxy. */
const NO_PROXY_LAYER = /material is a string or a JSON object/;
/** The vault's refusals of a secret by proxy (core/secrets-worker/src/secret/durable-object.ts,
 *  `secrets.set with proxy: <path> …`), by their stable part: the path has an approval rule; the
 *  path is set, or a write to it is in flight. */
const HAS_APPROVAL_RULE = /has an approval rule, which no use by proxy can pass/;
const SET_OR_BEING_SET = /is set or being set; delete it first/;
/** A stack older than `secrets.deleteIfProxy`, by its two refusals: a mind Worker whose `secrets`
 *  has no such method (the kernel's NOT_A_METHOD, or workerd's RPC across a stub), or a vault that
 *  knows no such verb (INVALID_INPUT `is no verb of a secret`). Any other error is thrown. */
const OLDER_STACK =
  /"deleteIfProxy" is not a method|does not implement the method "deleteIfProxy"|"deleteIfProxy" is no verb of a secret/;

const Description = z.object({
  set: z.boolean(),
  proxy: z.object({ mind: z.string(), url: z.string() }).optional(),
});
const StackKey = z.object({ listed: z.boolean().optional() });
/** The open's answer: a token for one use (32 random bytes, base64url). */
const OpenToken = z.object({ token: z.string().regex(/^[\w-]{20,200}$/) });
const Refusal = z.object({ error: z.object({ code: z.string(), message: z.string().optional() }) });

/** The refusal codes of the secret proxy (402, 403 and 409), by the step's name for each. */
const REFUSALS: Record<string, CreditFailure> = {
  iterate_credit_none_today: "none-today",
  iterate_credit_paused: "paused",
  iterate_credit_not_connected: "not-connected",
  iterate_credit_not_approved: "not-approved",
  iterate_credit_ended: "ended",
  iterate_credit_hostname_enrolled: "hostname-enrolled",
};

/** Why the proxy refused, from its status and its error's code. */
function failureOf(status: number, code: string | undefined): CreditFailure {
  if (status === 401) return "not-recognised";
  if (status === 502) return "no-working-key";
  return (code && Object.hasOwn(REFUSALS, code) && REFUSALS[code]) || "cloud-unreachable";
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The answer, or a throw after `ANSWER_MS`. */
function inTime<T>(answer: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    answer,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${ANSWER_MS} ms`)), ANSWER_MS);
    }),
  ]).finally(() => timer !== null && clearTimeout(timer));
}

/** The calls of a real mind. */
export function cloudCredit(itx: OnboardingItx): CloudCredit {
  /** One request to the proxy, signed as the mind: a 200's body read by `shape`, or why not. */
  const ask = async <T>(
    path: "connect" | "balance" | "open",
    shape: z.ZodType<T>,
  ): Promise<{ ok: true; value: T } | CreditRefusal> => {
    const cloud = itx.minds.get(ITERATE_PROXY.mind);
    let response: Response;
    try {
      response = await inTime(
        cloud.fetch(
          new Request(`${ITERATE_PROXY.url}/${path}`, {
            method: path === "balance" ? "GET" : "POST",
          }),
        ),
      );
    } catch (error) {
      // a stack too old to sign never gets here: its key document is not listed (`canSign`)
      return { ok: false, reason: "cloud-unreachable", message: messageOf(error) };
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const value = shape.safeParse(body);
      return value.success
        ? { ok: true, value: value.data }
        : { ok: false, reason: "cloud-unreachable", message: "an answer of no known shape" };
    }
    const refusal = Refusal.safeParse(body).data?.error;
    return {
      ok: false,
      reason: failureOf(response.status, refusal?.code),
      message: refusal?.message || `iterate Cloud answered ${response.status}`,
    };
  };
  const credit = async (path: "connect" | "balance"): Promise<CreditAnswer> => {
    const answer = await ask(path, Balance);
    if (!answer.ok) return answer;
    return { ok: true, balance: answer.value };
  };

  const secret = async (path: string): Promise<SecretKind> => {
    // parsed, not trusted: an older stack's describe answers no `proxy`
    const described = Description.parse(await itx.secrets.describe(path));
    if (!described.set) return "unset";
    if (!described.proxy) return "own";
    return described.proxy.url === ITERATE_PROXY.url ? "iterate-proxy" : "other-proxy";
  };

  return {
    async canSign() {
      const { mindSlug } = await itx.whoami();
      if (!mindSlug) return false;
      try {
        const response = await inTime(
          itx.fetch(new Request(`https://${mindSlug}/keys/stack.json`)),
        );
        if (!response.ok) return false;
        return StackKey.safeParse(await response.json()).data?.listed === true;
      } catch {
        return false;
      }
    },
    connect: () => credit("connect"),
    balance: () => credit("balance"),
    async open() {
      const answer = await ask("open", OpenToken);
      if (!answer.ok) return answer;
      return { ok: true, token: answer.value.token };
    },
    secret,
    async setByProxy(path, urls) {
      if ((await secret(path)) === "own") return "own";
      try {
        // a stack without the secret by proxy refuses `null` material, and that refusal is read below
        await itx.secrets.set(path, null, { urls: [...urls], proxy: ITERATE_PROXY });
      } catch (error) {
        const message = messageOf(error);
        if (NO_PROXY_LAYER.test(message)) return "no-proxy-layer";
        if (HAS_APPROVAL_RULE.test(message)) return "approval-rule";
        // the vault refuses a proxy over anything set since the read above: say what it holds now
        if (SET_OR_BEING_SET.test(message)) {
          const now = await secret(path);
          if (now === "iterate-proxy") return "set";
          return now === "unset" ? "being-set" : now;
        }
        throw error;
      }
      // a stack that took the call but keeps no proxy made no secret by proxy
      return (await secret(path)) === "iterate-proxy" ? "set" : "no-proxy-layer";
    },
    async deleteProxy(path) {
      // describe first: a path by another proxy is never asked to go
      if ((await secret(path)) !== "iterate-proxy") return false;
      try {
        // the vault deletes only while the path is still by proxy, in one turn of its object, so
        // an own key saved after the describe stays
        return (await itx.secrets.deleteIfProxy(path)).deleted;
      } catch (error) {
        if (!OLDER_STACK.test(messageOf(error))) throw error;
        // AN OLDER STACK, without the verb: today's describe, then delete. An own key saved
        // between the two is deleted (the race the verb closes); it ends at the stack's update
        await itx.secrets.delete(path);
        return true;
      }
    },
  };
}
