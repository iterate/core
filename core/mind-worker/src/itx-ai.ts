// What a call across RPC cannot carry is made plain here: a file comes in as bytes, a Response goes
// back as its body. Both are bounded: one call's bytes sit in this isolate beside every other call's.
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";
import { unavailableError } from "core-itx";
import { codedError, mindNamesOf } from "iterate/lib";
import { httpFailureKind } from "iterate/platform-retry";
import type { ItxAiGateway, ItxMarkdownDocument, ItxWebSearchAnswer } from "iterate/api";
import { traceModelCall } from "./agent-spans.ts";

/** AI Search's own ceiling for a file it converts with OCR, and under a third of a Workers RPC
 *  message's 32 MiB, since the bytes cross two hops. */
const TO_MARKDOWN_MAX_BYTES = 10 * 1024 * 1024;
const ANSWER_MAX_BYTES = 10 * 1024 * 1024;

/** Who makes a model call: the mind, and the context whose code calls. */
type ModelCaller = { mindSlug?: string; path: string };

type GatewayMetadata = NonNullable<GatewayOptions["metadata"]>;

/** A call's metadata for the AI Gateway, with the mind's name on it, whatever the caller passed:
 *  the gateway's spend rules cap a mind by `mindSlug`, so a caller that could leave it out or name
 *  another mind would spend outside its mind's cap. The caller's other keys are kept, and its
 *  `streamPath` when it names one (an agent's turn names the agent); else the calling context's
 *  path. The mind's name comes first: the gateway keeps five entries of a request. */
function stampedMetadata(given: GatewayMetadata | undefined, who: ModelCaller): GatewayMetadata {
  const mind = mindNamesOf({ mindSlug: who.mindSlug });
  return { ...mind, streamPath: who.path, ...given, ...mind };
}

export class ItxAi extends RpcTarget {
  readonly #ai: Ai;
  readonly #who: ModelCaller;
  constructor(ai: Ai, who: ModelCaller) {
    super();
    this.#ai = ai;
    this.#who = who;
  }

  run(model: string, inputs: Record<string, unknown>, given?: AiOptions): Promise<unknown> {
    // A call that names no gateway goes to Workers AI itself, which takes no metadata.
    const options = given?.gateway
      ? {
          ...given,
          gateway: {
            ...given.gateway,
            metadata: stampedMetadata(given.gateway.metadata, this.#who),
          },
        }
      : given;
    const send = () => this.#ai.run(model, inputs, options);
    // an agent's turn (the metadata iterate `agents/processor.ts` sends) gets traced
    const metadata = options?.gateway?.metadata;
    if (!options?.returnRawResponse || metadata?.context !== "agent-turn") return send();
    const slash = model.indexOf("/");
    return traceModelCall(
      {
        path: String(metadata.streamPath),
        provider: slash > 0 ? model.slice(0, slash) : "workers-ai",
        model: model.slice(slash + 1),
      },
      async () => {
        const raw: unknown = await send();
        if (raw instanceof Response) return raw;
        throw new Error(`model ${model}: Workers AI did not answer with the raw response`);
      },
    );
  }

  models(params?: AiModelsSearchParams): Promise<AiModelsSearchObject[]> {
    return this.#ai.models(params);
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
    const service = new ItxToMarkdown(this.#ai);
    return files ? service.transform(files, options) : service;
  }

  gateway(gatewayId: string): ItxAiGatewayTarget {
    return new ItxAiGatewayTarget(this.#ai.gateway(gatewayId), gatewayId, this.#who);
  }

  async websearch(request: AiWebSearchRequest): Promise<ItxWebSearchAnswer> {
    return WebSearchAnswer.parse(await bodyOf("Web Search", await this.#ai.websearch(request)));
  }
}

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

export class ItxAiGatewayTarget extends RpcTarget implements ItxAiGateway {
  readonly #gateway: AiGateway;
  readonly #id: string;
  readonly #who: ModelCaller;
  constructor(gateway: AiGateway, id: string, who: ModelCaller) {
    super();
    this.#gateway = gateway;
    this.#id = id;
    this.#who = who;
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
    // the binding's type wants the gateway's id beside its options: the one this handle is of
    const gateway = {
      id: this.#id,
      ...options?.gateway,
      metadata: stampedMetadata(options?.gateway?.metadata, this.#who),
    };
    return bodyOf("AI Gateway run", await this.#gateway.run(data, { ...options, gateway }));
  }
}

/** Checked for the fields the published type names, and kept whole. */
const WebSearchAnswer = z.looseObject({
  items: z.array(
    z.looseObject({ url: z.string(), title: z.string(), description: z.string().optional() }),
  ),
  metadata: z.looseObject({ query: z.string(), requestId: z.string(), latencyMs: z.number() }),
});

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

/** A 429 or 5xx throws UNAVAILABLE (iterate/platform-retry `httpFailureKind`); any other failure is the request's own. */
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
