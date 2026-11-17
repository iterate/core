// acp-sandbox/worker.ts — what the mind's worker hosts for the sandbox runner (runner.ts): the
// socket each session's host keeps to the mind, on the `acp-sandbox` host, the mind tools' MCP
// server beside it (../sandbox-tools/mind-tools.ts), and the install on every publish. The Workers-only half (`WebSocketPair`, `iterate/sdk`), apart so runner.ts can be
// tested under Node.
import type { IterateContextApi } from "iterate/api";
import type { Integration } from "iterate/sdk";
import { SESSION_PATH } from "../agent-kinds/acp.ts";
import { serveMcp } from "../sandbox-tools/mind-tools.ts";
import {
  AWAKE_EVERY_MS,
  HEADER,
  install,
  isSessionKey,
  keepAwake,
  MIND_TOOLS_KIND,
  notARunnerEvent,
  SLUG,
} from "./runner.ts";

/** The socket a session's host keeps to the mind: appends to that session and reads of it, and
 *  `busy`. Only that session's sandbox gets in: HEADER holds the session's own key, the HMAC of its
 *  path under SECRET (runner.ts `hostEnv`). A sandbox runs an agent that reads whatever it is
 *  given, so over THIS SOCKET its key opens its own session and no other, and it adds the
 *  harness's events alone. What the same key opens on `/mcp` is ../sandbox-tools/mind-tools.ts's
 *  to say. */
export async function serveSocket(
  request: Request,
  getItx: () => IterateContextApi & Disposable,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/socket") return new Response("Not found\n", { status: 404 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return new Response("a WebSocket, please\n", { status: 426 });
  const session = url.searchParams.get("session") || "";
  if (!SESSION_PATH.test(session)) return new Response("no session\n", { status: 400 });
  const key = request.headers.get(HEADER);
  {
    using itx = getItx();
    if (!(await isSessionKey(itx, session, key)))
      return new Response("not this session's sandbox\n", { status: 401 });
  }

  const [client, server] = Object.values(new WebSocketPair());
  server!.accept();
  let awakeAt = 0;
  // one request at a time, in the order sent: the host's appends are a session's log
  let queue: Promise<unknown> = Promise.resolve();
  server!.addEventListener("message", (message) => {
    const asked = JSON.parse(String(message.data));
    if (asked.op === "busy") {
      if (Date.now() - awakeAt < AWAKE_EVERY_MS) return;
      awakeAt = Date.now();
      void keepAwake(getItx, session);
      return;
    }
    queue = queue.then(async () => {
      try {
        if (asked.path !== session)
          throw new Error(`this socket is ${session}'s, not ${asked.path}'s`);
        using itx = getItx();
        const context = itx.cd(session);
        if (asked.op !== "append" && asked.op !== "read")
          throw new Error(`no ${String(asked.op)} here`);
        // what its runner says and no other: never a script to run, words as a person's, or the
        // answer to its own permission request
        const foreign = asked.op === "append" && asked.events.find(notARunnerEvent);
        if (foreign)
          throw new Error(`a sandbox adds its runner's events alone, not ${foreign.type}`);
        const result =
          asked.op === "append"
            ? (await context.append(...asked.events)).map((event) => ({ offset: event.offset }))
            : await context.readEvents(asked.after, asked.limit);
        server!.send(JSON.stringify({ id: asked.id, result }));
      } catch (error) {
        server!.send(
          JSON.stringify({
            id: asked.id,
            error: {
              message: error instanceof Error ? error.message : String(error),
              code: Object(error).code,
            },
          }),
        );
      }
    });
  });
  return new Response(null, { status: 101, webSocket: client });
}

/** The integration worker.ts hosts: the socket and the mind tools on its host, and the install on
 *  every publish.
 *
 *  `mindTools: false`: this mind's sandboxes get no `run` and no `commit`
 *  (../sandbox-tools/mind-tools.ts). A
 *  session's agent then reaches its own session and what the sandbox's egress lets out, and
 *  nothing of the mind. Without it they are on: an agent in a sandbox works on the mind. */
export function acpSandbox(options: { mindTools?: boolean } = {}): Integration {
  return {
    routingSlug: SLUG,
    fetch: (request, host) =>
      new URL(request.url).pathname === "/mcp"
        ? serveMcp(request, () => host.getItx(), MIND_TOOLS_KIND, options)
        : serveSocket(request, () => host.getItx()),
    processEvent: async ({ event, itx }) => {
      if (event.type === "events.iterate.com/mind/worker-updated" && event.path === "/")
        await install(itx, options);
    },
  };
}
