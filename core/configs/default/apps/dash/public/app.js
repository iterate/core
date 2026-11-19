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
import { memberItx } from "@iterate-com/ui/live";
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
  PlugIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UsersIcon,
  WaypointsIcon,
} from "@iterate-com/ui/icons";
import { CALL_FACET } from "./call-facet.js";

// The member's itx, from this host's /itx (app.ts answers it): over the socket that index.html
// dialled in its head, when it is there. The Dash draws in the frame that index.html drew, and
// asks the mind who is signed in after it has drawn.
const itx = memberItx();
// The mind's address is its control-plane hostname, where the stack's own pages are (keys, members,
// approvals): this host says it (`/.auth/session.json`, ../app.ts). The page never works it out
// from its own hostname, which may be in any zone of the mind. The Dash waits for this answer
// before it draws. index.html asks for it in its head, while the modules load, so it is
// usually there when this line runs.
const hostSession =
  window.__session ?? fetch("/.auth/session.json").then((answer) => answer.json());
const stack = (await hostSession).issuer;
const mind = new URL(stack).hostname;
/** The zone this page is on: an app's hostname is one label under its zone. */
const zone = location.hostname.split(".").slice(1).join(".");

const pages = [
  { id: "home", name: "Home", icon: LayoutDashboardIcon, component: DashHome },
  {
    id: "agents",
    name: "Agents",
    icon: BotIcon,
    component: DashAgents,
    // a call on any agent's page: "Start a call" turns the call facet on for the agent (call.ts)
    call: {
      enable: (itx, path) => itx.cd(path).processors.enable("call", CALL_FACET),
    },
    // what the mind says first in an agent's empty chat, the first time anyone opens it: the
    // onboarding agent greets a new owner (onboarding.md is what it is told)
    openers: {
      "/agents/onboarding":
        "The owner has just opened this chat for the first time and has typed nothing yet. Send your first message now: words only, no script (onboarding.md, 'Your first message').",
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

// The mind's apps, each on its own hostname of this page's zone: an app you add in worker.ts
// gets a row here.
const apps = [
  { name: "Docs", host: "docs", icon: BookOpenIcon },
  { name: "Onboarding", host: "onboarding", icon: SparklesIcon },
].map((app) => ({ ...app, href: `https://${app.host}.${zone}` }));

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
  { name: "Other Minds", href: `${stack}/minds`, icon: CompassIcon },
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
