// responses-keys.ts — the agent's model call with a stack of API keys, for a project that brings its
// own credentials instead of the deployment's AI Gateway (`llm.apiKeys`, contract.ts).
//
// A key is the text that follows `Bearer `: normally a `getSecret("/secrets/…")` placeholder, which
// egress swaps for the secret's value on the way to api.openai.com, so no key is ever in this code.
// Any key a ChatGPT plan or an API key holds works, because every key gets the same body.

/** Request fields OpenAI refuses when the key is a ChatGPT plan's token
 *  (https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). An API key
 *  accepts all of them, so dropping them costs nothing there. */
const REFUSED_BY_PLAN_TOKENS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

/** The body every key in the stack takes: the strictest key's rules. A plan's token refuses the
 *  fields above, and an explicit `prompt_cache_breakpoint` ("not supported on this model"); the
 *  implicit breakpoints after each message and result stay. */
export function bodyForKeys(body: Record<string, unknown>): Record<string, unknown> {
  const kept = Object.fromEntries(
    Object.entries(body).filter(([field]) => !REFUSED_BY_PLAN_TOKENS.includes(field)),
  );
  return JSON.parse(
    JSON.stringify(kept, (field, value: unknown) =>
      field === "prompt_cache_breakpoint" ? undefined : value,
    ),
  );
}

/** One Responses API request, sent with each key in turn until one answers 2xx. A key that answers
 *  anything else, or throws (its secret is missing), is logged by its position and skipped. When
 *  none answers 2xx, the last failed answer comes back unread, so the caller reports what OpenAI
 *  said; a stack that only threw rethrows its last error. `signal` is the turn's: once it aborts, the request in
 * flight is abandoned and no later key is sent. */
export async function postResponses(
  itx: { fetch(request: Request): Promise<Response> },
  body: Record<string, unknown>,
  apiKeys: readonly string[],
  signal: AbortSignal,
  log: (message: string) => void = console.warn,
): Promise<Response> {
  const json = JSON.stringify(bodyForKeys(body));
  let failure: Response | undefined;
  let thrown: unknown;
  for (const [position, apiKey] of apiKeys.entries()) {
    const label = `API key ${String(position + 1)} of ${String(apiKeys.length)}`;
    // An abort ends the call: no later key is tried for a turn that was cancelled or expired.
    if (signal.aborted) throw signal.reason || new Error("aborted");
    try {
      const response = await raceAbort(
        signal,
        itx.fetch(
          new Request("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: json,
          }),
        ),
      );
      if (response.ok) return response;
      log(`[agent] ${label} answered ${String(response.status)}`);
      await failure?.body?.cancel();
      failure = response;
    } catch (error) {
      if (signal.aborted) throw error;
      log(`[agent] ${label} threw: ${String(error)}`);
      thrown = error;
    }
  }
  if (failure) return failure;
  throw thrown ?? new Error("llm.apiKeys is empty");
}

/** Race an un-abortable dial against the caller's signal: the caller regains control the moment it
 *  aborts (an interruption, the expiry, the idle watchdog). A Response or stream the orphaned dial
 *  answers after that is cancelled, so the provider stops and no unread body holds the edge's
 *  invocation open; a stream already open is cancelled by `drainSse` itself. */
export function raceAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  const cancelLateBody = () =>
    void work.then(
      (late) => {
        const body = late instanceof Response ? late.body : late;
        if (body instanceof ReadableStream) void body.cancel(signal.reason).catch(() => undefined);
      },
      () => undefined,
    );
  if (signal.aborted) {
    cancelLateBody();
    return Promise.reject(signal.reason || new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason || new Error("aborted"));
      cancelLateBody();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // The listener goes in the same turn the dial settles: an answer handed over is its reader's.
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
