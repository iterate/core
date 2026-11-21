import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { contextAt, type Caller } from "core-itx";
import { bytesToBase64, errorCode } from "iterate/lib";
import { stampedCallerOf } from "iterate/principal";
import { z } from "zod";

// A caller without a stamp came in past the boundary (a home lab's local port).
export async function serveMcp(
  request: Request,
  readSignedFile: ReadSignedFile,
): Promise<Response> {
  const caller = stampedCallerOf(request);
  if (!caller.principal) return new Response("Sign in\n", { status: 401 });
  return mcpResponse(request, caller, readSignedFile);
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

function buildServer(
  caller: Caller,
  instructed: boolean,
  readSignedFile: ReadSignedFile,
): McpServer {
  const mcpServer = new McpServer(
    { name: "iterate-mind", version: "0.1.0" },
    instructed ? { instructions: runInstructions } : {},
  );

  mcpServer.registerTool(
    "run",
    {
      title: "Run a script",
      description: runDescription,
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

/** Stateless: `createMcpHandler` builds a server per HTTP request. */
async function mcpResponse(request: Request, caller: Caller, readSignedFile: ReadSignedFile) {
  const instructed = await answersWithInstructions(request);
  return createMcpHandler(
    () => buildServer(caller, instructed, readSignedFile),
    // A `run` can last ten minutes, and Claude Code gives up on a POST whose headers take 60 seconds.
    // "sse" sends the headers at once and a keep-alive every 15 seconds.
    { responseMode: "sse" },
  ).fetch(request);
}

/** The SDK's `Server._oninitialize` and `_ondiscover` (@modelcontextprotocol/server 2.0.0). */
const InstructedRequest = z.object({ method: z.enum(["initialize", "server/discover"]) });

/** Read from a copy, so the SDK reads and refuses the body as it always does. */
async function answersWithInstructions(request: Request) {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  return [body].flat().some((message) => InstructedRequest.safeParse(message).success);
}
