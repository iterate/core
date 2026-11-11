// The binding hands a session's CDP endpoint out as a Fetcher, which no caller across RPC can hold,
// so `cdp`, `navigate` and `openPage` open the WebSocket here. The binding's account-wide listings
// are not exposed: they would hand one project another's sessions.
import { z } from "zod";
import { failureKind, retryPlatformFailures, UPSTREAM_ONCE } from "iterate/platform-retry";
import type {
  CfBrowserApi,
  CfBrowserCdpOptions,
  CfBrowserPage,
  CfBrowserQuickAction,
  CfBrowserQuickActionOptions,
} from "iterate/api";

const CDP_TIMEOUT_MS = 30_000;
// the binding's own default is one minute
const OPEN_PAGE_KEEP_ALIVE_MS = 5 * 60_000;

const CdpMessage = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
const EvaluatedByValue = z.object({ result: z.object({ value: z.unknown().optional() }) });
const PageFacts = z.object({ url: z.string(), title: z.string() });

async function unwrapBrowserRunQuickAction(
  action: string,
  response: Response,
): Promise<string | Uint8Array | unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const envelope = (await response.json()) as {
    success?: boolean;
    result?: unknown;
    error?: unknown;
  } | null;
  if (envelope && "success" in envelope) {
    if (envelope.success !== true) {
      throw new Error(
        `Browser Run ${action} failed: ${JSON.stringify(envelope.error ?? envelope).slice(0, 500)}`,
      );
    }
    return envelope.result;
  }
  return envelope;
}

export function cfBrowser(binding: BrowserRun): CfBrowserApi {
  return {
    fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
      return binding.fetch(input, init);
    },
    // A quick action only reads the page, so running it twice is safe.
    async quickAction(
      action: CfBrowserQuickAction,
      options: CfBrowserQuickActionOptions,
    ): Promise<string | Uint8Array | unknown> {
      const attempt = async () =>
        unwrapBrowserRunQuickAction(
          action,
          await (
            binding as BrowserRun & {
              quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
            }
          ).quickAction(action, options),
        );
      return retryPlatformFailures(attempt, {
        area: "browser",
        schedule: UPSTREAM_ONCE,
        idempotent: true,
        // Browser Run's own timeout (code 6002) on inline HTML is the service's, never the page's;
        // a `url` page's timeout may be that site's.
        kind: (error) =>
          "html" in options &&
          /"code":6002\b/.test(error instanceof Error ? error.message : String(error))
            ? "disconnected"
            : failureKind(error),
        describe: (error) => ({
          name: action,
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    },

    async openPage({ url, ...options }) {
      const { sessionId } = await binding.acquire({
        ...options,
        keepAlive: options.keepAlive ?? OPEN_PAGE_KEEP_ALIVE_MS,
      });
      try {
        return await navigate(binding, sessionId, url, {});
      } catch (error) {
        // the caller has no id to close it by
        await binding.closeSession(sessionId).catch(() => undefined);
        throw error;
      }
    },
    navigate: (sessionId, url, options = {}) => navigate(binding, sessionId, url, options),
    async cdp(sessionId, method, params = {}, options = {}) {
      const connection = await connect(binding, sessionId, options.targetId);
      try {
        return await connection.send(method, params, options.timeoutMs ?? CDP_TIMEOUT_MS);
      } finally {
        connection.close();
      }
    },

    acquire: (options) => binding.acquire(options),
    getSession: async (sessionId) => await binding.getSession(sessionId),
    closeSession: (sessionId) => binding.closeSession(sessionId),
    getLiveView: (sessionId, options) => binding.getLiveView(sessionId, options),
    async limits() {
      const { activeSessions, ...limits } = await binding.limits();
      // the ids are every session of the account: only how many there are leaves here
      return { ...limits, activeSessions: activeSessions.length };
    },
    devtools: {
      getVersion: (sessionId) => binding.devtools.getVersion(sessionId),
      listTargets: (sessionId) => binding.devtools.listTargets(sessionId),
      getTarget: (sessionId, targetId) => binding.devtools.getTarget(sessionId, targetId),
      newTarget: (sessionId, url) => binding.devtools.newTarget(sessionId, url),
      activateTarget: (sessionId, targetId) => binding.devtools.activateTarget(sessionId, targetId),
      closeTarget: (sessionId, targetId) => binding.devtools.closeTarget(sessionId, targetId),
    },
  };
}

type CdpConnection = {
  targetId: string;
  send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  // null when none arrives within `timeoutMs`; ask before the command that causes it
  event(method: string, timeoutMs: number): Promise<unknown>;
  close(): void;
};

async function connect(
  binding: BrowserRun,
  sessionId: string,
  targetId: string | undefined,
): Promise<CdpConnection> {
  const target = targetId || (await firstPageOf(binding, sessionId));
  const { webSocket } = await binding.connectSession(
    sessionId,
    target === "browser" ? undefined : { targetId: target },
  );
  // the host is never dialled: the Fetcher is pinned to the session
  const response = await webSocket.fetch("https://browser-run.invalid", {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (!socket)
    throw new Error(
      `Browser Run opened no CDP connection to session ${sessionId} (HTTP ${String(response.status)})`,
    );
  socket.accept();

  let nextId = 0;
  const answers = new Map<number, (message: z.infer<typeof CdpMessage>) => void>();
  const awaited = new Map<string, ((params: unknown) => void)[]>();
  let closed: Error | null = null;
  const closedWaiters = new Set<(error: Error) => void>();
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = CdpMessage.safeParse(JSON.parse(event.data));
    if (!message.success) return;
    if (message.data.id !== undefined) return answers.get(message.data.id)?.(message.data);
    if (!message.data.method) return;
    for (const resolve of awaited.get(message.data.method) ?? []) resolve(message.data.params);
    awaited.delete(message.data.method);
  });
  socket.addEventListener("close", () => {
    closed = new Error(`Browser Run closed the CDP connection to session ${sessionId}`);
    for (const reject of closedWaiters) reject(closed);
  });

  return {
    targetId: target,
    send(method, params, timeoutMs) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(closed);
        const id = ++nextId;
        const settle = () => {
          clearTimeout(timer);
          answers.delete(id);
          closedWaiters.delete(reject);
        };
        const timer = setTimeout(() => {
          settle();
          reject(new Error(`Browser Run: ${method} did not answer within ${String(timeoutMs)} ms`));
        }, timeoutMs);
        closedWaiters.add(reject);
        answers.set(id, (message) => {
          settle();
          if (message.error)
            reject(new Error(`Browser Run: ${method} failed: ${message.error.message}`));
          else resolve(message.result);
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    event(method, timeoutMs) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        awaited.set(method, [
          ...(awaited.get(method) ?? []),
          (params) => {
            clearTimeout(timer);
            resolve(params ?? {});
          },
        ]);
      });
    },
    close: () => socket.close(),
  };
}

async function firstPageOf(binding: BrowserRun, sessionId: string): Promise<string> {
  const page = (await binding.devtools.listTargets(sessionId)).find(({ type }) => type === "page");
  if (!page) throw new Error(`Browser Run session ${sessionId} has no page open`);
  return page.id;
}

async function navigate(
  binding: BrowserRun,
  sessionId: string,
  url: string,
  options: CfBrowserCdpOptions,
): Promise<CfBrowserPage> {
  const timeoutMs = options.timeoutMs ?? CDP_TIMEOUT_MS;
  const connection = await connect(binding, sessionId, options.targetId);
  try {
    await connection.send("Page.enable", {}, timeoutMs);
    const load = connection.event("Page.loadEventFired", timeoutMs);
    const navigated = z
      .object({ errorText: z.string().optional() })
      .parse(await connection.send("Page.navigate", { url }, timeoutMs));
    if (navigated.errorText)
      throw new Error(`Browser Run: ${url} did not load: ${navigated.errorText}`);
    const loaded = (await load) !== null;
    const evaluated = EvaluatedByValue.parse(
      await connection.send(
        "Runtime.evaluate",
        { expression: "({ url: location.href, title: document.title })", returnByValue: true },
        timeoutMs,
      ),
    );
    const facts = PageFacts.parse(evaluated.result.value);
    return { sessionId, targetId: connection.targetId, ...facts, loaded };
  } finally {
    connection.close();
  }
}

export const BROWSER_ROOT_DESCRIPTION =
  'Cloudflare Browser Run. One-shot: `browser.quickAction("markdown", { url })` (also "content", "screenshot", "pdf", "links", "json", "snapshot", "scrape"). A session, to click and type: `browser.openPage({ url })` → { sessionId, targetId, url, title, loaded }; `browser.cdp(sessionId, method, params)` runs one Chrome DevTools Protocol command on its page (`Runtime.evaluate` with { expression, returnByValue: true, awaitPromise: true } to read or click, `Input.insertText`, `Page.captureScreenshot`); `browser.navigate(sessionId, url)`; `browser.devtools.listTargets(sessionId)` · `newTarget(sessionId, url)` for tabs; `browser.getLiveView(sessionId)` → a link to watch it; `browser.closeSession(sessionId)` when done (an open session is billed until its keepAlive, five minutes by default, runs out)';
