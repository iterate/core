// app.ts — THE MIND'S OWN MCP SERVER, as worker.ts mounts it on mcp.<domain> (server.ts is
// the server).
//
// THE TEXTS A CLIENT'S MODEL READS are right below (`MCP_INSTRUCTIONS`, `MCP_RUN_DESCRIPTION`):
// change them here, or pass your own `{ instructions, runDescription }` to `mcpApp(...)` in
// worker.ts.
//
// WHO ASKS is the platform's stamp alone. `open` answers `/.well-known/iterate-app` with
// `for: "members"` so the sign-in page opens on the passkey and shows the mind's icon. No other
// guard runs before `fetch`: the server answers its own 401 with RFC 9728's `resource_metadata`,
// which `this.auth.require`'s challenge lacks.
//
// `run` AS THE MEMBER. `this.getItx()` is this worker's own reach, never the member's, so a
// script must not go through it. `host.auth.mcpRun(request, message)` hands the `tools/call` to
// the platform, which answers in this app's place as it runs `run` at its own /mcp, for the
// member the boundary stamped on the request it still holds. On a platform that lacks it,
// `runUnavailable` answers.
import type { AppDescription, IterateConfigEntrypoint } from "iterate/sdk";
import { openFile } from "../open-files.ts";
import { mcpAnswer, type McpRunMessage, runUnavailable } from "./server.ts";

/** What `initialize` answers to an MCP client. */
export const MCP_INSTRUCTIONS =
  "One tool, `run({ script })`, runs a script of yours against this iterate mind, as the member who signed you in. Its description is the guide: how to inspect the mind, change its code and read the platform's source.";

/** The description of the one tool, `run`, as an MCP client's model reads it. */
export const MCP_RUN_DESCRIPTION = [
  "Evaluate a JavaScript function, `async (itx) => { ... }`, with the mind's root `itx` handle at `/`. Each call runs the complete script in a worker, for at most ten minutes: await every operation and return a JSON-serializable result. No variable survives a call, so carry state in returned results or in the mind. Every call and its settlement are logged at `/` with your principal and grant, and what your script writes carries them too.",
  'Start by reading who this context is, the mind\'s URL, and every capability with its description:\n```json\n{"script": "async (itx) => ({ context: await itx.whoami(), url: await itx.url(), capabilities: (await itx.rewriteRules.list()).map((rule) => [rule.match, rule.description]) })"}\n```',
  '`itx.cd("/path")` addresses another context of this mind.',
  'A result is JSON, and JSON is text to you. To SEE image files of the mind (`itx.files`), return their paths under the key `"itx/images"`: `return { note: "the page", "itx/images": ["/shots/page.png"] }`. Each arrives as an image beside the result: PNG, JPEG, GIF or WebP, at most 8 files and 5 MiB in all. `"itx/images-left-out"` in the result says which files did not come, and why.',
  'The mind\'s code is the config repo, `itx.repos.get("/repos/config")`: `listFiles()` and `readFile(path)` read it. Its `AGENTS.md` is the guide to this mind\'s code: read it before you change a file. `package.json` names the main module in `"main"` (`worker.ts`); its default export is a class that extends `IterateConfigEntrypoint` from `iterate/sdk`, and publication refuses any other. Files may be TypeScript (types are stripped, not checked) or JavaScript and import each other by relative path. `iterate/*` and `zod` come from the platform; any other package is listed in `package.json` `dependencies` and fetched from npm through esm.sh (a package that needs Node.js builtins is refused).',
  "A commit to the config repo publishes the mind a few seconds after it lands. `commitFiles({ message, changes, parent })` takes the whole new content of each changed file (`{ path, content }`, or `{ path, delete: true }`). There is no patch operation: change the text inside your script, and the file never has to pass through your context. Pass the tip you read as `parent`, so the commit is refused if main moved meanwhile. The commit is authored by you unless it names an `author`; end its message with `Via: <your name>` so it says which agent did the work. Every commit gets one outcome event on `/`, `worker-updated` or `worker-update-failed`, and a failure's `payload.error` says why the commit is not live.",
  "Change a file and wait for its outcome (this writes to the repo; replace the path and the text with your edit):\n```json\n{\"script\": \"async (itx) => { const repo = itx.repos.get('/repos/config'); const tip = await repo.tip(); const source = await repo.readFile('worker.ts', { commitOid: tip }); const next = source.replace('Homepage of mind ', 'Welcome to '); if (next === source) throw new Error('the homepage text is not in worker.ts'); const { commitOid } = await repo.commitFiles({ message: 'Change the homepage greeting\\\\n\\\\nVia: Claude Code', parent: tip, changes: [{ path: 'worker.ts', content: next }] }); const outcome = await itx.waitForEvent({ type: ['events.iterate.com/mind/worker-updated', 'events.iterate.com/mind/worker-update-failed'], payload: { commitOid }, afterOffset: 0, timeoutMs: 120000 }); if (outcome.payload.error) throw new Error(outcome.payload.error); return { commitOid, outcome: outcome.type }; }\"}\n```",
  'After `worker-updated` the site serves the commit within 5 seconds: fetch `await itx.url()`, the mind\'s apex, with `itx.fetch` and check the page before you report success. To try a change with no commit, run the candidate as a worker: `(await itx.workers.get({ source: { ...(await itx.repos.get("/repos/config").files()), "worker.ts": candidateSource } }).fetch(new Request(await itx.url()))).text()`, the repo\'s files under their repo paths with your edits over them.',
  'The source code for all of this is mirrored inside this mind at `/repos/github.com/iterate/core` (from https://github.com/iterate/core, synced daily): read it before you guess how anything here works. List files with `await itx.repos.get("/repos/github.com/iterate/core").listFiles()`, read `core/AGENTS.md` or any file with `.readFile(path)`, and call `.pull()` to refresh it. If that repo is not populated yet, fall back to https://data.jsdelivr.com/v1/packages/gh/iterate/core@main?structure=flat and `https://raw.githubusercontent.com/iterate/core/main/<path>`. `main` can differ from the code this mind runs: where they disagree, what a call answers is right.',
].join("\n\n");

/** WHAT THE MCP HOST SAYS OF ITSELF: for members alone, so its sign-in page opens on the passkey
 *  and shows the mind's icon (../open-files.ts answers it to anyone). */
const MCP: AppDescription = { name: "MCP", icon: "/icon.svg", for: "members" };

/** `instructions`: what `initialize` answers. `runDescription`: the description of the tool
 *  `run`. Both go to the client as they are. */
export function mcpApp(
  guidance: { instructions: string; runDescription: string } = {
    instructions: MCP_INSTRUCTIONS,
    runDescription: MCP_RUN_DESCRIPTION,
  },
) {
  return {
    /** The app's description and icon, for anyone: worker.ts asks this before `fetch`. */
    open: (request: Request) => openFile(request, MCP),
    async fetch(request: Request, host: Pick<IterateConfigEntrypoint, "auth">) {
      // a write from another site: the platform's own refusal
      const refused = host.auth.require(request);
      if (refused?.status === 403) return refused;
      const controlPlaneHostname = () => host.auth.controlPlaneHostname(request);
      return mcpAnswer(request, {
        // a member is a principal with no `kind`; another mind is no member
        caller: !refused ? "member" : host.auth.person(request) ? "non-member" : "anonymous",
        controlPlaneHostname,
        guidance,
        runAsMember: (message: McpRunMessage) =>
          typeof host.auth.mcpRun === "function"
            ? host.auth.mcpRun(request, message)
            : runUnavailable(controlPlaneHostname)(message),
      });
    },
  };
}
