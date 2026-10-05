// itx-ai.ts — THE PLATFORM'S WORKERS AI: `ItxAi`, the stateless entrypoint a context's built-in
// `itx.ai` root is a stub of (context/built-ins.ts). Every Workers AI call a context makes passes
// through it, so the call starts in a stateless invocation rather than in the context's Durable
// Object. Its props name the project the call is made for: where a meter or an attribution goes.
//
// The binding's methods keep their names and shapes (iterate/api `ItxAiApi` says which are here and
// why the rest are not). What a call across RPC cannot carry is made plain at this end: a file comes
// in as its bytes and becomes the Blob the binding takes, and a Response the binding answers goes
// back as its body. Both are bounded, since one call's bytes sit in this isolate beside every other
// project's calls.
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { codedError } from "iterate/lib";
import { httpFailureKind } from "iterate/platform-retry";
import type {
  IterateContextApi,
  ItxAiGateway,
  ItxMarkdownDocument,
  ItxWebSearchAnswer,
} from "iterate/api";
import type { Env } from "./iterate-context-durable-object.ts";
import { unavailableError } from "./unavailable.ts";

/** The most one `toMarkdown` call carries, its files together: AI Search's own ceiling for a file
 *  it converts with OCR, and under a third of the 32 MiB a Workers RPC message may be, since the
 *  bytes cross two hops before they become a Blob here. */
export const TO_MARKDOWN_MAX_BYTES = 10 * 1024 * 1024;
/** The most of a Response body `websearch` or a gateway's `run` reads into this isolate. */
export const ANSWER_MAX_BYTES = 10 * 1024 * 1024;

/** The binding's methods, under their own names. */
export class ItxAi extends WorkerEntrypoint<Env, { projectId: string }> {
  run(model: string, inputs: Record<string, unknown>, options?: AiOptions): Promise<unknown> {
    return this.env.AI.run(model, inputs, options);
  }

  models(params?: AiModelsSearchParams): Promise<AiModelsSearchObject[]> {
    return this.env.AI.models(params);
  }

  toMarkdown(): ItxToMarkdown;
  toMarkdown(
    files: ItxMarkdownDocument[],
    options?: ConversionRequestOptions,
  ): Promise<ConversionResponse[]>;
  toMarkdown(
    files: ItxMarkdownDocument,
    options?: ConversionRequestOptions,
  ): Promise<ConversionResponse>;
  toMarkdown(
    files?: ItxMarkdownDocument | ItxMarkdownDocument[],
    options?: ConversionRequestOptions,
  ): ItxToMarkdown | Promise<ConversionResponse | ConversionResponse[]> {
    const service = new ItxToMarkdown(this.env.AI);
    return files ? service.transform(files, options) : service;
  }

  gateway(gatewayId: string): ItxAiGatewayTarget {
    return new ItxAiGatewayTarget(this.env.AI.gateway(gatewayId));
  }

  websearch(request: AiWebSearchRequest): Promise<ItxWebSearchAnswer> {
    return websearch(this.env.AI, request);
  }
}

/** The binding's `ToMarkdownService`, taking each file as bytes or text (iterate/api
 *  `ItxToMarkdownService`, whose overloads the implementation spells out). */
export class ItxToMarkdown extends RpcTarget {
  readonly #ai: Pick<Ai, "toMarkdown">;
  constructor(ai: Pick<Ai, "toMarkdown">) {
    super();
    this.#ai = ai;
  }

  transform(
    files: ItxMarkdownDocument[],
    options?: ConversionRequestOptions,
  ): Promise<ConversionResponse[]>;
  transform(
    files: ItxMarkdownDocument,
    options?: ConversionRequestOptions,
  ): Promise<ConversionResponse>;
  transform(
    files: ItxMarkdownDocument | ItxMarkdownDocument[],
    options?: ConversionRequestOptions,
  ): Promise<ConversionResponse | ConversionResponse[]>;
  async transform(
    files: ItxMarkdownDocument | ItxMarkdownDocument[],
    options?: ConversionRequestOptions,
  ): Promise<ConversionResponse | ConversionResponse[]> {
    const parsed = MarkdownDocuments.safeParse(files);
    if (!parsed.success)
      throw codedError(
        "INVALID_INPUT",
        `toMarkdown takes { name, blob } (bytes or text), { name, data } (base64), or a list of them: ${z.prettifyError(parsed.error)}`,
      );
    const documents = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
    // A text's UTF-8 is no shorter than the text, so this refuses before any file is copied.
    refuseOverMarkdownBound(documents.reduce((sum, file) => sum + leastBytesOf(file), 0));
    // The binding refuses a Blob with no type, and tells a file's format from its name.
    const blobs = documents.map((file) => ({
      name: file.name,
      blob: new Blob(["data" in file ? bytesOfBase64(file.data) : file.blob], {
        type: file.type || "application/octet-stream",
      }),
    }));
    refuseOverMarkdownBound(blobs.reduce((sum, { blob }) => sum + blob.size, 0));
    const results = await this.#ai.toMarkdown(blobs, options);
    return Array.isArray(parsed.data) ? results : results[0];
  }

  supported(): Promise<SupportedFileFormat[]> {
    return this.#ai.toMarkdown().supported();
  }
}

/** The binding's `AiGateway`. */
export class ItxAiGatewayTarget extends RpcTarget implements ItxAiGateway {
  readonly #gateway: AiGateway;
  constructor(gateway: AiGateway) {
    super();
    this.#gateway = gateway;
  }

  async getLog(logId: Parameters<ItxAiGateway["getLog"]>[0]) {
    try {
      return await this.#gateway.getLog(logId);
    } catch (error) {
      // The binding's own error for an id the gateway holds no log for: the caller's to handle.
      if (error instanceof Error && error.name === "AiGatewayLogNotFound")
        throw codedError("INVALID_INPUT", `AI Gateway has no log ${logId}: ${error.message}`);
      throw error;
    }
  }

  patchLog(...[logId, data]: Parameters<ItxAiGateway["patchLog"]>) {
    return this.#gateway.patchLog(logId, data);
  }

  getUrl(provider?: Parameters<ItxAiGateway["getUrl"]>[0]) {
    return this.#gateway.getUrl(provider);
  }

  async run(...[data, options]: Parameters<ItxAiGateway["run"]>) {
    return bodyOf("AI Gateway run", await this.#gateway.run(data, options));
  }
}

/** The Web Search API's answer, checked for the fields the published type names and kept whole. */
const WebSearchAnswer = z.looseObject({
  items: z.array(
    z.looseObject({ url: z.string(), title: z.string(), description: z.string().optional() }),
  ),
  metadata: z.looseObject({ query: z.string(), requestId: z.string(), latencyMs: z.number() }),
});

export async function websearch(
  ai: Pick<Ai, "websearch">,
  request: AiWebSearchRequest,
): Promise<ItxWebSearchAnswer> {
  return WebSearchAnswer.parse(await bodyOf("Web Search", await ai.websearch(request)));
}

const MarkdownDocument = z.union([
  z.object({
    name: z.string().min(1),
    blob: z.union([z.instanceof(Uint8Array), z.instanceof(ArrayBuffer), z.string()]),
    type: z.string().optional(),
  }),
  z.object({ name: z.string().min(1), data: z.string(), type: z.string().optional() }),
]);
const MarkdownDocuments = z.union([MarkdownDocument, z.array(MarkdownDocument)]);

/** The fewest bytes a file can become: a base64 string's decoded length, a text's length. */
function leastBytesOf(file: z.infer<typeof MarkdownDocument>): number {
  if ("data" in file) return Math.floor((file.data.length * 3) / 4);
  return typeof file.blob === "string" ? file.blob.length : file.blob.byteLength;
}

function refuseOverMarkdownBound(bytes: number) {
  if (bytes > TO_MARKDOWN_MAX_BYTES)
    throw codedError(
      "INVALID_INPUT",
      `toMarkdown takes at most ${TO_MARKDOWN_MAX_BYTES} bytes a call, all files together; these are ${bytes}`,
    );
}

function bytesOfBase64(data: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    throw codedError("INVALID_INPUT", "toMarkdown: a file's `data` is not base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A binding's HTTP answer as a caller across RPC takes it: JSON parsed, text as a string, anything
 *  else as bytes. A failed answer throws by its kind (platform-retry.ts `httpFailureKind`): a 429 or
 *  5xx as UNAVAILABLE, any other status as the request's own refusal, with its status and body. */
async function bodyOf(what: string, response: Response): Promise<unknown> {
  const bytes = await boundedBytesOf(what, response);
  if (!response.ok) {
    const message = `${what} answered HTTP ${response.status}: ${new TextDecoder().decode(bytes).slice(0, 1_000)}`;
    const kind = httpFailureKind(response);
    if (kind === "overloaded" || kind === "disconnected") throw unavailableError(kind, message);
    throw codedError("INVALID_INPUT", message, { status: response.status });
  }
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json")) return JSON.parse(new TextDecoder().decode(bytes));
  if (type.startsWith("text/")) return new TextDecoder().decode(bytes);
  return bytes;
}

async function boundedBytesOf(what: string, response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > ANSWER_MAX_BYTES) {
      await reader.cancel();
      throw codedError(
        "INVALID_INPUT",
        `${what} answered more than ${ANSWER_MAX_BYTES} bytes, more than one call carries`,
      );
    }
    chunks.push(read.value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** Mint `ItxAi` for one project — `ctx.exports.ItxAi({ props })` on a context's Durable Object's
 *  state, or on the stateless entrypoint's execution context (context/stateless-context.ts). The
 *  cast: `Cloudflare.Exports` is `{}` without a generated `GlobalProps` (as for `itxEntrypointFor`),
 *  and the stub answers the methods the published `itx.ai` names. */
export function itxAiFor(
  ctx: DurableObjectState | ExecutionContext,
  projectId: string,
): IterateContextApi["ai"] {
  const { exports } = ctx as unknown as {
    exports: { ItxAi(opts: { props: { projectId: string } }): IterateContextApi["ai"] };
  };
  return exports.ItxAi({ props: { projectId } });
}
