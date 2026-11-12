// app.js — THE DASH'S PAGE: the mind seen from above. Five pages in one:
//
//   Overview   who is signed in, and the way to every app and every page about access
//   Contexts   any context of the mind, live: its log, its processors, who is here
//   Repo       the config repo as a small IDE: files, an editor, a diff, commits
//   Secrets    what the mind may send where: set a secret, update it, delete it
//   MCP        how to connect Claude Code or the Codex CLI to the mind
//
// The larger parts are components of @iterate-com/ui, loaded through the import map in
// index.html: `ContextExplorer`, `RepoIde`, `SecretsPage` and `McpConnect` are the ones
// iterate's hosted Dash draws. This file is the wiring: the member's itx, the URL, the sidebar and
// the overview. Change them here.
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
import {
  ContextExplorer,
  contextPathOf,
  contextViewStateOf,
} from "@iterate-com/ui/components/context-explorer/context-explorer";
import { McpConnect } from "@iterate-com/ui/components/mcp-connect";
import { RepoIde, repoIdeSearchOf } from "@iterate-com/ui/components/repo-ide/repo-ide";
import { SecretsPage, secretsPageStateOf } from "@iterate-com/ui/components/secrets-page";
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
  BookOpenIcon,
  BotIcon,
  FolderGit2Icon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LockKeyholeIcon,
  PhoneIcon,
  PlugIcon,
  ShieldCheckIcon,
  UsersIcon,
  WaypointsIcon,
} from "lucide-react";

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
  { name: "Voice", host: "voice", icon: PhoneIcon, about: "Call the mind from this browser." },
  { name: "Docs", host: "docs", icon: BookOpenIcon, about: "The config repo, read as pages." },
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

// ── the URL ──
// THE PAGE IS A LINK: `?page=contexts|repo|secrets|mcp` is the page (none: the overview),
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
  const context = contextPathOf(params.get("context") || "");
  let view = html`<${Overview} />`;
  if (page === "contexts") view = html`<${Contexts} path=${context} search=${search} />`;
  if (page === "repo")
    view = html`<${Repo} name=${params.get("repo") || "config"} search=${search} />`;
  if (page === "secrets") view = html`<${Secrets} search=${search} />`;
  if (page === "mcp")
    view = html`<div className="dash-scroll"><${McpConnect} server=${`${stack}/mcp`} /></div>`;
  return html`
    <${AppShell}
      app="Dash"
      mind=${domain}
      mindHref=${() => "./"}
      nav=${html`<${Nav} page=${page} waiting=${waiting} />`}
      account=${principal}
      locationKey=${location.pathname + search}
    >
      ${view}
    <//>
    <${Toaster} theme=${document.documentElement.classList.contains("dark") ? "dark" : "light"} />
  `;
}

/** Any context of the mind, live. The explorer knows no router: these are its links. */
function Contexts({ path, search }) {
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
    <${ContextExplorer}
      openRoot=${() => itx.cd("/")}
      deps=${[]}
      path=${path}
      links=${links}
      state=${contextViewStateOf(view)}
      onStateChange=${patchView}
    />
  `;
}

/** The mind's secrets. This page reads the list, and reads it again after a set or a delete. The
 *  sheet's state is `?view`, so New secret and a row's Update are links: opening one is a new entry
 *  in the history, and Back closes it. */
function Secrets({ search }) {
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
      <${SecretsPage}
        itx=${itx}
        secrets=${list.secrets}
        state=${secretsPageStateOf(view)}
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
function Repo({ name, search }) {
  const [view, patchView] = useView(search);
  const root = useContextStub(() => itx.cd("/"), []);
  if (root.error) return html`<p role="alert" className="dash-note dash-error">${root.error}</p>`;
  if (!root.stub) return html`<p className="dash-note" data-spinner="true">Opening the mind…</p>`;
  const email = principal?.email;
  return html`
    <div className="dash-fill">
      <${RepoIde}
        key=${name}
        mind=${root.stub}
        mindId=${domain}
        repoPath=${`/repos/${name}`}
        author=${email ? { name: email, email } : undefined}
        search=${repoIdeSearchOf(view)}
        onSearchChange=${patchView}
      />
    </div>
  `;
}

/** Who is signed in, and the way to everything else. */
function Overview() {
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

/** One group of the overview: a card for each row, and the whole card is the link. */
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
                  <${CardTitle}><${row.icon} aria-hidden="true" />${row.name}<//>
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

/** The sidebar: the Dash's three pages, then the mind's apps and the pages about access. */
function Nav({ page, waiting }) {
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
                  render=${html`<a ...${row.link} />`}
                >
                  <${row.icon} />
                  <span>${row.name}</span>
                <//>
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
