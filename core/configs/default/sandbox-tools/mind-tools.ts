// sandbox-tools/mind-tools.ts — THE MIND TOOLS of an agent that runs in a sandbox of its own: an
// MCP server (Streamable HTTP, JSON answers, no sessions) that the kind's worker mounts on a host
// of its choosing, and that each session is told of when it opens. For ACP's sessions
// (../acp-sandbox/worker.ts) and the Claude kind's (claude-sandbox/worker.ts in
// internal-packages/claude-code-bridge): each hands in what is its own, a `SandboxKind`. Two
// tools, as that first opencode bridge had them (../acp-sandbox/runner.ts):
//
//   - `run`: a script against the mind, `async (itx) => { … }`, like iterate's own MCP `run`. It
//     runs AT THE SESSION'S OWN CONTEXT, so the run and how it settled are on the session's log,
//     and it is handed the mind's root `itx`.
//   - `commit`: files of the session's working folder (its clone of the config repo, ./clone.ts)
//     to /repos/config's main, which publishes the mind. The parent is the commit the folder is
//     at, so nothing is written over a main that moved. Then the publication's outcome, and the
//     folder brought to the new commit. The kind's `committedType` on the session's log says it.
//
// WHO GETS IN: a request carries the session's own key in the kind's header, and the kind says
// whether it is that session's (`isSessionKey`).
// WHAT THAT KEY NOW OPENS: with these tools a session's key can run any script as the mind's code
// and change the mind's config. That is the point of them: an agent that works on the mind. A
// mind that wants its sandboxes kept to their own session turns them off (`mindTools: false`, as
// the kind's worker hands it in): sessions are then told of no server, and this one refuses.
//
// This folder imports nothing of a kind: only the platform's types, and its own files. Not
// Workers-only (no WebSocketPair), so the tests run it under Node.
import type { IterateContextApi } from "iterate/api";
import { CONFIG_REPO, repoAccess } from "./clone.ts";

/** WHAT IS A KIND'S OWN about its sandbox sessions. */
export type SandboxKind = {
  /** What a session's path looks like: no other is served. */
  sessionPath: RegExp;
  /** The request header that carries the session's key. */
  header: string;
  /** Whether `key` is that session's own (session-key.ts). */
  isSessionKey(
    itx: Pick<IterateContextApi, "secrets" | "sandboxes">,
    session: string,
    key: string | null,
  ): Promise<boolean>;
  /** The session's sandbox. */
  boxOf(session: string): string;
  /** The session's working folder in that sandbox: its clone of the config repo. */
  workOf(session: string): string;
  /** The event a commit lands on the session's log:
   *  `{ commitOid, paths, published, error? }`. */
  committedType: string;
  /** How a commit's own trailer names the session: "ACP session". */
  label: string;
};

type Sandbox = ReturnType<IterateContextApi["sandboxes"]["get"]>;

/** How long a publication is waited for. */
const PUBLISHED_WITHIN_MS = 120_000;
/** The most of a tool's answer an agent is handed. */
const ANSWER_CHARACTERS = 100_000;

/** The tools, as `tools/list` describes them to the agent. */
const TOOLS = [
  {
    name: "run",
    description:
      "Run a JavaScript function, `async (itx) => { ... }`, as code of this iterate mind, with the mind's root `itx` " +
      "(the same as iterate's own MCP `run`): read /repos/config (`itx.repos.get('/repos/config')`), read events " +
      "(`itx.cd(path).readEvents`), wait for an event (`itx.waitForEvent`), fetch through the mind's egress (`itx.fetch`), " +
      "list capabilities (`itx.rewriteRules.list()`). Return a JSON-serializable value. At most ten minutes. " +
      "The run is recorded on your own session's log.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "The text of `async (itx) => { ... }`." },
      },
      required: ["script"],
    },
  },
  {
    name: "commit",
    description:
      "Commit files of your working folder (a clone of the mind's config repo, /repos/config) to that repo's main, which " +
      "publishes the mind, then wait for the publication (up to two minutes) and bring your folder to the new commit. " +
      "Each path is repo-relative; a path missing from your folder is deleted. Text files only. The parent is your folder's " +
      "commit, so if main moved meanwhile nothing is committed and you are told how to catch up. " +
      "Do not `git commit` or `git push` yourself: your clone has no credentials.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The commit message: a subject line, a blank line, why.",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths of the files to commit.",
        },
      },
      required: ["message", "paths"],
    },
  },
];

/** `value` as a record of its own fields; an empty one for anything that is no object. What comes
 *  in here is JSON a sandbox sent: each field is then asked for its type where it is used. */
function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object") return {};
  // `null` is an object to `typeof`
  return Object.fromEntries(Object.entries(value || {}));
}

/** A path of a file in the repo, as `commit` takes it: relative, staying inside the repo, on one
 *  line. */
const isRepoPath = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[^/]/.test(value) &&
  !value.includes("\n") &&
  !value.split("/").includes("..");

/** A request to the server, wherever the kind's worker mounted it: one JSON-RPC message of MCP's
 *  Streamable HTTP transport, answered as JSON. The session is the `session` of the request's
 *  query. `mindTools: false` is the mind's own no. */
export async function serveMcp(
  request: Request,
  getItx: () => IterateContextApi & Disposable,
  kind: SandboxKind,
  options: { mindTools?: boolean },
): Promise<Response> {
  const session = new URL(request.url).searchParams.get("session") || "";
  if (!kind.sessionPath.test(session)) return refusal(400, "no session");
  {
    using itx = getItx();
    if (!(await kind.isSessionKey(itx, session, request.headers.get(kind.header))))
      return refusal(401, "not this session's sandbox");
  }
  if (options.mindTools === false)
    return refusal(404, "this mind gives these sandboxes no mind tools");
  // no server-to-client stream: the client is told so, and posts
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  const message = recordOf(await request.json().catch(() => null));
  const { id, method } = message;
  const params = recordOf(message.params);
  if (typeof method !== "string")
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "not a JSON-RPC message" } },
      { status: 400 },
    );
  // a notification (`notifications/initialized`) has no id, and is answered with nothing
  if (typeof id !== "string" && typeof id !== "number") return new Response(null, { status: 202 });
  const answer = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
  if (method === "initialize")
    return answer({
      protocolVersion:
        typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "iterate-mind", version: "1" },
    });
  if (method === "ping") return answer({});
  if (method === "tools/list") return answer({ tools: TOOLS });
  if (method === "tools/call") {
    const { name } = params;
    const input = recordOf(params.arguments);
    using itx = getItx();
    try {
      if (name !== "run" && name !== "commit") throw new Error(`no tool ${String(name)}`);
      const result =
        name === "run" ? await run(itx, session, input) : await commit(itx, kind, session, input);
      return answer({ content: [{ type: "text", text: textOf(result) }] });
    } catch (error) {
      return answer({
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      });
    }
  }
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `no method ${method}` },
  });
}

/** The `run` tool: the agent's function, at the session's own context (its log gets
 *  `itx/run-requested` and how it settled), handed the mind's root. A context under /agents has
 *  no rule for `itx.repos` and the rest; the root has them. */
async function run(itx: IterateContextApi, session: string, input: Record<string, unknown>) {
  if (typeof input.script !== "string" || !input.script.trim())
    throw new Error("run needs `script`, the text of `async (itx) => { ... }`");
  // the function as an expression: one written as a statement ends in a semicolon
  const theirs = input.script.trim().replace(/;+$/, "");
  return await itx.cd(session).run(`async (itx) => (${theirs})(itx.cd("/"))`);
}

/** The `commit` tool: the files as they are in the session's folder, over the commit the folder
 *  forked from, then the publication's outcome. The folder is then reset (not hard) to the new
 *  commit: the files it committed match, and anything else in progress stays as it was. */
async function commit(
  itx: IterateContextApi,
  kind: SandboxKind,
  session: string,
  input: Record<string, unknown>,
) {
  const { message } = input;
  if (typeof message !== "string" || !message.trim()) throw new Error("a commit needs a message");
  const asked = Array.isArray(input.paths) ? input.paths : [];
  const paths = asked.filter(isRepoPath);
  if (paths.length === 0 || paths.length !== asked.length)
    throw new Error("paths must be repo-relative paths, at least one");
  const folder = kind.workOf(session);
  const box = itx.sandboxes.get(kind.boxOf(session));
  // the commit the folder forked from: what it has of main's history
  const parent = (
    await sh(box, "mind-tools-fork-point", 'git -C "$DIR" merge-base HEAD origin/main', {
      DIR: folder,
    })
  ).trim();
  // A FILE IS DELETED FROM THE MIND'S REPO ONLY ON THE SANDBOX'S OWN WORD THAT IT IS NOT THERE:
  // one line for each path, "here" or "gone". A question that got no answer (a call that timed
  // out or dropped), or an answer that leaves a path out, commits nothing. To take "no answer"
  // for "no file" would delete that file from the mind's config, and publish the deletion.
  const said = await sh(box, "mind-tools-paths", PATHS_SCRIPT, {
    DIR: folder,
    PATHS: paths.join("\n"),
  });
  const there = new Map(
    said
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(5), line.slice(0, 4)]),
  );
  const changes: ({ path: string; content: string } | { path: string; delete: true })[] = [];
  for (const path of paths) {
    const word = there.get(path);
    if (word !== "here" && word !== "gone")
      throw new Error(
        `the sandbox did not say whether ${path} is in your folder: nothing was committed`,
      );
    changes.push(
      word === "here"
        ? { path, content: await new Response(await box.files.read(`${folder}/${path}`)).text() }
        : { path, delete: true },
    );
  }
  const repo = itx.repos.get(CONFIG_REPO);
  const tip = await repo.tip();
  if (tip !== parent) {
    // the folder has no credentials of its own: main's new commits are fetched for it here
    const fetched = await fetchMain(itx, box, folder).then(
      () => true,
      () => false,
    );
    throw new Error(
      `main has moved past your folder's ${parent.slice(0, 7)} (it is at ${String(tip).slice(0, 7)}), so nothing was committed. ` +
        (fetched
          ? `Its new commits are fetched into your clone. Catch up and commit again: \`git stash && git merge --ff-only origin/main && git stash pop\`, then check that your change still makes sense.`
          : `Its new commits could not be fetched into your clone just now: call commit again in a moment.`),
    );
  }
  const { commitOid, changedPaths } = await repo.commitFiles({
    message: `${message.trim()}\n\nVia: ${kind.label} ${session}`,
    parent,
    changes,
  });
  // files that are as main has them make no commit: the repo answers main's own tip then, with
  // no changed path. That tip is not this session's commit, so nothing is waited for or recorded.
  if (!commitOid || changedPaths.length === 0)
    return { committed: false, why: "the files are as main has them already" };
  const outcome = await itx
    .waitForEvent({
      type: [
        "events.iterate.com/mind/worker-updated",
        "events.iterate.com/mind/worker-update-failed",
      ],
      payload: { commitOid },
      afterOffset: 0,
      timeoutMs: PUBLISHED_WITHIN_MS,
    })
    .catch(() => null);
  const published = outcome?.type === "events.iterate.com/mind/worker-updated";
  const error = published
    ? undefined
    : outcome
      ? String(Object(outcome.payload).error)
      : "no outcome in two minutes";
  // on the session's log: what this session did to the mind
  await itx.cd(session).append({
    type: kind.committedType,
    idempotencyKey: `${kind.committedType}:${commitOid}`,
    payload: { commitOid, paths, published, error },
  });
  const caughtUp = await fetchMain(itx, box, folder, commitOid).then(
    () => true,
    () => false,
  );
  return {
    commitOid,
    published,
    error,
    folder: caughtUp
      ? `at ${commitOid.slice(0, 7)}`
      : `still at ${parent.slice(0, 7)} with your changes uncommitted there: the new commit could not be fetched just now. Your next commit fetches it.`,
  };
}

/** Main's commits into the folder's clone, with a token made for this one fetch (the clone keeps
 *  none: ./clone.ts CLONE_SCRIPT). With `oid`, the folder's HEAD and index then go to that commit,
 *  its files left as they are. */
async function fetchMain(itx: IterateContextApi, box: Sandbox, folder: string, oid = "") {
  const { token } = await repoAccess(itx);
  await sh(box, "mind-tools-fetch", FETCH_SCRIPT, { DIR: folder, TOKEN: token, OID: oid });
}

/** For each line of `$PATHS`: `here <path>` when it is in `$DIR` (a link too), else `gone <path>`. */
export const PATHS_SCRIPT = String.raw`
cd "$DIR" || exit 1
while IFS= read -r path; do
  if [ -e "$path" ] || [ -L "$path" ]; then printf 'here %s\n' "$path"; else printf 'gone %s\n' "$path"; fi
done <<PATHS_END
$PATHS
PATHS_END
`;

const FETCH_SCRIPT = String.raw`
auth=$(printf 'x:%s' "$TOKEN" | base64 | tr -d '\n')
git -C "$DIR" -c "http.extraHeader=Authorization: Basic $auth" -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 fetch -q origin || exit 1
[ -z "$OID" ] || git -C "$DIR" reset -q "$OID"
`;

/** A short script in the sandbox: what it printed, or what it said when it failed. */
async function sh(box: Sandbox, name: string, script: string, env: Record<string, string>) {
  const { exitCode, stdout, stderr } = await box.exec(["bash", "-s", "--", name], {
    stdin: script,
    env,
    timeoutMs: 45_000,
  });
  if (exitCode !== 0)
    throw new Error(
      `${`${decode(stdout)}${decode(stderr)}`.trim().slice(-800)} (exit ${String(exitCode)})`,
    );
  return decode(stdout);
}

/** A tool's answer as the text an agent reads. */
function textOf(result: unknown) {
  if (result === undefined) return "(undefined)";
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return text.length > ANSWER_CHARACTERS ? `${text.slice(0, ANSWER_CHARACTERS)}…` : text;
}

const refusal = (status: number, message: string) =>
  Response.json({ error: { message } }, { status });
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
