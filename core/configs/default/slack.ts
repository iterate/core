// slack.ts — THE SLACK AGENT (worker.ts, `slack/webhook-received`): one agent for each Slack
// thread, at `/agents/slack/<team>/<channel>/<thread>`. A mention starts one, and every later
// message of that thread reaches the same agent. The agent answers by calling Slack's Web API
// itself, through `itx.config.slack(method, args)`: the token stays in the vault.
//
// WHOSE WORDS REACH AN AGENT: an agent holds the whole `itx`, so a message is an instruction with
// the mind's full reach. Only a full member of the workspace with an email that Slack confirmed
// gets one (`slackSenderMay`): never a bot, an app, a guest, or a person of another workspace in
// a shared channel.

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
      /** The sender's own workspace: another's than `teamId` in a channel shared by Slack Connect. */
      user_team?: string;
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
  // a person of another workspace, in a channel shared by Slack Connect
  if (event.user_team && event.user_team !== teamId) return null;
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
    teamId,
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

/** What this module needs of the mind: Slack through the vault, and a few kept strings. */
type SlackItx = {
  fetch(request: Request): Promise<Response>;
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
  };
};

/** How long Slack's answer about one user is kept: a person who became a guest, or left, is
 *  refused within this time. */
const SENDER_KEPT_MS = 10 * 60_000;

/** Slack's own record of a user (`users.info`), the part read here. */
type SlackUser = {
  team_id?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  /** A guest, of several channels or of one. */
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  /** A person of another workspace, seen through a shared channel. */
  is_stranger?: boolean;
  is_email_confirmed?: boolean;
  profile?: { email?: string };
};

/** THE EMAIL OF A SENDER WHOSE WORDS MAY REACH AN AGENT, or null: a full member of this
 *  workspace, as Slack's own record says, with an email that Slack confirmed. A bot, an app, a
 *  guest, a deactivated user and a person of another workspace get null, and so does anyone when
 *  Slack does not answer: no answer is no permission. Kept for ten minutes for each user. */
export async function slackSenderMay(
  itx: SlackItx,
  message: { teamId: string; user: string },
  now = Date.now(),
): Promise<string | null> {
  const key = `slack-sender:${message.teamId}:${message.user}`;
  const kept = JSON.parse((await itx.kv.get(key)) || "null") as {
    email: string | null;
    until: number;
  } | null;
  if (kept && kept.until > now) return kept.email;
  const answer = (await callSlack(itx, "users.info", { user: message.user })) as {
    ok?: boolean;
    user?: SlackUser;
  };
  // a call that Slack refused is not kept: the next message asks again
  if (!answer.ok || !answer.user) return null;
  const who = answer.user;
  const full =
    who.team_id === message.teamId &&
    !who.deleted &&
    !who.is_bot &&
    !who.is_app_user &&
    !who.is_restricted &&
    !who.is_ultra_restricted &&
    !who.is_stranger &&
    who.is_email_confirmed === true;
  const email = (full && who.profile?.email?.trim().toLowerCase()) || null;
  await itx.kv.put(key, JSON.stringify({ email, until: now + SENDER_KEPT_MS }));
  return email;
}

/** ONE SHORT ANSWER to a person whose mention or direct message starts no agent, once for each
 *  thread. Their other words in a thread get no answer. */
export async function refuseSlackSender(
  itx: SlackItx,
  message: { teamId: string; channel: string; thread: string; starts: boolean },
) {
  if (!message.starts) return;
  const key = `slack-refused:${message.teamId}:${message.channel}:${message.thread}`;
  if (await itx.kv.get(key)) return;
  await itx.kv.put(key, "1");
  await callSlack(itx, "chat.postMessage", {
    channel: message.channel,
    thread_ts: message.thread,
    text: "I take instructions only from full members of this workspace, not from guests, apps or people of another workspace.",
  });
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
