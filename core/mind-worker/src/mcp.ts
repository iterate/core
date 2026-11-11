import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { contextAt, type Caller } from "core-itx";
import { errorCode } from "iterate/lib";
import { stampedCallerOf } from "iterate/principal";
import { z } from "zod";

// A caller without a stamp came in past the boundary (a home lab's local port).
export async function serveMcp(request: Request): Promise<Response> {
  const caller = stampedCallerOf(request);
  if (!caller.principal) return new Response("Sign in\n", { status: 401 });
  return mcpResponse(request, caller);
}

const runInstructions =
  "One tool, `run({ script })`, runs a script of yours against this iterate mind. Its description is the guide: how to inspect the mind, change its code and read the platform's source.";

const runDescription = [
  "Evaluate a JavaScript function, `async (itx) => { ... }`, with the mind's root `itx` handle at `/`. Each call runs the complete script in a worker, for at most ten minutes: await every operation and return a JSON-serializable result. No variable survives a call, so carry state in returned results or in the mind. Every call and its settlement are logged at `/` with your principal and grant, and what your script writes carries them too.",
  'Start by reading who this context is, the mind\'s URL, and every capability with its description:\n```json\n{"script": "async (itx) => ({ context: await itx.whoami(), url: await itx.url(), capabilities: (await itx.rewriteRules.list()).map((rule) => [rule.match, rule.description]) })"}\n```',
  '`itx.cd("/path")` addresses another context of this mind.',
  'The mind\'s code is the config repo, `itx.repos.get("/repos/config")`: `listFiles()` and `readFile(path)` read it. Its `AGENTS.md` is the guide to this mind\'s code: read it before you change a file. `package.json` names the main module in `"main"` (`worker.ts`); its default export is a class that extends `IterateConfigEntrypoint` from `iterate/sdk`, and publication refuses any other. Files may be TypeScript (types are stripped, not checked) or JavaScript and import each other by relative path. `iterate/*` and `zod` come from the platform; any other package is listed in `package.json` `dependencies` and fetched from npm through esm.sh (a package that needs Node.js builtins is refused).',
  "A commit to the config repo publishes the mind a few seconds after it lands. `commitFiles({ message, changes, parent })` takes the whole new content of each changed file (`{ path, content }`, or `{ path, delete: true }`). There is no patch operation: change the text inside your script, and the file never has to pass through your context. Pass the tip you read as `parent`, so the commit is refused if main moved meanwhile. The commit is authored by you unless it names an `author`; end its message with `Via: <your name>` so it says which agent did the work. Every commit gets one outcome event on `/`, `worker-updated` or `worker-update-failed`, and a failure's `payload.error` says why the commit is not live.",
  "Change a file and wait for its outcome (this writes to the repo; replace the path and the text with your edit):\n```json\n{\"script\": \"async (itx) => { const repo = itx.repos.get('/repos/config'); const tip = await repo.tip(); const source = await repo.readFile('worker.ts', { commitOid: tip }); const next = source.replace('Homepage of mind ', 'Welcome to '); if (next === source) throw new Error('the homepage text is not in worker.ts'); const { commitOid } = await repo.commitFiles({ message: 'Change the homepage greeting\\\\n\\\\nVia: Claude Code', parent: tip, changes: [{ path: 'worker.ts', content: next }] }); const outcome = await itx.waitForEvent({ type: ['events.iterate.com/mind/worker-updated', 'events.iterate.com/mind/worker-update-failed'], payload: { commitOid }, afterOffset: 0, timeoutMs: 120000 }); if (outcome.payload.error) throw new Error(outcome.payload.error); return { commitOid, outcome: outcome.type }; }\"}\n```",
  'After `worker-updated` the site serves the commit within 5 seconds: fetch `await itx.url()`, the mind\'s apex, with `itx.fetch` and check the page before you report success. To try a change with no commit, run the candidate as a worker: `(await itx.workers.get({ source: { ...(await itx.repos.get("/repos/config").files()), "worker.ts": candidateSource } }).fetch(new Request(await itx.url()))).text()`, the repo\'s files under their repo paths with your edits over them.',
  "The source code for all of this is public at https://github.com/iterate/core: read it before you guess how anything here works. List the files first: https://data.jsdelivr.com/v1/packages/gh/iterate/core@main?structure=flat (`files[].name`, each a path with a leading `/`; the list can be hours behind). GitHub's own list, https://api.github.com/repos/iterate/core/git/trees/main?recursive=1 (`tree[].path`), is exact, but GitHub allows 60 listings an hour to everyone behind one address, so through this tool it often answers 403. Then read `core/AGENTS.md`, then the file you need at `https://raw.githubusercontent.com/iterate/core/main/<path>`. To find where something is implemented, fetch the likely files in one script, search their text there, and return only the lines that match. `main` can differ from the code this mind runs: where they disagree, what a call answers is right. Through this tool: `async (itx) => (await itx.fetch(new Request(url))).text()`.",
].join("\n\n");

const validator = new CfWorkerJsonSchemaValidator();

function buildServer(caller: Caller, instructed: boolean): McpServer {
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
        // a round trip drops what JSON cannot carry and throws on what it refuses
        const json = JSON.stringify(value) ?? "null";
        return {
          content: [{ type: "text" as const, text: json }],
          isError: false,
          structuredContent: { result: JSON.parse(json) as unknown },
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
async function mcpResponse(request: Request, caller: Caller) {
  const instructed = await answersWithInstructions(request);
  return createMcpHandler(
    () => buildServer(caller, instructed),
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
