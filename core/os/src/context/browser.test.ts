import { expect, test } from "vitest";
import { cfBrowser, unwrapBrowserRunQuickAction } from "./browser.ts";
import { settle } from "./test-support.ts";

// The unwrap contract behind itx.browser.quickAction: callers get the
// action's RESULT, never the binding's Response envelope. The binding is an
// external service (local dev cannot dial it), so this pure function carries the
// contract.

test("unwrapBrowserRunQuickAction: returns the envelope's result for successful JSON actions", async () => {
  await expect(
    unwrapBrowserRunQuickAction("markdown", json({ success: true, result: "# Hello" })),
  ).resolves.toBe("# Hello");
  await expect(
    unwrapBrowserRunQuickAction(
      "links",
      json({ success: true, result: ["https://a", "https://b"] }),
    ),
  ).resolves.toEqual(["https://a", "https://b"]);
});

test("unwrapBrowserRunQuickAction: throws the envelope's error on failure", async () => {
  await expect(
    unwrapBrowserRunQuickAction("markdown", json({ success: false, error: "page timed out" })),
  ).rejects.toThrow(/Browser Run markdown failed: "page timed out"/);
});

test("unwrapBrowserRunQuickAction: returns binary media as bytes", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const result = await unwrapBrowserRunQuickAction(
    "screenshot",
    new Response(png, { headers: { "content-type": "image/png" } }),
  );
  expect(result).toBeInstanceOf(Uint8Array);
  expect([...(result as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});

test("unwrapBrowserRunQuickAction: passes through JSON that is not the success/result envelope", async () => {
  await expect(unwrapBrowserRunQuickAction("json", json({ title: "raw" }))).resolves.toEqual({
    title: "raw",
  });
});

// ── Browser Run's own timeout ── `{"code":6002,"message":"A timeout was reached. …","detail":"Promise
// timed out"}` on a one-line inline-HTML screenshot (PR iterate/iterate#2934 553ab630, 2026-09-24 00:20 UTC): nothing
// remote to wait for, so the timeout is the service's. A quick action on inline HTML retries it ONCE,
// a second later, logged; a second one surfaces, and a `url` page's timeout (maybe the site's) and
// every other failure are never retried.
test("quickAction on inline HTML: one retry, a second later, logged as browser.platform-failure-retry", async () => {
  const { calls, browser } = binding(timedOut, () => new Response(png));
  expect(await settle(() => browser.quickAction("screenshot", inline))).toMatchObject({
    value: png,
    retries: [
      {
        event: "browser.platform-failure-retry",
        name: "screenshot",
        message: expect.stringContaining('"code":6002'),
      },
    ],
  });
  expect(calls).toEqual(["screenshot", "screenshot"]);
});

test("quickAction's timeout retry is bounded: a second timeout surfaces; a url page's timeout and any other failure are never retried", async () => {
  const twice = binding(timedOut, timedOut);
  expect(await settle(() => twice.browser.quickAction("screenshot", inline))).toMatchObject({
    error: { message: expect.stringContaining('"code":6002') },
    retries: [
      { event: "browser.platform-failure-retry" },
      { event: "browser.platform-failure-gave-up", attempts: 2 },
    ],
  });
  expect(twice.calls).toHaveLength(2);

  const site = binding(timedOut, () => new Response(png));
  expect(
    await settle(() => site.browser.quickAction("screenshot", { url: "https://example.com" })),
  ).toMatchObject({ error: { message: expect.stringContaining('"code":6002') }, retries: [] });
  expect(site.calls).toHaveLength(1);

  const other = binding(
    () =>
      new Response(JSON.stringify({ success: false, error: "page crashed" }), {
        headers: { "content-type": "application/json" },
      }),
    () => new Response(png),
  );
  expect(await settle(() => other.browser.quickAction("screenshot", inline))).toMatchObject({
    error: { message: 'Browser Run screenshot failed: "page crashed"' },
    retries: [],
  });
  expect(other.calls).toHaveLength(1);
});

// ── Sessions ── a browser that stays open between calls. The fake is a Browser Run account: sessions
// with one page each, whose CDP endpoint answers the commands the wrapper sends and fires the load
// event after a navigation.

test("openPage starts a session and answers the loaded page; cdp runs one command on it; closeSession ends it", async () => {
  const run = account();
  const page = await run.browser.openPage({ url: "https://example.com/unsubscribe" });
  expect(page).toEqual({
    sessionId: "session-1",
    targetId: "page-1",
    url: "https://example.com/unsubscribe",
    title: "Title of https://example.com/unsubscribe",
    loaded: true,
  });
  // five minutes idle unless the caller names its own
  expect(run).toMatchObject({ acquired: [{ keepAlive: 300_000 }] });

  expect(
    await run.browser.cdp(page.sessionId, "Runtime.evaluate", {
      expression: "document.querySelector('button').click()",
      returnByValue: true,
    }),
  ).toEqual({ result: { value: "evaluated document.querySelector('button').click()" } });
  // each call is its own connection to the session's page, closed when it answered
  expect(run).toMatchObject({
    connections: [
      { sessionId: "session-1", targetId: "page-1", open: false },
      { sessionId: "session-1", targetId: "page-1", open: false },
    ],
  });

  expect(await run.browser.closeSession(page.sessionId)).toEqual({ status: "closed" });
  expect(await run.browser.getSession(page.sessionId)).toBeNull();
});

test("navigate loads another URL in the same session's page", async () => {
  const run = account();
  const { sessionId } = await run.browser.openPage({
    url: "https://example.com/a",
    keepAlive: 60_000,
  });
  expect(run).toMatchObject({ acquired: [{ keepAlive: 60_000 }] });
  expect(await run.browser.navigate(sessionId, "https://example.com/b")).toMatchObject({
    sessionId,
    url: "https://example.com/b",
    loaded: true,
  });
});

test.for<{ name: string; url: string; error: RegExp; sessionsLeft: number }>([
  {
    name: "a URL Chrome refuses throws its errorText, and the session openPage started is closed",
    url: "https://no-such-host.invalid/",
    error: /did not load: net::ERR_NAME_NOT_RESOLVED/,
    sessionsLeft: 0,
  },
])("$name", async ({ url, error, sessionsLeft }) => {
  const run = account();
  await expect(run.browser.openPage({ url })).rejects.toThrow(error);
  expect(run.sessions).toMatchObject({ size: sessionsLeft });
});

test("a page whose load event never arrives is answered with loaded: false once the bound passes", async () => {
  const run = account({ fireLoad: false });
  const { sessionId } = await run.browser.acquire();
  expect(
    await run.browser.navigate(sessionId, "https://example.com/slow", { timeoutMs: 20 }),
  ).toMatchObject({ url: "https://example.com/slow", loaded: false });
});

test("a CDP error throws with the command's name, and a command that never answers is bounded", async () => {
  const run = account();
  const { sessionId } = await run.browser.acquire();
  await expect(run.browser.cdp(sessionId, "Nope.nothing")).rejects.toThrow(
    "Browser Run: Nope.nothing failed: 'Nope.nothing' wasn't found",
  );
  await expect(run.browser.cdp(sessionId, "Test.hang", {}, { timeoutMs: 20 })).rejects.toThrow(
    "Browser Run: Test.hang did not answer within 20 ms",
  );
  expect(run.connections.every(({ open }) => !open)).toBe(true);
});

test('targetId picks the tab, and "browser" the browser\'s own endpoint', async () => {
  const run = account();
  const { sessionId } = await run.browser.acquire();
  const tab = await run.browser.devtools.newTarget(sessionId, "https://example.com/second");
  await run.browser.cdp(sessionId, "Runtime.evaluate", { expression: "1" }, { targetId: tab.id });
  await run.browser.cdp(sessionId, "Browser.getVersion", {}, { targetId: "browser" });
  expect(run.connections.map(({ targetId }) => targetId)).toEqual([tab.id, undefined]);
});

test("limits answers how many sessions are active, never their ids", async () => {
  const run = account();
  await run.browser.acquire();
  await run.browser.acquire();
  expect(await run.browser.limits()).toEqual({
    activeSessions: 2,
    maxConcurrentSessions: 10,
    allowedBrowserAcquisitions: 1,
    timeUntilNextAllowedBrowserAcquisition: 0,
  });
});

/** A fake Browser Run account behind `cfBrowser`: what it was asked to acquire, the CDP
 *  connections opened on it (and whether each is still open), and its live sessions. */
function account({ fireLoad = true } = {}) {
  type Target = { id: string; type: string; url: string; title: string };
  const sessions = new Map<string, Target[]>();
  const acquired: unknown[] = [];
  const connections: { sessionId: string; targetId: string | undefined; open: boolean }[] = [];
  let targets = 0;
  const targetsOf = (sessionId: string) => {
    const found = sessions.get(sessionId);
    if (!found) throw new Error(`no session ${sessionId}`);
    return found;
  };
  const page = (url: string): Target => ({
    id: `page-${String(++targets)}`,
    type: "page",
    url,
    title: "",
  });

  /** One CDP endpoint: answers the commands the wrapper sends, on the next tick. */
  const endpoint = (sessionId: string, targetId: string | undefined) => {
    const connection = { sessionId, targetId, open: true };
    connections.push(connection);
    const listeners: Record<string, ((event: { data?: string }) => void)[]> = {};
    const emit = (message: unknown) =>
      queueMicrotask(() => {
        for (const listener of listeners.message || []) listener({ data: JSON.stringify(message) });
      });
    const target = targetsOf(sessionId).find(({ id }) => id === targetId);
    return {
      accept() {},
      addEventListener(type: string, listener: (event: { data?: string }) => void) {
        (listeners[type] ??= []).push(listener);
      },
      close() {
        connection.open = false;
      },
      send(text: string) {
        const { id, method, params } = JSON.parse(text);
        if (method === "Test.hang") return;
        if (method === "Page.enable" || method === "Browser.getVersion")
          return emit({ id, result: {} });
        if (method === "Page.navigate") {
          if (new URL(params.url).hostname.endsWith(".invalid"))
            return emit({ id, result: { errorText: "net::ERR_NAME_NOT_RESOLVED" } });
          if (target) Object.assign(target, { url: params.url, title: `Title of ${params.url}` });
          emit({ id, result: { frameId: "frame-1" } });
          if (fireLoad) emit({ method: "Page.loadEventFired", params: { timestamp: 1 } });
          return;
        }
        if (method === "Runtime.evaluate") {
          const value = params.expression.includes("location.href")
            ? { url: target?.url, title: target?.title }
            : `evaluated ${params.expression}`;
          return emit({ id, result: { result: { value } } });
        }
        emit({ id, error: { message: `'${method}' wasn't found` } });
      },
    };
  };

  // Only what cfBrowser's session methods call, in the shapes the binding answers.
  const run = {
    acquire: async (options: unknown) => {
      acquired.push(options);
      const sessionId = `session-${String(sessions.size + 1)}`;
      sessions.set(sessionId, [page("about:blank")]);
      return { sessionId };
    },
    connectSession: async (sessionId: string, options?: { targetId?: string }) => ({
      sessionId,
      webSocket: {
        fetch: async () => ({ status: 101, webSocket: endpoint(sessionId, options?.targetId) }),
      },
    }),
    getSession: async (sessionId: string) => (sessions.has(sessionId) ? { sessionId } : null),
    closeSession: async (sessionId: string) => {
      sessions.delete(sessionId);
      return { status: "closed" };
    },
    limits: async () => ({
      activeSessions: [...sessions.keys()].map((id) => ({ id })),
      maxConcurrentSessions: 10,
      allowedBrowserAcquisitions: 1,
      timeUntilNextAllowedBrowserAcquisition: 0,
    }),
    devtools: {
      listTargets: async (sessionId: string) => targetsOf(sessionId),
      newTarget: async (sessionId: string, url = "about:blank") => {
        const target = page(url);
        targetsOf(sessionId).push(target);
        return target;
      },
    },
  } as unknown as BrowserRun;
  return { browser: cfBrowser(run), acquired, connections, sessions };
}

/** A JSON Response, as the Browser Run binding answers. */
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const timedOut = () =>
  new Response(
    JSON.stringify({
      success: false,
      errors: [
        {
          code: 6002,
          message:
            "A timeout was reached. Check gotoOptions/waitForSelector/waitForTimeout/actionTimeout options.",
          detail: "Promise timed out",
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
/** A binding whose quick actions answer `answers` in turn, and the calls it saw. */
const binding = (...answers: (() => Response)[]) => {
  const calls: string[] = [];
  const run = {
    quickAction: async (action: string) => {
      calls.push(action);
      return answers[calls.length - 1]!();
    },
  } as unknown as BrowserRun;
  return { calls, browser: cfBrowser(run) };
};
const inline = { html: "<!doctype html><body>Tuesday</body>" };
