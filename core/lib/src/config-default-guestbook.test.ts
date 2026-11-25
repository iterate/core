// The default config's guestbook (core/configs/default/apps/guestbook): who may read, write,
// answer, approve and remove, through the page's routes and through the app's own MCP server. The
// app runs here on a log that keeps what it is given, with the SDK's own guards reading the stamps
// the boundary would set.
/// <reference path="../../configs/default/files.d.ts" />
import { expect, test } from "vitest";
import { guestbookApp } from "../../configs/default/apps/guestbook/app.ts";
import { auth } from "./sdk/auth.ts";

// The app is on a second zone of the mind, whose control-plane hostname is iterate.example.com.

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

test("the app says what it is to anyone, where the mind's sign-in reads it: its people sign in by a mailed code first", async () => {
  const book = guestbook();
  const described = await book.fetch(nobody, "/.well-known/iterate-app");
  expect(described).toMatchObject({ status: 200 });
  expect(await described.json()).toEqual({
    name: "Guestbook",
    icon: "/icon.svg",
    signIn: ["email", "passkey"],
  });
  // the icon that it names is the mind's (profile/icon.svg), which answers anyone too
  expect(await book.fetch(nobody, "/icon.svg")).toMatchObject({ status: 200 });
});

test("the app asks the platform to serve its MCP server: at /mcp and at the sign-in document, for people", async () => {
  const book = guestbook();
  for (const path of [
    "/mcp",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    // whoever asks: the platform decides who may connect, from its own stamp
    const answer = await book.fetch(nobody, path, { method: "POST", body: "{}" });
    expect(answer.headers.get("x-iterate-serve")).toBe("mcp-server");
    expect(await answer.json()).toEqual({
      target: "guestbookMcp",
      for: "people",
      name: "guestbook at guestbook.example.org",
    });
  }
  expect((await book.fetch(nobody, "/mcp/other")).headers.has("x-iterate-serve")).toBe(false);
});

test("an agent signed in as a person lists, writes and answers through the tools of the MCP server's class", async () => {
  const book = guestbook();
  const asPerson = (name: string) => ({
    name: "an MCP client",
    person: {
      userId: `user_${name}`,
      email: `${name}@example.net`,
      name,
      method: "email" as const,
    },
  });
  const [ada_, bob_] = [book.mcpClass(asPerson("ada")), book.mcpClass(asPerson("bob"))];
  expect(ada_.instructions()).toContain("ada@example.net");
  expect(ada_.tools().map((tool) => tool.name)).toEqual([
    "list_entries",
    "add_entry",
    "reply_to_entry",
  ]);
  // every tool is a method of the class
  for (const tool of ada_.tools()) expect(ada_).toHaveProperty(tool.name);

  expect(await ada_.add_entry({ text: "from an agent" })).toEqual({ waiting: true });
  const [first] = book.ids();
  await book.post(member, `/entries/${first}/approve`);
  expect(await bob_.reply_to_entry({ entry: first!, text: "an answer" })).toEqual({
    waiting: true,
  });
  // a refusal is the tool's error
  await expect(bob_.add_entry({ text: "" })).rejects.toThrow("An entry needs some text.");
  // each agent sees the approved entries and its own waiting ones
  expect(await bob_.list_entries()).toMatchObject([
    { id: first, status: "approved", author: "ada", mine: false },
    { replyTo: first, status: "waiting", mine: true },
  ]);
  expect(await ada_.list_entries()).toHaveLength(1);
  // a client whom nobody signed in with an address reaches no tool
  const guest = book.mcpClass({
    person: { userId: "g", email: "", name: "a guest", method: "guest" },
  });
  expect(() => guest.list_entries()).toThrow("Sign in with an address");
  expect(() => book.mcpClass({}).instructions()).toThrow("Sign in with an address");
});

// ── who asks: the stamps the boundary sets on a request to a mind's host ──
const person = (name: string, method = "email") => ({
  "x-itx-person": JSON.stringify({
    userId: `user_${name}`,
    email: `${name}@example.net`,
    name,
    method,
  }),
});
const nobody = {};
const ada = person("ada");
const bob = person("bob");
// a member is a person the boundary also stamps as a principal
const member = {
  ...person("owner", "passkey"),
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
      new Request(`https://guestbook.example.org${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          // the boundary's stamp on every request for the mind's own code
          "x-iterate-control-plane-hostname": "iterate.example.com",
          ...who,
        },
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
    /** The class of the app's MCP server for one client, as worker.ts answers it. */
    mcpClass: (client: Parameters<typeof app.mcp>[0]) => app.mcp(client, host),
  };
}
