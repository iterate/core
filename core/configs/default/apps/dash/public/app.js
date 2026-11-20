// app.js — THE DASH'S PAGE: which pages there are and in what order, their names and icons,
// and the apps and the pages about access it links to. `Dash` from @iterate-com/ui draws them:
// how the sidebar, the URL and the three ids `agents`, `contexts` and `settings` work is in its
// source, packages/ui/src/components/dash/dash.tsx (links below).
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
import { html, render, useEffect, useState } from "@iterate-com/ui/page";
import {
  Dash,
  DashAnalytics,
  DashContexts,
  DashIntegrations,
  DashRepo,
  DashSecrets,
  DashSettings,
} from "@iterate-com/ui/components/dash/dash";
import { DashAgents, DashHome } from "@iterate-com/ui/agent-kind-view/dash-agents";
import { memberItx } from "@iterate-com/ui/live";
import {
  BlocksIcon,
  BookOpenIcon,
  BotIcon,
  ChartLineIcon,
  CompassIcon,
  FolderGit2Icon,
  HistoryIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LockKeyholeIcon,
  SettingsIcon,
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
  {
    id: "integrations",
    name: "Integrations",
    about: "The accounts and services the mind is connected to.",
    icon: BlocksIcon,
    row: false,
    component: DashIntegrations,
  },
  {
    id: "secrets",
    name: "Secrets",
    about: "The credentials the mind holds.",
    icon: LockKeyholeIcon,
    row: false,
    component: DashSecrets,
  },
  {
    id: "repos",
    name: "Config repo",
    about: "The mind's code. A commit to main publishes it.",
    icon: FolderGit2Icon,
    row: false,
    component: DashRepo,
  },
  {
    id: "contexts",
    name: "Contexts",
    about: "Every context of the mind, raw and live.",
    icon: WaypointsIcon,
    row: false,
    component: DashContexts,
  },
  // not every stack has telemetry: without it, the row says "Off"
  {
    id: "analytics",
    name: "Analytics",
    about: "The mind's telemetry.",
    icon: ChartLineIcon,
    serves: "telemetry",
    row: false,
    component: DashAnalytics,
  },
  { id: "settings", name: "Settings", icon: SettingsIcon, component: DashSettings },
];

// The mind's apps, each on its own hostname of this page's zone: an app you add in worker.ts
// gets a row here.
const apps = [
  {
    name: "Docs",
    about: "The repos' files, written together.",
    host: "docs",
    icon: BookOpenIcon,
  },
  {
    name: "Meet",
    about: "Calls and meetings with agents and guests.",
    host: "meet",
    icon: UsersIcon,
  },
  {
    name: "Onboarding",
    about: "Set up this mind step by step.",
    host: "onboarding",
    icon: SparklesIcon,
  },
].map((app) => ({ ...app, href: `https://${app.host}.${zone}` }));

// The stack's pages about who may do what. "Approvals" shows how many requests wait for a yes.
const access = [
  {
    name: "Approvals",
    about: "What waits for a passkey, and the rules.",
    href: `${stack}/secrets/approvals`,
    icon: ShieldCheckIcon,
    count: "approvals",
  },
  {
    name: "Members",
    about: "Who reaches the whole mind.",
    href: `${stack}/members`,
    icon: UsersIcon,
  },
  { name: "Keys", about: "The keys of this mind.", href: `${stack}/keys`, icon: KeyRoundIcon },
  {
    name: "Other minds",
    about: "The minds that may send events here.",
    href: `${stack}/minds`,
    icon: CompassIcon,
  },
];

const links = [
  { title: "Access", rows: access },
  { title: "Apps", rows: apps },
];

// Anchored at the foot of the sidebar above Settings.
const foot = [
  {
    name: "Approvals",
    href: `${stack}/secrets/approvals`,
    icon: ShieldCheckIcon,
    count: "approvals",
  },
];

// Personal items inside the account popover above Sign out.
const accountLinks = [{ name: "Your sessions", href: `${stack}/sessions`, icon: HistoryIcon }];

// The sidebar for a person who has not toggled it yet: as index.html drew it in its frame (open,
// or the rail of icons for a first arrival at the onboarding agent). A choice they made wins.
const sidebarDefaultOpen = document.documentElement.dataset.sidebar !== "collapsed";

// The mind's name and icon, as its owner wrote them (profile.ts, the folder profile/ of the
// repo): the zone's website answers them to anyone. The Dash never waits for the answer: it draws
// with the zone at once, and takes the name and the icon when they are here.
// A zone that answers no profile (a worker.ts of your own without the routes) keeps the zone
// as its name.
const profile = fetch(`https://${zone}/.well-known/iterate-profile`)
  .then((answer) => answer.json())
  .catch(() => ({}));

function MindDash() {
  const [{ name, icon }, setProfile] = useState({});
  useEffect(() => void profile.then(setProfile), []);
  // with no icon, the kit draws its own mark
  const logo = icon && html`<img src=${icon} alt="" className="size-8 rounded-md" />`;
  const shown = {
    name: name || zone,
    logo,
    itx,
    mind,
    pages,
    links,
    foot,
    accountLinks,
    sidebarDefaultOpen,
  };
  return html`<${Dash} app="Dash" ...${shown} />`;
}

render(html`<${MindDash} />`, document.getElementById("root"));
