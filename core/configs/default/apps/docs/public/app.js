// app.js — THE DOCS APP'S PAGE: the config repo (`/repos/config`), read-only. The repo's files are
// the sidebar's tree. Beside it is one file: markdown rendered, code as code, and under "History"
// the commits that changed it. Everything it draws is a component of @iterate-com/ui, loaded
// through the import map in index.html; `streamdown` is the markdown renderer that package uses.
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
import { CodeBlock } from "@iterate-com/ui/components/code-block";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@iterate-com/ui/components/ui/sidebar";
import { newWebSocketRpcSession } from "@iterate-com/ui/live";
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FileTextIcon } from "@iterate-com/ui/icons";
import { Streamdown } from "streamdown";

const REPO = "/repos/config";
/** How many of the repo's newest commits "History" reads a file at. */
const HISTORY_COMMITS = 30;

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
/** The repo's handle. A stub is used for one call, so each read asks for it again. */
const repo = () => itx.repos.get(REPO);

// The mind is its domain, and this host is one label under it.
const domain = location.hostname.split(".").slice(1).join(".") || location.hostname;

// ── the URL ──
// THE PAGE IS A LINK: `?file=<path>` is the open file, `?at=<commit>` the commit it is read at
// (none: the newest), and `?view=source|history` what is shown of it.
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

function useUrl() {
  const search = useSyncExternalStore(subscribeToUrl, () => location.search);
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const navigate = useCallback((change) => {
    history.pushState(null, "", hrefOf(change));
    dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  return { params, href: location.pathname + search, navigate };
}

/** What makes an `<a>` a link that changes this page's URL: a plain left click stays on the page,
 *  and any other click is the browser's (a new tab). */
const linkTo = (change, navigate) => ({
  href: hrefOf(change),
  onClick: (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    navigate(change);
  },
});

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

/** The commits among the repo's newest that changed `path`, newest first: the file is read at each
 *  commit, and a commit counts when the file differs from the commit before it. */
async function historyOf(path) {
  const commits = await repo().log({ limit: HISTORY_COMMITS });
  const contents = [];
  for (const commit of commits) contents.push(await textAt(path, commit.oid));
  return {
    read: commits.length,
    changed: commits.filter((commit, index) =>
      index + 1 < commits.length
        ? contents[index] !== contents[index + 1]
        : // the oldest one read: it counts when it is the repo's first commit and has the file
          commit.parents.length === 0 && contents[index] !== null,
    ),
  };
}

/** A file's text at a commit, or null when the commit has no such text file. */
const textAt = (path, commitOid) =>
  repo()
    .readFile(path, { commitOid })
    .catch(() => null);

// ── the page ──

function App() {
  const { params, href, navigate } = useUrl();
  const listing = useRead("files", () => repo().listFiles());
  const paths = useMemo(() => listing?.value?.paths.toSorted() || [], [listing]);
  const file =
    params.get("file") ||
    ["AGENTS.md", "README.md"].find((path) => paths.includes(path)) ||
    paths[0];
  const at = params.get("at") || undefined;
  return html`
    <${AppShell}
      app="Docs"
      mind=${domain}
      mindHref=${() => "./"}
      nav=${html`<${Tree} paths=${paths} file=${file} navigate=${navigate} />`}
      header=${file ? html`<span class="truncate font-mono text-sm">${file}</span>` : null}
      account=${principal}
      locationKey=${href}
    >
      ${listing?.error && html`<p class="docs-note">${listing.error}</p>`}
      ${listing?.value && paths.length === 0 && html`<p class="docs-note">The repo is empty.</p>`}
      ${
        file &&
        html`
          <${File}
            key=${`${file}@${at}`}
            path=${file}
            at=${at}
            view=${params.get("view") || undefined}
            paths=${paths}
            navigate=${navigate}
          />
        `
      }
    <//>
  `;
}

/** The repo's files as a tree: folders first, each open or closed; the open file's folders start
 *  open. */
function Tree({ paths, file, navigate }) {
  const root = useMemo(() => treeOf(paths), [paths]);
  const [toggled, setToggled] = useState(() => new Set());
  // a folder is open when it holds the open file, unless the person closed it; else when they opened it
  const isOpen = (folder) => (file || "").startsWith(`${folder}/`) !== toggled.has(folder);
  const toggle = (folder) =>
    setToggled((previous) => {
      const next = new Set(previous);
      if (!next.delete(folder)) next.add(folder);
      return next;
    });
  const rows = (node, Item, Button) => html`
    ${node.folders.map(
      (folder) => html`
        <${Item} key=${folder.path}>
          <${Button}
            render=${html`<button type="button" onClick=${() => toggle(folder.path)} />`}
            aria-expanded=${isOpen(folder.path)}
          >
            <${isOpen(folder.path) ? ChevronDownIcon : ChevronRightIcon} />
            <span class="truncate">${folder.name}</span>
          <//>
          ${
            isOpen(folder.path) &&
            html`<${SidebarMenuSub}>${rows(folder, SidebarMenuSubItem, SidebarMenuSubButton)}<//>`
          }
        <//>
      `,
    )}
    ${node.files.map(
      (entry) => html`
        <${Item} key=${entry.path} data-docs-file=${entry.path}>
          <${Button}
            isActive=${entry.path === file}
            render=${html`<a ...${linkTo({ file: entry.path, at: undefined, view: undefined }, navigate)} />`}
          >
            <${entry.name.endsWith(".md") ? FileTextIcon : FileIcon} />
            <span class="truncate">${entry.name}</span>
          <//>
        <//>
      `,
    )}
  `;
  return html`
    <${SidebarGroup}>
      <${SidebarGroupLabel}>${REPO}<//>
      <${SidebarGroupContent}>
        <${SidebarMenu}>${rows(root, SidebarMenuItem, SidebarMenuButton)}<//>
      <//>
    <//>
  `;
}

/** `paths` as nested folders: `{ folders: [{ name, path, folders, files }], files: [{ name, path }] }`. */
function treeOf(paths) {
  const root = { folders: [], files: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    for (const [index, name] of parts.slice(0, -1).entries()) {
      const folderPath = parts.slice(0, index + 1).join("/");
      let folder = node.folders.find((candidate) => candidate.path === folderPath);
      if (!folder) node.folders.push((folder = { name, path: folderPath, folders: [], files: [] }));
      node = folder;
    }
    node.files.push({ name: parts.at(-1), path });
  }
  return root;
}

/** One file: a bar that says what is shown, and the file read at the newest commit or at `at`. */
function File({ path, at, view, paths, navigate }) {
  const content = useRead(`${path}@${at}`, () =>
    repo().readFile(path, at ? { commitOid: at } : undefined),
  );
  const markdown = /\.(md|markdown)$/i.test(path);
  const shown = view === "history" ? "history" : markdown && view !== "source" ? "read" : "source";
  const tab = (name, label) => html`
    <button
      type="button"
      aria-pressed=${shown === name}
      onClick=${() => navigate({ view: name === (markdown ? "read" : "source") ? undefined : name })}
    >
      ${label}
    </button>
  `;
  const read = shown === "read";
  const body =
    shown === "history"
      ? html`<${History} path=${path} at=${at} navigate=${navigate} />`
      : html`<${Content} path=${path} content=${content} read=${read} paths=${paths} />`;
  return html`
    <div class="docs-file" data-docs-open=${path}>
      <div class="docs-bar">
        ${markdown && tab("read", "Read")} ${tab("source", markdown ? "Source" : "File")}
        ${tab("history", "History")}
        ${
          at &&
          html`
            <span class="text-xs text-muted-foreground">
              as of commit <code>${at.slice(0, 7)}</code> ·${" "}
              <a ...${linkTo({ at: undefined }, navigate)}>the newest</a>
            </span>
          `
        }
      </div>
      <div class="docs-body">${body}</div>
    </div>
  `;
}

function Content({ path, content, read, paths }) {
  if (!content) return html`<p class="docs-note" role="status">Reading…</p>`;
  if (content.error)
    return html`
      <p class="docs-note">This file is not text, so it is not shown. (${content.error})</p>
    `;
  if (content.value === null)
    return html`<p class="docs-note">The repo has no file ${path} at this commit.</p>`;
  if (read)
    return html`
      <div class="docs-markdown" data-docs-markdown>
        <${Streamdown}
          mode="static"
          controls=${false}
          linkSafety=${{ enabled: false }}
          rehypePlugins=${[]}
          skipHtml
          disallowedElements=${["img"]}
          urlTransform=${(url) => linkOf(url, path, paths)}
        >
          ${content.value}
        <//>
      </div>
    `;
  const language = /\.(md|markdown)$/i.test(path)
    ? "markdown"
    : /\.(ts|tsx|js|jsx|mjs|cjs|json)$/i.test(path) && "typescript";
  return language
    ? html`<${CodeBlock} code=${content.value} language=${language} />`
    : html`<pre class="docs-plain">${content.value}</pre>`;
}

/** Where a markdown link goes. Repo content is whatever its authors and agents committed, so
 *  nothing in it runs: an http(s) link stays, a link to another file of the repo opens that file
 *  here, and any other link goes nowhere. */
function linkOf(url, from, paths) {
  if (/^https?:\/\//i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#")) return "";
  const parts = url.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of url.split(/[?#]/)[0].split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  const target = parts.join("/");
  return paths.includes(target) ? hrefOf({ file: target, at: undefined, view: undefined }) : "";
}

/** A moment as `2026-11-11 22:55 UTC`. */
const utc = (timestamp) =>
  `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The commits that changed the file, newest first. A commit opens the file as it was then. */
function History({ path, at, navigate }) {
  const history = useRead(`history:${path}`, () => historyOf(path));
  if (!history) return html`<p class="docs-note" role="status">Reading the newest commits…</p>`;
  if (history.error) return html`<p class="docs-note">${history.error}</p>`;
  const { changed, read } = history.value;
  return html`
    <ul class="docs-commits" data-docs-history>
      ${changed.map(
        (commit) => html`
          <li key=${commit.oid} data-docs-commit=${commit.oid}>
            <a
              ...${linkTo({ at: commit.oid, view: undefined }, navigate)}
              aria-current=${commit.oid === at ? "true" : undefined}
            >
              ${commit.message.split("\n")[0]}
            </a>
            <small>
              ${`${commit.author.name} · ${utc(commit.timestamp)} · `}
              <code>${commit.oid.slice(0, 7)}</code>
            </small>
          </li>
        `,
      )}
    </ul>
    <p class="docs-note">
      ${`${changed.length || "None"} of the repo's newest ${read} commits changed this file.`}
    </p>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
