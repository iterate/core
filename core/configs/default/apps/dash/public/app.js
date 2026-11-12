// app.js — THE DASH'S PAGE: the mind seen from above. Seven pages in one:
//
//   Overview      who is signed in, and the way to every app and every page about access
//   Contexts      any context of the mind, live: its log, its processors, who is here
//   Repo          the config repo as a small IDE: files, an editor, a diff, commits
//   Secrets       what the mind may send where: set a secret, update it, delete it
//   Integrations  what the mind's packages registered, with their connections
//   Analytics     the mind's telemetry, when its stack has telemetry
//   MCP           how to connect Claude Code or the Codex CLI to the mind
//
// The larger parts are components of @iterate-com/ui, loaded through the import map in
// index.html, EACH WHEN ITS PAGE FIRST OPENS (`kits` below): the overview loads none of them.
// They are: `ContextExplorer`, `RepoIde`, `SecretsPage`, `IntegrationsPage`, `AnalyticsPage`
// and `McpConnect` are the ones iterate's hosted Dash draws. This file is the wiring: the member's
// itx, the URL, the sidebar and the overview. Change them here.
//
// WHAT THE PAGE ASKS BY ITSELF: the count of what waits for approval (the kit asks once when the
// page opens, then every five minutes while the tab is in front), whether the mind has telemetry
// (once, when the page opens: the sidebar and the overview say "Off" when it has none), and the
// live charts of Analytics (every thirty seconds while that page is shown). Every other read is
// one that a person's click starts.
import {
  html,
  render,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "@iterate-com/ui/page";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import { ApprovalsAlert } from "@iterate-com/ui/components/approvals-alert";
import { Card, CardDescription, CardHeader, CardTitle } from "@iterate-com/ui/components/ui/card";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/ui/sidebar";
import { Toaster } from "@iterate-com/ui/components/ui/sonner";
import { titleWithCount, useWaitingApprovals } from "@iterate-com/ui/lib/waiting-approvals";
import { newWebSocketRpcSession, useContextStub } from "@iterate-com/ui/live";
import {
  BlocksIcon,
  BookOpenIcon,
  BotIcon,
  ChartLineIcon,
  CompassIcon,
  FolderGit2Icon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LockKeyholeIcon,
  PhoneIcon,
  PlugIcon,
  ShieldCheckIcon,
  UsersIcon,
  WaypointsIcon,
} from "@iterate-com/ui/icons";
import { kitPages } from "./kit-pages.js";

// ── the member's itx ──
// As apps/agents/public/app.js: one WebSocket to this host's /itx, a capnweb session whose root is
// the mind's itx, as the member the platform signed in on this host. The platform ends it when
// the sign-in ends; a reload signs in again. Three closes in a minute stop the reloads.
const socket = new WebSocket(new URL("/itx", location.href.replace(/^http/, "ws")));
const itx = newWebSocketRpcSession(socket);
socket.addEventListener("close", () => {
  const now = Date.now();
  let closes = [];
  try {
    closes = JSON.parse(sessionStorage.getItem("itx-closes") || "[]").filter(
      (at) => now - at < 60_000,
    );
    sessionStorage.setItem("itx-closes", JSON.stringify([...closes, now]));
  } catch {
    // no storage: one reload is still right
  }
  if (closes.length < 3) setTimeout(() => location.reload(), 1000);
  else document.getElementById("root").textContent = "Disconnected. Reload the page to connect.";
});

const { principal } = await itx.whoami();

// The mind is its domain, and this host is one label under it.
const domain = location.hostname.split(".").slice(1).join(".") || location.hostname;
/** The stack's own pages (keys, members, approvals) are on this host of the mind. */
const stack = `https://iterate.${domain}`;

// ── what the Dash links to ──
// The mind's apps, each on its own host, and the stack's pages about who may do what. An app you
// add in worker.ts gets a row here.
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
].map((app) => ({ ...app, href: `https://${app.host}.${domain}` }));

/** Where a member answers what waits for a yes: the stack's own page, which asks for a passkey. */
const approvals = `${stack}/secrets/approvals`;

const access = [
  {
    name: "Approvals",
    href: approvals,
    icon: ShieldCheckIcon,
    about: "What waits for your yes, and the rules that make it wait.",
  },
  {
    name: "Keys",
    href: `${stack}/keys`,
    icon: KeyRoundIcon,
    about: "Your passkeys, and the keys of your devices and tools.",
  },
  { name: "Members", href: `${stack}/members`, icon: UsersIcon, about: "Who may use this mind." },
];

// ── a page's part of the kit ──
// A PAGE'S COMPONENT IS LOADED WHEN ITS PAGE FIRST OPENS, once. The overview loads none of them:
// the repo IDE, the charts and the YAML reader are most of what the kit weighs. A page you add
// names its module here and takes it as `kit`.
const kits = {
  analytics: () => import("@iterate-com/ui/components/analytics-page"),
  contexts: () => import("@iterate-com/ui/components/context-explorer/context-explorer"),
  integrations: () => import("@iterate-com/ui/components/integrations-page"),
  mcp: () => import("@iterate-com/ui/components/mcp-connect"),
  repo: () => import("@iterate-com/ui/components/repo-ide/repo-ide"),
  secrets: () => import("@iterate-com/ui/components/secrets-page"),
};
const pages = kitPages(kits);

/** The kit's module for `page` (./kit-pages.js): `{ module }` once it is here, `{ error }` when it
 *  did not load, and neither while it loads. Opening a page starts its part; what the page's part
 *  is comes from the store, so it is the open page's own and never another page's. A part that
 *  did not load stays so until the page is loaded again: the view says that. */
function useKit(page) {
  useEffect(() => pages.load(page), [page]);
  return useSyncExternalStore(pages.subscribe, () => pages.read(page));
}

// ── the URL ──
// THE PAGE IS A LINK: `?page=contexts|repo|secrets|integrations|analytics|mcp` is the page (none:
// the overview),
// `?context=<path>` the context shown, `?repo=<name>` the repo (none: config), and `?view=<json>`
// what the page's own view holds (the explorer's filter and inspected event, the IDE's open file
// and panes, the secrets page's open sheet).
const subscribeToUrl = (listener) => {
  addEventListener("popstate", listener);
  return () => removeEventListener("popstate", listener);
};

const hrefOf = (change) => {
  const next = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(change))
    if (value === undefined) next.delete(key);
    else next.set(key, value);
  const query = next.toString();
  return query ? `?${query}` : "./";
};

/** Go to `href` on this page: a new entry in the history, or the same entry changed. */
const go = (href, replace) => {
  if (replace) history.replaceState(null, "", href);
  else history.pushState(null, "", href);
  dispatchEvent(new PopStateEvent("popstate"));
};

/** What makes an `<a>` a link that changes this page's URL: a plain left click stays on the page,
 *  and any other click is the browser's (a new tab). */
const linkTo = (change) => ({
  href: hrefOf(change),
  onClick: (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    go(hrefOf(change));
  },
});

/** The keys that name a page, cleared: a link to a page starts from none of the last one's. */
const pageOf = (page, more = {}) => ({
  page,
  context: undefined,
  repo: undefined,
  view: undefined,
  ...more,
});

/** `?view=<json>` as an object, and the way a view patches it: an absent key is dropped, and the
 *  change replaces the history's entry, so Back leaves the page and not each keystroke. */
function useView(search) {
  const view = useMemo(() => {
    try {
      return JSON.parse(new URLSearchParams(search).get("view") || "{}");
    } catch {
      return {}; // a hand-edited value: no view state
    }
  }, [search]);
  const patchView = useCallback(
    (patch) => {
      const next = Object.fromEntries(
        Object.entries({ ...view, ...patch }).filter(([, value]) => value !== undefined),
      );
      go(hrefOf({ view: Object.keys(next).length ? JSON.stringify(next) : undefined }), true);
    },
    [view],
  );
  return [view, patchView];
}

/** How the kit's reader of approvals asks this mind: with the page's one `itx`. */
const read = (ask) => ask(itx);

function App() {
  // WHAT WAITS FOR A MEMBER'S YES is said on every page: the alert at the top of the sidebar, the
  // number beside "Approvals", and the count before the tab's title. An agent stands still until
  // a member answers. The kit asks again every 30 seconds while the tab is in front.
  const waiting = useWaitingApprovals(domain, read);
  useEffect(() => {
    document.title = titleWithCount(document.title, waiting);
  }, [waiting]);
  const search = useSyncExternalStore(subscribeToUrl, () => location.search);
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const page = params.get("page") || "overview";
  const { module: kit, error: kitError } = useKit(page);
  // Asked once here, for the sidebar, the overview and the Analytics page: a mind with no
  // telemetry shows Analytics as "Off" everywhere, and its page says how to turn it on.
  const hasTelemetry = useServes("telemetry");
  const telemetryOff = hasTelemetry === false;
  let view = html`<${Overview} telemetryOff=${telemetryOff} />`;
  if (kitError)
    view = html`
      <p role="alert" className="dash-note dash-error">
        This page did not load: ${kitError}. ${" "}
        <a href=${location.href}>Load the page again</a> to try once more.
      </p>
    `;
  else if (!kit) view = html`<p className="dash-note" data-spinner="true">Loading the page…</p>`;
  else if (page === "contexts")
    view = html`<${Contexts} kit=${kit} path=${params.get("context") || ""} search=${search} />`;
  else if (page === "repo")
    view = html`<${Repo} kit=${kit} name=${params.get("repo") || "config"} search=${search} />`;
  else if (page === "secrets") view = html`<${Secrets} kit=${kit} search=${search} />`;
  else if (page === "integrations") view = html`<${Integrations} kit=${kit} />`;
  else if (page === "analytics") view = html`<${Analytics} kit=${kit} serves=${hasTelemetry} />`;
  else if (page === "mcp")
    view = html`<div className="dash-scroll"><${kit.McpConnect} server=${`${stack}/mcp`} /></div>`;
  return html`
    <${AppShell}
      app="Dash"
      mind=${domain}
      mindHref=${() => "./"}
      nav=${html`<${Nav} page=${page} waiting=${waiting} telemetryOff=${telemetryOff} />`}
      account=${principal}
      locationKey=${location.pathname + search}
    >
      ${view}
    <//>
    <${Toaster} theme=${document.documentElement.classList.contains("dark") ? "dark" : "light"} />
  `;
}

/** Any context of the mind, live. The explorer knows no router: these are its links. */
function Contexts({ kit, path, search }) {
  const [view, patchView] = useView(search);
  const links = useMemo(
    () => ({
      hrefOf: (to) => hrefOf(pageOf("contexts", { context: to === "/" ? undefined : to })),
      onNavigate: (href, event) => {
        event.preventDefault();
        go(href);
      },
    }),
    [],
  );
  return html`
    <${kit.ContextExplorer}
      openRoot=${() => itx.cd("/")}
      deps=${[]}
      path=${kit.contextPathOf(path)}
      links=${links}
      state=${kit.contextViewStateOf(view)}
      onStateChange=${patchView}
    />
  `;
}

/** Whether the mind serves `itx.<root>` (a part that not every stack has): undefined while the
 *  page asks, which it does once. */
function useServes(root) {
  const [serves, setServes] = useState();
  useEffect(() => {
    let current = true;
    itx.rewriteRules.get(`itx.${root}`).then(
      (rule) => current && setServes(Boolean(rule?.target)),
      () => current && setServes(false),
    );
    return () => {
      current = false;
    };
  }, [root]);
  return serves;
}

/** A page for a part that the mind's stack does not have: its title and one plain line. */
function PartIsOff({ title, children }) {
  return html`
    <div className="dash-scroll">
      <div className="dash-overview">
        <header>
          <h1>${title}</h1>
          <p className="dash-muted">${children}</p>
        </header>
      </div>
    </div>
  `;
}

/** ONE function for the page's life: the kit's pages read again when they are handed another. */
const openIntegrations = () => itx.cd("/integrations");

/** What the mind's packages registered, live from one subscription. */
function Integrations({ kit }) {
  const serves = useServes("integrations");
  if (serves === undefined)
    return html`<p className="dash-note" data-spinner="true">Reading the mind…</p>`;
  if (!serves)
    return html`<${PartIsOff} title="Integrations">This mind has no integrations yet.<//>`;
  return html`
    <div className="dash-scroll">
      <${kit.IntegrationsPage} openRegistry=${openIntegrations} deps=${[]} mind=${domain} />
    </div>
  `;
}

/** The mind's telemetry. A mind without telemetry is asked nothing: the kit's page says that it
 *  is off, what turns it on and who can. `serves` is the shell's one answer (undefined: asking). */
function Analytics({ kit, serves }) {
  // one function for the page's life: the page reads again when it is handed another
  const telemetry = useMemo(() => kit.telemetryQueryOf(itx), [kit]);
  if (serves === undefined)
    return html`<p className="dash-note" data-spinner="true">Reading the mind…</p>`;
  if (!serves)
    return html`<div className="dash-scroll"><${kit.TelemetryOff} mind=${domain} /></div>`;
  return html`<div className="dash-scroll"><${kit.AnalyticsPage} query=${telemetry} /></div>`;
}

/** The mind's secrets. This page reads the list, and reads it again after a set or a delete. The
 *  sheet's state is `?view`, so New secret and a row's Update are links: opening one is a new entry
 *  in the history, and Back closes it. */
function Secrets({ kit, search }) {
  const [view] = useView(search);
  // undefined while the page reads; then `{ secrets }`, `{ off }` for a mind with no vault, or `{ error }`
  const [list, setList] = useState();
  const reload = useCallback(async () => {
    try {
      const vault = await itx.rewriteRules.get("itx.secrets");
      setList(vault?.target ? { secrets: await itx.secrets.list() } : { off: true });
    } catch (failure) {
      setList({ error: failure instanceof Error ? failure.message : String(failure) });
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  if (!list) return html`<p className="dash-note" data-spinner="true">Reading the secrets…</p>`;
  if (list.error) return html`<p role="alert" className="dash-note dash-error">${list.error}</p>`;
  if (list.off) return html`<p className="dash-note">This mind has no vault for secrets yet.</p>`;
  return html`
    <div className="dash-scroll">
      <${kit.SecretsPage}
        itx=${itx}
        secrets=${list.secrets}
        state=${kit.secretsPageStateOf(view)}
        onStateChange=${(next, replace) =>
          go(
            hrefOf({ view: Object.keys(next).length ? JSON.stringify(next) : undefined }),
            replace,
          )}
        onChanged=${reload}
      />
    </div>
  `;
}

/** One repo of the mind as a small IDE. It follows the repo's commits live, so the mind's root
 *  is held while the page is up. */
function Repo({ kit, name, search }) {
  const [view, patchView] = useView(search);
  const root = useContextStub(() => itx.cd("/"), []);
  if (root.error) return html`<p role="alert" className="dash-note dash-error">${root.error}</p>`;
  if (!root.stub) return html`<p className="dash-note" data-spinner="true">Opening the mind…</p>`;
  const email = principal?.email;
  return html`
    <div className="dash-fill">
      <${kit.RepoIde}
        key=${name}
        mind=${root.stub}
        mindId=${domain}
        repoPath=${`/repos/${name}`}
        author=${email ? { name: email, email } : undefined}
        search=${kit.repoIdeSearchOf(view)}
        onSearchChange=${patchView}
      />
    </div>
  `;
}

/** Who is signed in, and the way to everything else. */
function Overview({ telemetryOff }) {
  return html`
    <div className="dash-scroll">
      <div className="dash-overview">
        <header>
          <h1>${domain}</h1>
          <p className="dash-muted">
            ${principal?.email ? `Signed in as ${principal.email}.` : "Signed in."} This page is
            apps/dash in the mind's config repo: change it like any file there.
          </p>
        </header>
        <${Cards}
          title="The mind"
          rows=${[
            {
              name: "Contexts",
              icon: WaypointsIcon,
              about: "Any context's log, live: agents, integrations, repos, secrets.",
              link: linkTo(pageOf("contexts")),
            },
            {
              name: "Config repo",
              icon: FolderGit2Icon,
              about: "The mind's own code: read it, change it, commit.",
              link: linkTo(pageOf("repo")),
            },
            {
              name: "Secrets",
              icon: LockKeyholeIcon,
              about: "What the mind may send where: set, update, delete.",
              link: linkTo(pageOf("secrets")),
            },
            {
              name: "Integrations",
              icon: BlocksIcon,
              about: "What the mind's packages registered, and their connections.",
              link: linkTo(pageOf("integrations")),
            },
            {
              name: "Analytics",
              icon: ChartLineIcon,
              about: telemetryOff
                ? "Telemetry is off. The page says how to turn it on."
                : "The mind's telemetry: events, lag, storage, a SQL box.",
              off: telemetryOff,
              link: linkTo(pageOf("analytics")),
            },
            {
              name: "MCP",
              icon: PlugIcon,
              about: "Connect Claude Code or the Codex CLI to this mind.",
              link: linkTo(pageOf("mcp")),
            },
          ]}
        />
        <${Cards} title="Apps" rows=${apps.map((app) => ({ ...app, link: { href: app.href } }))} />
        <${Cards}
          title="Access"
          rows=${access.map((row) => ({ ...row, link: { href: row.href } }))}
        />
      </div>
    </div>
  `;
}

/** One group of the overview: a card for each row, and the whole card is the link. A row that is
 *  `off` says "Off" beside its name. */
function Cards({ title, rows }) {
  return html`
    <section>
      <h2>${title}</h2>
      <div className="dash-cards">
        ${rows.map(
          (row) => html`
            <a key=${row.name} className="dash-card" ...${row.link}>
              <${Card}>
                <${CardHeader}>
                  <${CardTitle}>
                    <${row.icon} aria-hidden="true" />${row.name}
                    ${row.off ? html`<span className="dash-off">Off</span>` : null}
                  <//>
                  <${CardDescription}>${row.about}<//>
                <//>
              <//>
            </a>
          `,
        )}
      </div>
    </section>
  `;
}

/** The sidebar: the Dash's pages, then the mind's apps and the pages about access. Analytics
 *  stays in its place for a mind with no telemetry, muted, with "Off" beside it. */
function Nav({ page, waiting, telemetryOff }) {
  const pages = [
    {
      name: "Overview",
      icon: LayoutDashboardIcon,
      page: "overview",
      link: linkTo(pageOf(undefined)),
    },
    { name: "Contexts", icon: WaypointsIcon, page: "contexts", link: linkTo(pageOf("contexts")) },
    { name: "Config repo", icon: FolderGit2Icon, page: "repo", link: linkTo(pageOf("repo")) },
    {
      name: "Secrets",
      icon: LockKeyholeIcon,
      page: "secrets",
      link: linkTo(pageOf("secrets")),
    },
    {
      name: "Integrations",
      icon: BlocksIcon,
      page: "integrations",
      link: linkTo(pageOf("integrations")),
    },
    {
      name: "Analytics",
      icon: ChartLineIcon,
      page: "analytics",
      off: telemetryOff,
      link: linkTo(pageOf("analytics")),
    },
    { name: "MCP", icon: PlugIcon, page: "mcp", link: linkTo(pageOf("mcp")) },
  ];
  return html`
    <${SidebarGroup}>
      <${SidebarGroupContent}>
        <${ApprovalsAlert} waiting=${waiting} render=${html`<a href=${approvals} />`} />
        <${SidebarMenu}>
          ${pages.map(
            (row) => html`
              <${SidebarMenuItem} key=${row.name}>
                <${SidebarMenuButton}
                  isActive=${row.page === page}
                  tooltip=${row.name}
                  className=${row.off ? "text-muted-foreground" : undefined}
                  render=${html`<a ...${row.link} />`}
                >
                  <${row.icon} />
                  <span>${row.name}</span>
                <//>
                ${row.off ? html`<${SidebarMenuBadge} className="dash-off-badge">Off<//>` : null}
              <//>
            `,
          )}
        <//>
      <//>
    <//>
    <${Links} title="Apps" rows=${apps} />
    <${Links} title="Access" rows=${access} counts=${{ Approvals: waiting }} />
  `;
}

/** A group of the sidebar whose rows leave the Dash: another app, or a page of the stack. A row
 *  named in `counts` shows its number. */
function Links({ title, rows, counts = {} }) {
  return html`
    <${SidebarGroup}>
      <${SidebarGroupLabel}>${title}<//>
      <${SidebarGroupContent}>
        <${SidebarMenu}>
          ${rows.map(
            (row) => html`
              <${SidebarMenuItem} key=${row.name}>
                <${SidebarMenuButton} tooltip=${row.name} render=${html`<a href=${row.href} />`}>
                  <${row.icon} />
                  <span>${row.name}</span>
                <//>
                ${counts[row.name] ? html`<${SidebarMenuBadge}>${counts[row.name]}<//>` : null}
              <//>
            `,
          )}
        <//>
      <//>
    <//>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
