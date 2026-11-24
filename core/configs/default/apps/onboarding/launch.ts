// launch.ts — CREATES AND SEEDS `/agents/main` THE MOMENT AI IS PROVEN WORKING
// (`app.ts`: POST /verify-ai). It reads the repo `/repos/onboarding` at its newest commit, and
// appends a fat, idempotent event stack onto `/agents/main`:
//   1. Bespoke instructions from `onboarding/instructions.md` of that repo (dont-trigger-request)
//   2. Generated overview of all `onboarding`-tagged markdown cards in that repo's `tasks/` and
//      their `depends-on` dependencies, with live statuses and filtered Tasks app deep-links
//      (dont-trigger-request)
//   3. The idempotent opener (`opener:/agents/main`) that wakes the agent for its greeting
// And immediately starts the background subagents (`researcher`, which hands off to `website`
// after researching the owner and generating a starter logo, plus `sandbox`) via
// `startFirstSubagents` (idempotent across Cloud handover and direct `npx iterate deploy`).
// A mind with no `/repos/onboarding` has no guide to give the agent, so nothing is launched there.
import { errorCode } from "iterate/lib";
import { type HandoverItx, startFirstSubagents } from "../../cloud-handover.ts";
import { ONBOARDING_REPO } from "./app.ts";

export const ONBOARDING_AGENT = "/agents/main";
const CONTEXT_ADDED = "events.iterate.com/agent/context-added";

/** The mind, as the launch uses it: the handover's calls, optional whoami, and reads of `/repos/onboarding`. */
export type LaunchOnboardingItx = HandoverItx & {
  whoami?():
    | { principal?: { email?: string; name?: string } }
    | Promise<{ principal?: { email?: string; name?: string } }>;
  repos?: {
    get(path: string): {
      tip(): Promise<string | null>;
      readFile(path: string, options: { commitOid: string }): Promise<string | null>;
      modules(options: { commitOid: string; dir: string }): Promise<Record<string, string>>;
    };
  };
};

export type OnboardingTaskSummary = {
  path: string;
  title: string;
  status: string;
  tags: string[];
  priority: string;
  agent: string;
  dependsOn: string[];
  summary: string;
};

export type LaunchOnboardingResult = {
  launched: boolean;
  deleted?: boolean;
  tasksCount: number;
};

const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const STATUS_ORDER = ["in-progress", "todo", "backlog", "in-review", "done"] as const;
const STATUS_LABELS: Record<string, string> = {
  "in-progress": "In progress (started automatically in the background)",
  todo: "Todo (first sitting)",
  backlog: "Backlog (days after)",
  "in-review": "In review",
  done: "Done",
};

function stripQuotes(text: string): string {
  const value = text.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  return quoted ? quoted[2]! : value.replace(/\s+#.*$/, "").trim();
}

function parseList(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : raw.split(",");
  return items.map((item) => stripQuotes(item)).filter(Boolean);
}

function frontmatterValue(lines: string[], keys: string[]): string | string[] | undefined {
  const keySet = new Set(keys);
  const at = lines.findIndex((line) => {
    const match = /^([A-Za-z][\w-]*)[ \t]*:(?:[ \t]|$)/.exec(line);
    return match ? keySet.has(match[1]!) : false;
  });
  if (at < 0) return undefined;
  const line = lines[at]!;
  const rest = line.slice(line.indexOf(":") + 1).trim();
  const inline = /^\[([\s\S]*)\]$/.exec(rest);
  if (inline) return inline[1]!.split(",").map(stripQuotes).filter(Boolean);
  if (rest) return stripQuotes(rest);
  const block: string[] = [];
  for (const next of lines.slice(at + 1)) {
    const item = /^\s*-\s+(.*)$/.exec(next);
    if (!item) break;
    block.push(stripQuotes(item[1]!));
  }
  return block.length > 0 ? block : "";
}

function parseOnboardingCard(path: string, source: string): OnboardingTaskSummary {
  const match = FRONTMATTER.exec(source);
  const lines = match?.[1] ? match[1].split(/\r?\n/) : [];
  const body = match ? source.slice(match[0].length) : source;
  const bodyLines = body.split(/\r?\n/);
  const headingLine = bodyLines.find((line) => /^#\s+/.test(line));
  const title =
    (typeof frontmatterValue(lines, ["title"]) === "string"
      ? (frontmatterValue(lines, ["title"]) as string)
      : "") ||
    headingLine?.replace(/^#\s+/, "").trim() ||
    path.replace(/^tasks\//, "").replace(/\.md$/i, "");

  // First plain paragraph after the `# Title` heading for a crisp one-line summary.
  const headingIndex = headingLine ? bodyLines.indexOf(headingLine) : -1;
  const summaryLines: string[] = [];
  for (const line of bodyLines.slice(headingIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (summaryLines.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) break;
    summaryLines.push(trimmed);
  }

  const rawStatus = frontmatterValue(lines, ["status", "state"]);
  const status = (typeof rawStatus === "string" ? rawStatus : "").toLowerCase() || "todo";
  const rawPriority = frontmatterValue(lines, ["priority"]);
  const rawAgent = frontmatterValue(lines, ["agent"]);

  return {
    path,
    title,
    status,
    tags: [...new Set(parseList(frontmatterValue(lines, ["tags", "labels"])))],
    priority: typeof rawPriority === "string" ? rawPriority : "",
    agent: typeof rawAgent === "string" ? rawAgent : "",
    dependsOn: [...new Set(parseList(frontmatterValue(lines, ["depends-on", "depends_on"])))],
    summary: summaryLines.join(" "),
  };
}

/** Extracts all `onboarding`-tagged markdown task cards from `{ "tasks/...": text }`. */
function parseOnboardingTasks(files: Record<string, string>): OnboardingTaskSummary[] {
  return Object.entries(files)
    .filter(([path]) => /^tasks\/.+\.(?:md|markdown)$/i.test(path))
    .map(([path, content]) => parseOnboardingCard(path, content))
    .filter((task) => task.tags.includes("onboarding"))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Builds the Markdown overview of onboarding tasks and their `depends-on` dependencies that is
 *  seeded onto `/agents/main` at launch. */
export function renderOnboardingTasksOverview(
  files: Record<string, string>,
  zone: string,
): { text: string; tasks: OnboardingTaskSummary[] } {
  const tasks = parseOnboardingTasks(files);
  const byPath = new Map(tasks.map((task) => [task.path, task]));
  const boardUrl = `https://tasks.${zone}/?tag=onboarding`;
  const activeUrl = `https://tasks.${zone}/?tag=onboarding&status=in-progress&status=todo`;

  const sections: string[] = [
    "# Onboarding tasks and dependencies",
    "",
    `Live board (filtered to onboarding): ${boardUrl}`,
    `Active items only: ${activeUrl}`,
    "",
    `Each item below is a markdown card under \`tasks/\` in \`${ONBOARDING_REPO}\` (\`itx.repos.get("${ONBOARDING_REPO}")\`; a commit there publishes nothing). Update a card's \`status:\` to \`done\` (or \`in-progress\`) as the owner moves through onboarding, and prefer tasks whose \`depends-on\` prerequisites are already \`done\`.`,
  ];

  const statuses = [
    ...STATUS_ORDER,
    ...tasks
      .map((task) => task.status)
      .filter((status) => !(STATUS_ORDER as readonly string[]).includes(status)),
  ];
  const seenStatuses = new Set<string>();

  for (const status of statuses) {
    if (seenStatuses.has(status)) continue;
    seenStatuses.add(status);
    const group = tasks.filter((task) => task.status === status);
    if (group.length === 0) continue;
    sections.push("", `## ${STATUS_LABELS[status] || status}`);
    for (const task of group) {
      const meta = [
        task.priority ? `priority: ${task.priority}` : "",
        task.tags.length > 0 ? `tags: ${task.tags.join(", ")}` : "",
        task.agent ? `agent: ${task.agent}` : "",
      ].filter(Boolean);
      const deps =
        task.dependsOn.length > 0
          ? task.dependsOn
              .map((dep) => {
                const target = byPath.get(dep);
                return target ? `${dep} (${target.status})` : dep;
              })
              .join(", ")
          : "none";
      sections.push(
        `- **${task.title}** (\`${task.path}\`) — ${meta.join(" · ")}`,
        `  - Depends on: ${deps}`,
        ...(task.summary ? [`  - Goal: ${task.summary}`] : []),
      );
    }
  }

  return { text: `${sections.join("\n")}\n`, tasks };
}

/** WHAT THE LAUNCH READS of `/repos/onboarding` at its newest commit: the agent's instructions
 *  and the cards under `tasks/`, by path. Null on a mind with no such repo, a repo with no commit,
 *  or one with no instructions: there is no guide to give the agent then. */
async function readOnboardingRepo(
  itx: LaunchOnboardingItx,
): Promise<{ instructions: string; files: Record<string, string> } | null> {
  if (!itx.repos) return null;
  const repo = itx.repos.get(ONBOARDING_REPO);
  const commitOid = await repo.tip().catch(() => null);
  if (!commitOid) return null;
  const [instructions, under] = await Promise.all([
    repo.readFile("onboarding/instructions.md", { commitOid }),
    repo.modules({ commitOid, dir: "tasks" }),
  ]);
  if (!instructions) return null;
  const files = Object.fromEntries(
    Object.entries(under).map(([name, content]) => [`tasks/${name}`, content]),
  );
  return { instructions, files };
}

async function appendIdempotent(
  itx: LaunchOnboardingItx,
  event: { type: string; idempotencyKey: string; payload: Record<string, unknown> },
) {
  await itx
    .cd(ONBOARDING_AGENT)
    .append(event)
    .catch((error: unknown) => {
      if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
    });
}

function ownerSummaryOf(owner: { email?: string; name?: string } | undefined): string {
  const lines = [
    owner?.name?.trim() ? `- Name: ${owner.name.trim()}` : "",
    owner?.email?.trim() ? `- Email: ${owner.email.trim()}` : "",
  ].filter(Boolean);
  return lines.length > 0 ? `About the owner:\n${lines.join("\n")}` : "";
}

/** CREATES `/agents/main` AND APPENDS ITS FAT EVENT STACK once AI is proven working:
 *  bespoke instructions from `onboarding/instructions.md` of `/repos/onboarding`, the generated
 *  tasks & dependencies overview from that repo's `tasks/*.md`, the signed-in owner's email/name
 *  when known, and the idempotent opener — then kicks off the background `researcher` (which
 *  researches the owner, generates a starter logo, and hands off to `website`) and `sandbox`
 *  subagents immediately. On a mind with no `/repos/onboarding` it does nothing. */
export async function launchOnboardingAgent(
  itx: LaunchOnboardingItx,
  owner?: { email?: string; name?: string },
): Promise<LaunchOnboardingResult> {
  const onboarding = await readOnboardingRepo(itx);
  if (!onboarding) return { launched: false, tasksCount: 0 };
  try {
    await itx.agents.create(ONBOARDING_AGENT);
  } catch (error: unknown) {
    if (/\bdeleted\b/.test(error instanceof Error ? error.message : String(error)))
      return { launched: false, deleted: true, tasksCount: 0 };
    throw error;
  }

  const zone = new URL(await itx.url()).hostname;
  const { text: tasksOverview, tasks } = renderOnboardingTasksOverview(onboarding.files, zone);
  const who =
    !owner?.email && typeof itx.whoami === "function"
      ? (await Promise.resolve(itx.whoami()).catch(() => null))?.principal
      : undefined;
  const resolvedOwner = {
    email: owner?.email || who?.email,
    name: owner?.name || who?.name,
  };
  const ownerSummary = ownerSummaryOf(resolvedOwner);

  // Append the fat context stack (instructions + generated tasks/dependencies overview + owner
  // identity when known), then the opener that triggers the agent's first reply. Each event
  // carries a stable idempotency key so retries or a prior iterate Cloud handover never duplicate
  // context or greetings.
  await appendIdempotent(itx, {
    type: CONTEXT_ADDED,
    idempotencyKey: "onboarding:init:instructions",
    payload: {
      role: "developer",
      actor: { type: "agent" },
      content: onboarding.instructions.replaceAll("<zone>", zone),
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    },
  });
  await appendIdempotent(itx, {
    type: CONTEXT_ADDED,
    idempotencyKey: "onboarding:init:tasks-overview",
    payload: {
      role: "developer",
      actor: { type: "agent" },
      content: tasksOverview,
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    },
  });
  if (ownerSummary) {
    await appendIdempotent(itx, {
      type: CONTEXT_ADDED,
      idempotencyKey: "onboarding:init:owner",
      payload: {
        role: "developer",
        actor: { type: "agent" },
        content: `${ownerSummary}\n\nThis is the verified member who just finished setting up the mind (never publish private email addresses on public pages).`,
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    });
  }
  await appendIdempotent(itx, {
    type: CONTEXT_ADDED,
    idempotencyKey: `opener:${ONBOARDING_AGENT}`,
    payload: {
      role: "developer",
      actor: { type: "agent" },
      content:
        "The owner has just verified their AI connection and opened onboarding for the first time. Send your first message now (follow the onboarding instructions and tasks overview above).",
    },
  });

  // Immediately kick off the background `researcher` (which researches the owner, generates a
  // starter logo, and hands off to `website`) and `sandbox` subagents (idempotent via
  // `onboarding:helper:<job>` keys), passing the owner's email/name so researcher has it on turn 1.
  await startFirstSubagents(itx, ownerSummary, false);

  return { launched: true, tasksCount: tasks.length };
}
