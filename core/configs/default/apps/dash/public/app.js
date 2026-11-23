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
  CircleCheckIcon,
  CompassIcon,
  FolderGit2Icon,
  HistoryIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LockKeyholeIcon,
  PlugIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UsersIcon,
  WaypointsIcon,
} from "@iterate-com/ui/icons";
import { CALL_FACET } from "./call-facet.js";
import { DashMcp } from "./mcp-page.js";
import { endLink, makeLink } from "./share-links.js";

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
    // the chat shows who else has this agent open now and who is typing: the faces come from the
    // context's own subscription rows (who holds each open page), and a page says only its status
    // (hidden, typing) in an ephemeral event. Nothing durable is written for it.
    presence: true,
    // a call on any agent's page: the first press of the header's call buttons turns the call
    // facet on for the agent (call.ts)
    call: {
      enable: (itx, path) => itx.cd(path).processors.enable("call", CALL_FACET),
    },
    // SHARE beside the call's controls: links that let people who are not members into one agent's
    // chat and call, the live ones with their guests, End, and a calendar invite. The link is made
    // by share-links.js, the one module that Meet and `itx.config.shareAgent` use too, and appended
    // through the member's own stub, so the link names the member as its maker. A guest comes in on
    // Meet's guest page. Take this out, and the agent's header has no Share.
    share: {
      make: async (itx, path, lifetimeMs) => {
        const { event, url, until, link } = await makeLink({
          zone,
          agent: path,
          lifetimeMs,
          now: Date.now(),
        });
        await itx.cd(path).append(event);
        return { url, until, link };
      },
      end: (itx, path, link) => itx.cd(path).append(endLink(link)),
    },
    // AN AGENT'S TOOLS IN THIS PAGE are off. `pageTools: true` here lends the agent whose page a
    // member has open a banner in that tab, and, inside what index.html marks with
    // `data-page-tools="scope"` (<body> for all of it), Playwright's locators: fill, click, press,
    // highlight, read. What the agent does there carries THAT MEMBER's stamp in the log, and the
    // page's audit row for the call names no caller. A jailed agent gets nothing. apps.md, "The
    // Dash", says what it costs.
  },
  {
    id: "integrations",
    name: "Integrations",
    about: "The accounts and services the mind is connected to.",
    icon: BlocksIcon,
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
    component: DashRepo,
  },
  {
    id: "contexts",
    name: "Contexts",
    about: "Every context of the mind, raw and live.",
    icon: WaypointsIcon,
    component: DashContexts,
  },
  // not every stack has telemetry: without it, the row says "Off"
  {
    id: "analytics",
    name: "Analytics",
    about: "The mind's telemetry.",
    icon: ChartLineIcon,
    serves: "telemetry",
    component: DashAnalytics,
  },
  {
    id: "mcp",
    name: "MCP",
    about: "Connect coding agents over MCP — stays up even if you brick the userspace web UI.",
    icon: PlugIcon,
    component: DashMcp,
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
  {
    name: "Tasks",
    about: "Tasks and onboarding cards as a board.",
    host: "tasks",
    icon: CircleCheckIcon,
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
//
// AFTER EACH PUBLICATION the open Dash reads them again (live-reload.js tells the window), so a
// new name or icon shows with no reload. `at` makes the addresses new ones: a browser keeps the
// profile and the icon for five minutes.
const readProfile = (at) =>
  fetch(`https://${zone}/.well-known/iterate-profile${at ? `?at=${at}` : ""}`)
    .then((answer) => answer.json())
    .then((said) => (at && said.icon ? { ...said, icon: `${said.icon}?at=${at}` } : said))
    .catch(() => null);
const profile = readProfile();

function MindDash() {
  const [{ name, icon }, setProfile] = useState({});
  useEffect(() => {
    void profile.then((said) => said && setProfile(said));
    const readAgain = async () => {
      const at = Date.now();
      const said = await readProfile(at);
      if (!said) return;
      setProfile(said);
      // the tab's icon is the same file, on this host
      const tab = document.querySelector('link[rel="icon"]');
      if (tab) tab.href = `/icon.svg?at=${at}`;
    };
    window.addEventListener("live-reload:published", readAgain);
    return () => window.removeEventListener("live-reload:published", readAgain);
  }, []);
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
