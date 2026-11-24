// app.js — THE DOCS APP'S PAGE: the files of this mind's repos, written together. The sidebar is
// a repo's files as a tree. Beside it is one file in a live editor: several people type in it at
// once and see each other, comment on its text, and what they type is saved as commits. With no
// file open, the page lists the repo's docs and makes a new one.
//
// Everything it draws is a component of @iterate-com/ui, loaded through the import map in
// index.html: `DocEditor`, `DocTree` and `DocListPanel` are that package's docs editor. This file
// is the wiring: the member's itx, the URL, and where the editor's processors are (processors/).
import {
  html,
  render,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "@iterate-com/ui/page";
import { AppShell, AppShellBrand } from "@iterate-com/ui/components/app-shell";
import {
  commitAuthorOf,
  cursorColor,
  DocEditor,
  DocList,
  DocListPanel,
  DocSession,
  DocTree,
  fileKind,
} from "@iterate-com/ui/components/docs-editor/docs-editor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@iterate-com/ui/components/ui/sidebar";
import { CheckIcon, ChevronDownIcon } from "@iterate-com/ui/icons";
import { newWebSocketRpcSession } from "@iterate-com/ui/live";

// ── the member's itx ──
// As @iterate-com/ui/live's `memberItx` (the Dash's page): one WebSocket to this host's /itx, a
// capnweb session whose root is the mind's itx, as the member the platform signed in on this
// host. The platform ends it when the sign-in ends; a reload signs in again. Three closes in a
// minute stop the reloads.
const socket = new WebSocket(new URL("/itx", location.href.replace(/^http/, "ws")));
socket.addEventListener("open", () => performance.mark("iterate:itx-open"), { once: true });
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
// Who types, as the others see them, and who a commit made here is by.
const me = principal?.email || principal?.actor || "someone";
const user = { name: me, email: me, color: cursorColor(me) };
const author = principal ? commitAuthorOf(principal) : undefined;

// The mind's address is its control-plane hostname, where its sign-in is: this host says it
// (`/.auth/session.json`, ../app.ts). The page never works it out from its own hostname, which
// may be in any zone of the mind.
// index.html asks for it in its head, while the modules load.
const hostSession =
  window.__session ?? fetch("/.auth/session.json").then((answer) => answer.json());
const mind = new URL((await hostSession).issuer).hostname;
// The sidebar's head: the mind's icon above its address, as in the Dash. The app's own
// `/icon.svg` is the mind's icon (../../open-files.ts), so the page asks its own host for it.
// This app serves one mind, so it shows the plain head, with no list of minds to switch to.
const MIND_ICON = html`<img src="/icon.svg" alt="" className="size-8 rounded-md" />`;

// ── where the editor's processors are ──
// The page starts a doc's processors (../processors/classes.ts says why from here) under a name
// for their version: the source's, which ../app.ts answers, and the pins of the three packages in
// package.json, so a changed pin starts them anew too.
const PROCESSOR_PACKAGES = ["yjs", "diff", "node-diff3"];
const processorsAnswer = await fetch("/processors.json");
// a refusal is said as it is: its body is no list of processors
if (!processorsAnswer.ok)
  throw new Error(`Docs cannot start: /processors.json answered ${processorsAnswer.status}`);
const processors = await processorsAnswer.json();
const manifest = JSON.parse(
  (await itx.repos.get("/repos/config").readFile("package.json")) || "{}",
);
const pins = PROCESSOR_PACKAGES.map((name) => `${name}@${manifest.dependencies?.[name] || "none"}`);
const missingPackages = PROCESSOR_PACKAGES.filter((name) => !manifest.dependencies?.[name]);
const facetSpec = (className) => ({
  className,
  mainModule: processors.mainModule,
  source: ["itx", ["cd", "/"], "repos", ["get", "/repos/config"], ["modules"]],
  cacheKey: `docs-processors:${processors.version}:${pins.join(",")}`,
});

/** What the editor says, in this page's words, when a doc cannot be opened for editing: what the
 *  config repo needs. The editor shows the platform's own reason above it. */
/** One sentence when the repo's package.json lacks one of the packages, else nothing. */
function whatIsMissing() {
  if (missingPackages.length === 0) return null;
  return html`
    This repo's <code>package.json</code> does not list <code> ${missingPackages.join(", ")}</code>.
  `;
}
const whatDocsNeeds = html`
  <div>
    <p>
      Docs edits a file through two classes in this mind's config repo,
      <code> apps/docs/processors/</code>, and three packages in its <code>package.json</code>.
      ${whatIsMissing()}
    </p>
    <p>
      To set it up, ask an agent of this mind to "bring the Docs app's processors and packages up to
      the default config's", or add them by hand: the folder
      <code> apps/docs/processors/</code> and, under <code>"dependencies"</code>, the packages
      <code> yjs</code>, <code>diff</code> and <code>node-diff3</code>, as in
      <a
        href="https://github.com/iterate/core/tree/main/core/configs/default"
        target="_blank"
        rel="noreferrer"
        >the default config</a
      >. The file below is shown as it was read.
    </p>
  </div>
`;

// ── the URL ──
// THE PAGE IS A LINK: `?repo=<name>` is the repo (none: config), `?doc=<path>` the open file, and
// `?mode=comment` opens it to read and comment on, not to edit.
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

const go = (href) => {
  history.pushState(null, "", href);
  dispatchEvent(new PopStateEvent("popstate"));
};

/** The repos' names, sorted: `config` is /repos/config. */
const repoNames = (repos) =>
  repos
    .map((repo) => /^\/repos\/([^/]+)$/.exec(repo.path)?.[1])
    .filter(Boolean)
    .sort();

// ── reads ──

/** What a promise came to, for the `key` it was asked with: `{ key, value }`, `{ key, error }`, or
 *  undefined while it runs. A newer key drops the older answer. */
function useRead(key, read) {
  const [answer, setAnswer] = useState();
  useEffect(() => {
    let current = true;
    read().then(
      (value) => current && setAnswer({ key, value }),
      (error) =>
        current &&
        setAnswer({ key, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      current = false;
    };
    // `read` is made anew each render: `key` says when to read again
  }, [key]);
  return answer?.key === key ? answer : undefined;
}

// ── the page ──

function App() {
  const search = useSyncExternalStore(subscribeToUrl, () => location.search);
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const repo = params.get("repo") || "config";
  const path = params.get("doc") || undefined;
  const commentOnly = params.get("mode") === "comment";
  const repos = useRead("repos", async () => repoNames(await itx.repos.list()));
  const names = repos?.value || [];
  // one list per repo: the tree and the doc list read the same one
  const list = useMemo(() => new DocList(itx, `/repos/${repo}`), [repo]);
  const open = useCallback((file) => go(hrefOf({ doc: file, mode: undefined })), []);
  return html`
    <${AppShell}
      app="Docs"
      mind=${mind}
      switcher=${html`<${RepoSwitcher} repo=${repo} repos=${names} />`}
      nav=${html`<${Files} repo=${repo} list=${list} path=${path} open=${open} />`}
      account=${principal}
      locationKey=${location.pathname + search}
    >
      <${Page} repo=${repo} path=${path} commentOnly=${commentOnly} list=${list} open=${open} />
    <//>
  `;
}

/** The sidebar's head: Docs + the active repo, with a dropdown to switch repos when the mind has
 *  more than one, or a plain brand when it has one. */
function RepoSwitcher({ repo, repos }) {
  const { isMobile, setOpenMobile } = useSidebar();
  if (repos.length <= 1) {
    return html`<${AppShellBrand} app="Docs" line=${repo} logo=${MIND_ICON} href="./" />`;
  }
  return html`
    <${SidebarMenu}>
      <${SidebarMenuItem}>
        <${DropdownMenu}>
          <${DropdownMenuTrigger}
            render=${html`
              <${SidebarMenuButton}
                size="lg"
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
                aria-label=${`Repo: ${repo}`}
              >
                <span
                  className="flex aspect-square size-8 items-center justify-center rounded-md bg-black"
                >
                  ${MIND_ICON}
                </span>
                <span className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Docs</span>
                  <span className="truncate text-xs text-muted-foreground">${repo}</span>
                </span>
                <${ChevronDownIcon} className="ml-auto" />
              <//>
            `}
          />
          <${DropdownMenuContent}
            align="start"
            side=${isMobile ? "bottom" : "right"}
            sideOffset=${4}
            className="min-w-56 rounded-lg"
          >
            <${DropdownMenuGroup}>
              <${DropdownMenuLabel}>Repos<//>
              ${repos.map(
                (name) => html`
                  <${DropdownMenuItem}
                    key=${name}
                    className="gap-2"
                    onClick=${() => {
                      if (name !== repo)
                        go(hrefOf({ repo: name, doc: undefined, mode: undefined }));
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <span className="truncate">${name}</span>
                    ${name === repo ? html`<${CheckIcon} className="ml-auto" />` : null}
                  <//>
                `,
              )}
            <//>
          <//>
        <//>
      <//>
    <//>
  `;
}

/** Beside the sidebar: the open file, or with none the repo's docs and "New doc". */
function Page({ repo, path, commentOnly, list, open }) {
  if (!path)
    return html`
      <${DocListPanel}
        list=${list}
        author=${author}
        docHref=${(file) => hrefOf({ doc: file, mode: undefined })}
        onOpen=${open}
      />
    `;
  return html`
    <${Doc}
      key=${`${repo}:${path}:${commentOnly}`}
      repo=${repo}
      path=${path}
      commentOnly=${commentOnly}
    />
  `;
}

/** The sidebar: the repo's name and its files as a tree. */
function Files({ repo, list, path, open }) {
  return html`
    <${SidebarGroup}>
      <${SidebarGroupLabel}>${repo}<//>
      <${SidebarGroupContent}>
        <${DocTree} list=${list} openPath=${path} onOpen=${open} author=${author} />
      <//>
    <//>
  `;
}

/** One file of the repo: read once, then live in the editor. A file that is not text has no
 *  editor. */
function Doc({ repo, path, commentOnly }) {
  const kind = fileKind(path);
  const file = useRead(`${repo}:${path}`, () =>
    kind === "binary" ? Promise.resolve(null) : itx.repos.get(`/repos/${repo}`).readFile(path),
  );
  if (kind === "binary")
    return html`<p class="docs-note">${path} is not text, so it has no editor here.</p>`;
  if (!file) return html`<p class="docs-note">Reading ${path}…</p>`;
  if (file.error)
    return html`<p class="docs-note" role="alert">Couldn't read ${path}: ${file.error}</p>`;
  if (typeof file.value !== "string")
    return html`<p class="docs-note">${repo} has no file ${path}.</p>`;
  return html`
    <${LiveDoc}
      repo=${repo}
      path=${path}
      kind=${kind}
      text=${file.value}
      commentOnly=${commentOnly}
    />
  `;
}

function LiveDoc({ repo, path, kind, text, commentOnly }) {
  // one session per doc and person: it opens the doc's context when the editor mounts and lets it
  // go when it unmounts
  const session = useMemo(
    () =>
      new DocSession({
        itx,
        repo: `/repos/${repo}`,
        path,
        kind,
        text,
        user,
        facetSpec,
        commentOnly,
      }),
    [repo, path, kind, text, commentOnly],
  );
  return html`
    <${DocEditor}
      session=${session}
      listHref=${hrefOf({ doc: undefined, mode: undefined })}
      listLabel=${repo}
      editHref=${hrefOf({ mode: undefined })}
      onNavigate=${go}
      unavailable=${whatDocsNeeds}
    />
  `;
}

render(html`<${App} />`, document.getElementById("root"));
