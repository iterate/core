// api.ts — THE MIND'S OWN API: `itx.config.<name>(…)`, for its agents and its pages.
//
// `itx.config.<name>(…)` reaches every public method of the config's class: flat names alone
// (`itx.config.slack`, never `itx.config.cloudflare.billing`), and never an arrow field, which
// is no method of the class. worker.ts's class extends this one, so the methods here are the
// mind's standard API. An owner adds a method to worker.ts's class, or here.
import type { IterateContextApiWith } from "iterate/api";
import { IterateConfigEntrypoint } from "iterate/sdk";
import { agentCatalogOf, type CatalogItx, isAgentOf } from "./apps/dash/agent-catalog.ts";
import { dashLink, type DashLinkInput } from "./apps/dash/links.ts";
import { runStep, stepContext } from "./apps/onboarding/steps.ts";
import { startMeeting } from "./apps/meet/meeting.ts";
// @ts-expect-error -- a plain module of the Tasks app, with no types
import { taskAskers } from "./apps/tasks/askers.js";
// @ts-expect-error -- a plain module of the Tasks app, with no types
import { answerTask } from "./apps/tasks/asks.js";
// @ts-expect-error -- a plain module of the Tasks app, with no types
import { taskBoard } from "./apps/tasks/board.js";
// @ts-expect-error -- a plain module of the Tasks app, with no types
import { taskAssign, taskOpen, taskUpdate } from "./apps/tasks/cards.js";
// @ts-expect-error -- a plain module of the Tasks app, with no types
import { followTasks, taskFollowers, unfollowTasks } from "./apps/tasks/feed.js";
import { exceptionGroups } from "./apps/telemetry/crashes.ts";
import { pageSpeed } from "./apps/telemetry/page-speed.ts";
import { callSnapshot } from "./call/snapshot.ts";
import { endShare, shareAgent, type ShareItx, shareLinks } from "./call/share-api.ts";
import { connectCloudAccount, INTEGRATION_CALLABLE, removeCloudAccount } from "./cloud-accounts.ts";
import {
  cloudflareBilling,
  cloudflareBillingToken,
  cloudflareConnect,
  cloudflareForAgent,
  cloudflareLastHour,
  cloudflareMcpForAgent,
} from "./cloudflare.ts";
import { profileOf } from "./profile.ts";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import profileFiles from "./profile/";
import { slackForAgent } from "./slack.ts";

/** THE REPO OF THE MIND'S TASKS: the board shows the markdown files under its `tasks/`
 *  (worker.ts, `tasksApp({ repo })`), and the task calls below read and write it when a call
 *  names no repo. A new mind's cards are its onboarding jobs, in the repo it starts with. */
export const TASKS_BOARD_REPO = "/repos/onboarding";

export abstract class ConfigApi extends IterateConfigEntrypoint {
  /** `itx.config.dashLink(input)`: a canonical URL to a view in this mind's Dash
   *  (`apps/dash/links.ts`). Takes a structured destination (`{ view: "agent", contextPath }`,
   *  `{ view: "context", contextPath }`, `{ view: "repos", repo?, file? }`, `{ view: "page", page,
   *  rest? }`, or a named view like `"home"`, `"secrets"`, `"integrations"`). The origin is always
   *  this mind's Dash; the returned URL grants no permission. */
  async dashLink(input: DashLinkInput) {
    using itx = this.getItx();
    const apex = new URL(await itx.url()).hostname;
    return dashLink(apex, input);
  }

  /** `itx.config.profile()`: what the mind says of itself to the world, `{ name, description,
   *  icon }`, as its website answers it at `/.well-known/iterate-profile` (profile.ts). `problem`
   *  is there when a file of the folder profile/ is broken, and says which. To change the
   *  profile, commit `profile/profile.json` (and `profile/icon.svg`) to this repo. */
  async profile() {
    using itx = this.getItx();
    return profileOf(profileFiles, new URL(await itx.url()).hostname);
  }

  /** `itx.config.slack(method, args)`: any method of Slack's Web API, as the workspace's bot
   *  (slack.ts). An agent of a Slack thread answers with it, and reads the thread with it: each
   *  message in the answer says who wrote it, and a non-member's words come as a quote. */
  async slack(method: string, args?: Record<string, unknown>) {
    using itx = this.getItx();
    return await slackForAgent(itx, method, args);
  }

  /** `itx.config.startMeeting({ title?, path? })`: a new meeting, an agent under `/agents/meet/`
   *  with its call on, or the call on for the agent `path`; it answers `{ path }`. Meet's
   *  "Start new meeting" is this call, and an agent makes one the same way (apps/meet/meeting.ts).
   *  Its page is `https://meet.<zone>/contexts<path>`. */
  async startMeeting(options?: { title?: string; path?: string }) {
    // A cast, safe and needed: `getItx()` is typed as the bare `IterateContextApi`, but the
    // root's table has `agents` by the agents app's rewrite rule, as processEvent's own itx type
    // (`IterateConfigProcessEventArgs<"agents">`) says. The SDK has no typed getItx for it.
    using itx = this.getItx() as IterateContextApiWith<"agents"> & Disposable;
    return await startMeeting(itx, options);
  }

  /** `itx.config.callSnapshot({ source, of? })`: ONE still picture of the camera or the shared
   *  screen of a person in the CALLING AGENT'S OWN CALL who turned "Let the agent look" on
   *  (call/snapshot.ts). The picture is attached to the agent's context for its next step; a
   *  refusal says why (`{ status: "refused", reason }`). */
  async callSnapshot(input: { source: "camera" | "screen"; of?: string }) {
    using itx = this.getItx();
    return await callSnapshot(itx, input, { callerPath: () => this.callerPath() });
  }

  /** `itx.config.shareAgent({ agent, lifetimeMs? })`: a link that lets people who are not members
   *  into the agent's chat and call as guests, as the Dash's Share and Meet's Guests make one. It
   *  turns the agent's call on when it is off, lives a day unless `lifetimeMs` says otherwise
   *  (more than 7 days is refused), and answers `{ url, until, link }` once the call admits by it.
   *  The secret is in `url` alone: the log keeps its hash (call/share-api.ts). */
  async shareAgent(input: { agent: string; lifetimeMs?: number }) {
    using itx = this.getItx();
    return await shareAgent(shareItx(itx), input);
  }

  /** `itx.config.shareLinks({ agent })`: the agent's live links, each with who made it, its end
   *  and the guests who came by it. */
  async shareLinks(input: { agent: string }) {
    using itx = this.getItx();
    return await shareLinks(shareItx(itx), input);
  }

  /** `itx.config.endShare({ agent, link })`: ends one link before its time; its guests are out. */
  async endShare(input: { agent: string; link: string }) {
    using itx = this.getItx();
    return await endShare(shareItx(itx), input);
  }

  /** `itx.config.onboardingStep(step, action)`: one press of a button of the onboarding app, as
   *  the onboarding agent makes it from the owner's plain words (apps/onboarding/steps.ts;
   *  onboarding/connect-iterate-cloud.md of /repos/onboarding). It answers `{ status, words, link? }`. */
  async onboardingStep(step: string, action: string) {
    using itx = this.getItx();
    return await runStep(await stepContext(itx), step, action);
  }

  /** `itx.config.cloudflareConnect({ tell? })`: the one link that a member opens to connect the
   *  mind to its own Cloudflare account, through Cloudflare's MCP server (cloudflare.ts;
   *  cloudflare.md). `tell`: the agent that asks, which is told when the consent has landed. */
  async cloudflareConnect(options?: { tell?: string }) {
    using itx = this.getItx();
    return await cloudflareConnect(itx, options);
  }

  /** `itx.config.connectCloudAccount(app, again?)`: the Integrations page's "Connect", "Add
   *  account" and "Connect again" for an app of iterate Cloud's, and an agent's. It answers
   *  `{ secret, link }`: the secret the connect fills, and the page the member opens to approve
   *  (cloud-accounts.ts `connectCloudAccount`; accounts.md). */
  async connectCloudAccount(app: string, again?: string) {
    using itx = this.getItx();
    return await connectCloudAccount(itx, app, again);
  }

  /** `itx.config.integrationCalls()`: the names of this config's functions that a card's button
   *  may call (cloud-accounts.ts `INTEGRATION_CALLABLE`). The Dash asks once, and calls no other. */
  integrationCalls() {
    return [...INTEGRATION_CALLABLE];
  }

  /** `itx.config.removeCloudAccount(path)`: the Integrations page's "Remove" for an account that
   *  a member connected through iterate Cloud. The mind forgets it and asks the Cloud to stop its
   *  deliveries (cloud-accounts.ts `removeCloudAccount`; accounts.md, "Remove an account"). */
  async removeCloudAccount(path: string) {
    using itx = this.getItx();
    return await removeCloudAccount(itx, path);
  }

  /** `itx.config.cloudflare(tool, args)`: one request to Cloudflare's REST API (`"execute"`), or
   *  who the mind is connected as (`"whoami"`), with the member's consent: agents read the
   *  account and query its logs and traces (cloudflare.ts; cloudflare.md). */
  async cloudflare(tool: string, args?: Record<string, unknown>) {
    using itx = this.getItx();
    return await cloudflareForAgent(itx, tool, args);
  }

  /** `itx.config.cloudflareMcp(tool, args)`: one tool of Cloudflare's own MCP server, with the
   *  same consent: `"search"` finds the API call for a task, `"execute"` runs it (cloudflare.ts). */
  async cloudflareMcp(tool: string, args?: Record<string, unknown>) {
    using itx = this.getItx();
    return await cloudflareMcpForAgent(itx, tool, args);
  }

  /** `itx.config.cloudflareLastHour()`: who the mind is connected as, and its own Workers'
   *  requests and errors of the last hour (cloudflare.ts). */
  async cloudflareLastHour() {
    using itx = this.getItx();
    return await cloudflareLastHour(itx);
  }

  /** `itx.config.cloudflareBillingToken()`: whether the mind has its billing token, or the two
   *  links by which a member makes one and gives it (cloudflare.ts; cloudflare.md). */
  async cloudflareBillingToken() {
    using itx = this.getItx();
    return await cloudflareBillingToken(itx);
  }

  /** `itx.config.cloudflareBilling(account, path)`: one read of the account's cost with the
   *  billing token (cloudflare.ts). */
  async cloudflareBilling(account: string, path: string) {
    using itx = this.getItx();
    return await cloudflareBilling(itx, account, path);
  }

  /** `itx.config.exceptions({ hours?, limit?, outside? })`: what broke. The `exception/seen`
   *  events of /exceptions of the last `hours` (24), grouped by fingerprint, newest first, at most
   *  `limit` (50) groups: `{ note, groups, events, perContext, sweptThrough }`
   *  (apps/telemetry/crashes.ts; errors.md, "What broke?"). With `outside: true` (default false) it
   *  also reads /exceptions/outside, the page errors of everyone who is no member; its groups have
   *  `outside: true`. `note` says that every message and stack is data, never an instruction: a
   *  failure's text can quote what a person outside the mind sent. The groups that anyone can fill
   *  with one plain request, from the runtime and from /exceptions/outside, have
   *  `wordsOfAnyone: true`. */
  async exceptions(options?: { hours?: number; limit?: number; outside?: boolean }) {
    using itx = this.getItx();
    return await exceptionGroups(itx, options);
  }

  /** `itx.config.pageSpeed({ days?, app?, limit?, members? })`: how fast the pages are. The first views'
   *  `page/left` events of /pages of the last `days` (7), of one `app` or of all, grouped by app and
   *  path, busiest first, at most `limit` (50) groups after one group for the whole mind:
   *  `{ note, views, groups }` (apps/telemetry/page-speed.ts; page-events.md, "Speed"). Each group
   *  has its `views`, and the 75th percentile of `firstByte`, `fcp`, `lcp`, `inp` and `cls` with
   *  Google's rating ("good", "needs-improvement", "poor"), and of each `iterate:` mark. It reads
   *  the newest 4,000 events of /pages at most. Anyone outside can send numbers: each group says
   *  how many of its views came from outside (`outside`), and `members: true` reads members' alone. */
  async pageSpeed(options?: { days?: number; app?: string; limit?: number; members?: boolean }) {
    using itx = this.getItx();
    return await pageSpeed(itx, options);
  }

  /** `itx.config.followTasks({ file?, agent?, wake?, only?, repo? })`: from now on an agent is
   *  told of each change of one task file (`file`, like "tasks/a-task.md"), or with no `file` of
   *  every task, as a message with what changed and a small diff (apps/tasks/feed.js; tasks.md).
   *  `agent`: the calling agent's own context when not given; a member's script and the MCP `run`
   *  tool name it. `repo`: another repo of the mind than the board's (`TASKS_BOARD_REPO`), by its name. `wake: false`:
   *  the words are context only. `only`: the changes that moved one of the fields it names
   *  (`["status", "blocked-on", "human-ask"]`), and no other. It answers
   *  `{ agent, follows, only, repo, log, row }`. */
  async followTasks(input?: {
    file?: string;
    agent?: string;
    wake?: boolean;
    only?: string[];
    repo?: string;
  }) {
    using itx = this.getItx();
    return await followTasks(
      itx,
      { ...input, repo: input?.repo || TASKS_BOARD_REPO },
      this.taskDeps(itx),
    );
  }

  /** `itx.config.unfollowTasks({ file?, agent?, repo? })`: ends what `followTasks` with the same
   *  `file` (or with none) and the same repo began. It answers `{ agent, follows, repo, ended }`. */
  async unfollowTasks(input?: { file?: string; agent?: string; repo?: string }) {
    using itx = this.getItx();
    return await unfollowTasks(
      itx,
      { ...input, repo: input?.repo || TASKS_BOARD_REPO },
      this.taskDeps(itx),
    );
  }

  /** `itx.config.taskFollowers({ repo? })`: which agent follows which task file, or "every task",
   *  in the board's repo or in the repo that `repo` names. */
  async taskFollowers(input?: { repo?: string }) {
    using itx = this.getItx();
    return await taskFollowers(itx, { ...input, repo: input?.repo || TASKS_BOARD_REPO });
  }

  /** `itx.config.answerTask({ file, ask, answer, by, repo? })`: an answer that a person gave to
   *  an ask of a task (one line of its `human-ask:`), written into the task file as the board
   *  writes it: the ask's line goes, and the ask with the answer, `by` and the time is kept under
   *  `## Answers` (apps/tasks/asks.js). For an answer that reached an agent in a chat or on a
   *  call; a person at the board answers there ("Needs a person"). `ask`: the ask's whole text.
   *  It answers `{ repo, file, commitOid, stillAsked }`. */
  async answerTask(input: {
    file: string;
    ask: string;
    answer: string;
    by: string;
    repo?: string;
  }) {
    using itx = this.getItx();
    return await answerTask(itx, { ...input, repo: input?.repo || TASKS_BOARD_REPO });
  }

  /** `itx.config.taskAskers({ repo? })`: who asked each ask that a task still has (a line of its
   *  `human-ask:`), read from the change feed (apps/tasks/askers.js): the agent of the commit that
   *  added the ask, by its `Via:` line or the platform's stamp. The board's "Needs a person" links
   *  each ask to that agent's chat. It answers `{ repo, asks, readFrom }`, each ask as
   *  `{ file, ask, agent, by, page, at, message, model, blocking, assignee }`. `agent` is null when nothing
   *  says who asked; `assignee` is the task's own agent, which is not the asker. */
  async taskAskers(input?: { repo?: string }) {
    using itx = this.getItx();
    return await taskAskers(itx, { ...input, repo: input?.repo || TASKS_BOARD_REPO });
  }

  /** `itx.config.taskBoard({ repo? })`: the whole board as data, in one call, for an agent that
   *  manages work or starts with no history (apps/tasks/board.js): every task as its card with the
   *  answers people gave to its asks, its last change and whether the agent it names has work now,
   *  the tasks that need a person, the board's newest changes and who follows what. It answers
   *  `{ repo, commitOid, board, tasks, needsAPerson, recentChanges, followers }`. */
  async taskBoard(input?: { repo?: string }) {
    using itx = this.getItx();
    return await taskBoard(itx, { ...input, repo: input?.repo || TASKS_BOARD_REPO });
  }

  /** `itx.config.taskOpen({ title, text?, status?, owner?, agent?, tags?, ask?, decision?,
   *  noChoice?, repo?, by? })`: a new card on the board (apps/tasks/cards.js): `text` is the ask
   *  in the person's own words and where it came from, `owner` the person who asked. It answers
   *  `{ repo, file, commitOid, link }`. */
  async taskOpen(input: Record<string, unknown>) {
    using itx = this.getItx();
    return await taskOpen(
      itx,
      { ...input, repo: input?.repo || TASKS_BOARD_REPO },
      this.taskDeps(itx),
    );
  }

  /** `itx.config.taskUpdate({ file, status?, title?, owner?, agent?, tags?, model?, effort?,
   *  blockedOn?, ask?, decision?, tell?, noChoice?, withdraw?, reword?, note?, repo?, by? })`: one commit
   *  that keeps a card true, with no YAML by hand (apps/tasks/cards.js; tasks.md). `blockedOn: ""`
   *  takes the blocker away; `ask` is one more question for a person, with its `decision`, its
   *  `tell: { agent, words? }` (the agent that acts on the answer) or `noChoice`; `withdraw: { ask, why }` takes an ask off that nobody has to answer any more, and
   *  `reword: { ask, to }` writes one again in plain words; `note` is one line under `## Log`.
   *  `by`: the agent that makes the change, when the call comes from no agent's context (the MCP
   *  `run` tool). It answers `{ repo, file, commitOid, changed, card }`. */
  async taskUpdate(input: Record<string, unknown>) {
    using itx = this.getItx();
    return await taskUpdate(
      itx,
      { ...input, repo: input?.repo || TASKS_BOARD_REPO },
      this.taskDeps(itx),
    );
  }

  /** `itx.config.taskAssign({ file, agent, message?, repo?, by? })`: gives a card to an agent that
   *  runs (apps/tasks/cards.js). The card names the agent and is in progress, and the agent gets
   *  one message that makes the card its brief. It answers
   *  `{ repo, file, agent, model, effort, starting, running, card }`. */
  async taskAssign(input: Record<string, unknown>) {
    using itx = this.getItx();
    return await taskAssign(
      itx,
      { ...input, repo: input?.repo || TASKS_BOARD_REPO },
      this.taskDeps(itx),
    );
  }

  /** What the task calls ask of the mind (apps/tasks/cards.js, feed.js): where a call came from,
   *  and the one gate that says a path is an agent (apps/dash/agent-catalog.ts), since a
   *  follower's row writes to the path it names. A mind adds its own parts by overriding this in
   *  worker.ts's class: cards.js lists them (`linkNote`, `briefRules`, `startWorker`,
   *  `sessionState`). */
  protected taskDeps(itx: object) {
    // Two casts, both of shapes that this file cannot name more closely: `itx` is the root's
    // handle, which has `cd(path).facets` as `CatalogItx` asks; and the catalog's live state is
    // `unknown` to its reader, with `agents` a map by path (iterate/agents writes it).
    const catalog = async () =>
      (await agentCatalogOf(itx as CatalogItx)) as { agents?: Record<string, unknown> } | null;
    return {
      callerPath: () => this.callerPath(),
      isAgent: async (path: string) => isAgentOf(await catalog(), path),
      /** the agent's row in the catalog (`kind`, `status`, `lastActivityAt`), or null */
      agentRow: async (path: string) => {
        const agents = (await catalog())?.agents;
        return agents && Object.hasOwn(agents, path) ? agents[path] : null;
      },
    };
  }
}

/** The root's `itx` as call/share-api.ts reads it. A cast, needed and safe: the root's types say
 *  that some calls (`processors.list`) answer a value where the call over RPC answers its promise,
 *  and that file awaits each. It calls only `url`, `contexts.list`, `cd(path).append`, `processors.list`,
 *  `processors.enable` and the call facet's `snapshot`, which the root's itx has. */
const shareItx = (itx: object) => itx as ShareItx;
