// app.js — THE DASH'S PAGE: the mind seen from above. This file is the CONTENTS: which pages
// there are and in what order, their names, icons and words, the apps and the pages about access
// it links to, and the overview's words. `Dash` from @iterate-com/ui draws them: the sidebar and
// the overview's cards come from the one list `pages`, the URL says which page is shown
// (`?page=<id>`; none: the first), and every page shows what waits for a member's yes.
//
// A PAGE OF YOUR OWN is a row with a component, which gets `{ itx, mind, principal, page }`:
//   import { Notes } from "./notes.js";
//   { id: "notes", name: "Notes", icon: NotebookIcon, about: "What we wrote down.", component: Notes },
// TO REPLACE A KIT PAGE, put your component in its row. Each kit page is one small component in
// @iterate-com/ui (components/dash/dash-pages.tsx): copy it into this folder and change it there.
//
// The kit's pages load their larger parts when they first open: the overview loads none of them.
import { html, render } from "@iterate-com/ui/page";
import {
  Dash,
  DashAnalytics,
  DashContexts,
  DashIntegrations,
  DashMcp,
  DashOverview,
  DashRepo,
  DashSecrets,
} from "@iterate-com/ui/components/dash/dash";
import { memberItx, mindOfHost } from "@iterate-com/ui/live";
import {
  BlocksIcon,
  BookOpenIcon,
  BotIcon,
  ChartLineIcon,
  CircleCheckIcon,
  CompassIcon,
  FolderGit2Icon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LockKeyholeIcon,
  LogOutIcon,
  PhoneIcon,
  PlugIcon,
  ShieldCheckIcon,
  UsersIcon,
  WaypointsIcon,
} from "@iterate-com/ui/icons";

// The member's itx, from this host's /itx (app.ts answers it), and who they are.
const itx = memberItx();
const { principal } = await itx.whoami();
const mind = mindOfHost();
/** The stack's own pages (keys, members, approvals) are on this host of the mind. */
const stack = `https://iterate.${mind}`;

/** Who is signed in, and the way to everything else. */
const Overview = (props) => html`
  <${DashOverview} ...${props} pagesTitle="The mind">
    ${principal?.email ? `Signed in as ${principal.email}.` : "Signed in."} This page is apps/dash
    in the mind's config repo: change it like any file there.
  <//>
`;

const pages = [
  { id: "overview", name: "Overview", icon: LayoutDashboardIcon, component: Overview },
  {
    id: "contexts",
    name: "Contexts",
    icon: WaypointsIcon,
    about: "Any context's log, live: agents, integrations, repos, secrets.",
    component: DashContexts,
  },
  {
    id: "repo",
    name: "Config repo",
    icon: FolderGit2Icon,
    about: "The mind's own code: read it, change it, commit.",
    component: DashRepo,
  },
  {
    id: "secrets",
    name: "Secrets",
    icon: LockKeyholeIcon,
    about: "What the mind may send where: set, update, delete.",
    component: DashSecrets,
  },
  {
    id: "integrations",
    name: "Integrations",
    icon: BlocksIcon,
    about: "What the mind's packages registered, and their connections.",
    component: DashIntegrations,
  },
  {
    // not every stack has telemetry: without it, the row and the card say "Off"
    id: "analytics",
    name: "Analytics",
    icon: ChartLineIcon,
    about: "The mind's telemetry: events, lag, storage, a SQL box.",
    serves: "telemetry",
    offAbout: "Telemetry is off. The page says how to turn it on.",
    component: DashAnalytics,
  },
  {
    id: "mcp",
    name: "MCP",
    icon: PlugIcon,
    about: "Connect Claude Code or the Codex CLI to this mind.",
    component: DashMcp,
  },
];

// The mind's apps, each on its own host: an app you add in worker.ts gets a row here.
const apps = [
  {
    name: "Agents",
    host: "agents",
    icon: BotIcon,
    about: "Every agent of the mind, and a chat with each.",
  },
  {
    name: "Onboarding",
    host: "onboarding",
    icon: CompassIcon,
    about: "A chat that sets the mind up with you.",
  },
  { name: "Docs", host: "docs", icon: BookOpenIcon, about: "The config repo, read as pages." },
  { name: "Voice", host: "voice", icon: PhoneIcon, about: "Call the mind from this browser." },
].map((app) => ({ ...app, href: `https://${app.host}.${mind}` }));

// The stack's pages about who may do what. "Approvals" shows how many requests wait for a yes.
const access = [
  {
    name: "Approvals",
    href: `${stack}/secrets/approvals`,
    icon: ShieldCheckIcon,
    about: "What waits for your yes, and the rules that make it wait.",
    count: "approvals",
  },
  {
    name: "Keys",
    href: `${stack}/keys`,
    icon: KeyRoundIcon,
    about: "Your passkeys, and the keys of your devices and tools.",
  },
  {
    name: "Sessions",
    href: `${stack}/sessions`,
    icon: LogOutIcon,
    about: "Where you are signed in, and the way to end it.",
  },
  { name: "Members", href: `${stack}/members`, icon: UsersIcon, about: "Who may use this mind." },
  {
    name: "Self-test",
    href: `${stack}/self-test`,
    icon: CircleCheckIcon,
    about: "Check that everything works.",
  },
];

const links = [
  { title: "Apps", rows: apps },
  { title: "Access", rows: access },
];

render(
  html`<${Dash} app="Dash" ...${{ itx, mind, principal, pages, links }} />`,
  document.getElementById("root"),
);
