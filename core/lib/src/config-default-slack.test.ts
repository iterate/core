// The default config's Slack agent (core/configs/default/slack.ts): which deliveries reach an
// agent, the agent's path for a thread, and the call that answers through the vault.
import { expect, test } from "vitest";
import { callSlack, slackContentOf, slackMessageOf } from "../../configs/default/slack.ts";

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
