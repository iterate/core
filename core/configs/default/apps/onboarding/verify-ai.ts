// verify-ai.ts — SERVER-SIDE AI CONFIGURATION STATUS AND LIVE INFERENCE VERIFICATION for the
// onboarding wizard (`app.ts`: GET /ai-status.json, POST /collect-openai-key, POST /verify-ai).
// Tests the exact same credential order that agents.ts configures: ChatGPT plan, /secrets/openai
// (own key or iterate Cloud proxy), and Cloudflare AI Gateway. Every failure is translated into a
// clean, human-readable message — never raw upstream JSON or HTTP error bodies.
import type { IterateConfigProcessEventArgs } from "iterate/sdk";
import { z } from "zod";
import { cloudCredit, type SecretKind } from "./cloud-credit.ts";
import type { OnboardingItx } from "./steps.ts";

const TEST_MODEL = "gpt-6.1-sol";

export type VerifyAiItx = OnboardingItx & Pick<IterateConfigProcessEventArgs["itx"], "ai">;

export type AiProvider = "chatgpt" | "iterate-cloud" | "openai" | "ai-gateway";

export type AiStatus = {
  chatgpt: boolean;
  openai: SecretKind;
  mind: string;
  zone: string;
};

export type VerifyAiResult = { ok: true; provider: AiProvider } | { ok: false; error: string };

const ErrorEnvelope = z.object({
  error: z
    .union([
      z.string(),
      z.object({
        code: z.string().optional(),
        type: z.string().optional(),
        message: z.string().optional(),
      }),
    ])
    .optional(),
  errors: z
    .array(z.object({ code: z.number().optional(), message: z.string().optional() }))
    .optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

const StreamEvent = z.object({
  type: z.string(),
  delta: z.string().optional(),
  error: z
    .object({
      code: z.string().optional(),
      type: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  response: z
    .object({
      status: z.string().optional(),
      error: z
        .object({
          code: z.string().optional(),
          type: z.string().optional(),
          message: z.string().optional(),
        })
        .nullish(),
    })
    .optional(),
});

/** Reads what AI credentials are currently configured on this mind. */
export async function aiStatus(itx: OnboardingItx): Promise<AiStatus> {
  const credit = cloudCredit(itx);
  const [{ mindSlug }, url, chatgpt, openai] = await Promise.all([
    itx.whoami(),
    itx.url(),
    itx.secrets.describe("/secrets/chatgpt"),
    credit.secret("/secrets/openai"),
  ]);
  if (!mindSlug) throw new Error("onboarding: the mind did not say its control-plane hostname");
  return {
    chatgpt: chatgpt.set,
    openai,
    mind: mindSlug,
    zone: new URL(url).hostname,
  };
}

/** Creates the mind's own secret-collection form for `/secrets/openai`. */
export async function collectOpenAiKey(itx: OnboardingItx): Promise<{ link: string }> {
  const { url } = await itx.secrets.collectFromUser({
    path: "/secrets/openai",
    egress: { urls: ["https://api.openai.com"] },
    description: "An OpenAI API key, from https://platform.openai.com/api-keys",
  });
  return { link: url };
}

/** Extracts normalized error details from an upstream response body or error string. */
function errorDetailsOf(rawText: string): { code: string; type: string; message: string } {
  const trimmed = rawText.trim();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch {
    return { code: "", type: "", message: trimmed };
  }
  const envelope = ErrorEnvelope.safeParse(parsedJson).data;
  if (!envelope) return { code: "", type: "", message: "" };
  if (typeof envelope.error === "string")
    return { code: envelope.code || "", type: "", message: envelope.error };
  if (envelope.error) {
    return {
      code: envelope.error.code || envelope.code || "",
      type: envelope.error.type || "",
      message: envelope.error.message || envelope.message || "",
    };
  }
  const firstCfError = envelope.errors?.[0];
  if (firstCfError) {
    return {
      code: firstCfError.code !== undefined ? String(firstCfError.code) : "",
      type: "",
      message: firstCfError.message || "",
    };
  }
  return { code: envelope.code || "", type: "", message: envelope.message || "" };
}

/** Translates any upstream inference status/body into a clear human-readable message. */
export function humanAiError(provider: AiProvider, status: number, rawText: string): string {
  const { code, type, message } = errorDetailsOf(rawText);
  const combined = `${code} ${type} ${message}`;

  // iterate's own limit, not the mind's: nothing here deletes a secret by iterate's proxy
  if (code === "iterate_credit_provider_limit")
    return "iterate's account at the provider reached its spend limit, and iterate is told. Your mind goes on with its own keys.";
  if (code === "iterate_credit_ended")
    return "A person at iterate ended this mind's credit. Add your own OpenAI key, ChatGPT plan, or Cloudflare AI Gateway credit.";
  if (code === "iterate_credit_not_approved")
    return "iterate Cloud has not approved this mind yet. Wait for approval, or go back to add your own OpenAI key, ChatGPT plan, or Cloudflare AI Gateway credit.";
  if (code === "iterate_credit_none_today")
    return "iterate Cloud has reached its daily limit for new credits. Try again tomorrow, or go back to add your own AI key.";
  if (code === "iterate_credit_paused")
    return "iterate Cloud credit is paused until tomorrow (UTC). Go back to add your own AI key to continue now.";
  if (code === "iterate_credit_not_connected")
    return "Your mind is not connected to iterate Cloud credit yet. Go back to connect iterate Cloud or add your own AI key.";

  if (provider === "iterate-cloud") {
    if (status === 402)
      return "Your iterate Cloud credit is unavailable or used up. Go back to add your own OpenAI key, ChatGPT plan, or Cloudflare AI Gateway credit.";
    if (status === 401)
      return "iterate Cloud could not verify this mind's identity yet. Try again in a moment, or go back to add your own AI key.";
    if (status === 403)
      return "iterate Cloud refused this mind's AI request. Check your iterate Cloud connection, or go back to add your own AI key.";
    if (status === 429)
      return "iterate Cloud is rate-limiting requests right now. Wait a moment and try again.";
    return "Could not complete a test AI request through iterate Cloud. Try again or go back to configure another AI option.";
  }

  if (provider === "chatgpt") {
    if (status === 401 || status === 403)
      return "Your ChatGPT sign-in was rejected or expired. Go back and run the ChatGPT connect command again, or choose another AI option.";
    if (status === 402 || /quota|billing|limit|plan/i.test(combined))
      return "Your ChatGPT plan could not pay for a model request. Check your ChatGPT Plus or Pro subscription, or choose another AI option.";
    if (status === 429)
      return "ChatGPT is rate-limiting requests right now. Wait a moment and try again.";
    return "Could not complete a test AI request with your ChatGPT plan. Try again or go back to choose another AI option.";
  }

  if (provider === "openai") {
    if (status === 401)
      return "Your OpenAI API key was rejected (invalid or revoked). Go back and add a valid OpenAI API key, or choose another AI option.";
    if (
      status === 402 ||
      code === "insufficient_quota" ||
      type === "insufficient_quota" ||
      /insufficient_quota|billing|credit|quota/i.test(combined)
    )
      return "Your OpenAI API account has no available credit or billing is not set up. Add billing at platform.openai.com, or go back to choose another AI option.";
    if (status === 403)
      return "Your OpenAI API key does not have access to this model. Check your OpenAI project permissions, or go back to choose another AI option.";
    if (status === 429)
      return "OpenAI is rate-limiting requests right now. Wait a moment and try again.";
    return "Could not complete a test AI request with your OpenAI API key. Check the key and try again, or choose another AI option.";
  }

  if (
    status === 402 ||
    /credit|billing|payment|balance|insufficient|fund|quota|budget|\b402\b/i.test(combined)
  )
    return "Your Cloudflare AI Gateway has no credit yet. Add AI Gateway credit in Cloudflare, or go back to connect iterate Cloud, add an OpenAI API key, or connect ChatGPT.";
  if (status === 401 || status === 403)
    return "Cloudflare AI Gateway could not authorize the model request. Go back to connect iterate Cloud, add an OpenAI API key, or connect ChatGPT.";
  if (status === 429)
    return "Cloudflare AI Gateway is rate-limiting requests right now. Wait a moment and try again.";
  return "No working AI connection was found. Go back to connect iterate Cloud, add an OpenAI API key, connect ChatGPT, or add Cloudflare AI Gateway credit.";
}

/** Validates an HTTP 2xx Responses API stream (or JSON body) to confirm inference completed. */
function checkStreamBody(provider: AiProvider, bodyText: string): VerifyAiResult {
  let sawTerminalCompletion = false;
  let sawEvent = false;
  for (const line of bodyText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(data);
    } catch {
      continue;
    }
    const event = StreamEvent.safeParse(parsedJson).data;
    if (!event) continue;
    sawEvent = true;
    if (event.type === "error") {
      return {
        ok: false,
        error: humanAiError(provider, 502, JSON.stringify({ error: event.error || {} })),
      };
    }
    if (event.type === "response.failed") {
      return {
        ok: false,
        error: humanAiError(provider, 502, JSON.stringify({ error: event.response?.error || {} })),
      };
    }
    if (event.type === "response.completed" || event.type === "response.incomplete")
      sawTerminalCompletion = true;
  }
  if (sawTerminalCompletion) return { ok: true, provider };
  if (!sawEvent) {
    // Some gateways may answer a non-streamed Responses JSON object; accept a finished response.
    try {
      const nonStream = z
        .object({ status: z.string().optional(), output: z.array(z.unknown()).optional() })
        .safeParse(JSON.parse(bodyText)).data;
      if (nonStream?.status === "completed" || nonStream?.status === "incomplete")
        return { ok: true, provider };
    } catch {
      // fall through to generic failure
    }
  }
  return { ok: false, error: humanAiError(provider, 502, bodyText) };
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  const remaining = Math.max(1, ms);
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error("Request timed out"));
      }, remaining);
    }),
  ]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/** Reads a response body bounded by `deadline`, cancelling the reader if the deadline expires. */
async function readResponseTextWithin(response: Response, deadline: number): Promise<string> {
  if (!response.body) return withTimeout(response.text(), deadline - Date.now());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const readAll = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join("");
    } finally {
      reader.releaseLock();
    }
  };
  return withTimeout(readAll(), deadline - Date.now(), () => {
    void reader.cancel().catch(() => undefined);
  });
}

async function testKeyProvider(
  itx: VerifyAiItx,
  provider: Exclude<AiProvider, "ai-gateway">,
  authorization: string,
  timeoutMs: number,
): Promise<VerifyAiResult> {
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  let response: Response;
  try {
    response = await withTimeout(
      itx.fetch(
        new Request("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: TEST_MODEL,
            input: [{ role: "user", content: "Reply with the single word: ok" }],
            reasoning: { effort: "low" },
            // ChatGPT plan tokens refuse max_output_tokens; cap API-key and proxy probes to 256 so
            // iterate Cloud's secret proxy holds minimal reservation while the probe is in flight.
            ...(provider !== "chatgpt" && { max_output_tokens: 256 }),
            stream: true,
            store: false,
          }),
          signal: controller.signal,
        }),
      ),
      deadline - Date.now(),
      () => controller.abort(new Error("Request timed out")),
    );
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, error: humanAiError(provider, 0, text) };
  }
  let bodyText: string;
  try {
    bodyText = await readResponseTextWithin(response, deadline);
  } catch (error) {
    controller.abort(error);
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, error: humanAiError(provider, 0, text) };
  }
  if (!response.ok) return { ok: false, error: humanAiError(provider, response.status, bodyText) };
  return checkStreamBody(provider, bodyText);
}

async function testAiGateway(itx: VerifyAiItx, timeoutMs: number): Promise<VerifyAiResult> {
  const deadline = Date.now() + timeoutMs;
  const body = {
    input: [{ role: "user", content: "Reply with the single word: ok" }],
    reasoning: { effort: "low" },
    max_output_tokens: 256,
    stream: true,
    store: false,
  };
  let raw: unknown;
  try {
    raw = await withTimeout(
      itx.ai.run(
        // Two casts because @cloudflare/workers-types lists only Workers AI's own models: partner
        // models (`openai/...`) accept the provider's Responses API body through AI Gateway.
        `openai/${TEST_MODEL}` as Parameters<Ai["run"]>[0],
        body as never,
        {
          returnRawResponse: true,
          gateway: {
            id: "default",
            skipCache: true,
          },
        },
      ),
      deadline - Date.now(),
    );
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, error: humanAiError("ai-gateway", 0, text) };
  }
  if (!(raw instanceof Response)) return { ok: false, error: humanAiError("ai-gateway", 502, "") };
  let bodyText: string;
  try {
    bodyText = await readResponseTextWithin(raw, deadline);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, error: humanAiError("ai-gateway", 0, text) };
  }
  if (!raw.ok) return { ok: false, error: humanAiError("ai-gateway", raw.status, bodyText) };
  return checkStreamBody("ai-gateway", bodyText);
}

/** Runs a real test LLM inference request across the mind's configured AI credentials in the same
 *  priority order as agents.ts (ChatGPT plan -> /secrets/openai -> Cloudflare AI Gateway). */
export async function verifyAi(
  itx: VerifyAiItx,
  options: { timeoutMs?: number } = {},
): Promise<VerifyAiResult> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const credit = cloudCredit(itx);
  const [chatgpt, openaiKind] = await Promise.all([
    itx.secrets.describe("/secrets/chatgpt"),
    credit.secret("/secrets/openai"),
  ]);

  let configuredError: string | undefined;

  if (chatgpt.set) {
    const result = await testKeyProvider(
      itx,
      "chatgpt",
      'Bearer getSecret("/secrets/chatgpt", { field: "accessToken" })',
      timeoutMs,
    );
    if (result.ok) return result;
    configuredError = result.error;
  }

  if (openaiKind !== "unset") {
    const provider: AiProvider = openaiKind === "iterate-proxy" ? "iterate-cloud" : "openai";
    const result = await testKeyProvider(
      itx,
      provider,
      'Bearer getSecret("/secrets/openai")',
      timeoutMs,
    );
    if (result.ok) return result;
    configuredError ||= result.error;
  }

  const gatewayResult = await testAiGateway(itx, timeoutMs);
  if (gatewayResult.ok) return gatewayResult;
  return { ok: false, error: configuredError || gatewayResult.error };
}
