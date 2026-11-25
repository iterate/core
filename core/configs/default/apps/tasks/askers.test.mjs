// askers.test.mjs — who asked each open ask of a task (askers.js). Run it with `node --test apps/tasks/`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASK_LOCATED,
  askersOf,
  blockingOf,
  locateAsk,
  modelOf,
  needleOf,
  taskAskers,
} from "./askers.js";

const card = (...humanAsk) => ({ humanAsk: humanAsk.length > 0 ? humanAsk : null });
const change = (offset, file, before, after, who) => ({
  type: "events.iterate.com/tasks/task-changed",
  offset,
  payload: {
    file,
    before,
    after,
    by: null,
    via: null,
    page: null,
    committedAt: `2026-11-20T16:00:${String(offset % 60).padStart(2, "0")}.000Z`,
    commitOid: `c${offset}`,
    ...who,
  },
});

test("the asker of an ask is the agent of the newest commit that added it", () => {
  const open = { "tasks/a.md": ["Ship it?", "On a Friday?"], "tasks/b.md": ["Pay?"] };
  const changes = [
    // newest first: a note that moved no ask says nothing
    {
      file: "tasks/a.md",
      before: card("Ship it?", "On a Friday?"),
      after: card("Ship it?", "On a Friday?"),
      by: "/agents/noter",
      via: null,
    },
    // an agent's session through a person's sign-in: the commit's Via line is the agent
    {
      file: "tasks/a.md",
      before: card("Ship it?"),
      after: card("Ship it?", "On a Friday?"),
      by: "jonas@x",
      via: "/agents/manager",
      committedAt: "t2",
      commitOid: "c2",
    },
    // an ask that is not open any more is no row
    {
      file: "tasks/a.md",
      before: card("Ship it?"),
      after: card("Ship it?", "Gone?"),
      by: "/agents/other",
      via: null,
    },
    // an agent's own turn: the platform's stamp is the agent
    {
      file: "tasks/a.md",
      before: null,
      after: card("Ship it?"),
      by: "/agents/worker",
      via: null,
      committedAt: "t1",
      commitOid: "c1",
    },
    // a person on the board: no agent
    {
      file: "tasks/b.md",
      before: card(),
      after: card("Pay?"),
      by: "misha@x",
      page: "tasks.iterate.com",
      via: null,
      committedAt: "t0",
      commitOid: "c0",
    },
    // a file that asks nothing now
    { file: "tasks/c.md", before: card(), after: card("Old?"), by: "/agents/worker", via: null },
  ];
  assert.deepEqual(askersOf(open, changes), {
    "tasks/a.md": {
      "On a Friday?": {
        agent: "/agents/manager",
        by: "jonas@x",
        page: null,
        at: "t2",
        commitOid: "c2",
        commitOffset: null,
      },
      "Ship it?": {
        agent: "/agents/worker",
        by: "/agents/worker",
        page: null,
        at: "t1",
        commitOid: "c1",
        commitOffset: null,
      },
    },
    "tasks/b.md": {
      "Pay?": {
        agent: null,
        by: "misha@x",
        page: "tasks.iterate.com",
        at: "t0",
        commitOid: "c0",
        commitOffset: null,
      },
    },
  });
  // an ask that was answered and asked again is its last asker's; a Via line that is no path names no agent
  const again = [
    { file: "tasks/b.md", before: card(), after: card("Pay?"), by: "jonas@x", via: "Claude Code" },
    { file: "tasks/b.md", before: card(), after: card("Pay?"), by: "/agents/first", via: null },
  ];
  assert.equal(askersOf(open, again)["tasks/b.md"]["Pay?"].agent, null);
  assert.equal(askersOf(open, again.toReversed())["tasks/b.md"]["Pay?"].agent, "/agents/first");
});

// A fake mind: one repo with a tasks folder, the feed's log and the catalog.
// `logs`: the events of any other context, by its path. `reads` are those of the feed's log alone.
function fakeMind({ files, events, listed = true, logs = {} }) {
  const reads = [];
  const appended = [];
  const itx = {
    repos: {
      list: async () => [{ path: "/repos/tasks" }],
      get: () => ({ tip: async () => "t1", modules: async () => files }),
    },
    contexts: { list: async () => (listed ? [{ path: "/task-files/tasks" }] : []) },
    cd: (path) => ({
      readEvents: async (after, limit) => {
        const all = path === "/task-files/tasks" ? events : (logs[path] ?? []);
        if (path === "/task-files/tasks") reads.push([path, after, limit]);
        return {
          events: all.filter((event) => event.offset > after).slice(0, limit),
          scannedThroughOffset: all.at(-1)?.offset ?? 0,
        };
      },
      append: async (event) => {
        appended.push([path, event]);
        if (path === "/task-files/tasks")
          events.push({ ...event, offset: (events.at(-1)?.offset ?? 0) + 1 });
      },
    }),
  };
  return { itx, reads, appended };
}

test("taskAskers: each open ask with its asker, which is not the task's assignee; an ask the feed does not have has none", async () => {
  const files = {
    "a.md":
      "---\nstatus: in-progress\nagent: /agents/worker\nhuman-ask:\n  - Ship it?\n  - An old one?\n---\n# A\n",
    "b.md": "---\nstatus: todo\nhuman-ask:\n  - Pay?\n---\n# B\n",
    "c.md": "---\nstatus: todo\n---\n# C\n",
  };
  const events = [
    change(1, "tasks/b.md", null, card("Pay?"), { by: "misha@x", page: "tasks.iterate.com" }),
    { type: "events.iterate.com/itx/woken", offset: 2, payload: {} },
    change(3, "tasks/a.md", card("An old one?"), card("Ship it?", "An old one?"), {
      by: "jonas@x",
      via: "/agents/manager",
    }),
  ];
  const { itx, reads } = fakeMind({ files, events });
  const answer = await taskAskers(itx);
  assert.deepEqual(answer, {
    repo: "/repos/tasks",
    asks: [
      {
        file: "tasks/a.md",
        ask: "Ship it?",
        agent: "/agents/manager",
        by: "jonas@x",
        page: null,
        at: "2026-11-20T16:00:03.000Z",
        message: null,
        model: null,
        blocking: null,
        assignee: "/agents/worker",
      },
      {
        file: "tasks/a.md",
        ask: "An old one?",
        agent: null,
        by: null,
        page: null,
        at: null,
        message: null,
        model: null,
        blocking: null,
        assignee: "/agents/worker",
      },
      {
        file: "tasks/b.md",
        ask: "Pay?",
        agent: null,
        by: "misha@x",
        page: "tasks.iterate.com",
        at: "2026-11-20T16:00:01.000Z",
        message: null,
        model: null,
        blocking: null,
        assignee: null,
      },
    ],
    readFrom: 0,
  });
  assert.deepEqual(reads.slice(1), [["/task-files/tasks", 0, 200]]);
});

test("taskAskers reads the feed from its end back, and stops when every ask has its asker", async () => {
  const files = { "a.md": "---\nstatus: todo\nhuman-ask:\n  - New?\n---\n# A\n" };
  const events = [];
  for (let offset = 1; offset <= 450; offset += 1)
    events.push(change(offset, "tasks/z.md", card(), card(), {}));
  events[429] = change(430, "tasks/a.md", card(), card("New?"), { by: "/agents/late" });
  events[9] = change(10, "tasks/a.md", card(), card("New?"), { by: "/agents/early" });
  const { itx, reads } = fakeMind({ files, events: [...events] }); // a copy: a call keeps what it looked up on the feed;
  const answer = await taskAskers(itx);
  assert.equal(answer.asks[0].agent, "/agents/late");
  assert.equal(answer.readFrom, 250);
  assert.deepEqual(reads.slice(1), [["/task-files/tasks", 250, 200]]);
  // an ask that only the log's start has is found by going back
  events[429] = change(430, "tasks/z.md", card(), card(), {});
  const far = fakeMind({ files, events });
  assert.equal((await taskAskers(far.itx)).asks[0].agent, "/agents/early");
  assert.deepEqual(
    far.reads.slice(1).map(([, after]) => after),
    [250, 50, 0],
  );
});

test("taskAskers reads no log that does not exist, and none for a board that asks nothing", async () => {
  const asking = {
    "a.md": "---\nstatus: todo\nagent: /agents/worker\nhuman-ask:\n  - New?\n---\n# A\n",
  };
  const unborn = fakeMind({ files: asking, events: [], listed: false });
  assert.deepEqual(await taskAskers(unborn.itx), {
    repo: "/repos/tasks",
    asks: [
      {
        file: "tasks/a.md",
        ask: "New?",
        agent: null,
        by: null,
        page: null,
        at: null,
        message: null,
        model: null,
        blocking: null,
        assignee: "/agents/worker",
      },
    ],
    readFrom: null,
  });
  assert.deepEqual(unborn.reads, []);
  const quiet = fakeMind({
    files: { "c.md": "# C\n" },
    events: [change(1, "tasks/c.md", null, card(), {})],
  });
  assert.deepEqual(await taskAskers(quiet.itx), { repo: "/repos/tasks", asks: [], readFrom: null });
  assert.deepEqual(quiet.reads, []);
  await assert.rejects(taskAskers(quiet.itx, "tasks"), /takes \{ repo\? \}/);
  await assert.rejects(
    taskAskers(quiet.itx, { repo: "none" }),
    /the mind has no repo \/repos\/none/,
  );
});

test("the message that asked: the commit's cause for an agent's own turn, else the session's event that holds the ask's words", async () => {
  assert.equal(
    needleOf("Jonas: for Xero, pay for [Xero's Core plan](https://x) or not?"),
    "Jonas: for Xero, pay for [Xero",
  );
  assert.equal(needleOf("Ship it?"), null);
  const at = "2026-11-20T16:00:00.000Z";
  const hook = (offset, seconds, words, call = "taskUpdate") => ({
    offset,
    createdAt: new Date(Date.parse(at) + seconds * 1000).toISOString(),
    payload: { tool_input: { script: `${call}({ ask: "${words}" })` } },
  });
  const logs = {
    // the repo's log: the fact of an agent's own commit names its cause; a session's names none
    "/repos/tasks": [
      { offset: 7, source: { cause: { parent: "/agents/worker@41" } } },
      { offset: 8, source: { onBehalfOf: { principal: { email: "jonas@x" } } } },
      { offset: 9, source: { cause: { parent: "/agents/other@5" } } },
    ],
    "/agents/worker": [
      {
        offset: 41,
        createdAt: at,
        payload: { text: 'taskUpdate({ ask: "Ship it or wait a day?" })' },
      },
    ],
    "/agents/claude/session": [
      ...Array.from({ length: 30 }, (_, n) =>
        hook(n + 1, -4000 + n, "Jonas: may the demo be erased on 27 Nov?"),
      ),
      hook(31, -200, "Jonas: may the demo be erased on 27 Nov?"),
      hook(32, -40, "Jonas: may the demo be erased on 27 Nov?"),
      hook(33, -3, "Jonas: may the demo be erased on 27 Nov?"),
      // an event that only quotes the ask writes nothing; one after the commit is another call
      hook(34, -1, "Jonas: may the demo be erased on 27 Nov?", "said"),
      hook(35, 9, "Jonas: may the demo be erased on 27 Nov?"),
      hook(36, 500, "Jonas: may the demo be erased on 27 Nov?"),
    ],
  };
  const { itx } = fakeMind({ files: {}, events: [], logs });
  assert.deepEqual(
    await locateAsk(itx, "/repos/tasks", "Ship it or wait a day?", {
      agent: "/agents/worker",
      at,
      commitOffset: 7,
    }),
    { path: "/agents/worker", offset: 41, words: true },
  );
  // code that an event set off wrote the ask: the event led to it, and does not hold its words
  assert.deepEqual(
    await locateAsk(itx, "/repos/tasks", "Should this mind be let in?", {
      agent: "/agents/worker",
      at,
      commitOffset: 7,
    }),
    { path: "/agents/worker", offset: 41, words: false },
  );
  // the words in a call that writes an ask: the last such event of the two minutes before the commit
  assert.deepEqual(
    await locateAsk(itx, "/repos/tasks", "Jonas: may the demo be erased on 27 Nov?", {
      agent: "/agents/claude/session",
      at,
      commitOffset: 8,
    }),
    { path: "/agents/claude/session", offset: 33, words: true },
  );
  assert.equal(
    await locateAsk(itx, "/repos/tasks", "Jonas: another question entirely?", {
      agent: "/agents/claude/session",
      at,
      commitOffset: 8,
    }),
    null,
  );
  // a cause that is another context's is not the asker's message; no agent, no log, no time: none
  assert.equal(
    await locateAsk(itx, "/repos/tasks", "Jonas: may the demo be erased on 27 Nov?", {
      agent: "/agents/gone",
      at,
      commitOffset: 9,
    }),
    null,
  );
  assert.equal(
    await locateAsk(itx, "/repos/tasks", "Jonas: may the demo be erased on 27 Nov?", {
      agent: null,
      at,
      commitOffset: 7,
    }),
    null,
  );
  assert.equal(
    await locateAsk(itx, "/repos/tasks", "Jonas: may the demo be erased on 27 Nov?", {
      agent: "/agents/claude/session",
      at: null,
      commitOffset: null,
    }),
    null,
  );
});

test("taskAskers answers each ask's message, looks one up once and keeps the answer on the feed", async () => {
  const files = {
    "a.md":
      "---\nstatus: todo\nhuman-ask:\n  - Ship it or wait a day?\n  - Jonas, is this one found?\n---\n# A\n",
  };
  const events = [
    change(1, "tasks/a.md", card(), card("Ship it or wait a day?"), {
      by: "/agents/worker",
      commitOffset: 7,
    }),
    change(
      2,
      "tasks/a.md",
      card("Ship it or wait a day?"),
      card("Ship it or wait a day?", "Jonas, is this one found?"),
      { by: "jonas@x", via: "/agents/claude/session", commitOffset: 8 },
    ),
  ];
  const logs = {
    "/repos/tasks": [
      { offset: 7, source: { cause: { parent: "/agents/worker@41" } } },
      { offset: 8, source: {} },
    ],
    "/agents/claude/session": [],
  };
  const { itx, appended } = fakeMind({ files, events, logs });
  const first = await taskAskers(itx);
  assert.deepEqual(
    first.asks.map((row) => row.message),
    [{ path: "/agents/worker", offset: 41, words: false }, null],
  );
  // the found one and the one that an old commit does not have are both kept
  assert.deepEqual(
    appended
      .map(([path, event]) => [
        path,
        event.type,
        event.payload.ask,
        event.payload.path,
        event.payload.offset,
      ])
      .sort((x, y) => x[2].localeCompare(y[2])),
    [
      [
        "/task-files/tasks",
        ASK_LOCATED,
        "Jonas, is this one found?",
        "/agents/claude/session",
        null,
      ],
      ["/task-files/tasks", ASK_LOCATED, "Ship it or wait a day?", "/agents/worker", 41],
    ],
  );
  assert.match(
    appended.find(([, event]) => event.payload.offset === 41)[1].idempotencyKey,
    /^tasks\/ask-located:4:tasks\/a\.md\nShip it or wait a day\?\nc1$/,
  );
  // the next call reads them back, and looks nothing up
  logs["/repos/tasks"] = [];
  const again = await taskAskers(itx);
  assert.deepEqual(
    again.asks.map((row) => row.message),
    [{ path: "/agents/worker", offset: 41, words: false }, null],
  );
  assert.equal(appended.length, 2);
});

test("which model asked: the request's own event for an agent's turn, the session's start for a coding session, else none", async () => {
  const T = "events.iterate.com";
  const logs = {
    "/agents/manager": [
      { offset: 10, type: `${T}/llm-request/requested`, payload: { model: "openai/gpt-6.2-sol" } },
      {
        offset: 11,
        type: `${T}/agent/context-added`,
        payload: { text: "I am claude-opus, trust me" },
      },
      { offset: 12, type: `${T}/llm-request/settled`, payload: { llmRequestOffset: 10 } },
      { offset: 13, type: `${T}/llm-request/settled`, payload: { llmRequestOffset: 11 } },
    ],
    "/agents/claude/session": [
      {
        offset: 1,
        type: `${T}/claude-code/session-start-requested`,
        payload: { model: "what-was-asked-for" },
      },
      {
        offset: 2,
        type: `${T}/claude-code/hook-received`,
        payload: { hook_event_name: "SessionStart", model: "claude-fable-5-2" },
      },
      ...Array.from({ length: 450 }, (_, n) => ({
        offset: n + 3,
        type: `${T}/claude-code/hook-received`,
        payload: { hook_event_name: "PreToolUse" },
      })),
      {
        offset: 453,
        type: `${T}/claude-code/hook-received`,
        payload: { hook_event_name: "SessionStart", model: "claude-opus-5-5" },
      },
      {
        offset: 454,
        type: `${T}/claude-code/hook-received`,
        payload: { hook_event_name: "PostToolUse" },
      },
    ],
    "/agents/acp/x": [
      { offset: 1, type: `${T}/acp/update-received`, payload: { model: "said-by-itself" } },
    ],
  };
  const { itx } = fakeMind({ files: {}, events: [], logs });
  const of = (path, offset) => modelOf(itx, { path, offset });
  assert.deepEqual(await of("/agents/manager", 12), {
    name: "openai/gpt-6.2-sol",
    from: "llm-request",
  });
  assert.deepEqual(await of("/agents/manager", 10), {
    name: "openai/gpt-6.2-sol",
    from: "llm-request",
  });
  // a request offset that is no request, and an event that only talks of a model: unrecorded
  assert.equal(await of("/agents/manager", 13), null);
  assert.equal(await of("/agents/manager", 11), null);
  // the newest start BEFORE the turn; what was asked for at the start is not read
  assert.deepEqual(await of("/agents/claude/session", 454), {
    name: "claude-opus-5-5",
    from: "session-start",
  });
  assert.deepEqual(await of("/agents/claude/session", 400), {
    name: "claude-fable-5-2",
    from: "session-start",
  });
  assert.equal(await of("/agents/acp/x", 1), null);
  assert.equal(await of("/agents/gone", 5), null);
  assert.equal(await modelOf(itx, null), null);
});

test("taskAskers answers the model of each ask's turn, and keeps it with the message", async () => {
  const files = { "a.md": "---\nstatus: todo\nhuman-ask:\n  - Ship it or wait a day?\n---\n# A\n" };
  const events = [
    change(1, "tasks/a.md", card(), card("Ship it or wait a day?"), {
      by: "/agents/worker",
      commitOffset: 7,
    }),
  ];
  const logs = {
    "/repos/tasks": [{ offset: 7, source: { cause: { parent: "/agents/worker@41" } } }],
    "/agents/worker": [
      {
        offset: 40,
        type: "events.iterate.com/llm-request/requested",
        payload: { model: "openai/gpt-6.2-sol" },
      },
      {
        offset: 41,
        type: "events.iterate.com/llm-request/settled",
        payload: {
          llmRequestOffset: 40,
          result: { text: 'taskUpdate({ ask: "Ship it or wait a day?" })' },
        },
      },
    ],
  };
  const { itx, appended } = fakeMind({ files, events, logs });
  const row = (await taskAskers(itx)).asks[0];
  assert.deepEqual(
    [row.message, row.model],
    [
      { path: "/agents/worker", offset: 41, words: true },
      { name: "openai/gpt-6.2-sol", from: "llm-request" },
    ],
  );
  assert.deepEqual(appended[0][1].payload.model, {
    name: "openai/gpt-6.2-sol",
    from: "llm-request",
  });
  logs["/agents/worker"] = [];
  assert.deepEqual((await taskAskers(itx)).asks[0].model, {
    name: "openai/gpt-6.2-sol",
    from: "llm-request",
  });
});

test("the agent's blocking message: the request's own text, or a session's first Stop after the ask", async () => {
  const T = "events.iterate.com";
  const hook = (offset, name, more = {}) => ({
    offset,
    type: `${T}/claude-code/hook-received`,
    payload: { hook_event_name: name, ...more },
  });
  const logs = {
    "/agents/manager": [
      {
        offset: 12,
        type: `${T}/llm-request/settled`,
        payload: {
          result: {
            text: "I need a yes.\n<codemode>\nitx.config.taskUpdate({ ask: 'x' })\n</codemode>\n\n\n\nThen I go on.",
          },
        },
      },
      {
        offset: 13,
        type: `${T}/llm-request/settled`,
        payload: { result: { text: "<codemode>only a script</codemode>" } },
      },
    ],
    "/agents/claude/done": [
      hook(5, "PreToolUse"),
      hook(6, "PostToolUse"),
      hook(7, "PreToolUse"),
      hook(8, "Stop", { last_assistant_message: "The link is ready.\n\nSay yes or no." }),
      hook(9, "Stop", { last_assistant_message: "a later turn" }),
    ],
    "/agents/claude/working": [hook(5, "PreToolUse"), hook(6, "PostToolUse")],
    "/agents/claude/interrupted": [
      hook(5, "PreToolUse"),
      hook(6, "UserPromptSubmit", { prompt: "stop" }),
      hook(7, "Stop", { last_assistant_message: "of the next turn" }),
    ],
    "/agents/acp/x": [{ offset: 1, type: `${T}/acp/update-received`, payload: {} }],
  };
  const { itx } = fakeMind({ files: {}, events: [], logs });
  const now = Date.parse("2026-11-25T12:00:00Z");
  const of = (path, offset, askedAt = "2026-11-25T11:00:00Z") =>
    blockingOf(itx, { path, offset }, askedAt, now);
  assert.deepEqual(await of("/agents/manager", 12), {
    path: "/agents/manager",
    offset: 12,
    text: "I need a yes.\n\nThen I go on.",
  });
  assert.equal(await of("/agents/manager", 13), null);
  assert.deepEqual(await of("/agents/claude/done", 5), {
    path: "/agents/claude/done",
    offset: 8,
    text: "The link is ready.\n\nSay yes or no.",
  });
  // the turn has not ended: it may still come; a day later it will not
  assert.equal(await of("/agents/claude/working", 5), undefined);
  assert.equal(await of("/agents/claude/working", 5, "2026-11-23T11:00:00Z"), null);
  // the person spoke before the turn ended; a kind with no such event; no event there
  assert.equal(await of("/agents/claude/interrupted", 5), null);
  assert.equal(await of("/agents/acp/x", 1), null);
  assert.equal(await of("/agents/gone", 3), null);
  // a long message is cut at a word
  logs["/agents/long"] = [
    {
      offset: 1,
      type: `${T}/llm-request/settled`,
      payload: { result: { text: "word ".repeat(2000) } },
    },
  ];
  const long = await of("/agents/long", 1);
  assert.ok(long.text.length <= 4002 && long.text.endsWith(" …"));
});

test("taskAskers answers the blocking message when the turn has ended, and keeps it", async () => {
  const T = "events.iterate.com";
  const files = {
    "a.md": "---\nstatus: todo\nhuman-ask:\n  - Jonas, may the demo be erased?\n---\n# A\n",
  };
  const events = [
    change(1, "tasks/a.md", card(), card("Jonas, may the demo be erased?"), {
      by: "jonas@x",
      via: "/agents/claude/s",
      commitOffset: 8,
      committedAt: new Date().toISOString(),
    }),
  ];
  // the ask is of this minute: an ask of a day ago with no Stop has no blocking message for good
  const at = events[0].payload.committedAt;
  const hook = (offset, name, more = {}) => ({
    offset,
    createdAt: at,
    type: `${T}/claude-code/hook-received`,
    payload: { hook_event_name: name, ...more },
  });
  const logs = {
    "/repos/tasks": [{ offset: 8, source: {} }],
    "/agents/claude/s": [
      hook(1, "SessionStart", { model: "claude-fable-5-2" }),
      hook(2, "PreToolUse", {
        tool_input: { script: 'taskUpdate({ ask: "Jonas, may the demo be erased?" })' },
      }),
    ],
  };
  const { itx, appended } = fakeMind({ files, events, logs });
  // the turn still runs: a message, a model, and no blocking message yet
  const first = (await taskAskers(itx)).asks[0];
  assert.deepEqual(
    [first.message, first.model, first.blocking],
    [
      { path: "/agents/claude/s", offset: 2, words: true },
      { name: "claude-fable-5-2", from: "session-start" },
      null,
    ],
  );
  assert.equal(appended.length, 1);
  // the turn ended: the next read finds it and keeps it
  logs["/agents/claude/s"].push(
    hook(3, "Stop", { last_assistant_message: "The demo holds nothing of yours. Erase it?" }),
  );
  const second = (await taskAskers(itx)).asks[0];
  assert.deepEqual(second.blocking, {
    path: "/agents/claude/s",
    offset: 3,
    text: "The demo holds nothing of yours. Erase it?",
  });
  assert.deepEqual(second.model, { name: "claude-fable-5-2", from: "session-start" });
  assert.equal(appended.length, 2);
  assert.match(appended[1][1].idempotencyKey, /:blocking$/);
  // and the read after that looks nothing up
  logs["/agents/claude/s"] = [];
  const third = (await taskAskers(itx)).asks[0];
  assert.deepEqual([third.blocking.offset, third.message.offset], [3, 2]);
  assert.equal(appended.length, 2);
});
