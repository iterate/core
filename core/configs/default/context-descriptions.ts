// context-descriptions.ts — WHAT EACH CONTEXT OF THE MIND IS FOR, in one line. The mind's catalog
// shows it (`await itx.cd("/").contexts.list()`, `description`). A context says it with the event
// `events.iterate.com/itx/described` on its own log: the newest one stands, null clears it, and
// anyone who can append there can write it. worker.ts calls `contextDescriptionsEvent` for every
// event, and this file writes the line from the table below for each context that the platform and
// this repo make. An agent writes its own line: its title (iterate/agents, the catalog on /agents).
//
// It writes at two moments:
//
//   itx/created            a context is born: its line, if a row of the table matches its path
//   mind/worker-updated    every publish of this repo: the line of every context the catalog
//                          lists (at most 1,000, the most recently active first), so a context
//                          born before a row was added gets it too
//
// It never writes to a path that has no context: an append there would give birth to one.
//
// Each text lands once on each context: the append's key names the path and the text. So a
// repeated delivery appends nothing, and a description that a person wrote later stands until the
// table's text for that context changes. Then the new text lands once.
//
// THE TABLE. A row's path matches a context's path segment by segment. `<name>` matches one
// segment and `<name...>` the rest of the path, and the text says the same word where it was. The
// first row that matches wins, so a row for one path comes before a row of its kind. Add a row
// for each kind of context that your own code makes.
import { errorCode } from "iterate/lib";

const CONTEXT_DESCRIPTIONS: { path: string; description: string }[] = [
  {
    path: "/",
    description:
      "The mind's root: each publication of /repos/config, where its hosts go, and the facts of the whole mind.",
  },
  {
    path: "/agents",
    description:
      "The list of this mind's agents, which the Agents app shows: each context below /agents is an agent.",
  },
  {
    path: "/agents/email",
    description:
      "The agents of email threads: one for each thread a member started, /agents/email/t<thread>.",
  },
  {
    path: "/agents/slack",
    description:
      "The agents of Slack threads: one for each thread, /agents/slack/<team>/<channel>/<thread>.",
  },
  {
    path: "/agents/slack/<team>",
    description: "The agents of Slack threads in the Slack workspace <team>.",
  },
  {
    path: "/agents/slack/<team>/<channel>",
    description:
      "The agents of Slack threads in the channel <channel> of the Slack workspace <team>.",
  },
  {
    path: "/agents/x",
    description:
      "The agents of X accounts that a member linked: one for each account, /agents/x/u<x user id>.",
  },
  {
    path: "/repos/config",
    description:
      "This mind's code: a commit to main publishes the mind. Its AGENTS.md says how the code works.",
  },
  { path: "/repos/<name>", description: "The git repository <name>." },
  {
    path: "/secrets",
    description: "The mind's secrets: each context below /secrets is one secret.",
  },
  {
    path: "/secrets/<name>",
    description:
      "The secret <name>: its value stays in the vault, and this log records when it was set, refreshed and used.",
  },
  {
    path: "/integrations",
    description:
      "The cards of the Dash's Integrations page: one for each integration, with the accounts connected through it.",
  },
  {
    path: "/integrations/email",
    description: "The mind's email: each mail it received and sent, folded into threads.",
  },
  {
    path: "/integrations/webhooks/<name>",
    description: "The webhook <name>: each request that reached it with a valid signature.",
  },
  {
    path: "/integrations/github/<installation>",
    description:
      "The GitHub App installation <installation>: the webhooks GitHub sent for it, relayed by iterate Cloud.",
  },
  {
    path: "/integrations/google/<address>",
    description:
      "The Google account <address> that a member connected: its new mail and its calendar's changes.",
  },
  {
    path: "/integrations/slack/<team>",
    description:
      "The Slack workspace <team> that a member linked: what happened there, relayed by iterate Cloud.",
  },
  {
    path: "/integrations/x/<user>",
    description:
      "The X account <user> that a member linked: its direct messages and the posts that mention iterate's bot.",
  },
  {
    path: "/approvals",
    description:
      "The gate for acts that wait for a member's yes: its rules, each held act and what became of it.",
  },
  {
    path: "/docs",
    description: "The Docs app's open docs: /docs/<repo>/<path>, one for each doc.",
  },
  { path: "/docs/<repo>", description: "The Docs app's open docs of /repos/<repo>." },
  {
    path: "/docs/<repo>/<path...>",
    description:
      "The Docs app's co-editing of <path> in /repos/<repo>: an open doc, or a folder of them.",
  },
];

/** The description the table gives `path`, or undefined when no row matches. */
export function contextDescription(path: string): string | undefined {
  const segments = path.split("/").filter(Boolean);
  for (const row of CONTEXT_DESCRIPTIONS) {
    const words = matchRow(row.path.split("/").filter(Boolean), segments);
    if (words)
      return row.description.replace(
        /<([a-z]+)>/g,
        (placeholder, name: string) => words[name] ?? placeholder,
      );
  }
  return undefined;
}

/** The words of `segments` that a row's placeholders take, or undefined when the row does not
 *  match. */
function matchRow(pattern: string[], segments: string[]): Record<string, string> | undefined {
  const words: Record<string, string> = {};
  for (const [index, part] of pattern.entries()) {
    const placeholder = /^<([a-z]+)(\.\.\.)?>$/.exec(part);
    if (placeholder?.[2]) {
      if (index !== pattern.length - 1 || segments.length <= index) return undefined;
      words[placeholder[1]!] = segments.slice(index).join("/");
      return words;
    }
    const segment = segments[index];
    if (!segment) return undefined;
    if (placeholder) words[placeholder[1]!] = segment;
    else if (part !== segment) return undefined;
  }
  return pattern.length === segments.length ? words : undefined;
}

/** The append's key: the path and a short hash of the text (FNV-1a), so each text lands once on
 *  each context. */
export function descriptionKey(path: string, description: string): string {
  let hash = 0x811c9dc5;
  for (const char of description) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `config/described:${path}:${hash.toString(36)}`;
}

/** The part of the mind's root that this file uses. */
type DescriptionsItx = {
  cd(path: string): {
    append(event: {
      type: "events.iterate.com/itx/described";
      idempotencyKey: string;
      payload: { description: string };
    }): Promise<unknown>;
  };
  contexts: {
    list(options: { limit: number }): Promise<{ path: string; description?: string }[]>;
  };
};

/** A context's line, from the table: at its birth, and for every listed context at each publish.
 *  Any other event returns at once and makes no call. */
export async function contextDescriptionsEvent(
  itx: DescriptionsItx,
  event: { type: string; path: string },
): Promise<void> {
  if (event.type === "events.iterate.com/itx/created") {
    const description = contextDescription(event.path);
    if (description) await describe(itx, event.path, description);
    return;
  }
  if (event.type !== "events.iterate.com/mind/worker-updated" || event.path !== "/") return;
  const contexts = await itx.contexts.list({ limit: 1_000 });
  await Promise.all(
    contexts.map(async (context) => {
      const description = contextDescription(context.path);
      // A context that says this already needs no call. One that says something else gets the
      // text once: when a person wrote theirs after it, the key finds the text and adds nothing.
      if (description && context.description !== description)
        await describe(itx, context.path, description);
    }),
  );
}

async function describe(itx: DescriptionsItx, path: string, description: string) {
  await itx
    .cd(path)
    .append({
      type: "events.iterate.com/itx/described",
      idempotencyKey: descriptionKey(path, description),
      payload: { description },
    })
    .catch((error: unknown) => {
      if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
    });
}
