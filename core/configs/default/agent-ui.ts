// agent-ui.ts — THE DASH'S CHAT IS A CHANNEL. A channel has raw facts in a namespace of its own: the
// three of the web and mobile UI are below. No processor runs them: they are a vocabulary, as the
// LLM request protocol is (agent/llm-request.ts). The agent's own contract names no channel.
//
//   agent-ui/message-received { message, files?, client? }
//       What the chat's composer creates, on the agent's own context, with the message's files
//       stored first (the kit's AgentChat). The platform stamps who wrote it (`event.source`).
//   agent-ui/agent-requested { model? }
//       Start the agent at this path, on `model` if it names one, with no words yet.
//   agent-ui/message-sent { message }
//       The agent's script: words for a person in the web or mobile UI (`WEB_MESSAGES`).
//
// The mind reads the first two and appends the agent's one input, `agent/context-added`, in words
// that say who sent them and where. It reads the platform's own channel the same way:
//
//   agent/message-received { message, files?, from?, trigger? }
//       `itx.agents.get(path).message()`. Other kinds of agent, a tool, and a page that cannot
//       store files use it. It is not this file's fact.
//
// `agentUiContext` and `agentsApiContext` are THE TRANSCRIPTION: each gives the payload of ONE
// `agent/context-added` of role `user`. ITS FIRST LINE IS THE MIND'S: who sent the words, through
// what and when, and where the raw fact is. EVERYTHING AFTER THE FIRST LINE IS THE SENDER'S TEXT.
// The boundary is the position, and nothing a sender writes can stand before the first line: so
// no text of theirs, in any spelling, can pass as the mind's line. (The line stood last before,
// with a mark on words that imitated it: a look-alike in other characters got no mark.) `source` names the raw fact, so the log
// keeps both: what happened, and what the model was told. The kind `agent` appends it
// (agent-kinds/agent.ts `processEvent`), under the key `transcriptionKey`.
import { z } from "zod";

const T = "events.iterate.com/";

/** A file in the mind's file store, by reference: the four fields the Dash needs to draw it. */
const FileAttachment = z.object({
  contentType: z.string().min(1),
  filename: z.string().min(1),
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
});

/** The payload of `agent-ui/message-received`. */
const AgentUiMessage = z.object({
  message: z.string(),
  files: z.array(FileAttachment).optional(),
  /** What the browser says of itself. None: the web. */
  client: z.enum(["web", "mobile"]).optional(),
});

/** The payload of `agent-ui/agent-requested`: start an agent here, on this model. */
const AgentUiAgentRequested = z.object({
  model: z
    .string()
    .regex(/^[a-z0-9-]+\/.+$/)
    .optional(),
});

/** Words for a person in front of the web or mobile UI: the prompt fragment of this channel
 *  (agent/fragments.ts). */
export const WEB_MESSAGES = [
  "A person reads your feed in the web or mobile UI. To say words to them, a script appends one",
  "fact to your own log. Nothing else you write reaches them:",
  "",
  "<codemode>",
  'const files = await itx.repos.get("/repos/config").files();',
  'itx.append({ type: "events.iterate.com/agent-ui/message-sent", payload: { message: `The config has ${Object.keys(files).length} files.` } });',
  "</codemode>",
].join("\n");

/** The config of an agent that `agent-ui/agent-requested` asks for, or null for a payload that is
 *  not this fact's. */
export function agentUiStartConfig(event: { payload?: unknown }): Record<string, unknown> | null {
  const parsed = AgentUiAgentRequested.safeParse(event.payload);
  if (!parsed.success) return null;
  return parsed.data.model ? { llm: { model: parsed.data.model } } : {};
}

/** The payload of the platform's `agent/message-received` (iterate/agents: what
 *  `itx.agents.get(path).message()` appends). */
const AgentsApiMessage = z.object({
  message: z.string(),
  files: z.array(FileAttachment).optional(),
  /** The context that sent it, when another agent did. */
  from: z.string().optional(),
  trigger: z.literal(false).optional(),
});

type Principal = {
  actor: string;
  email?: string;
  name?: string;
  kind?: string;
  hostname?: string;
  impersonatedBy?: { actor: string; email: string };
};
/** The platform's stamp on an event, the fields this file reads. */
type Stamp = {
  principal?: Principal;
  onBehalfOf?: { principal: Principal; run?: string; call?: string };
  signer?: { principal: Principal };
  schedule?: unknown;
  copiedFrom?: unknown;
  platform?: boolean;
};
export type RawFact = {
  type: string;
  path: string;
  offset: number;
  payload?: unknown;
  source?: Stamp;
  createdAt?: string;
};

/** What the mind's code adds to a transcription that the raw fact does not hold: whether the
 *  sender is a member of this mind (`itx.members.has`; undefined: not asked, or no answer). */
export type Said = { member?: boolean };

/** WHO WROTE AN EVENT, in words, by the platform's stamp alone (the kit reads the same stamp:
 *  packages/ui stream-event.ts `senderOf`). Null: the stamp names no person. */
function senderWords(source: Stamp | undefined): string | null {
  if (!source || source.schedule || source.copiedFrom || source.platform) return null;
  if (source.signer) {
    const { actor, kind, hostname } = source.signer.principal;
    return kind === "mind" ? `the mind ${hostname || actor}` : null;
  }
  const principal = source.principal || source.onBehalfOf?.principal;
  if (!principal) return null;
  const { actor, email, kind, impersonatedBy } = principal;
  // a name is the person's claim: it proves nothing, and it is their text. One line of it, with
  // no bracket, so it cannot end the mind's own line or begin another
  const name = (principal.name || "")
    .replace(/[[\]<>—]/g, "")
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim()
    .slice(0, NAME_KEPT);
  const who =
    name && email
      ? `${name} <${email}>`
      : email ||
        (name
          ? `${name} (a name they gave${kind === "guest" ? ", as a guest who proved nothing" : ""})`
          : actor);
  const script = !source.principal && source.onBehalfOf?.run ? " (by a script)" : "";
  const as = impersonatedBy
    ? ` (an administrator, ${impersonatedBy.email}, signed in as them)`
    : "";
  return `${who}${script}${as}`;
}

/** How many characters of a person's name the line keeps. */
const NAME_KEPT = 80;

/** THE ADDRESS THE PLATFORM'S STAMP NAMES for the person who wrote an event, or for whom code
 *  wrote it. None for a mind, a schedule, a copy and the platform's own fact. */
export function senderEmail(event: RawFact): string | undefined {
  const source = event.source;
  if (!source || source.signer || source.schedule || source.copiedFrom || source.platform)
    return undefined;
  return (source.principal || source.onBehalfOf?.principal)?.email || undefined;
}

/** What the line says of the sender beyond the stamp: a member, or no member, of this mind. */
const memberWords = (said: Said) =>
  said.member === true
    ? ", a member of this mind,"
    : said.member === false
      ? ", who is NO member of this mind,"
      : "";

/** When the words were sent, by the raw fact's own time: "at 2026-11-24 12:40 UTC". */
const timeWords = (event: RawFact) =>
  event.createdAt ? ` at ${event.createdAt.slice(0, 16).replace("T", " ")} UTC` : "";

/** A payload's `from`, as one line: it is text that a writer chose. */
const fromWords = (from: string) => from.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").slice(0, 200);

/** The raw fact, for the model: where it is and how to read it whole. */
const rawLine = (event: { path: string; offset: number }) =>
  `Raw event: offset ${event.offset} of ${event.path} (\`(await itx.cd(${JSON.stringify(event.path)}).readEvents(${event.offset - 1}, 1)).events[0]\`).`;

/** The key of the one `agent/context-added` that a raw fact becomes: it names the raw fact. */
export const transcriptionKey = (event: { type: string; offset: number }) =>
  `transcribed:${event.type.slice(T.length)}@${event.offset}`;

/** The payload of one `agent/context-added`. */
export type ContextAddedPayload = {
  role: "user";
  content: string;
  files?: z.infer<typeof FileAttachment>[];
  source: { path: string; offset: number };
  llmRequestPolicy?: { behaviour: "dont-trigger-request" };
};

const wordsOf = (message: string) => message.trim() || "(no text)";

/** THE TRANSCRIPTION OF THE DASH'S CHAT: the person's words, who wrote them in the Dash, and the
 *  raw fact. Null for a payload that is not this fact's. */
export function agentUiContext(event: RawFact, said: Said = {}): ContextAddedPayload | null {
  const parsed = AgentUiMessage.safeParse(event.payload);
  if (!parsed.success) return null;
  const { message, files, client } = parsed.data;
  const channel = client === "mobile" ? "Mobile UI" : "Web UI";
  const where = client === "mobile" ? "in the Dash, on a phone" : "in the Dash";
  const who = senderWords(event.source);
  const when = timeWords(event);
  const line = who
    ? `— ${channel}: ${who}${memberWords(said)} wrote this ${where}${when}.`
    : `— ${channel}: someone wrote this ${where}${when}, and the platform's stamp names no person.`;
  return {
    role: "user",
    content: `${line} ${rawLine(event)}\n\n${wordsOf(message)}`,
    ...(!!files?.length && { files }),
    source: { path: event.path, offset: event.offset },
  };
}

/** THE TRANSCRIPTION OF THE PLATFORM'S `message()`: the words, who sent them through the agents
 *  API (another context, a person, or both), and the raw fact. `trigger: false` is context only. */
export function agentsApiContext(event: RawFact, said: Said = {}): ContextAddedPayload | null {
  const parsed = AgentsApiMessage.safeParse(event.payload);
  if (!parsed.success) return null;
  const { message, files, from, trigger } = parsed.data;
  const person = senderWords(event.source);
  const sender = person && `${person}${memberWords(said)}`;
  // `from` IS NEVER PROOF OF A SENDING CONTEXT. The collection writes it from its base, and a
  // caller chooses the base (`itx.agents.at(base)` is public: iterate/agents catalog.ts). So the
  // platform's stamp on this event says that the collection wrote it, and nothing about which
  // context asked. The line names `from` as the sender's own claim, always. (Words that another
  // agent appends to this log itself carry that agent's path in the stamp, and the agent reads
  // them after `[from <path>]`, which the platform's stamp gives: agent/processor.ts.)
  const context =
    from && from !== "/"
      ? `a sender that names itself the context ${fromWords(from)} (its own claim: nothing proves it)`
      : null;
  const who = context ? `${context}${sender ? `, for ${sender}` : ""}` : sender;
  const when = timeWords(event);
  const line = who
    ? `— Agents API: ${who} sent this with \`itx.agents.get(path).message()\`${when}.`
    : `— Agents API: this came with \`itx.agents.get(path).message()\`${when}, and the platform's stamp names no sender.`;
  return {
    role: "user",
    content: `${line} ${rawLine(event)}\n\n${wordsOf(message)}`,
    ...(!!files?.length && { files }),
    source: { path: event.path, offset: event.offset },
    ...(trigger === false && {
      llmRequestPolicy: { behaviour: "dont-trigger-request" as const },
    }),
  };
}
