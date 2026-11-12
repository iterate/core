// The default config's Slack agent (core/configs/default/slack.ts): which deliveries reach an
// agent, the agent's path for a thread, and the call that answers through the vault.
import { expect, test } from "vitest";
import {
  callSlack,
  refuseSlackSender,
  slackContentOf,
  slackMessageOf,
  slackSenderIsMember,
  slackSenderMay,
} from "../../configs/default/slack.ts";

test("a mention starts the agent of its own thread", () => {
  const message = slackMessageOf(
    delivery({ type: "app_mention", ts: "17.000100", text: "<@UBOT> hi" }),
  );
  expect(message).toMatchObject({
    agent: "/agents/slack/T1/C1/17-000100",
    idempotencyKey: "slack:C1:17.000100",
    starts: true,
    thread: "17.000100",
  });
  expect(slackContentOf(message!)).toContain(
    'await itx.config.slack("chat.postMessage", { channel: "C1", thread_ts: "17.000100", text })',
  );
});

test("a later message of the thread has the same agent, and starts none", () => {
  const message = slackMessageOf(
    delivery({ type: "message", ts: "18.000200", thread_ts: "17.000100", text: "and this?" }),
  );
  expect(message).toMatchObject({
    agent: "/agents/slack/T1/C1/17-000100",
    starts: false,
    idempotencyKey: "slack:C1:18.000200",
  });
});

test("a direct message starts an agent with no mention", () => {
  expect(
    slackMessageOf(delivery({ type: "message", channel_type: "im", channel: "D1", ts: "19.1" })),
  ).toMatchObject({ agent: "/agents/slack/T1/D1/19-1", starts: true });
});

test.for([
  ["the bot's own words", { type: "message", ts: "1.1", user: "UBOT" }],
  ["a bot's message", { type: "message", ts: "1.1", bot_id: "B1" }],
  ["an edit", { type: "message", ts: "1.1", subtype: "message_changed" }],
  ["an event that is no message", { type: "reaction_added", ts: "1.1" }],
] as const)("%s reaches no agent", ([, event]) => {
  expect(slackMessageOf(delivery(event))).toBeNull();
});

test("a person of another workspace, in a shared channel, reaches no agent", () => {
  expect(
    slackMessageOf(delivery({ type: "app_mention", ts: "20.1", user_team: "T-OTHER" })),
  ).toBeNull();
  // the workspace's own person, as Slack names their team
  expect(
    slackMessageOf(delivery({ type: "app_mention", ts: "20.1", user_team: "T1" })),
  ).toMatchObject({ teamId: "T1", user: "U1" });
});

test("a full member of the workspace with a confirmed email may instruct an agent, and Slack is asked once", async () => {
  const mind = slackMind({
    team_id: "T1",
    is_email_confirmed: true,
    profile: { email: "Ada@Example.com" },
  });
  expect(await slackSenderMay(mind, { teamId: "T1", user: "U1" }, 1000)).toBe("ada@example.com");
  expect(await slackSenderMay(mind, { teamId: "T1", user: "U1" }, 2000)).toBe("ada@example.com");
  expect(mind.calls.map(({ method, form }) => [method, form.user])).toEqual([["users.info", "U1"]]);
  // the answer is kept for ten minutes, and asked for again after
  await slackSenderMay(mind, { teamId: "T1", user: "U1" }, 1000 + 10 * 60_000 + 1);
  expect(mind.calls).toHaveLength(2);
});

test.for([
  ["a bot", { is_bot: true }],
  ["an app's user", { is_app_user: true }],
  ["a guest of several channels", { is_restricted: true }],
  ["a guest of one channel", { is_restricted: true, is_ultra_restricted: true }],
  ["a person of another workspace", { is_stranger: true }],
  ["a user of another team", { team_id: "T-OTHER" }],
  ["a deactivated user", { deleted: true }],
  ["a user whose email Slack did not confirm", { is_email_confirmed: false }],
  ["a user with no email", { profile: {} }],
] as const)("%s may not instruct an agent", async ([, facts]) => {
  const mind = slackMind({
    team_id: "T1",
    is_email_confirmed: true,
    profile: { email: "eve@example.com" },
    ...facts,
  });
  expect(await slackSenderMay(mind, { teamId: "T1", user: "U1" })).toBeNull();
});

test("a workspace member who is no member of the mind instructs no agent, and a member does", async () => {
  const ada = { team_id: "T1", is_email_confirmed: true, profile: { email: "ada@example.com" } };
  const asked: string[] = [];
  const mindWith = (members: string[], user: Record<string, unknown> = ada) => ({
    ...slackMind(user),
    members: {
      has: async (email: string) => {
        asked.push(email);
        return members.includes(email);
      },
    },
  });
  const message = { teamId: "T1", user: "U1" };
  expect(await slackSenderIsMember(mindWith(["ada@example.com"]), message)).toBe(true);
  expect(await slackSenderIsMember(mindWith(["grace@example.com"]), message)).toBe(false);
  // membership is asked for each message: one mind, two messages, two questions
  const mind = mindWith(["ada@example.com"]);
  await slackSenderIsMember(mind, message);
  await slackSenderIsMember(mind, message);
  expect(asked).toEqual(Array(4).fill("ada@example.com"));
  // a guest is refused by Slack's record alone: the stack is not asked
  const guest = mindWith(["ada@example.com"], { ...ada, is_restricted: true });
  expect(await slackSenderIsMember(guest, message)).toBe(false);
  expect(asked).toHaveLength(4);
});

test("a kept value of another shape is read as none kept, and Slack is asked", async () => {
  const mind = slackMind({
    team_id: "T1",
    is_email_confirmed: true,
    profile: { email: "ada@example.com" },
  });
  for (const kept of [JSON.stringify({ member: true }), "not json", JSON.stringify("text")]) {
    await mind.kv.put("slack-sender:T1:U1", kept);
    expect(await slackSenderMay(mind, { teamId: "T1", user: "U1" })).toBe("ada@example.com");
  }
  expect(mind.calls).toHaveLength(3);
});

test("when Slack does not answer, nobody may, and the next message asks again", async () => {
  const mind = slackMind(null);
  expect(await slackSenderMay(mind, { teamId: "T1", user: "U1" })).toBeNull();
  expect(await slackSenderMay(mind, { teamId: "T1", user: "U1" })).toBeNull();
  expect(mind.calls).toHaveLength(2);
});

test("a refused mention gets one short answer for its thread, and other words of a thread get none", async () => {
  const mind = slackMind(null);
  const mention = { teamId: "T1", channel: "C1", thread: "17.000100", starts: true };
  await refuseSlackSender(mind, mention);
  await refuseSlackSender(mind, mention);
  await refuseSlackSender(mind, { ...mention, thread: "18.000200", starts: false });
  expect(mind.calls.map(({ method, form }) => [method, form.channel, form.thread_ts])).toEqual([
    ["chat.postMessage", "C1", "17.000100"],
  ]);
});

test("a call goes to Slack's method with the secret named, never the token", async () => {
  const requests: Request[] = [];
  const answer = await callSlack(
    {
      fetch: async (request) => {
        requests.push(request);
        return Response.json({ ok: true });
      },
    },
    "chat.postMessage",
    { channel: "C1", text: "hello", unfurl_links: false, blocks: [{ type: "divider" }] },
  );
  expect(answer).toEqual({ ok: true });
  expect(requests[0]).toMatchObject({ url: "https://slack.com/api/chat.postMessage" });
  expect(requests[0]!.headers.get("authorization")).toBe(
    'Bearer getSecret("/secrets/slack", { field: "accessToken" })',
  );
  // a form, as Slack's SDK sends it: text as it is, anything else as its JSON
  expect(Object.fromEntries(new URLSearchParams(await requests[0]!.text()))).toEqual({
    channel: "C1",
    text: "hello",
    unfurl_links: "false",
    blocks: '[{"type":"divider"}]',
  });
  await expect(callSlack({ fetch }, "../oauth.v2.access")).rejects.toThrow(/no Slack method/);
});

// Slack's delivery as iterate Cloud relays it, with one event in channel C1 from user U1.
function delivery(event: Record<string, unknown>) {
  return {
    teamId: "T1",
    slackRequestTimestamp: "1",
    body: { authorizations: [{ user_id: "UBOT" }], event: { channel: "C1", user: "U1", ...event } },
  };
}

/** The part of a mind that slack.ts uses: a key-value store in memory, and a Slack that answers
 *  `users.info` with `user` (null: Slack refuses) and records each call. */
function slackMind(user: Record<string, unknown> | null) {
  const kept = new Map<string, string>();
  const calls: { method: string; form: Record<string, string> }[] = [];
  return {
    calls,
    kv: {
      get: async (key: string) => kept.get(key) ?? null,
      put: async (key: string, value: string) => void kept.set(key, value),
    },
    fetch: async (request: Request) => {
      const method = new URL(request.url).pathname.replace("/api/", "");
      calls.push({ method, form: Object.fromEntries(new URLSearchParams(await request.text())) });
      if (method !== "users.info") return Response.json({ ok: true });
      return Response.json(user ? { ok: true, user } : { ok: false, error: "user_not_found" });
    },
  };
}
