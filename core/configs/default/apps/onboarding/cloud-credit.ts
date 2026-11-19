// cloud-credit.ts — THE CALLS OF THE STEP "Connect to iterate Cloud" THAT LEAVE ITS OWN LOG: the
// grant and the balance at iterate Cloud's secret proxy, the two secrets by proxy, and whether this
// mind's stack can sign a request as the mind. steps/connect-iterate-cloud.ts calls nothing else
// outside the onboarding log, so its tests replace this one object.
//
// What it needs of the stack (the secret proxy's contract, iterate-config apps/secret-proxy):
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
  { path: "/secrets/openai", urls: ["https://api.openai.com"] },
  { path: "/secrets/exa", urls: ["https://api.exa.ai"] },
] as const;

/** How long the step waits for iterate Cloud or the stack's key document. */
const ANSWER_MS = 5_000;

export const Balance = z.object({
  grantedUsd: z.number(),
  spentUsd: z.number(),
  remainingUsd: z.number(),
});
export type Balance = z.infer<typeof Balance>;

/** Why a call to iterate Cloud gave no balance. */
export type CreditFailure =
  | "none-today" // 402 iterate_credit_none_today: no new grant today
  | "paused" // 402 iterate_credit_paused: iterate's total for the day is spent
  | "not-connected" // 402 iterate_credit_not_connected: this mind has no grant (a balance)
  | "not-recognised" // 401: the Cloud did not recognise this mind's signature
  | "no-working-key" // 502: the Cloud could not use this mind's key
  | "stack-without-proxy" // the stack cannot sign a request to another mind
  | "cloud-unreachable"; // no answer, or one of no known shape

export type CreditAnswer =
  | { ok: true; balance: Balance }
  | { ok: false; reason: CreditFailure; message?: string };

/** What a secret path holds, for the step: nothing, the owner's own value, iterate's proxy, or a
 *  proxy of someone else's. */
export type SecretKind = "unset" | "own" | "iterate-proxy" | "other-proxy";

export type CloudCredit = {
  /** Whether this mind's stack signs requests as the mind: its key document says `listed`. The
   *  document is the mind's own: no request goes to iterate. */
  canSign(): Promise<boolean>;
  /** The grant: once for each mind id, the same balance on a second call. */
  connect(): Promise<CreditAnswer>;
  /** The balance, with no write. */
  balance(): Promise<CreditAnswer>;
  secret(path: string): Promise<SecretKind>;
  /** A secret by iterate's proxy at `path`, where the path holds no value: "own" when it holds
   *  the owner's own (the platform refuses to replace it), "no-proxy-layer" when the stack has no
   *  secret by proxy. */
  setByProxy(path: string, urls: readonly string[]): Promise<"set" | "own" | "no-proxy-layer">;
  /** Deletes the secret at `path` when it is iterate's proxy, and nothing else. */
  deleteProxy(path: string): Promise<boolean>;
};

/** The secrets Worker's refusal of `null` material: a stack without the secret by proxy. */
const NO_PROXY_LAYER = /material is a string or a JSON object/;
/** The platform's refusal to put a secret by proxy over a value: the owner's own key stays. */
const HOLDS_A_KEY = /holds a key of its own/;
/** The minds API of a stack without signed requests between minds. */
const NO_MIND_FETCH = /a mind answers deliverEvents/;

const Description = z.object({
  set: z.boolean(),
  proxy: z.object({ mind: z.string(), url: z.string() }).optional(),
});
const StackKey = z.object({ listed: z.boolean().optional() });
const Refusal = z.object({ error: z.object({ code: z.string(), message: z.string().optional() }) });

/** The 402 codes of the secret proxy, by the step's name for each. */
const REFUSALS: Record<string, CreditFailure> = {
  iterate_credit_none_today: "none-today",
  iterate_credit_paused: "paused",
  iterate_credit_not_connected: "not-connected",
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
  const ask = async (path: "connect" | "balance"): Promise<CreditAnswer> => {
    // The signed request between minds is a method of the stack's minds API that the type does
    // not name yet: on a stack without it the call throws, and that throw is read below.
    const cloud = itx.minds.get(ITERATE_PROXY.mind) as unknown as {
      fetch(request: Request): Promise<Response>;
    };
    let response: Response;
    try {
      response = await inTime(
        cloud.fetch(
          new Request(`${ITERATE_PROXY.url}/${path}`, {
            method: path === "connect" ? "POST" : "GET",
          }),
        ),
      );
    } catch (error) {
      const message = messageOf(error);
      return {
        ok: false,
        reason: NO_MIND_FETCH.test(message) ? "stack-without-proxy" : "cloud-unreachable",
        message,
      };
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const balance = Balance.safeParse(body);
      return balance.success
        ? { ok: true, balance: balance.data }
        : { ok: false, reason: "cloud-unreachable", message: "an answer of no known shape" };
    }
    const refusal = Refusal.safeParse(body).data?.error;
    return {
      ok: false,
      reason: failureOf(response.status, refusal?.code),
      message: refusal?.message || `iterate Cloud answered ${response.status}`,
    };
  };

  const secret = async (path: string): Promise<SecretKind> => {
    // describe answers more fields than its type names (`proxy`, with the secret by proxy)
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
    connect: () => ask("connect"),
    balance: () => ask("balance"),
    secret,
    async setByProxy(path, urls) {
      if ((await secret(path)) === "own") return "own";
      try {
        // `null` material and `proxy` are the secret by proxy's, which the type does not name yet;
        // a stack without it refuses the call, and that refusal is read below
        const set = itx.secrets.set as unknown as (
          path: string,
          material: null,
          options: { urls: string[]; proxy: typeof ITERATE_PROXY },
        ) => Promise<unknown>;
        await set.call(itx.secrets, path, null, { urls: [...urls], proxy: ITERATE_PROXY });
      } catch (error) {
        const message = messageOf(error);
        if (NO_PROXY_LAYER.test(message)) return "no-proxy-layer";
        // the platform refuses to replace a value: the owner's key, set since the read above
        if (HOLDS_A_KEY.test(message) || (await secret(path)) === "own") return "own";
        throw error;
      }
      // a stack that took the call but keeps no proxy made no secret by proxy
      return (await secret(path)) === "iterate-proxy" ? "set" : "no-proxy-layer";
    },
    async deleteProxy(path) {
      if ((await secret(path)) !== "iterate-proxy") return false;
      await itx.secrets.delete(path);
      return true;
    },
  };
}
