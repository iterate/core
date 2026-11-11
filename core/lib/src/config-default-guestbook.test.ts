// The default config's guestbook (core/configs/default/apps/guestbook): who may read, write,
// answer, approve and remove, through the page's routes and through the app's own MCP server. The
// app runs here on a log that keeps what it is given, with the SDK's own guards reading the stamps
// the boundary would set.
/// <reference path="../../configs/default/files.d.ts" />
import { expect, test } from "vitest";
import { guestbookApp } from "../../configs/default/apps/guestbook/app.ts";
import { auth } from "./sdk/auth.ts";

const ORIGIN = "https://guestbook.example.com";

test("an entry waits until a member approves it, and each person sees what is theirs to see", async () => {
  const book = guestbook();
  expect(await book.post(ada, "/entries", { text: " Hello " })).toEqual([200, { waiting: true }]);
  const [id] = book.ids();
  // The log is the record: one event, with who wrote it, and the text trimmed.
  expect(book).toMatchObject({
    log: [
      {
        type: "guestbook/entry-written",
        offset: id,
        createdAt: expect.any(String),
        payload: { text: "Hello", by: { userId: "user_ada", email: "ada@example.net" } },
      },
    ],
  });
  expect(await book.entries(nobody)).toEqual([]);
  expect(await book.entries(bob)).toEqual([]);
  expect(await book.entries(ada)).toMatchObject([{ id, status: "waiting", mine: true }]);
  // a member sees it waiting, with the whole address; everyone else the part before the `@`
  expect(await book.entries(member)).toMatchObject([
    { id, status: "waiting", author: "ada@example.net" },
  ]);
  expect(await book.post(member, `/entries/${id}/approve`)).toEqual([
    200,
    { entry: id, decision: "approve" },
  ]);
  expect(await book.entries(nobody)).toMatchObject([
    { id, text: "Hello", status: "approved", author: "ada", mine: false },
  ]);
});

test("only a signed-in person writes, and only a member approves or removes", async () => {
  const book = guestbook();
  expect((await book.post(nobody, "/entries", { text: "no" }))[0]).toBe(401);
  await book.post(ada, "/entries", { text: "mine" });
  const [id] = book.ids();
  for (const who of [nobody, ada, bob]) {
    expect((await book.post(who, `/entries/${id}/approve`))[0]).toBe(401);
    expect((await book.post(who, `/entries/${id}/remove`))[0]).toBe(401);
  }
  expect(book.log).toHaveLength(1);
  // a member removes an approved entry too, and a removed entry stays removed
  await book.post(member, `/entries/${id}/approve`);
  await book.post(member, `/entries/${id}/remove`);
  await book.post(member, `/entries/${id}/approve`);
  expect(await book.entries(member)).toEqual([]);
  expect(await book.post(member, "/entries/999/approve")).toEqual([
    404,
    { refused: "There is no such entry." },
  ]);
});

test("what a person may not write is refused, and nothing lands on the log", async () => {
  const book = guestbook();
  const refused = async (input: unknown) => (await book.post(ada, "/entries", input))[1];
  expect(await refused({ text: "   " })).toEqual({ refused: "An entry needs some text." });
  expect(await refused({ text: 7 })).toEqual({ refused: "An entry needs some text." });
  expect(await refused({ text: "x".repeat(1001) })).toEqual({
    refused: "An entry is 1000 characters at most.",
  });
  // a reply names an entry everyone can see
  expect(await refused({ text: "a reply", replyTo: 1 })).toEqual({
    refused: "The entry you answer is not in the guestbook.",
  });
  expect(book.ids()).toEqual([]);
  // five may wait for one person; another person is not held back by them
  for (let n = 0; n < 5; n += 1) await book.post(ada, "/entries", { text: `entry ${n}` });
  expect(await refused({ text: "a sixth" })).toMatchObject({
    refused: expect.stringContaining("5 entries waiting"),
  });
  expect((await book.post(bob, "/entries", { text: "mine" }))[0]).toBe(200);
  expect(book.log).toHaveLength(6);
});

test("a reply answers an approved entry, and waits for approval like any entry", async () => {
  const book = guestbook();
  await book.post(ada, "/entries", { text: "first" });
  const [first] = book.ids();
  expect((await book.post(bob, "/entries", { text: "early", replyTo: first }))[0]).toBe(400);
  await book.post(member, `/entries/${first}/approve`);
  expect(await book.post(bob, "/entries", { text: "a reply", replyTo: first })).toEqual([
    200,
    { waiting: true },
  ]);
  const reply = book.ids().at(-1);
  expect(await book.entries(nobody)).toMatchObject([{ id: first }]);
  await book.post(member, `/entries/${reply}/approve`);
  expect(await book.entries(nobody)).toMatchObject([
    { id: first },
    { id: reply, replyTo: first, author: "bob" },
  ]);
});

test("the app's MCP server sends a client with no token to the mind's sign-in, for this host alone", async () => {
  const book = guestbook();
  const answer = await book.fetch(nobody, "/mcp", { method: "POST", body: "{}" });
  expect(answer).toMatchObject({ status: 401 });
  expect(answer.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="identity"`,
  );
  const document = await book.fetch(nobody, "/.well-known/oauth-protected-resource/mcp");
  expect(await document.json()).toEqual({
    resource: ORIGIN,
    authorization_servers: ["https://iterate.example.com"],
    scopes_supported: ["identity"],
    bearer_methods_supported: ["header"],
  });
});

test("an agent signed in as a person lists, writes and answers through the MCP tools", async () => {
  const book = guestbook();
  expect(await book.mcp(ada, "initialize", { protocolVersion: "2025-06-18" })).toMatchObject({
    result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
  });
  expect(await book.mcp(ada, "tools/list")).toMatchObject({
    result: {
      tools: [{ name: "list_entries" }, { name: "add_entry" }, { name: "reply_to_entry" }],
    },
  });
  const call = async (who: Record<string, string>, name: string, input = {}) => {
    const answer = await book.mcp(who, "tools/call", { name, arguments: input });
    const { content, isError } = answer.result as { content: { text: string }[]; isError: boolean };
    return [JSON.parse(content[0]!.text), isError];
  };
  expect(await call(ada, "add_entry", { text: "from an agent" })).toEqual([
    { waiting: true },
    false,
  ]);
  const [first] = book.ids();
  await book.post(member, `/entries/${first}/approve`);
  expect(await call(bob, "reply_to_entry", { entry: first, text: "an answer" })).toEqual([
    { waiting: true },
    false,
  ]);
  expect(await call(bob, "reply_to_entry", { text: "to nothing" })).toEqual([
    { refused: "Name the entry you answer." },
    true,
  ]);
  expect(await call(bob, "add_entry", { text: "" })).toEqual([
    { refused: "An entry needs some text." },
    true,
  ]);
  // each agent sees the approved entries and its own waiting ones
  expect((await call(bob, "list_entries"))[0]).toMatchObject([
    { id: first, status: "approved", author: "ada", mine: false },
    { replyTo: first, status: "waiting", mine: true },
  ]);
  expect((await call(ada, "list_entries"))[0]).toHaveLength(1);
  // a notification gets no answer, and an unknown method or tool is an error of the protocol
  const notified = await book.fetch(ada, "/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  expect(notified).toMatchObject({ status: 202 });
  expect(await book.mcp(ada, "resources/list")).toMatchObject({ error: { code: -32601 } });
  expect(await book.mcp(ada, "tools/call", { name: "delete_all" })).toMatchObject({
    error: { code: -32602 },
  });
});

// ── who asks: the stamps the boundary sets on a request to a mind's host ──
const person = (name: string) => ({
  "x-itx-person": JSON.stringify({ userId: `user_${name}`, email: `${name}@example.net` }),
});
const nobody = {};
const ada = person("ada");
const bob = person("bob");
// a member is a person the boundary also stamps as a principal
const member = {
  ...person("owner"),
  "x-itx-principal": JSON.stringify({ actor: "user_owner", email: "owner@example.net" }),
};

/** The app on one context's log, which keeps what it is given and numbers it from 1. */
function guestbook() {
  const log: { type: string; offset: number; createdAt: string; payload?: unknown }[] = [];
  const context = {
    append: async (event: { type: string; payload?: unknown }) => {
      log.push({ ...event, offset: log.length + 1, createdAt: new Date().toISOString() });
    },
    readEvents: async (after = 0, limit = 500) => {
      const events = log.filter((event) => event.offset > after).slice(0, limit);
      const scannedThroughOffset = events.at(-1)?.offset || after;
      return { events, scannedThroughOffset, atHead: scannedThroughOffset === log.length };
    },
  };
  const host = {
    auth,
    getItx: () => ({ cd: () => context, [Symbol.dispose]() {} }),
  } as unknown as Parameters<ReturnType<typeof guestbookApp>["fetch"]>[1];
  const app = guestbookApp();
  const fetch = (who: Record<string, string>, path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`${ORIGIN}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...who },
      }),
      host,
    );
  return {
    log,
    fetch,
    /** The ids of the entries written so far: each is its event's offset. */
    ids: () =>
      log.filter((event) => event.type === "guestbook/entry-written").map((event) => event.offset),
    async post(who: Record<string, string>, path: string, body: unknown = {}) {
      const answer = await fetch(who, path, { method: "POST", body: JSON.stringify(body) });
      return [answer.status, await answer.json().catch(() => null)];
    },
    async entries(who: Record<string, string>) {
      const answer = await fetch(who, "/entries.json");
      return ((await answer.json()) as { entries: unknown[] }).entries;
    },
    async mcp(who: Record<string, string>, method: string, params?: unknown) {
      const answer = await fetch(who, "/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return (await answer.json()) as { result?: unknown; error?: unknown };
    },
  };
}
