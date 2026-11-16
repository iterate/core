// app.js — THE DASH'S PAGE: which pages there are and in what order, their names and icons,
// and the apps and the pages about access it links to. `Dash` from @iterate-com/ui draws them:
// how the sidebar, the URL, ⌘K and the two ids `agents` and `contexts` work is in its source,
// packages/ui/src/components/dash/dash.tsx (links below).
//
// A PAGE OF YOUR OWN is a row with a component, which gets `{ itx, mind, principal, page, agents }`:
//   import { Notes } from "./notes.js";
//   { id: "notes", name: "Notes", icon: NotebookIcon, component: Notes },
// The Dash draws before the mind has said who is signed in: `principal` is undefined until then.
// A page or a wrapper of your own is mounted anew when the page's connection comes back, unless it
// says `Notes.staysOverReconnect = true` (apps.md, "The Dash", says when that is right).
// TO REPLACE A KIT PAGE, put your component in its row, under the same id. Each kit page is one
// small component in @iterate-com/ui: copy it into this folder and change it there. Their source:
//   https://github.com/iterate/packages/tree/main/packages/ui/src/components/dash (the Dash and
//   most pages) and .../packages/ui/src/agent-kind-view/dash-agents.tsx (Home and Agents)
// (apps.md, "UI components in a page", for the source of the version index.html pins).
//
// The kit's pages load their larger parts when they first open: the home loads the composer only.
import { html, render } from "@iterate-com/ui/page";
import {
  Dash,
  DashAnalytics,
  DashContexts,
  DashIntegrations,
  DashMcp,
  DashRepo,
  DashSecrets,
} from "@iterate-com/ui/components/dash/dash";
import { DashAgents, DashHome } from "@iterate-com/ui/agent-kind-view/dash-agents";
import { memberItx, mindOfHost } from "@iterate-com/ui/live";
import {
  BlocksIcon,
  BookOpenIcon,
  BotIcon,
  ChartLineIcon,
  CircleCheckIcon,
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

// The member's itx, from this host's /itx (app.ts answers it): over the socket that index.html
// dialled in its head, when it is there. Nothing here waits for the mind: the Dash draws at once,
// in the frame that index.html drew, and asks the mind who is signed in.
const itx = memberItx();
const mind = mindOfHost();
/** The stack's own pages (keys, members, approvals) are on this host of the mind. */
const stack = `https://iterate.${mind}`;

const pages = [
  { id: "home", name: "Home", icon: LayoutDashboardIcon, component: DashHome },
  {
    id: "agents",
    name: "Agents",
    icon: BotIcon,
    component: DashAgents,
    // what the mind says first in an agent's empty chat, the first time anyone opens it: the
    // onboarding agent greets a new owner (onboarding.md is what it is told)
    openers: {
      "/agents/onboarding":
        "The owner has just opened the onboarding chat for the first time. Begin with step 1.",
    },
  },
  { id: "contexts", name: "Contexts", icon: WaypointsIcon, component: DashContexts },
  { id: "repo", name: "Config repo", icon: FolderGit2Icon, component: DashRepo },
  { id: "secrets", name: "Secrets", icon: LockKeyholeIcon, component: DashSecrets },
  { id: "integrations", name: "Integrations", icon: BlocksIcon, component: DashIntegrations },
  // not every stack has telemetry: without it, the row says "Off"
  {
    id: "analytics",
    name: "Analytics",
    icon: ChartLineIcon,
    serves: "telemetry",
    component: DashAnalytics,
  },
  { id: "mcp", name: "MCP", icon: PlugIcon, component: DashMcp },
];

// The mind's apps, each on its own host: an app you add in worker.ts gets a row here.
const apps = [
  { name: "Docs", host: "docs", icon: BookOpenIcon },
  { name: "Voice", host: "voice", icon: PhoneIcon },
].map((app) => ({ ...app, href: `https://${app.host}.${mind}` }));

// The stack's pages about who may do what. "Approvals" shows how many requests wait for a yes.
const access = [
  {
    name: "Approvals",
    href: `${stack}/secrets/approvals`,
    icon: ShieldCheckIcon,
    count: "approvals",
  },
  { name: "Keys", href: `${stack}/keys`, icon: KeyRoundIcon },
  { name: "Sessions", href: `${stack}/sessions`, icon: LogOutIcon },
  { name: "Members", href: `${stack}/members`, icon: UsersIcon },
  { name: "Self-test", href: `${stack}/self-test`, icon: CircleCheckIcon },
];

const links = [
  { title: "Apps", rows: apps },
  { title: "Access", rows: access },
];

// The sidebar for a person who has not toggled it yet: as index.html drew it in its frame (open,
// or the rail of icons for a first arrival at the onboarding agent). A choice they made wins.
const sidebarDefaultOpen = document.documentElement.dataset.sidebar !== "collapsed";

render(
  html`<${Dash} app="Dash" ...${{ itx, mind, pages, links, sidebarDefaultOpen }} />`,
  document.getElementById("root"),
);
