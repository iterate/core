// acp-sandbox/runner.ts — THE SANDBOX RUNNER, `itx.acp.sandbox`: the worker's side. Each ACP session
// (agent-kinds/acp.ts) whose start request names `acp.sandbox` runs in a sandbox of its own, at
// `<session>/box`, where a host process (src/sandbox-host.ts, bundled into host.generated.ts) runs
// the agent. Copy this folder, ../sandbox-tools/, ../acp-sandbox.ts and ../agent-kinds/acp.ts into
// a mind's config repo, and in its worker.ts add `acpSandbox()` (worker.ts here) to `integrations` and the kind to
// `agentKinds`.
//
// Modelled on an opencode bridge that a mind's own config had first (its sandbox and its bridge):
//   - IN: the session's delivery row calls `deliverEvent` (../acp-sandbox.ts). It posts the event to
//     the host's port (`getTcpPort` + `fetch`, which starts nothing). When nothing answers there (a
//     new session, or a sandbox that parked): the sandbox created, started from its last saved disk,
//     the host's file written and the host started under a lock (START_SCRIPT), and the event posted
//     again. Each step accepts its own earlier success, so a delivery that runs past its 20 s is
//     tried again by the platform and finds it done.
//   - OUT: the host's WebSocket to this mind's `acp-sandbox` host (worker.ts): appends to its
//     session and reads of its log, as the session's own code. In the sandbox there is no iterate
//     token: the handshake carries the session's own key, of two parts
//     (../sandbox-tools/session-key.ts): a signature of the session's path, a plain value, and a
//     placeholder of a secret pinned to that host, which the sandbox's egress fills in.
//   - AWAKE: while the host says it is busy, the socket runs a command in the sandbox at most once a
//     minute, so it isn't parked under a turn. A sandbox with nothing running parks after five idle
//     minutes, its disk saved; the next message wakes it, and the host loads the session again.
//   - KEYS: the agents' keys are placeholders in the host's environment (`getSecret("/secrets/openai")`
//     and `/secrets/anthropic`), each pinned to its provider's origin: no key is on the sandbox.
//     Claude takes a plan's login in place of the key when the mind has `/secrets/claude-current`;
//     the OpenAI agents take a ChatGPT plan's token (`/secrets/chatgpt`) when the mind has one,
//     before its `/secrets/openai`.
//   - THE WORKING FOLDER of a new session is a clone of the mind's config repo
//     (../sandbox-tools/clone.ts): the start script clones it before the host starts, with a
//     token that reads that repo for minutes and is in no file and no process after.
//   - THE MIND TOOLS: each session is told of an MCP server on the same host, with `run` and
//     `commit` (../sandbox-tools/mind-tools.ts), unless the mind's worker.ts turns them off.
//   - PROGRESS: a copy row on the sandbox's context (`progressRow`) puts its creation, each start
//     and each run of the start script on the session, where the chat lists them under "Starting …".
import type { IterateContextApi } from "iterate/api";
import { ACP, SESSION_PATH } from "../agent-kinds/acp.ts";
import { CLONE_SCRIPT, cloneEnv } from "../sandbox-tools/clone.ts";
import {
  ensureSecrets,
  isSessionKey as isKey,
  sessionKeyFor,
  type SessionKeys,
} from "../sandbox-tools/session-key.ts";
import type { SandboxKind } from "../sandbox-tools/mind-tools.ts";
import { HOST_SCRIPT, HOST_VERSION } from "./host.generated.ts";

/** The runner's name: the delivery row's target is `itx.acp.sandbox.deliverEvent`. */
const RUNNER = "acp.sandbox";
/** The mind's host the sandbox's socket reaches: `acp-sandbox.<domain>`. */
export const SLUG = "acp-sandbox";
const KEYS: SessionKeys = {
  signing: "/secrets/acp-sandbox",
  egress: "/secrets/acp-sandbox-egress",
};
/** Not `Authorization`: the platform's edge takes any bearer on a mind's host for an iterate
 *  token, and refuses one it doesn't know (opencode/bridge.ts found this). */
export const HEADER = "x-acp-sandbox";
/** The host's port in the sandbox. */
const PORT = 4100;
/** Where the host keeps its files and log. Sessions get their folders in WORKSPACES: on the disk,
 *  so a session's folder and the agent's own record of it are there when the sandbox wakes. */
const HOST_DIR = "/work/acp-host";
const WORKSPACES = "/work/acp";
/** Where the worker's own word about the mind tools is kept for the runner (`install` writes it
 *  on every publish, `hostEnv` reads it): "off" when the mind's worker.ts says
 *  `acpSandbox({ mindTools: false })`. The runner is another Worker than worker.ts (a rule loads
 *  ../acp-sandbox.ts), so it cannot read that option itself. */
const MIND_TOOLS_KEY = "acp-sandbox/mind-tools";
/** How long a command may run: a call to the sandbox past a minute is cut off, so well under. */
const EXEC_TIMEOUT_MS = 45_000;
/** How long the start script waits for the host before it answers NOT_YET. */
const SCRIPT_SECONDS = 30;
/** The start script's exit when it ran out of time, or another start held the lock. */
const NOT_YET = 75;
/** How often a busy host keeps its sandbox awake: a minute, well inside the five a sandbox idles. */
export const AWAKE_EVERY_MS = 60_000;

/** A session's sandbox. Its path follows from the session's, so nothing has to look it up. */
export const boxOf = (session: string) => `${session}/box`;

/** A busy session's sandbox is kept from parking: a command is a use of it (the socket's `busy`,
 *  worker.ts). The scope is this call's own and is held until the command has settled: a scope
 *  that ends under a pending call releases the call with it, and the command then never lands. It
 *  never rejects: a sandbox that does not answer is one line in the log, and the next `busy` asks
 *  again. */
export async function keepAwake(
  getItx: () => Pick<IterateContextApi, "sandboxes"> & Disposable,
  session: string,
) {
  try {
    using itx = getItx();
    await itx.sandboxes.get(boxOf(session)).exec(["true"], { timeoutMs: 10_000 });
  } catch (error) {
    console.warn(
      `acp-sandbox: keeping ${session} awake: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** A session's working folder in its sandbox: `<workspaces>/<session id>/work`, where the host's
 *  runner starts the agent (src/runner.ts `open`; a test holds the two to each other). */
export const workOf = (session: string, workspaces = WORKSPACES) =>
  `${workspaces}/${session.split("/").at(-1)}/work`;

type Event = { type: string; path: string; offset: number; payload?: unknown };

/** The delivery row's target: `event` to its session's host, the sandbox woken first if it has to be.
 *  What the host throws is thrown again, so the row asks again on its ladder. */
export async function deliverEvent(itx: IterateContextApi, event: Event) {
  if (!SESSION_PATH.test(String(event?.path))) return { delivered: false };
  const answer = await post(itx, event).catch(async (error: unknown) => {
    // The start request and the first message arrive together, and neither finds a host. The
    // start request's delivery starts it; anything else for a session that hasn't started yet
    // waits for that host rather than start a second one. Once a session has started, no host
    // means a parked sandbox, which any event wakes.
    if (event.type !== ACP.sessionStartRequested && !(await hasStarted(itx, event.path)))
      return await postOnceUp(itx, event, error);
    const why = error instanceof Error ? error.message : String(error);
    console.warn(`acp-sandbox: waking ${event.path}'s sandbox: ${why}`);
    await wake(itx, event.path);
    return await post(itx, event);
  });
  const body = (await answer.json()) as { error?: { message: string; code?: string } };
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
  return body;
}

/** Start a session of `agent` on this runner: its path, where to message it. `model`: one of the
 *  agent's own (agent-kinds/acp.ts `MODELS`), which the host holds the start to; none: its first. */
export async function start(itx: IterateContextApi, agent: string, model?: string) {
  const path = `/agents/acp/${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  await itx.cd(path).append({
    type: ACP.sessionStartRequested,
    payload: { agent, runner: RUNNER, model },
  });
  return { path };
}

/** Whether the session's log has its `session-started`: a host ran it once. */
async function hasStarted(itx: IterateContextApi, session: string) {
  return await itx
    .cd(session)
    .waitForEvent({ type: [ACP.sessionStarted], afterOffset: 0, timeoutMs: 1 })
    .then(
      () => true,
      () => false,
    );
}

/** How long a delivery waits for a host another delivery is starting: well inside its 20 s. After
 *  that it throws, and the row asks again on its ladder. */
const WAIT_FOR_HOST_MS = 15_000;

/** `post` again until the host answers, at most WAIT_FOR_HOST_MS; then the first failure. */
async function postOnceUp(itx: IterateContextApi, event: Event, first: unknown): Promise<Response> {
  const until = Date.now() + WAIT_FOR_HOST_MS;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const answer = await post(itx, event).catch(() => null);
    if (answer) return answer;
  }
  throw first;
}

/** The event to the host's port. Starts nothing: a parked sandbox, or no host, throws. */
async function post(itx: IterateContextApi, event: Event): Promise<Response> {
  const request = new Request("http://host/deliver", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  return (await itx.sandboxes.get(boxOf(event.path)).container.invoke([
    ["getTcpPort", PORT],
    ["fetch", request],
  ])) as Response;
}

/** The session's sandbox up, with its host answering at HOST_VERSION. */
async function wake(itx: IterateContextApi, session: string) {
  const path = boxOf(session);
  // a create after the first is a harmless fact (iterate's entity lifecycle)
  await itx.sandboxes.create(path);
  // its lifecycle onto the session, as it happens, for the chat's "Starting …" (keyed: once)
  const row = progressRow(session);
  await itx.cd(path).append({
    type: "events.iterate.com/itx/subscription-configured",
    idempotencyKey: `acp/row:${path}:${row.name}:v3`,
    payload: row,
  });
  const box = itx.sandboxes.get(path);
  // Its own disk when it has one; the platform's image when it's new. A session's sandbox may use
  // any secret of the mind that is pinned to the host it calls, as every sandbox may. A mind that
  // wants a narrower sandbox gives its context a rule for `itx.fetch` (the sandboxes' description).
  await box.start();
  const file = `${HOST_DIR}/host-${HOST_VERSION}.mjs`;
  const written = await box.files.stat(file).then(
    () => true,
    () => false,
  );
  if (!written) {
    await box.files.mkdir(HOST_DIR, { recursive: true });
    // written aside and renamed, so no start ever runs a file another is halfway through writing
    const aside = `${file}.${crypto.randomUUID().slice(0, 8)}`;
    await box.files.write(aside, HOST_SCRIPT);
    await box.files.rename(aside, file);
  }
  await startHost(itx, session, file);
}

/** A copy row on the sandbox's context: its creation, each start and each run of START_SCRIPT become
 *  `acp/runner-progressed` on the session, which the kind's chat lists under "Starting …". */
export function progressRow(session: string) {
  return {
    name: "acp-progress",
    consumes: [
      "events.iterate.com/sandbox/created",
      "events.iterate.com/sandbox/started",
      "events.iterate.com/sandbox/exec-started",
      "events.iterate.com/sandbox/exec-finished",
    ],
    // a command run is the start script's alone, not the keep-awake one
    filter: `$not($exists(payload.command)) or $contains(payload.command, "start-acp-host")`,
    afterOffset: 0,
    target: {
      path: session,
      type: ACP.runnerProgressed,
      payload: `{
        "step": $exists(payload.exitCode) ? "command-finished"
          : $exists(payload.command) ? "command-started"
          : $exists(payload.from) ? "sandbox-started"
          : "sandbox-created",
        "from": payload.from,
        "command": payload.command,
        "startedOffset": payload.startedOffset,
        "exitCode": payload.exitCode,
        "durationMs": payload.durationMs,
        "said": $exists(payload.exitCode) ? $substring($trim(payload.stdout & "\n" & payload.stderr), -1500)
      }`,
    },
  };
}

/** START_SCRIPT, run until the host answers, NOT_YET meaning "run me again". */
async function startHost(itx: IterateContextApi, session: string, file: string) {
  const box = itx.sandboxes.get(boxOf(session));
  // the clone's token is for the script alone, which unsets it before it starts the host
  const env = {
    ...(await hostEnv(itx, session, file)),
    ...(await cloneEnv(itx, { box: boxOf(session), into: workOf(session) })),
  };
  for (let attempt = 1; ; attempt++) {
    const { exitCode, stdout, stderr } = await box.exec(
      ["bash", "-s", "--", `start-acp-host-${HOST_VERSION}-${crypto.randomUUID().slice(0, 8)}`],
      { stdin: START_SCRIPT, env, timeoutMs: EXEC_TIMEOUT_MS },
    );
    if (exitCode === 0) return;
    const said = `${decode(stdout)}${decode(stderr)}`.trim().slice(-1500);
    if (exitCode !== NOT_YET || attempt === 3)
      throw new Error(`the sandbox's ACP host didn't start: ${said}`);
  }
}

/** A Claude plan's login that the mind's AI subscriptions app keeps current (its secret publisher,
 *  in iterate-config's apps/ai-subscriptions): when the mind has it, Claude signs in with it, as
 *  `claude` on a computer would, and not with the API key. */
const CLAUDE_PLAN_SECRET = "/secrets/claude-current";

/** A ChatGPT plan's token, from `iterate chatgpt connect`: a key OpenAI's Responses API takes. */
const CHATGPT_PLAN_SECRET = "/secrets/chatgpt";

/** The host's environment: where it listens, its way to the mind, and the agents' keys, every
 *  secret a placeholder the sandbox's egress fills in. */
async function hostEnv(
  itx: Pick<IterateContextApi, "url" | "secrets" | "kv">,
  session: string,
  file: string,
) {
  const secrets = await itx.secrets.list();
  const claudePlan = secrets.some((secret) => secret.path === CLAUDE_PLAN_SECRET);
  // A ChatGPT plan's token first (`iterate chatgpt connect`), which OpenAI's Responses API takes
  // as a key too, though not for every model; with no plan, the OpenAI API key. The order of the
  // mind's own agents (its `llm.apiKeys`): a plan is paid for already, a key bills each request.
  const chatgptPlan = secrets.some((secret) => secret.path === CHATGPT_PLAN_SECRET);
  const socket = await socketUrl(itx);
  // the mind tools' MCP server, on the same host, for the same session
  // (../sandbox-tools/mind-tools.ts): the
  // session is told of it unless the mind turned its mind tools off
  const mcp = new URL("/mcp", socket);
  mcp.searchParams.set("session", session);
  const mindTools = (await itx.kv.get(MIND_TOOLS_KEY)) !== "off";
  socket.protocol = socket.protocol.replace(/^http/, "ws");
  socket.searchParams.set("session", session);
  return {
    HOST_FILE: file,
    HOST_DIR,
    WITHIN: String(SCRIPT_SECONDS),
    ACP_SANDBOX_VERSION: HOST_VERSION,
    ACP_SANDBOX_PORT: String(PORT),
    ACP_SANDBOX_RUNNER: RUNNER,
    ACP_SANDBOX_WORKSPACES: WORKSPACES,
    ACP_SANDBOX_SOCKET: socket.href,
    ACP_SANDBOX_MCP: mindTools ? mcp.href : "",
    ACP_SANDBOX_HEADER: HEADER,
    // this session's own key: no use from outside the sandbox (../sandbox-tools/session-key.ts)
    ACP_SANDBOX_KEY: await sessionKeyFor(itx, KEYS, session),
    ...(chatgptPlan
      ? {
          OPENAI_API_KEY: `getSecret("${CHATGPT_PLAN_SECRET}", { field: "accessToken" })`,
          // the model iterate's own agents run on a plan's token (src/agents.ts `openaiModel`)
          ACP_OPENAI_MODEL: "gpt-6.1-sol",
        }
      : { OPENAI_API_KEY: 'getSecret("/secrets/openai")' }),
    // Claude Code prefers an API key to its OAuth token, so a plan's login comes without one.
    ...(claudePlan
      ? { CLAUDE_CODE_OAUTH_TOKEN: `getSecret("${CLAUDE_PLAN_SECRET}", { field: "accessToken" })` }
      : { ANTHROPIC_API_KEY: 'getSecret("/secrets/anthropic")' }),
    // the sandbox runs as root, where Claude's adapter offers bypassPermissions only with this
    IS_SANDBOX: "1",
  };
}

/** Under a lock, so one start runs at a time: a host answering at this version is left alone; one
 *  at another version is replaced unless it is busy (it finishes its turn, and the next start
 *  replaces it); none is started. Then wait for it to answer, at most $WITHIN seconds. */
const START_SCRIPT = String.raw`
mkdir -p "$HOST_DIR" "$ACP_SANDBOX_WORKSPACES"
exec 9>"$HOST_DIR/start.lock" || exit 1
flock -w "$((WITHIN - SECONDS))" 9 || { echo "another start of the host is still running"; exit 75; }
command -v node >/dev/null || { echo "this sandbox's image has no node, so the ACP host cannot run in it. The 'managed' image has none: set the stack's mind.sandboxImage to 'published'."; exit 1; }
# node, not curl, pkill or pgrep: a stack deployed without iterate's image has none of them
health() { node -e 'fetch("http://localhost:" + process.env.ACP_SANDBOX_PORT + "/health", { signal: AbortSignal.timeout(2000) }).then((r) => (r.ok ? r.text() : Promise.reject()), () => process.exit(1)).then((t) => process.stdout.write(t), () => process.exit(1))'; }
# a host's pids: /proc/<pid>/cmdline read into bash drops its NULs, so "node" and the file touch
hosts() ( cd /proc && for d in [0-9]*; do { c=$(<"$d/cmdline"); } 2>/dev/null; [[ "$c" == "node$HOST_DIR/host-"* ]] && echo "$d"; done )
# The tools agents expect (git, rg, ps, curl), on an image without them: installed once, onto the
# sandbox's disk, in the background (an exec is cut off after a minute), with NOT_YET meanwhile.
if ! command -v git >/dev/null || ! command -v rg >/dev/null; then
  mark="$HOST_DIR/tools.installing"
  if [ ! -e "$mark" ] || [ $(( $(date +%s) - $(stat -c %Y "$mark") )) -gt 300 ]; then
    touch "$mark"
    nohup bash -c 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git ripgrep procps curl ca-certificates; rm -f "$1"' _ "$mark" >>"$HOST_DIR/tools.log" 2>&1 9>&- </dev/null &
  fi
  echo "installing git, ripgrep, procps and curl (once per sandbox)"
  while [ -e "$mark" ] && [ "$SECONDS" -lt "$WITHIN" ]; do sleep 1; done
  command -v git >/dev/null || { tail -n 3 "$HOST_DIR/tools.log"; exit 75; }
fi
now=$(health)
case "$now" in
  *"\"version\":\"$ACP_SANDBOX_VERSION\""*) exit 0 ;;
  *'"busy":true'*) echo "an older host is at a turn: it stays until it isn't"; exit 0 ;;
esac
old=$(hosts); [ -n "$old" ] && kill $old
while [ -n "$(hosts)" ] && [ "$SECONDS" -lt "$WITHIN" ]; do sleep 0.2; done
${CLONE_SCRIPT}
cd "$ACP_SANDBOX_WORKSPACES"
nohup node "$HOST_FILE" >>"$HOST_DIR/host.log" 2>&1 9>&- </dev/null &
pid=$!
until health >/dev/null; do
  kill -0 "$pid" 2>/dev/null || { echo "the host stopped before it answered:"; tail -n 30 "$HOST_DIR/host.log"; exit 1; }
  [ "$SECONDS" -lt "$WITHIN" ] || { echo "the host is still starting"; exit 75; }
  sleep 0.3
done
`;

/** The socket's URL, as the sandbox reaches it: SLUG's host of the mind, `acp-sandbox.<domain>`,
 *  where worker.ts hands the request to this package (acp-sandbox/worker.ts). */
async function socketUrl(itx: Pick<IterateContextApi, "url">): Promise<URL> {
  return new URL(await itx.url({ routingSlug: SLUG, path: "/socket" }));
}

/** Whether `key` is `session`'s own, as `hostEnv` gave its sandbox and the egress sent it on, while
 *  that sandbox runs. Another session's key, a key sent from anywhere else, or none, is not. */
export async function isSessionKey(
  itx: Pick<IterateContextApi, "secrets" | "sandboxes">,
  session: string,
  key: string | null,
) {
  return await isKey(itx, KEYS, { session, box: boxOf(session), presented: key });
}

/** ACP'S OWN VALUES for the mind tools that every kind of sandbox session shares
 *  (../sandbox-tools/mind-tools.ts): what its sessions' paths look like, how a request shows the
 *  session's key, where a session's sandbox and working folder are, and what a commit is called
 *  on a session's log and in the commit itself. */
export const MIND_TOOLS_KIND: SandboxKind = {
  sessionPath: SESSION_PATH,
  header: HEADER,
  isSessionKey,
  boxOf,
  workOf,
  committedType: ACP.mindCommitted,
  label: "ACP session",
};

/** What a session's RUNNER says: the session's state, what the agent said, and a request for a
 *  permission. The other ACP events are the caller's: a start request, the answer to a permission
 *  request, a cancelled turn, an ended session. */
const RUNNER_TYPES = new Set<string>([
  ACP.sessionStarted,
  ACP.sessionStartFailed,
  ACP.updateFrame,
  ACP.updateReceived,
  ACP.turnEnded,
  ACP.permissionRequested,
  ACP.sessionEnded,
]);
/** An event a sandbox may not add to its session: anything but what its runner says. What runs in
 *  a sandbox must not answer its own permission request, nor start a session elsewhere. One
 *  answer is the runner's own: `cancelled`, for the requests still open when a turn is cancelled
 *  (src/runner.ts `cancelPermissions`). */
export function notARunnerEvent(event: { type?: unknown; payload?: unknown }) {
  const type = String(event?.type);
  if (RUNNER_TYPES.has(type)) return false;
  const outcome = Object(Object(event?.payload).outcome).outcome;
  return !(type === ACP.permissionSettled && outcome === "cancelled");
}

/** One line of at most 500 characters: what an agent's capability tree says of `itx.acp.sandbox`. */
const DESCRIPTION =
  "Coding agents over the Agent Client Protocol (claude, codex, opencode), each session in a sandbox of its own, as agents at /agents/acp/<id>. start(agent, model?) starts one and answers its path (model: haiku, sonnet or opus for claude; gpt-6.1-terra or gpt-6.1-sol for the others); message it with itx.agents.get(path).message(). deliverEvent(event) is each session's delivery row's target.";

/** The secret, the mind's word about the mind tools (`mindTools: false` is its no), and the rule
 *  that makes `itx.acp.sandbox` this config's ../acp-sandbox.ts. */
export async function install(itx: IterateContextApi, options: { mindTools?: boolean } = {}) {
  await ensureSecrets(itx, KEYS, (await socketUrl(itx)).origin);
  await itx.kv.put(MIND_TOOLS_KEY, options.mindTools === false ? "off" : "on");
  if ((await itx.rewriteRules.get(`itx.${RUNNER}`))?.description === DESCRIPTION) return;
  await itx.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: `itx.${RUNNER}`,
      target: [
        "itx",
        "workers",
        ["get", { mainModule: "acp-sandbox.ts", source: ["itx", ["cd", "/"], "config"] }],
      ],
      description: DESCRIPTION,
    },
  });
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
