// browser.ts — the `itx.browser` built-in root. Its shape is the published one (iterate/api
// `CfBrowserApi`).
//
// ONE-SHOT: raw `fetch` for CDP, and `quickAction`, which returns the action's RESULT instead of the
// binding's `{ success, result }` Response envelope.
//
// SESSIONS: a browser that stays open between calls. The binding hands a session's CDP endpoint out
// as a Fetcher, which no caller across RPC can hold, so the calls that need one (`cdp`, `navigate`,
// `openPage`) open the WebSocket here, run their commands and close it; the session, its pages and
// its cookies outlive the connection. Every session call names its session by id, the capability
// `acquire` and `openPage` answer: the binding's account-wide listings (`listSessions`, `history`,
// the ids in `limits`) are not exposed, since they would hand one project another's sessions.

import { z } from "zod";
import { failureKind, retryPlatformFailures, UPSTREAM_ONCE } from "iterate/platform-retry";
import type {
  CfBrowserApi,
  CfBrowserCdpOptions,
  CfBrowserPage,
  CfBrowserQuickAction,
  CfBrowserQuickActionOptions,
} from "iterate/api";

/** How long one CDP command, and a page's load, may take when the caller names no bound. */
const CDP_TIMEOUT_MS = 30_000;
/** `openPage`'s idle lifetime when the caller names none: long enough for an agent to think between
 *  two scripts, short enough that a forgotten session stops costing soon. The binding's own
 *  default is one minute. */
const OPEN_PAGE_KEEP_ALIVE_MS = 5 * 60_000;
/** The target a call names to reach the browser's own endpoint rather than a page's. */
const BROWSER_TARGET = "browser";

/** A CDP message: the answer to a command (its `id`, then `result` or `error`) or an event
 *  (`method`, `params`). */
const CdpMessage = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
/** What `Runtime.evaluate` answers for an expression returned by value. */
const EvaluatedByValue = z.object({ result: z.object({ value: z.unknown().optional() }) });
const PageFacts = z.object({ url: z.string(), title: z.string() });

/**
 * Unwraps a Browser Run quick-action Response to the caller-facing result:
 * JSON envelopes (`{ success, result }`) yield their `result` (throwing the
 * envelope's error on failure), binary media (screenshot, pdf) yields bytes.
 * Pure so the unwrap contract is unit-testable — the binding itself is an
 * external service local dev cannot dial.
 */
export async function unwrapBrowserRunQuickAction(
  action: string,
  response: Response,
): Promise<string | Uint8Array | unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    // Binary actions (screenshot, pdf) respond with the media itself.
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

/** Cloudflare Browser Run binding exposed through itx. */
export function cfBrowser(binding: BrowserRun): CfBrowserApi {
  return {
    /** Raw Browser Run fetch, primarily for libraries that connect over CDP. */
    fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
      return binding.fetch(input, init);
    },
    /**
     * Browser Run Quick Actions: content, screenshot, pdf, markdown, snapshot,
     * scrape, json, links, crawl. Returns the action's RESULT directly —
     * `quickAction("markdown", { url })` is the markdown string, structured
     * actions (links, json, scrape, …) are their parsed value, and binary
     * actions (screenshot, pdf) are bytes — instead of the binding's raw
     * Response and its `{ success, result }` JSON envelope. A failed action
     * throws with the envelope's error — after ONE retry, a second later, when
     * the failure is Browser Run's own timeout on inline HTML (logged as
     * `browser.platform-failure-retry`; scripts/ci/prd-fault-alarm.ts pages on
     * a burst). A quick action only reads the page, so running it twice is safe.
     */
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
        // Browser Run's own timeout (`{"code":6002,"message":"A timeout was reached. …"}`) on INLINE
        // HTML: nothing remote to wait for, so the timeout is the service's, never the page's. A
        // `url` page's timeout may be that site's and is not retried.
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
        // a session whose first page never opened is no use to the caller, who has no id to close it by
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

/** One CDP connection to a session: commands answered by their id, events awaited by name. */
type CdpConnection = {
  targetId: string;
  send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  /** The next event named `method`, or null when none arrives within `timeoutMs`. Ask before the
   *  command that causes it. */
  event(method: string, timeoutMs: number): Promise<unknown>;
  close(): void;
};

/** A session's CDP endpoint, opened: its first page's unless `targetId` names another target, or
 *  the browser's own for `"browser"`. */
async function connect(
  binding: BrowserRun,
  sessionId: string,
  targetId: string | undefined,
): Promise<CdpConnection> {
  const target = targetId || (await firstPageOf(binding, sessionId));
  const { webSocket } = await binding.connectSession(
    sessionId,
    target === BROWSER_TARGET ? undefined : { targetId: target },
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

/** The session's first page: the target a call is for when it names none. */
async function firstPageOf(binding: BrowserRun, sessionId: string): Promise<string> {
  const page = (await binding.devtools.listTargets(sessionId)).find(({ type }) => type === "page");
  if (!page) throw new Error(`Browser Run session ${sessionId} has no page open`);
  return page.id;
}

/** `url` loaded in a session's page: the navigation, its load event (or the bound, with
 *  `loaded: false`), then where the page ended up and its title. A navigation Chrome refuses (a
 *  bad URL, a host that does not resolve) throws its `errorText`. */
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
