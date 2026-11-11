// slack.ts — THE SLACK AGENT (worker.ts, `slack/webhook-received`): one agent for each Slack
// thread, at `/agents/slack/<team>/<channel>/<thread>`. A mention starts one, and every later
// message of that thread reaches the same agent. The agent answers by calling Slack's Web API
// itself, through `itx.config.slack(method, args)`: the token stays in the vault.

/** The secret a member linked the workspace into, through iterate Cloud's Slack app. */
const SLACK_SECRET = "/secrets/slack";

/** Slack's Events API delivery as iterate Cloud relays it, the part read here. */
type SlackDelivery = {
  teamId?: string;
  body?: {
    authorizations?: { user_id?: string }[];
    event?: {
      type?: string;
      subtype?: string;
      channel?: string;
      channel_type?: string;
      user?: string;
      bot_id?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
    };
  };
};

/** What one Slack message is to this mind, or null for a delivery no agent sees: an event that is
 *  no message, an edit or a join (a `subtype`), and the bot's own words. */
export function slackMessageOf(payload: unknown) {
  const { teamId, body } = (payload || {}) as SlackDelivery;
  const event = body?.event;
  if (!teamId || !event?.channel || !event.ts || !event.user) return null;
  if (event.type !== "app_mention" && event.type !== "message") return null;
  if (event.subtype || event.bot_id) return null;
  if (body?.authorizations?.some((authorization) => authorization.user_id === event.user))
    return null;
  // a message outside a thread starts one: Slack's thread is named by its first message's `ts`
  const thread = event.thread_ts || event.ts;
  return {
    /** A path segment takes no dot: the thread's `ts` with a dash in the dot's place. */
    agent: `/agents/slack/${teamId}/${event.channel}/${thread.replace(".", "-")}`,
    /** One event for one message: a mention in a channel the bot reads arrives twice. */
    idempotencyKey: `slack:${event.channel}:${event.ts}`,
    /** A mention, or a direct message: these start an agent. Any other message reaches an agent
     *  only when its thread has one. */
    starts: event.type === "app_mention" || event.channel_type === "im",
    channel: event.channel,
    thread,
    user: event.user,
    text: event.text || "",
  };
}

/** What the agent reads: who said what, and how to answer. */
export function slackContentOf(message: NonNullable<ReturnType<typeof slackMessageOf>>) {
  const answer = `await itx.config.slack("chat.postMessage", { channel: ${JSON.stringify(message.channel)}, thread_ts: ${JSON.stringify(message.thread)}, text })`;
  return [
    `Slack message from <@${message.user}> in channel ${message.channel}:`,
    message.text || "(no text)",
    `Answer in this thread with \`${answer}\`. Your words reach nobody otherwise. \`itx.config.slack(method, args)\` calls any method of Slack's Web API (https://docs.slack.dev/reference/methods) the same way and answers Slack's JSON: \`reactions.add\`, \`conversations.replies\` to read the thread, \`users.info\` for who <@${message.user}> is.`,
  ].join("\n\n");
}

/** One call of Slack's Web API through the vault: `POST https://slack.com/api/<method>`, the
 *  arguments as a form, as Slack's own SDK sends them: a method that reads takes no JSON body. A
 *  value that is no text (`blocks`, a list) goes as its JSON. The header names the secret, and the
 *  door puts the token in. */
export async function callSlack(
  itx: { fetch(request: Request): Promise<Response> },
  method: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if (!/^[a-zA-Z]+(\.[a-zA-Z]+)+$/.test(method))
    throw new Error(`${JSON.stringify(method)} is no Slack method: a name like chat.postMessage`);
  const form = new URLSearchParams();
  // through JSON first, so that an argument left undefined is no argument
  for (const [name, value] of Object.entries(JSON.parse(JSON.stringify(args)) as object))
    form.set(name, typeof value === "string" ? value : JSON.stringify(value));
  const answer = await itx.fetch(
    new Request(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer getSecret(${JSON.stringify(SLACK_SECRET)}, { field: "accessToken" })`,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: form.toString(),
    }),
  );
  return await answer.json();
}
