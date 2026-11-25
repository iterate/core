import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  ResourceNotFoundError,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { contextAt, type Caller } from "core-itx";
import { bytesToBase64, errorCode } from "iterate/lib";
import { stampedCallerOf } from "iterate/principal";
import { z } from "zod";
import { skillCatalog, type SkillCatalog } from "./mcp-skills.ts";

// mcp.ts — EVERY MCP SERVER OF A MIND IS SERVED HERE. The protocol, the SDK and the skills
// catalog are this Worker's; a mind's config says what a server offers, as a class with a method
// for each tool (iterate/sdk `McpServerTarget`), and none of the protocol is in its worker.
//
//   - THE MIND'S OWN SERVER, at the control-plane hostname, for members: the tool `run`. When the
//     deploy's config names a method of the config's class (`mcpTarget`, iterate/mind-config),
//     that class may give the instructions, the description of `run`, more tools and skills.
//   - A SERVER OF AN APP, on a host of the mind: the config's `fetch` asked for it
//     (iterate/sdk `auth.mcpServer`; core/itx/src/serve-host.ts hands it over). It has the
//     class's tools and skills, and no `run`.
//
// THE CONFIG CANNOT BREAK A SERVER. Each thing it is asked (`askConfig`) has a time limit and a
// schema. What fails, is slow or does not fit is logged, and the default stands: the mind's own
// server then answers as it does with no `mcpTarget`.

/** One call of the config's class for this server: `method` with `args`
 *  (iterate/sdk `IterateConfigEntrypoint.mcpCall`). */
export type McpConfigCall = (
  client: McpClient,
  method: string,
  args: unknown[],
) => Promise<unknown>;

/** The client as the config's class gets it (iterate/sdk `McpClient`). */
type McpClient = { name?: string; version?: string; person?: unknown; member?: unknown };

// A caller without a stamp came in past the boundary (a home lab's local port).
export async function serveMcp(
  request: Request,
  readSignedFile: ReadSignedFile,
  // the config's part, when the deploy's config names its method
  config?: McpConfigCall,
): Promise<Response> {
  const caller = stampedCallerOf(request);
  if (!caller.principal) return new Response("Sign in\n", { status: 401 });
  return mcpResponse(request, caller, { name: "iterate-mind", run: readSignedFile, config });
}

/** ONE `run` FOR AN MCP SERVER OF THE MIND'S OWN CONFIG (core/itx/src/serve-host.ts
 *  `mcpRunAnswer`): `message` is one `tools/call` of `run`, and `caller` the member the boundary
 *  stamped. The same handler as above, so a run is the same run at either address. */
export const serveMcpRun = (message: Request, caller: Caller, readSignedFile: ReadSignedFile) =>
  mcpResponse(message, caller, { name: "iterate-mind", run: readSignedFile });

const plain = (body: string, status: number, headers?: Record<string, string>) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });

/** AN APP'S MCP SERVER, on a host of the mind (core/itx/src/serve-host.ts hands it over when the
 *  config's `fetch` asked: iterate/sdk `auth.mcpServer`). The tools and skills of the config's
 *  class, and no `run`.
 *
 *  WHO MAY CONNECT is decided here, by the stamp of the boundary that `caller` carries, never by
 *  the config's answer: "members" takes a member; "people" also a person who signed in and
 *  proved an address (no guest, and no member of another mind). Anyone else gets MCP's 401, which
 *  names RFC 9728's document; that names the mind's sign-in, and the token a client gets there is
 *  good for this host alone. A write from another site's page is refused, as every guard of
 *  iterate/sdk `auth` does. */
export async function serveAppMcp(
  request: Request,
  caller: Caller,
  server: {
    target: string;
    for: "members" | "people";
    name?: string;
    controlPlaneOrigin: string;
    config: McpConfigCall;
  },
): Promise<Response> {
  const url = new URL(request.url);
  // A body that is not read is dropped and NEVER AWAITED: `request` is one branch of a tee
  // (core/itx/src/serve-host.ts), whose cancellation settles only when the other branch is
  // cancelled or ends. A refusal must not wait for a sender's upload.
  const drop = () => {
    request.body?.cancel().catch(() => {});
  };
  if (url.pathname !== "/mcp") {
    drop();
    return request.method === "GET"
      ? Response.json(
          {
            resource: url.origin,
            authorization_servers: [server.controlPlaneOrigin],
            scopes_supported: ["identity"],
            bearer_methods_supported: ["header"],
          },
          { headers: { "Cache-Control": "no-store" } },
        )
      : plain("Method not allowed\n", 405, { allow: "GET" });
  }
  const refuse = (body: string, status: number, headers?: Record<string, string>) => {
    drop();
    return plain(body, status, headers);
  };
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return refuse("Cross-site request refused\n", 403);
  const { person } = caller;
  const proved = person && person.method !== "guest" && person.method !== "mind";
  if (!caller.principal && !(server.for === "people" && proved)) {
    // signed in, and not one this server takes: a 401 would make the client sign the same
    // person in again
    if (person) return refuse("This MCP server is not open to you.\n", 403);
    const invalid = request.headers.has("authorization") ? 'error="invalid_token", ' : "";
    // a 401 at the probe of a client of MCP 2026-07-28 ends its connect with an error; a 400
    // makes it `initialize`, whose 401 signs it in. Nobody is signed in, so the body is not
    // read whole: the probe is named in a header, or in the first bytes of a small message.
    const probe = request.method === "POST" && (await isDiscoverProbe(request));
    return refuse("Sign in to use this MCP server.\n", probe ? 400 : 401, {
      "WWW-Authenticate": `Bearer ${invalid}resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp", scope="identity"`,
    });
  }
  if (request.method !== "POST") return refuse("Method not allowed\n", 405, { allow: "POST" });
  return mcpResponse(request, caller, {
    name: server.name || url.hostname,
    config: server.config,
  });
}

const runInstructions =
  "One tool, `run({ script })`, runs a script of yours against this iterate mind. Its description is the guide: how to inspect the mind, change its code and read the platform's source.";

const runDescription = [
  "Evaluate a JavaScript function, `async (itx) => { ... }`, with the mind's root `itx` handle at `/`. Each call runs the complete script in a worker, for at most ten minutes: await every operation and return a JSON-serializable result. No variable survives a call, so carry state in returned results or in the mind. Every call and its settlement are logged at `/` with your principal and grant, and what your script writes carries them too.",
  'Start by reading who this context is, the mind\'s URL, and every capability with its description:\n```json\n{"script": "async (itx) => ({ context: await itx.whoami(), url: await itx.url(), capabilities: (await itx.rewriteRules.list()).map((rule) => [rule.match, rule.description]) })"}\n```',
  '`itx.cd("/path")` addresses another context of this mind.',
  'A result is JSON, and JSON is text to you. To SEE image files of the mind (`itx.files`), return their paths under the key `"itx/images"`: `return { note: "the page", "itx/images": ["/shots/page.png"] }`. Each arrives as an image beside the result: PNG, JPEG, GIF or WebP, at most 8 files and 5 MiB in all. `"itx/images-left-out"` in the result says which files did not come, and why.',
  'The mind\'s code is the config repo, `itx.repos.get("/repos/config")`: `listFiles()` and `readFile(path)` read it. Its `AGENTS.md` is the guide to this mind\'s code: read it before you change a file. `package.json` names the main module in `"main"` (`worker.ts`); its default export is a class that extends `IterateConfigEntrypoint` from `iterate/sdk`, and publication refuses any other. Files may be TypeScript (types are stripped, not checked) or JavaScript and import each other by relative path. `iterate/*` and `zod` come from the platform; any other package is listed in `package.json` `dependencies` and fetched from npm through esm.sh (a package that needs Node.js builtins is refused).',
  "A commit to the config repo publishes the mind a few seconds after it lands. `commitFiles({ message, changes, parent })` takes the whole new content of each changed file (`{ path, content }`, or `{ path, delete: true }`). There is no patch operation: change the text inside your script, and the file never has to pass through your context. Pass the tip you read as `parent`, so the commit is refused if main moved meanwhile. The commit is authored by you unless it names an `author`; end its message with `Via: <your name>` so it says which agent did the work. Every commit gets one outcome event on `/`, `worker-updated` or `worker-update-failed`, and a failure's `payload.error` says why the commit is not live.",
  "Change a file and wait for its outcome (this writes to the repo; replace the path and the text with your edit):\n```json\n{\"script\": \"async (itx) => { const repo = itx.repos.get('/repos/config'); const tip = await repo.tip(); const source = await repo.readFile('worker.ts', { commitOid: tip }); const next = source.replace('Homepage of mind ', 'Welcome to '); if (next === source) throw new Error('the homepage text is not in worker.ts'); const { commitOid } = await repo.commitFiles({ message: 'Change the homepage greeting\\\\n\\\\nVia: Claude Code', parent: tip, changes: [{ path: 'worker.ts', content: next }] }); const outcome = await itx.waitForEvent({ type: ['events.iterate.com/mind/worker-updated', 'events.iterate.com/mind/worker-update-failed'], payload: { commitOid }, afterOffset: 0, timeoutMs: 120000 }); if (outcome.payload.error) throw new Error(outcome.payload.error); return { commitOid, outcome: outcome.type }; }\"}\n```",
  'After `worker-updated` the site serves the commit within 5 seconds: fetch `await itx.url()`, the mind\'s apex, with `itx.fetch` and check the page before you report success. To try a change with no commit, run the candidate as a worker: `(await itx.workers.get({ source: { ...(await itx.repos.get("/repos/config").files()), "worker.ts": candidateSource } }).fetch(new Request(await itx.url()))).text()`, the repo\'s files under their repo paths with your edits over them.',
  "The source code for all of this is public at https://github.com/iterate/core: read it before you guess how anything here works. List the files first: https://data.jsdelivr.com/v1/packages/gh/iterate/core@main?structure=flat (`files[].name`, each a path with a leading `/`; the list can be hours behind). GitHub's own list, https://api.github.com/repos/iterate/core/git/trees/main?recursive=1 (`tree[].path`), is exact, but GitHub allows 60 listings an hour to everyone behind one address, so through this tool it often answers 403. Then read `core/AGENTS.md`, then the file you need at `https://raw.githubusercontent.com/iterate/core/main/<path>`. To find where something is implemented, fetch the likely files in one script, search their text there, and return only the lines that match. `main` can differ from the code this mind runs: where they disagree, what a call answers is right. Through this tool: `async (itx) => (await itx.fetch(new Request(url))).text()`.",
].join("\n\n");

const validator = new CfWorkerJsonSchemaValidator();

// A SCRIPT SHOWS ITS CALLER IMAGES. A result reaches the model as JSON text, so a model on the
// other side of MCP could not be shown a file of the mind: not a capture's picture, not a screen
// snapshot. A script names the files, and they go out as MCP image blocks beside the text.
const SHOWN_IMAGES_KEY = "itx/images";
const MAX_SHOWN_IMAGES = 8;
const MAX_SHOWN_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SHOWN_PATH_LENGTH = 1024;
// what a model's API takes as an image: another type would fail the whole turn of the client
const SHOWN_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const ShownImages = z.looseObject({ [SHOWN_IMAGES_KEY]: z.array(z.string()) });
const ListedFiles = z.array(
  z.object({
    path: z.string(),
    contentType: z.string().optional(),
    size: z.number().optional(),
    url: z.string().optional(),
    error: z.string().optional(),
  }),
);

/** A signed file URL of this mind, answered in this Worker (./context/file-urls.ts). */
type ReadSignedFile = (url: string) => Promise<Response>;

/** The script that looks the named files up. It goes through `itx.run` as the caller's own script
 *  did, with the same caller: it reaches what a script of that member reaches and no more, and the
 *  member could send this same script. It signs a link of one minute only for a file that could go
 *  out alone (its type and its size), so that no other link is in the run's log. */
const listShownFiles = (paths: string[]) => `async (itx) =>
  Promise.all(${JSON.stringify(paths)}.map(async (path) => {
    try {
      const file = itx.files.get(path);
      const head = await file.head();
      if (!head) return { path, error: "no such file" };
      const isShown = ${JSON.stringify([...SHOWN_IMAGE_TYPES])}.includes(String(head.contentType).split(";")[0].trim().toLowerCase()) && head.size > 0 && head.size <= ${MAX_SHOWN_IMAGE_BYTES};
      return { path, contentType: head.contentType, size: head.size, ...(isShown && { url: (await file.url({ expiresInSeconds: 60 })).url }) };
    } catch (error) {
      return { path, error: String(error?.message ?? error).slice(0, 200) };
    }
  }))`;

/** A response's body and how many bytes were read for it. No body when the response is not a
 *  file, or is past `limit` bytes: the read stops at the chunk that crosses it. */
async function bodyUpTo(
  response: Response,
  limit: number,
): Promise<{ body?: Uint8Array; read: number }> {
  if (!response.ok || !response.body) return { read: 0 };
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    return { read: 0 };
  }
  const chunks: Uint8Array[] = [];
  let read = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > limit) {
        await reader.cancel();
        return { read };
      }
      chunks.push(value);
    }
  } catch {
    // a stream that broke: what it gave before counts
    return { read };
  }
  const body = new Uint8Array(read);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return { body, read };
}

const shownTypeOf = (contentType: string | null | undefined) =>
  (contentType || "").split(";")[0].trim().toLowerCase();

/** The image blocks for the files a result names, and the result to answer: with each file that
 *  is not among the blocks and the reason, when there is one. `list` runs `listShownFiles`. Every
 *  outcome is expected and bounded: at most 8 files are looked up and opened, each path once;
 *  every byte that is read counts against 5 MiB, also the bytes of a stream that breaks; and the
 *  list of what did not come has at most 9 entries. */
export async function shownImages(
  value: unknown,
  list: (paths: string[]) => Promise<unknown>,
  read: ReadSignedFile,
): Promise<{
  value: unknown;
  namesImages: boolean;
  images: { type: "image"; mimeType: string; data: string }[];
}> {
  const named = ShownImages.safeParse(value);
  if (!named.success || named.data[SHOWN_IMAGES_KEY].length === 0)
    return { value, namesImages: false, images: [] };
  // each path once: a path named twice has one image, or one reason
  const paths = [...new Set(named.data[SHOWN_IMAGES_KEY])];
  // a Map: a path may be "__proto__"
  const leftOut = new Map<string, string>();
  // one entry for all the paths past the eighth: a result may name a million
  if (paths.length > MAX_SHOWN_IMAGES)
    leftOut.set(
      `(${paths.length - MAX_SHOWN_IMAGES} more paths)`,
      `not looked up: at most ${MAX_SHOWN_IMAGES} files`,
    );
  const looked: string[] = [];
  for (const path of paths.slice(0, MAX_SHOWN_IMAGES)) {
    // a path goes into the lookup script, and so into the log
    if (path.length > MAX_SHOWN_PATH_LENGTH)
      leftOut.set(
        `${path.slice(0, 64)}…`,
        `a path of more than ${MAX_SHOWN_PATH_LENGTH} characters`,
      );
    else looked.push(path);
  }
  const listed = ListedFiles.safeParse(
    looked.length > 0 ? await list(looked).catch(() => undefined) : [],
  );
  // one row for each path that was asked for, in that order: a `run` that a rule replaced may answer anything
  const rows =
    listed.success &&
    listed.data.length === looked.length &&
    listed.data.every((file, index) => file.path === looked[index])
      ? listed.data
      : [];
  if (rows.length === 0) for (const path of looked) leftOut.set(path, "the lookup failed");
  const images: { type: "image"; mimeType: string; data: string }[] = [];
  let budget = MAX_SHOWN_IMAGE_BYTES;
  for (const file of rows) {
    if (file.error) leftOut.set(file.path, file.error);
    else if (!SHOWN_IMAGE_TYPES.has(shownTypeOf(file.contentType)))
      leftOut.set(
        file.path,
        `not a PNG, JPEG, GIF or WebP image: ${file.contentType || "no content type"}`,
      );
    else if (!file.size) leftOut.set(file.path, "an empty file");
    else if (file.size > budget || !file.url)
      leftOut.set(file.path, `more than ${MAX_SHOWN_IMAGE_BYTES} bytes of images in all`);
    else {
      // The lookup's type and size were claims about a file that can change: the read decides.
      const { url } = file;
      // inside the chain: a link that is no URL throws before there is a promise
      const answer = await Promise.resolve()
        .then(() => read(url))
        .then(async (response) => ({
          mimeType: shownTypeOf(response.headers.get("content-type")),
          ...(await bodyUpTo(response, budget)),
        }))
        .catch(() => undefined);
      budget -= answer?.read || 0;
      if (answer?.body?.byteLength && SHOWN_IMAGE_TYPES.has(answer.mimeType))
        images.push({ type: "image", mimeType: answer.mimeType, data: bytesToBase64(answer.body) });
      else leftOut.set(file.path, "the read failed, or the file changed after the lookup");
    }
  }
  return {
    images,
    namesImages: true,
    value: leftOut.size
      ? { ...named.data, "itx/images-left-out": Object.fromEntries(leftOut) }
      : value,
  };
}

/** What one server offers. `run`: the mind's own tool, with the reader of the files it shows.
 *  `config`: the config's class. */
type Served = { name: string; run?: ReadSignedFile; config?: McpConfigCall };

/** What the config's class said for one request, each part checked: absent where it said
 *  nothing, failed or did not fit. */
type Said = {
  instructions?: string;
  tools?: z.infer<typeof ConfigTools>;
  skills?: SkillCatalog;
};

const CONFIG_ANSWER_TIMEOUT_MS = 5000;
const ConfigInstructions = z.string().max(16_384);
/** MCP's `Tool`, as far as this server reads it. A tool's name is a method's name. */
const ConfigTools = z
  .array(
    z.object({
      name: z.string().regex(/^[A-Za-z_][\w-]{0,63}$/),
      title: z.string().max(256).optional(),
      description: z.string().max(16_384).optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
    }),
  )
  .max(128);
const ConfigSkillFiles = z.record(z.string(), z.union([z.string(), z.instanceof(Uint8Array)]));

/** The names no tool of a config may have: the class's own three, and what every object has. */
const NO_TOOL_NAMES: ReadonlySet<string> = new Set([
  "instructions",
  "tools",
  "skills",
  "constructor",
  "fetch",
]);

/** MCP's Skills extension (./mcp-skills.ts). An empty object: no `resources/directory/read`. */
const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
/** What MCP from 2026-07-28 on asks on a list and a read: a client may keep an answer for a
 *  minute, for the one who asked. */
const CACHEABLE = { resultType: "complete", ttlMs: 60_000, cacheScope: "private" } as const;
const UriParams = z.looseObject({ uri: z.string() });
const AnyResult = z.looseObject({});

/** ONE QUESTION TO THE CONFIG'S CLASS, which cannot break the server: its answer within the time
 *  limit and in `schema`'s shape, or undefined, with one log line that says what went wrong. */
async function askConfig<T>(
  ask: () => Promise<unknown>,
  schema: z.ZodType<T>,
  what: string,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      ask(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer in ${CONFIG_ANSWER_TIMEOUT_MS} ms`)),
          CONFIG_ANSWER_TIMEOUT_MS,
        );
      }),
    ]);
    // the class has no such method: the default stands, and nothing is wrong
    if (!answer) return undefined;
    const parsed = schema.safeParse(answer);
    if (parsed.success) return parsed.data;
    throw new Error(`not the expected shape: ${parsed.error.issues[0]?.message || "invalid"}`);
  } catch (error) {
    console.warn({
      event: "mcp.config-target-failed",
      what,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function buildServer(caller: Caller, served: Served, said: Said, client: McpClient): McpServer {
  const instructions = said.instructions || (served.run ? runInstructions : undefined);
  const mcpServer = new McpServer(
    { name: served.name, version: "0.1.0" },
    instructions ? { instructions } : {},
  );
  const { config } = served;
  for (const tool of said.tools || []) {
    // `run` is the platform's on the mind's own server: its entry gives the description alone
    if (NO_TOOL_NAMES.has(tool.name) || (served.run && tool.name === "run") || !config) continue;
    mcpServer.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(
          (tool.inputSchema || { type: "object" }) as Parameters<typeof fromJsonSchema>[0],
          validator,
        ),
      },
      async (toolArguments: unknown) => {
        try {
          const value = await config(client, tool.name, [toolArguments]);
          const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
          return { content: [{ type: "text" as const, text }], isError: false };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      },
    );
  }
  if (said.skills) serveSkills(mcpServer, said.skills);
  const readSignedFile = served.run;
  if (!readSignedFile) return mcpServer;

  mcpServer.registerTool(
    "run",
    {
      title: "Run a script",
      description: said.tools?.find((tool) => tool.name === "run")?.description || runDescription,
      inputSchema: fromJsonSchema(
        {
          type: "object",
          additionalProperties: false,
          required: ["script"],
          properties: {
            script: {
              type: "string",
              minLength: 1,
              description:
                "The text of an async function of one parameter, `itx`: `async (itx) => { const n = Number(await itx.kv.get('n')) || 0; await itx.kv.put('n', String(n + 1)); return n + 1; }`. It bakes in its own values (there are no arguments — write the whole script). Return a JSON-serializable value (undefined, functions and live handles do not cross the boundary).",
            },
          },
        } as Parameters<typeof fromJsonSchema>[0],
        validator,
      ),
    },
    async (raw: unknown) => {
      // the validator has checked `raw` against the schema above
      const toolArguments = raw as { script: string };
      try {
        const value = await contextAt("/").invoke(
          ["itx", ["run", toolArguments.script]],
          [],
          caller,
        );
        const shown = await shownImages(
          value,
          (paths) => contextAt("/").invoke(["itx", ["run", listShownFiles(paths)]], [], caller),
          readSignedFile,
        );
        // a round trip drops what JSON cannot carry and throws on what it refuses
        const json = JSON.stringify(shown.value) ?? "null";
        return {
          content: [{ type: "text" as const, text: json }, ...shown.images],
          isError: false,
          // Codex reads `structuredContent` in place of `content`: beside images it would drop
          // them. So a result that names images has none, whether or not an image came: the
          // shape of an answer follows from the script's own result alone.
          ...(!shown.namesImages && {
            structuredContent: { result: JSON.parse(json) as unknown },
          }),
        };
      } catch (error) {
        // A failure is an isError result, never a thrown 500, led by the error code when present.
        const message = error instanceof Error ? error.message : String(error);
        const code = errorCode(error);
        return {
          content: [{ type: "text" as const, text: code ? `${code}: ${message}` : message }],
          isError: true,
        };
      }
    },
  );

  return mcpServer;
}

/** The skills of a server, as resources and through MCP's Skills extension. All of it reads the
 *  catalog: nothing of a skill is run. */
function serveSkills(mcpServer: McpServer, catalog: SkillCatalog) {
  const { server } = mcpServer;
  server.registerCapabilities({
    resources: {},
    extensions: { [SKILLS_EXTENSION]: {} },
  } as Parameters<typeof server.registerCapabilities>[0]);
  server.setRequestHandler("resources/list", () => ({
    ...CACHEABLE,
    resources: catalog.resources,
  }));
  server.setRequestHandler("resources/templates/list", () => ({
    ...CACHEABLE,
    resourceTemplates: [],
  }));
  server.setRequestHandler("resources/read", (request) => {
    const contents = catalog.contents.get(request.params.uri);
    // one lookup of the exact URI: a path that climbs finds nothing. The SDK's own error for
    // it, so a client reads "not found" and not a fault of the server.
    if (!contents) throw new ResourceNotFoundError(request.params.uri);
    return { ...CACHEABLE, contents: [contents] };
  });
  server.setRequestHandler("skills/list", { params: z.looseObject({}), result: AnyResult }, () => ({
    ...CACHEABLE,
    skills: catalog.skills,
    // a SKILL.md that is no valid skill is not served: say which, and why
    ...(catalog.leftOut.length > 0 && {
      _meta: { "com.iterate/skills-left-out": catalog.leftOut },
    }),
  }));
  server.setRequestHandler("skills/get", { params: UriParams, result: AnyResult }, (params) => {
    const skill = catalog.skills.find(({ uri }) => uri === params.uri);
    if (!skill) throw new ResourceNotFoundError(params.uri, `No skill is served at ${params.uri}`);
    return { ...CACHEABLE, skill };
  });
}

/** Stateless: `createMcpHandler` builds a server per HTTP request. The config's class is asked
 *  only what this request needs. */
async function mcpResponse(request: Request, caller: Caller, served: Served) {
  const asked = await askedOf(request);
  const client: McpClient = {
    ...asked.client,
    person: caller.person,
    // null for anyone who is no member
    member: caller.principal || undefined,
  };
  const said: Said = {};
  const { config } = served;
  if (config) {
    const say = <T>(method: string, schema: z.ZodType<T>) =>
      askConfig(() => config(client, method, []), schema, `${served.name}.${method}`);
    const [instructions, tools, files] = await Promise.all([
      asked.instructions ? say("instructions", ConfigInstructions) : undefined,
      // an initialize says whether the server has tools and skills at all
      asked.tools || asked.instructions ? say("tools", ConfigTools) : undefined,
      asked.skills || asked.instructions ? say("skills", ConfigSkillFiles) : undefined,
    ]);
    said.instructions = instructions;
    said.tools = tools;
    if (files) said.skills = await skillCatalog(files);
  }
  return createMcpHandler(
    () => buildServer(caller, served, said, client),
    // A `run` can last ten minutes, and Claude Code gives up on a POST whose headers take 60 seconds.
    // "sse" sends the headers at once and a keep-alive every 15 seconds.
    { responseMode: "sse" },
  ).fetch(request);
}

/** A probe is one small JSON-RPC message: more than this is read of no anonymous body. */
const PROBE_BYTES = 2048;

/** WHETHER AN ANONYMOUS POST IS THE `server/discover` PROBE, read at no more cost than a probe
 *  has. MCP from 2026-07-28 on names the method in the header `Mcp-Method`: then no byte is read.
 *  Without the header, a body is read only when it declares a length of at most `PROBE_BYTES`
 *  (a body of unknown length is no probe, and is not read); the read takes at most one
 *  second in all, and no chunk past the declared size is decoded. The body is
 *  cancelled after: the caller refuses the request either way. */
async function isDiscoverProbe(request: Request): Promise<boolean> {
  const named = request.headers.get("mcp-method");
  if (named) return named === "server/discover";
  const declared = request.headers.get("content-length");
  const length = declared && /^\d+$/.test(declared) ? Number(declared) : Infinity;
  if (length > PROBE_BYTES || !request.body) return false;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), 1000);
  });
  let text = "";
  let read = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late]);
      // a sender that pauses holds no answer open
      if (next === "late") return false;
      if (next.done) return /"method"\s*:\s*"server\/discover"/.test(text + decoder.decode());
      read += next.value.byteLength;
      // more than the body declared: no probe, and the chunk is not decoded
      if (read > length) return false;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    // the rest is never read, and the caller may cancel the body itself after this
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const ClientInfo = z.looseObject({ name: z.string().max(256), version: z.string().max(64) });
/** One JSON-RPC message, as far as this file reads it before the SDK does: its method, and how
 *  the client named itself (`initialize`'s `clientInfo`, or each call's envelope from MCP
 *  2026-07-28 on). */
const AskedMessage = z.looseObject({
  method: z.string(),
  params: z
    .looseObject({
      clientInfo: ClientInfo.optional().catch(undefined),
      _meta: z
        .looseObject({
          "io.modelcontextprotocol/clientInfo": ClientInfo.optional().catch(undefined),
        })
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});

/** What a request asks, read from a copy, so the SDK reads and refuses the body as it always
 *  does. `instructions`: the SDK's `Server._oninitialize` and `_ondiscover`. */
async function askedOf(request: Request) {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  const messages = [body].flat().flatMap((message) => {
    const parsed = AskedMessage.safeParse(message);
    return parsed.success ? [parsed.data] : [];
  });
  const methods = messages.map((message) => message.method);
  const named = messages
    .map(
      (message) =>
        message.params?.clientInfo || message.params?._meta?.["io.modelcontextprotocol/clientInfo"],
    )
    .find(Boolean);
  return {
    client: named ? { name: named.name, version: named.version } : {},
    instructions: methods.some((method) => method === "initialize" || method === "server/discover"),
    tools: methods.some((method) => method.startsWith("tools/")),
    skills: methods.some(
      (method) => method.startsWith("skills/") || method.startsWith("resources/"),
    ),
  };
}
