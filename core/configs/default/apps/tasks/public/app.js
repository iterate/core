// app.js — THE TASKS APP'S PAGE: the markdown files under tasks/ in one repo of this mind, as a
// board. The repo is the one worker.ts points the app at (app.ts `tasksApp({ repo })`, which
// /board.json answers; the tasks repo, tasks-model.js `TASKS_REPO`, when it names none), or the
// one that `?repo=<name>` names (/repos/<name>): the bar's "Repo" menu lists the mind's repos,
// and the page loads again for the one chosen.
// A column is a status, a card is a file (tasks-model.js says how a file is read). A person
// makes a task, moves a card to another column (by drag, or from the card's menu), and filters the
// board by words, by folder and by each dimension that the files hold (tags, priority, size, owner,
// agent: tasks-model.js `DIMENSIONS`). "Group by" breaks the board into rows by one of them. A
// card's title opens the task in a sheet at the right of the board, where its title, its properties
// and its text are edited and commented on ("the task sheet", below).
//
// EVERY CHANGE IS A COMMIT TO THAT REPO. The board shows a change at once and commits a moment
// later, with whatever else was changed meanwhile: several cards moved in a row are ONE commit
// (`Board`, below). The board reads the repo again at every commit to it, whoever made it, so each
// open board shows what the others did. A commit to a repo of tasks publishes nothing: only
// /repos/config is the mind's code. (`?repo=config` is a board like any other, and there a commit
// does publish the mind.)
//
// Everything it draws is a component of @iterate-com/ui, loaded through the import map in
// index.html. The page's own layout is app.css.
// oxlint-disable unicorn-js/template-indent -- the formatter indents a template that starts in a branch of a ternary or in an argument, and this rule then asks for another indent: its own fix and the formatter never agree on this file
import {
  html,
  render,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "@iterate-com/ui/page";
import { AppShell, AppShellPageHeader } from "@iterate-com/ui/components/app-shell";
import { ReconnectingMark } from "@iterate-com/ui/components/reconnecting-mark";
import { Badge } from "@iterate-com/ui/components/ui/badge";
import { Button } from "@iterate-com/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@iterate-com/ui/components/ui/empty";
import { Input } from "@iterate-com/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@iterate-com/ui/components/ui/sheet";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/ui/sidebar";
import { Spinner } from "@iterate-com/ui/components/ui/spinner";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "@iterate-com/ui/icons";
import { itxSessionOf, memberItx } from "@iterate-com/ui/live";
import {
  agentChatPath,
  applyChange,
  columnOf,
  columnsOf,
  commitOf,
  DIMENSIONS,
  dimensionsOf,
  filterTasks,
  messageOf,
  needsAPerson,
  newTask,
  rowsOf,
  TASKS_DIR,
  TASKS_REPO,
  tasksOf,
  valuesOf,
} from "./tasks-model.js";

// ── the member's itx ──
// @iterate-com/ui's `memberItx`: one WebSocket to this host's /itx, whose root is the mind's itx as
// the member the platform signed in here. A publication cuts the socket for a few seconds; the
// same `itx` then calls through a new session, and the board opens its subscription again
// (`pageSession`'s epoch, in `App`).
const itx = memberItx();
const pageSession = itxSessionOf(itx);
const [{ principal }, initialRepos, pointed] = await Promise.all([
  itx.whoami(),
  itx.repos.list().catch(() => []),
  // the repo worker.ts points the board at (app.ts, `tasksApp({ repo })`); an answer that is no
  // JSON, or names no repo path, leaves the tasks repo
  fetch("/board.json")
    .then((answer) => answer.json())
    .catch(() => ({})),
]);
/** The repo the board points at: a path `/repos/<name>` from app.ts, else the tasks repo. */
const BOARD_REPO = /^\/repos\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pointed?.repo)
  ? pointed.repo
  : TASKS_REPO;
/** Who a commit made here is by: the person's email as both name and address. */
const author = principal?.email ? { name: principal.email, email: principal.email } : undefined;

// The mind is its domain, and this host is one label under it.
const domain = location.hostname.split(".").slice(1).join(".") || location.hostname;
/** THE REPO WHOSE TASKS THE BOARD SHOWS, by its name: the one `?repo=` names, else the repo the
 *  board points at (`BOARD_REPO`) when the mind has it, else `config` (so a new mind's
 *  onboarding cards under `tasks/` in `/repos/config` appear before the tasks repo is made).
 *  Read once when the page loads; the bar's "Repo" menu loads the page again for another
 *  (`showRepo`). */
const DEFAULT_REPO_NAME = initialRepos.some((repo) => repo.path === BOARD_REPO)
  ? BOARD_REPO.split("/").at(-1)
  : "config";
const REPO_NAME = (() => {
  const named = new URLSearchParams(location.search).get("repo");
  return named && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(named) ? named : DEFAULT_REPO_NAME;
})();
const REPO = `/repos/${REPO_NAME}`;
/** The repo with this mind's code: the editor's processors and their package pins are there. */
const CODE_REPO = "/repos/config";
/** A task's file in the Docs app, where it is written and commented on. */
const docsHref = (path) =>
  `https://docs.${domain}/?repo=${encodeURIComponent(REPO_NAME)}&doc=${encodeURIComponent(path)}`;
/** An agent's chat in the Dash (tasks-model.js `agentChatPath`), or null when the card names no
 *  context path. */
const agentHref = (agent) => {
  const path = agentChatPath(agent);
  return path && `https://dash.${domain}${path}`;
};
/** The board of another repo: the page again, with no filter of this one. */
const showRepo = (name) => {
  if (name === REPO_NAME) return;
  location.assign(
    name === DEFAULT_REPO_NAME
      ? location.pathname
      : `${location.pathname}?repo=${encodeURIComponent(name)}`,
  );
};

const wordsOf = (error) => (error instanceof Error ? error.message : String(error));

// ── the board's store ──

/** How long the board waits after a change before it commits, and how long at most after the
 *  first change that is not committed yet: several changes in that time are one commit. */
const COMMIT_AFTER_MS = 1500;

/** THE TASKS OF THE REPO, AND THE CHANGES NOT COMMITTED YET. The page reads `get()` through
 *  React's useSyncExternalStore.
 *
 *  - What it shows is the repo's files with the waiting changes applied, so a moved card is in its
 *    new column at once.
 *  - A change is kept as what the person did ("this file's status is done"), and is applied to the
 *    file as the repo has it when the commit is made. So a commit somebody else made meanwhile
 *    (an edit in Docs, an agent's) is never written over: only the status line is ours.
 *  - A commit names the tip it was decided on (`parent`). When the tip has moved, the repo refuses
 *    it, and the board reads again and tries again.
 *  - A commit whose answer was lost (the publication it starts can cut the socket) is tried
 *    again, and then changes nothing: the files already say what it wanted.
 *  - Reads and commits run one at a time. */
class Board {
  #listeners = new Set();
  #view;
  /** The repo's task files at `#tip`, by path; null before the first read. */
  #files = null;
  #tip = null;
  #loadError = null;
  /** The changes not committed yet, oldest first. */
  #pending = [];
  /** The tasks made on this page, newest first: they head their column, where their maker looks. */
  #made = [];
  /** `state`: "idle", "waiting" (a commit is due), "saving", "saved" or "failed". */
  #save = { state: "idle", error: null };
  #timer = null;
  #firstChangeAt = 0;
  #savedTimer = null;
  #serial = Promise.resolve();

  constructor() {
    this.#publish();
  }

  subscribe = (listener) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get = () => this.#view;

  #publish() {
    const files = this.#files ? this.#pending.reduce(applyChange, this.#files) : {};
    this.#view = {
      loaded: Boolean(this.#files),
      loadError: this.#loadError,
      tasks: madeFirst(tasksOf(files), this.#made),
      paths: Object.keys(files),
      /** the paths with a change that is not committed yet */
      unsaved: new Set(this.#pending.map((change) => change.path)),
      save: this.#save,
    };
    for (const listener of this.#listeners) listener();
  }

  #exclusive(work) {
    const run = this.#serial.then(work);
    this.#serial = run.catch(() => {});
    return run;
  }

  /** The task files at the repo's tip. `modules` answers the paths under the folder without the
   *  folder's name; a repo with no tasks/ answers none. */
  async #readTip() {
    const repo = itx.repos.get(REPO);
    try {
      const tip = await repo.tip();
      if (tip === this.#tip && this.#files) return { tip, files: this.#files };
      const under = tip ? await repo.modules({ commitOid: tip, dir: TASKS_DIR }) : {};
      const files = Object.fromEntries(
        Object.entries(under).map(([path, text]) => [`${TASKS_DIR}/${path}`, text]),
      );
      return { tip, files };
    } finally {
      repo[Symbol.dispose]?.();
    }
  }

  /** Read the repo again: at the page's start, and after each commit to it. */
  read() {
    return this.#exclusive(async () => {
      try {
        const { tip, files } = await this.#readTip();
        if (files === this.#files) return;
        this.#tip = tip;
        this.#files = files;
        this.#loadError = null;
      } catch (error) {
        // a board that has drawn keeps what it drew: the next commit's event reads again
        if (this.#files) return;
        this.#loadError = wordsOf(error);
      }
      this.#publish();
    });
  }

  /** Hear of each commit to the repo, and read once now. Answers what lets go of it. A session of
   *  the member's itx ends with its socket, so the page opens this again at each new session. */
  open() {
    const { epoch } = pageSession.get();
    let closed = false;
    let subscription = null;
    void (async () => {
      // subscribed before the read: a commit between the two is read again, never missed
      const opened = await itx.subscribe({
        consumes: ["events.iterate.com/repo/commit-completed"],
        target: (events) => {
          // capnweb hands each event as a proxy, which structuredClone refuses: a plain copy to read
          // react-doctor-disable-next-line react-doctor/no-json-parse-stringify-clone -- a structured clone refuses a proxy; JSON reads one through its properties (the UI kit's DocList does the same)
          const commits = JSON.parse(JSON.stringify(events));
          const moved = commits.some(
            (event) => event?.payload?.path === REPO && event.payload.commitOid !== this.#tip,
          );
          if (moved && !closed) void this.read();
        },
      });
      if (closed) return opened[Symbol.dispose]?.();
      subscription = opened;
      await this.read();
      // what waited through a cut connection is committed now
      if (this.#pending.length > 0) this.#schedule(0);
    })().catch((error) => {
      if (closed || this.#files) return;
      this.#loadError = wordsOf(error);
      this.#publish();
    });
    return () => {
      closed = true;
      // a session that is gone took its subscriptions with it: there is nothing to let go of
      const now = pageSession.get();
      if (now.epoch === epoch && now.state === "open") subscription?.[Symbol.dispose]?.();
    };
  }

  /** A person changed something: shown at once, committed a moment later. */
  change(change) {
    this.#pending = [...this.#pending, change];
    if (change.kind === "create") this.#made = [change.path, ...this.#made];
    this.#firstChangeAt ||= Date.now();
    this.#save = { state: "waiting", error: null };
    this.#publish();
    this.#schedule(
      Math.max(
        0,
        // 6000: at most that long after the first change that is not committed yet
        Math.min(COMMIT_AFTER_MS, this.#firstChangeAt + 6000 - Date.now()),
      ),
    );
  }

  /** Commit what waits now: "Try again" after a commit failed, and the page being left. */
  commitNow() {
    if (this.#pending.length > 0) this.#schedule(0);
  }

  #schedule(ms) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#commit(), ms);
  }

  #commit() {
    return this.#exclusive(async () => {
      const sending = this.#pending;
      if (sending.length === 0) return;
      clearTimeout(this.#savedTimer);
      this.#firstChangeAt = 0;
      this.#save = { state: "saving", error: null };
      this.#publish();
      try {
        await this.#send(sending);
        // what a person changed while this commit ran waits for the next one
        this.#pending = this.#pending.slice(sending.length);
        this.#save = { state: this.#pending.length > 0 ? "waiting" : "saved", error: null };
        if (this.#pending.length > 0) {
          this.#firstChangeAt = Date.now();
          this.#schedule(COMMIT_AFTER_MS);
        } else {
          this.#savedTimer = setTimeout(() => {
            if (this.#save.state !== "saved") return;
            this.#save = { state: "idle", error: null };
            this.#publish();
          }, 2500);
        }
      } catch (error) {
        // the changes stay on the board and wait: "Try again", or the next change, commits them
        this.#save = { state: "failed", error: wordsOf(error) };
      }
      this.#publish();
    });
  }

  /** One commit of `changes` on the repo's tip. Tried again when the repo refuses it (its tip
   *  moved) or the answer is lost: each try reads the tip first, and a try that finds nothing
   *  left to write is done. */
  async #send(changes) {
    const waits = [400, 1500, 4000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        const { tip, files } = await this.#readTip();
        this.#tip = tip;
        this.#files = files;
        const written = commitOf(files, changes);
        if (written.length === 0) return;
        const repo = itx.repos.get(REPO);
        try {
          const { commitOid } = await repo.commitFiles({
            message: messageOf(changes),
            changes: written,
            parent: tip,
            author,
          });
          this.#files = {
            ...files,
            ...Object.fromEntries(written.map((each) => [each.path, each.content])),
          };
          this.#tip = commitOid || tip;
          return;
        } finally {
          repo[Symbol.dispose]?.();
        }
      } catch (error) {
        if (attempt >= waits.length) throw error;
        await new Promise((done) => setTimeout(done, waits[attempt]));
      }
    }
  }
}

/** `tasks` with those of `made` first, in its order; the others stay as they were. */
function madeFirst(tasks, made) {
  if (made.length === 0) return tasks;
  const place = new Map(made.map((path, at) => [path, at]));
  const first = tasks
    .filter((task) => place.has(task.path))
    .sort((a, b) => place.get(a.path) - place.get(b.path));
  return [...first, ...tasks.filter((task) => !place.has(task.path))];
}

const board = new Board();

// a page that is left commits what waits; a commit that cannot finish is said first
addEventListener("pagehide", () => board.commitNow());
addEventListener("beforeunload", (event) => {
  if (board.get().unsaved.size === 0) return;
  board.commitNow();
  event.preventDefault();
});

// ── the URL ──
// THE VIEW IS A LINK: `?q=` the words, `?folder=` a folder under tasks/ ("." for the top),
// `?status=` one or more columns (`?status=in-progress&status=todo`), one parameter for each value
// of a dimension that filters (`?tag=onboarding&size=large`: one of the tags AND that size),
// `?group=priority` the dimension that breaks the board into rows, and `?task=<path>` the task
// whose sheet is open. The board is ONE board over every file under tasks/, however deep: a folder
// narrows it, and no row is a folder.
const subscribeToUrl = (listener) => {
  addEventListener("popstate", listener);
  return () => removeEventListener("popstate", listener);
};

function setView(change) {
  const next = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(change)) {
    next.delete(key);
    // a list is one parameter for each element
    for (const each of [value].flat())
      if (each !== undefined && each !== "" && each !== null) next.append(key, each);
  }
  const query = next.toString();
  // a filter typed letter by letter is one entry of the history, not one a letter
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
  dispatchEvent(new PopStateEvent("popstate"));
}

function useView() {
  const search = useSyncExternalStore(subscribeToUrl, () => location.search);
  return useMemo(() => {
    const params = new URLSearchParams(search);
    const folder = params.get("folder");
    return {
      query: params.get("q") || "",
      // oxlint-disable-next-line iterate/simple-truthiness-check -- no `folder` in the address (null) is no folder asked for; "." is the top of tasks/, which is ""
      folder: folder === null ? null : folder === "." ? "" : folder,
      /** the columns that filter, normalized (`?status=in-progress&status=todo`) */
      statuses: [...new Set(params.getAll("status").filter(Boolean).map(columnOf))],
      /** the values that filter, by dimension: { tags: ["ui"], size: [], … } */
      where: Object.fromEntries(
        DIMENSIONS.map(({ id, param }) => [id, params.getAll(param).filter(Boolean)]),
      ),
      /** the dimension that breaks the board into rows, by its id, or null */
      group: DIMENSIONS.find(({ id }) => id === params.get("group"))?.id ?? null,
      /** the path of the task whose sheet is open, or null */
      task: params.get("task"),
      /** `?needs=person`: the list of what waits for a person in place of the board */
      needs: params.get("needs") === "person",
    };
  }, [search]);
}

/** Filter by a value of a dimension, or let go of it when it filters already. */
function pick(view, dimension, value) {
  const now = view.where[dimension.id];
  setView({
    [dimension.param]: now.includes(value) ? now.filter((each) => each !== value) : [...now, value],
  });
}

/** The board with no filter: the words, the folder, the statuses and every dimension's values let go. */
const showEverything = () =>
  setView({
    q: undefined,
    folder: undefined,
    status: undefined,
    ...Object.fromEntries(DIMENSIONS.map(({ param }) => [param, undefined])),
  });

/** A value as a person reads it: an agent is its path's last part. */
const valueLabel = (dimension, value) =>
  dimension.id === "agent" ? value.split("/").filter(Boolean).at(-1) || value : value;

// ── a status's mark ──
// A ring that fills as the work goes on, as issue trackers draw it: dashed for the backlog, open
// for todo, half and three quarters for the two states of work, and a check for done. A status of
// its own is a plain dot.
function StatusMark({ column }) {
  const share = { todo: 0, "in-progress": 0.5, "in-review": 0.75 }[column];
  if (column === "done")
    return html`
      <svg class="status-mark" data-status="done" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="M5 8.2l2.1 2.1L11.2 6"
          fill="none"
          stroke="var(--background)"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  if (column === "backlog")
    return html`
      <svg class="status-mark" data-status="backlog" viewBox="0 0 16 16" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="6.25"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-dasharray="2.2 2.2"
        />
      </svg>
    `;
  if (share === undefined)
    return html`
      <svg class="status-mark" data-status="own" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
        <circle cx="8" cy="8" r="2.5" fill="currentColor" />
      </svg>
    `;
  // the filled part is a circle of radius 2 drawn with a stroke 4 wide: a pie of `share`
  const round = 2 * Math.PI * 2;
  return html`
    <svg class="status-mark" data-status=${column} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
      ${
        share > 0 &&
        html`<circle
          cx="8"
          cy="8"
          r="2"
          fill="none"
          stroke="currentColor"
          stroke-width="4"
          stroke-dasharray=${`${round * share} ${round}`}
          transform="rotate(-90 8 8)"
        />`
      }
    </svg>
  `;
}

/** The status a card gets in a column: the column's id, or for a status of its own the words the
 *  files use for it. */
const statusOf = (column) => (column.own ? column.label : column.id);

// ── the page ──

function App() {
  const { epoch } = useSyncExternalStore(pageSession.subscribe, pageSession.get, pageSession.get);
  // the board's subscription is of one session: opened again at each new one
  useEffect(() => board.open(), [epoch]);
  const state = useSyncExternalStore(board.subscribe, board.get);
  const view = useView();
  const [composer, setComposer] = useState(null);
  const searchRef = useRef(null);
  // the mind's repos by name, for the bar's "Repo" menu: the one shown is always among them
  const [repos, setRepos] = useState([REPO_NAME]);
  useEffect(() => {
    let current = true;
    itx.repos.list().then(
      (listed) => {
        const names = listed
          .map((repo) => /^\/repos\/([^/]+)$/.exec(repo.path)?.[1])
          .filter(Boolean);
        if (current) setRepos([...new Set([REPO_NAME, ...names])].sort());
      },
      // the menu then holds this repo alone
      () => {},
    );
    return () => {
      current = false;
    };
  }, [epoch]);

  const shown = useMemo(() => filterTasks(state.tasks, view), [state.tasks, view]);
  const allColumns = useMemo(() => columnsOf(state.tasks), [state.tasks]);
  const columns = useMemo(
    () =>
      view.statuses.length > 0
        ? allColumns.filter((column) => view.statuses.includes(column.id))
        : allColumns,
    [allColumns, view.statuses],
  );
  /** the dimensions that the files hold: no file with a priority, no priority on the page */
  const dimensions = useMemo(() => dimensionsOf(state.tasks), [state.tasks]);
  // iterate DIMENSIONS (not `dimensions`) so a deep-linked filter chip is always visible and removable
  const picked = DIMENSIONS.flatMap((dimension) =>
    view.where[dimension.id].map((value) => ({ dimension, value })),
  );
  const filtered = Boolean(
    view.query ||
    view.folder !== null ||
    view.statuses.length > 0 ||
    DIMENSIONS.some(({ id }) => view.where[id].length > 0),
  );
  /** the dimension of the rows, when the link names one that the files hold */
  const group = dimensions.find((dimension) => dimension.id === view.group) ?? null;
  // the rows: one for each value of that dimension that has a task shown, or one row with every
  // task. `value` is the row's value, null for the tasks that have none, undefined with no rows.
  const rows = useMemo(() => {
    if (!group) return [{ value: undefined, tasks: shown }];
    const found = rowsOf(shown, group);
    return found.length > 0 ? found : [{ value: null, label: group.none, tasks: [] }];
  }, [group, shown]);

  /** Open the box for a new task in a column, in the folder the board shows, and in a row when the
   *  board has rows (the first one, when the bar's button or "c" asks). */
  const compose = (column, row = rows[0].value) =>
    setComposer({ column: column.id, status: statusOf(column), folder: view.folder ?? "", row });
  const create = (title) => {
    if (!composer || !title.trim()) return;
    // a task made in a filtered view or row inherits its active filter values so it stays visible
    const fields = {};
    for (const dimension of DIMENSIONS) {
      const active = view.where[dimension.id];
      if (active.length === 0) continue;
      fields[dimension.id] = dimension.many ? [...active] : active[0];
    }
    if (group && composer.row) {
      fields[group.id] = group.many
        ? [...new Set([...(fields[group.id] || []), composer.row])]
        : composer.row;
    }
    const made = newTask({
      title,
      status: composer.status,
      folder: composer.folder,
      taken: state.paths,
      fields,
    });
    board.change({ kind: "create", ...made });
  };
  const move = (task, column) => {
    if (task.column !== column.id)
      board.change({ kind: "status", path: task.path, status: statusOf(column) });
  };

  // "/" goes to the search, "c" makes a task: only when nobody is typing
  useEffect(() => {
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const at = document.activeElement;
      if (at && (/^(?:INPUT|TEXTAREA|SELECT)$/.test(at.tagName) || at.isContentEditable)) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "c" && state.loaded) {
        event.preventDefault();
        compose(columns.find((column) => column.id === "todo") || columns[0] || allColumns[0]);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  return html`
    <${AppShell}
      app="Tasks"
      mind=${domain}
      mindHref=${() => "./"}
      nav=${html`<${Nav} tasks=${state.tasks} dimensions=${dimensions} view=${view} />`}
      account=${principal}
      locationKey=${location.pathname + location.search}
    >
      <${AppShellPageHeader}>
        <div class="tasks-bar">
          <label class="tasks-search">
            <${SearchIcon} />
            <${Input}
              ref=${searchRef}
              type="search"
              placeholder="Filter tasks"
              aria-label="Filter tasks"
              value=${view.query}
              onChange=${(event) => setView({ q: event.target.value })}
              onKeyDown=${(event) => event.key === "Escape" && event.target.blur()}
            />
          </label>
          <${DropdownMenu}>
            <${DropdownMenuTrigger}
              render=${html`<${Button} variant="ghost" size="sm" className="tasks-group" />`}
            >
              <span>Repo<span class="tasks-wide">: ${REPO_NAME}</span></span>
              <${ChevronDownIcon} data-icon="inline-end" />
            <//>
            <${DropdownMenuContent} align="start" className="task-menu-popup">
              <${DropdownMenuGroup}>
                <${DropdownMenuLabel}>Tasks of the repo<//>
                <${DropdownMenuRadioGroup} value=${REPO_NAME} onValueChange=${showRepo}>
                  ${repos.map(
                    (name) =>
                      html`<${DropdownMenuRadioItem} key=${name} value=${name} closeOnClick=${true}
                        >${name}<//
                      >`,
                  )}
                <//>
              <//>
            <//>
          <//>
          ${
            dimensions.length > 0 &&
            html`
              <${DropdownMenu}>
                <${DropdownMenuTrigger}
                  render=${html`<${Button} variant=${group ? "secondary" : "ghost"} size="sm" className="tasks-group" />`}
                >
                  <span>Group${group && html`<span class="tasks-wide">: ${group.one}</span>`}</span>
                  <${ChevronDownIcon} data-icon="inline-end" />
                <//>
                <${DropdownMenuContent} align="start" className="task-menu-popup">
                  <${DropdownMenuGroup}>
                    <${DropdownMenuLabel}>Rows by<//>
                    <${DropdownMenuRadioGroup}
                      value=${group?.id ?? "none"}
                      onValueChange=${(id) => setView({ group: id === "none" ? undefined : id })}
                    >
                      <${DropdownMenuRadioItem} value="none" closeOnClick=${true}>Nothing<//>
                      ${dimensions.map(
                        (dimension) => html`
                          <${DropdownMenuRadioItem}
                            key=${dimension.id}
                            value=${dimension.id}
                            closeOnClick=${true}
                          >
                            ${dimension.one}
                          <//>
                        `,
                      )}
                    <//>
                  <//>
                <//>
              <//>
            `
          }
          <span class="tasks-bar-end">
            <${SaveMark} save=${state.save} />
            <${Button}
              size="sm"
              disabled=${!state.loaded}
              aria-label="New task"
              onClick=${() => compose(columns.find((column) => column.id === "todo") || columns[0] || allColumns[0])}
            >
              <${PlusIcon} data-icon="inline-start" /><span class="tasks-wide">New task</span>
            <//>
          </span>
        </div>
      <//>
      ${
        view.needs
          ? html`<${NeedsPage} state=${state} tasks=${needsAPerson(shown)} filtered=${filtered} />`
          : html`<${Page}
              state=${state}
              shown=${shown}
              columns=${columns}
              allColumns=${allColumns}
              view=${view}
              picked=${picked}
              group=${group}
              rows=${rows}
              filtered=${filtered}
              composer=${composer}
              compose=${compose}
              closeComposer=${() => setComposer(null)}
              create=${create}
              move=${move}
            />`
      }
    <//>
    <${TaskSheet}
      path=${view.task}
      state=${state}
      columns=${allColumns}
      dimensions=${dimensions}
      move=${move}
    />
    <${ReconnectingMark} itx=${itx} />
  `;
}

/** Beside the title: whether what the person changed is in the repo yet. */
function SaveMark({ save }) {
  if (save.state === "waiting" || save.state === "saving")
    return html`<span class="tasks-save" role="status"><${Spinner} />Saving…</span>`;
  if (save.state === "saved")
    return html`<span class="tasks-save" role="status"><${CheckIcon} />Saved</span>`;
  if (save.state === "failed")
    return html`
      <span class="tasks-save" data-failed role="alert" title=${save.error}>
        <${TriangleAlertIcon} />Not saved
        <${Button} variant="outline" size="xs" onClick=${() => board.commitNow()}>Try again<//>
      </span>
    `;
  return null;
}

/** The sidebar: the folders under tasks/, then each dimension that the files hold with its values,
 *  each with how many tasks it has. A press on one filters the board; a press on one that filters
 *  lets go of it. */
function Nav({ tasks, dimensions, view }) {
  const folders = useMemo(() => {
    // a folder counts what is in it and beneath it, as the filter does
    const names = new Set();
    for (const task of tasks) {
      const parts = task.folder ? task.folder.split("/") : [];
      for (let depth = 1; depth <= parts.length; depth += 1)
        names.add(parts.slice(0, depth).join("/"));
    }
    return [...names]
      .sort()
      .map((name) => [
        name,
        tasks.filter((task) => task.folder === name || task.folder.startsWith(`${name}/`)).length,
      ]);
  }, [tasks]);
  const row = (key, label, count, active, onClick, depth = 0) => html`
    <${SidebarMenuItem} key=${key}>
      <${SidebarMenuButton} isActive=${active} onClick=${onClick} tooltip=${label}>
        <span class="tasks-nav-label" style=${{ paddingInlineStart: `${depth * 0.75}rem` }}
          >${label}</span
        >
      <//>
      <${SidebarMenuBadge}>${count}<//>
    <//>
  `;
  return html`
    <${SidebarGroup}>
      <${SidebarGroupLabel}>Tasks<//>
      <${SidebarGroupContent}>
        <${SidebarMenu}>
          ${row(
            "all",
            "All tasks",
            tasks.length,
            !view.needs &&
              !view.query &&
              view.folder === null &&
              view.statuses.length === 0 &&
              DIMENSIONS.every(({ id }) => view.where[id].length === 0),
            () =>
              setView({
                q: undefined,
                folder: undefined,
                status: undefined,
                needs: undefined,
                ...Object.fromEntries(DIMENSIONS.map(({ param }) => [param, undefined])),
              }),
          )}
          ${row("needs", "Needs a person", needsAPerson(tasks).length, view.needs, () =>
            setView({ needs: view.needs ? undefined : "person" }),
          )}
          ${folders.map(([name, count]) =>
            row(
              `folder:${name}`,
              name.split("/").at(-1),
              count,
              view.folder === name,
              () => setView({ folder: view.folder === name ? undefined : name }),
              name.split("/").length,
            ),
          )}
        <//>
      <//>
    <//>
    ${dimensions.map(
      (dimension) => html`
        <${SidebarGroup} key=${dimension.id}>
          <${SidebarGroupLabel}>${dimension.label}<//>
          <${SidebarGroupContent}>
            <${SidebarMenu}>
              ${dimension.values.map(([value, count]) =>
                row(
                  `${dimension.id}:${value}`,
                  valueLabel(dimension, value),
                  count,
                  view.where[dimension.id].includes(value),
                  () => pick(view, dimension, value),
                ),
              )}
            <//>
          <//>
        <//>
      `,
    )}
  `;
}

/** WHO ASKED EACH OPEN ASK OF THE BOARD: `itx.config.taskAskers` (apps/tasks/askers.js), which
 *  reads it from the change feed, as a map from `<file>\n<ask>` to its row. Null until the first
 *  answer; "unread" when the call fails, so that the page then says what it does know (the
 *  task's agent) and that the asker could not be read. It is asked again when the board's asks change, and once more a moment later
 *  when an ask has no asker yet: the feed hears of a commit a moment after the board does. */
function useAskers(tasks) {
  const asked = tasks
    .flatMap((task) => task.humanAsk.map((ask) => `${task.path}\n${ask}`))
    .join("\n\n");
  const [askers, setAskers] = useState(null);
  useEffect(() => {
    if (!asked) return undefined;
    let live = true;
    let timer;
    const read = (again) =>
      itx.config.taskAskers({ repo: REPO_NAME }).then(
        (answer) => {
          if (!live) return;
          setAskers(new Map(answer.asks.map((row) => [`${row.file}\n${row.ask}`, row])));
          if (again && answer.asks.some((row) => !row.at))
            timer = setTimeout(() => read(false), 4000);
        },
        () => live && setAskers((now) => now ?? "unread"),
      );
    read(true);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [asked]);
  return askers;
}

/** WHO ASKED, UNDER AN ASK: the agent that added the ask, as a link to its chat in the Dash, where
 *  a person asks it why before they answer. `asker` is the ask's row of `useAskers`. When nothing
 *  says who asked (an ask older than the change feed, or one written by hand), the line names the
 *  task's own agent and SAYS that it is the task's agent: that one may not be the asker. A person
 *  who asked on the board is named with no link. */
function Asker({ task, asker }) {
  const when = asker?.at ? ` on ${asker.at.slice(0, 16).replace("T", " ")} UTC` : "";
  if (asker?.agent && agentHref(asker.agent))
    return html`
      <a
        class="needs-asker"
        data-asker="agent"
        href=${agentHref(asker.agent)}
        target="_blank"
        rel="noreferrer"
        title=${`${asker.agent} asked this${when}. Opens its chat in the Dash.`}
      >
        Asked by ${valueLabel(DIMENSION.agent, asker.agent)}<${ExternalLinkIcon} />
      </a>
    `;
  if (asker?.by && !asker.by.startsWith("/"))
    return html`<span
      class="needs-asker"
      data-asker="person"
      title=${`${asker.by} asked this${when}${asker.page ? ` on ${asker.page}` : ""}.`}
      >Asked by ${asker.by}</span
    >`;
  // the first answer is not here yet: say nothing, not the wrong agent
  if (!asker || !agentHref(task.agent)) return null;
  return html`
    <a
      class="needs-asker"
      data-asker="assignee"
      href=${agentHref(task.agent)}
      target="_blank"
      rel="noreferrer"
      title=${`${asker.unread ? "Who asked this could not be read" : "Who asked this is not recorded"}. ${task.agent} is the agent that has the task. Opens its chat in the Dash.`}
    >
      ${asker.unread ? "Asker not read" : "Asker not recorded"}. The task's agent:
      ${valueLabel(DIMENSION.agent, task.agent)}<${ExternalLinkIcon} />
    </a>
  `;
}

/** ONE ASK OF A TASK, WITH THE BOX THAT ANSWERS IT. An answer is a change like a moved card: the
 *  ask leaves the list at once, and a commit a moment later takes its line out of the file's
 *  `human-ask:` and keeps the ask with the answer, who gave it and when under `## Answers` in the
 *  task's text (tasks-model.js `answerAsk`). The agent that follows the task hears of that commit
 *  (apps/tasks/feed.js), so nobody has to tell it. */
function Ask({ task, ask, asker }) {
  const [answer, setAnswer] = useState("");
  return html`
    <li>
      <span>${ask}</span>
      <${Asker} task=${task} asker=${asker} />
      <form
        class="needs-answer"
        onSubmit=${(event) => {
          event.preventDefault();
          if (!answer.trim()) return;
          board.change({
            kind: "answer",
            path: task.path,
            ask,
            answer,
            by: principal?.email || principal?.actor || "someone",
            at: new Date().toISOString(),
          });
        }}
      >
        <${Input}
          placeholder="Your answer, then Enter"
          aria-label=${`Your answer to: ${ask}`}
          value=${answer}
          onChange=${(event) => setAnswer(event.target.value)}
          onKeyDown=${(event) => {
            // Enter sends it, with Cmd or Ctrl too: a browser sends a form on the bare key alone
            if (event.key !== "Enter" || event.isComposing || event.nativeEvent?.isComposing)
              return;
            event.preventDefault();
            event.currentTarget.form.requestSubmit();
          }}
        />
        <${Button} type="submit" variant="outline" size="sm" disabled=${!answer.trim()}>Answer<//>
      </form>
    </li>
  `;
}

/** "Needs a person" (`?needs=person`), in place of the board: each task that is not done and asks a
 *  person something (`human-ask:`) or says what holds it (`blocked-on:`), as a row. A person
 *  answers an ask here (`Ask`), and each ask names the agent that asked it, as a link to its chat
 *  (`Asker`); what holds a task is only read. The board's other filters still narrow it. */
function NeedsPage({ state, tasks, filtered }) {
  const askers = useAskers(tasks);
  if (!state.loaded)
    return state.loadError
      ? html`<p class="tasks-note" role="alert">Couldn't read the tasks: ${state.loadError}</p>`
      : html`<p class="tasks-note">Reading the tasks…</p>`;
  if (tasks.length === 0 && filtered)
    return html`
      <p class="tasks-note">
        No task that needs a person matches.${" "}
        <button class="tasks-link" onClick=${showEverything}>Show every task</button>
      </p>
    `;
  if (tasks.length === 0)
    return html`
      <${Empty} className="tasks-empty">
        <${EmptyHeader}>
          <${EmptyTitle}>Nothing waits for a person<//>
          <${EmptyDescription}>
            A task asks a person with <code>human-ask:</code> in its frontmatter, and says what
            holds it with <code>blocked-on:</code>. An ask is answered here. A done task is not
            listed.
          <//>
        <//>
      <//>
    `;
  return html`
    <ul class="needs" aria-label="Tasks that need a person">
      ${tasks.map(
        (task) => html`
          <li class="needs-row" key=${task.path}>
            <div class="needs-top">
              <${StatusMark} column=${task.column} />
              <a
                class="task-title"
                href=${taskHref(task.path)}
                onClick=${(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  openTask(task.path);
                }}
              >
                ${task.title}
              </a>
              ${task.owner && html`<${Badge} variant="outline">${task.owner}<//>`}
            </div>
            ${
              task.humanAsk.length > 0 &&
              html`
                <ul class="needs-asks" aria-label="Asks">
                  ${task.humanAsk.map(
                    (ask) =>
                      html`<${Ask}
                        key=${ask}
                        task=${task}
                        ask=${ask}
                        asker=${
                          // a row with no asker for an ask that the answer does not have (a new one): the task's agent then
                          askers &&
                          (askers === "unread"
                            ? { unread: true }
                            : (askers.get(`${task.path}\n${ask}`) ?? {}))
                        }
                      />`,
                  )}
                </ul>
              `
            }
            ${task.blockedOn && html`<p class="needs-blocked">Blocked on: ${task.blockedOn}</p>`}
          </li>
        `,
      )}
    </ul>
  `;
}

/** Beside the sidebar: the board, or the line that says why there is none. */
function Page({
  state,
  shown,
  columns,
  allColumns,
  view,
  picked,
  group,
  rows,
  filtered,
  composer,
  compose,
  closeComposer,
  create,
  move,
}) {
  if (!state.loaded)
    return state.loadError
      ? html`<p class="tasks-note" role="alert">Couldn't read the tasks: ${state.loadError}</p>`
      : html`<p class="tasks-note">Reading the tasks…</p>`;
  if (state.tasks.length === 0 && !composer)
    return html`
      <${Empty} className="tasks-empty">
        <${EmptyHeader}>
          <${EmptyTitle}>No tasks yet<//>
          <${EmptyDescription}>
            A task is a markdown file under <code>${TASKS_DIR}/</code> in the repo
            <code>${REPO}</code>. Make the first one here, or commit one.
          <//>
        <//>
        <${EmptyContent}>
          <${Button} onClick=${() => compose(columns.find((column) => column.id === "todo"))}>
            <${PlusIcon} data-icon="inline-start" />New task
          <//>
        <//>
      <//>
    `;
  return html`
    ${
      (view.folder !== null || view.statuses.length > 0 || picked.length > 0) &&
      html`
        <div class="tasks-picked" role="group" aria-label="What filters the board">
          ${
            view.folder !== null &&
            html`
              <button class="tasks-chip" onClick=${() => setView({ folder: undefined })}>
                <span class="tasks-chip-of">Folder</span>${view.folder || TASKS_DIR}<${XIcon}
                  aria-label="Remove this filter"
                />
              </button>
            `
          }
          ${view.statuses.map(
            (status) => html`
              <button
                class="tasks-chip"
                key=${`status:${status}`}
                onClick=${() => setView({ status: view.statuses.filter((each) => each !== status) })}
              >
                <span class="tasks-chip-of">Status</span
                >${columns.find((column) => column.id === status)?.label || status}
                <${XIcon} aria-label="Remove this filter" />
              </button>
            `,
          )}
          ${picked.map(
            ({ dimension, value }) => html`
              <button
                class="tasks-chip"
                key=${`${dimension.id}:${value}`}
                onClick=${() => pick(view, dimension, value)}
              >
                <span class="tasks-chip-of">${dimension.one}</span>${valueLabel(dimension, value)}
                <${XIcon} aria-label="Remove this filter" />
              </button>
            `,
          )}
          <button class="tasks-link" onClick=${showEverything}>Clear</button>
        </div>
      `
    }
    <div class="board" style=${{ "--columns": columns.length }}>
      <div class="board-head">
        ${columns.map(
          (column) => html`
            <div class="board-column-head" key=${column.id}>
              <${StatusMark} column=${column.id} />
              <span class="board-column-name">${column.label}</span>
              <span class="board-column-count">
                ${shown.filter((task) => task.column === column.id).length}
              </span>
              <${Button}
                variant="ghost"
                size="icon-xs"
                className="board-column-add"
                aria-label=${`New task in ${column.label}`}
                onClick=${() => compose(column)}
              >
                <${PlusIcon} />
              <//>
            </div>
          `,
        )}
      </div>
      ${
        filtered && shown.length === 0 && !composer
          ? html`
              <p class="tasks-note">
                No task matches.${" "}
                <button class="tasks-link" onClick=${showEverything}>Show every task</button>
              </p>
            `
          : rows.map(
              (row) => html`
                <section class="board-row" key=${String(row.value)}>
                  ${
                    group &&
                    html`
                      <h2 class="board-row-name">
                        <span class="board-row-of">${group.one}</span>
                        ${row.value === null ? row.label : valueLabel(group, row.value)}
                        <span class="board-column-count">${row.tasks.length}</span>
                      </h2>
                    `
                  }
                  <div class="board-cells">
                    ${columns.map(
                      (column) => html`
                        <${Cell}
                          key=${column.id}
                          column=${column}
                          columns=${allColumns}
                          tasks=${row.tasks.filter((task) => task.column === column.id)}
                          all=${state.tasks}
                          unsaved=${state.unsaved}
                          view=${view}
                          group=${group}
                          composing=${composer?.column === column.id && composer.row === row.value}
                          compose=${() => compose(column, row.value)}
                          closeComposer=${closeComposer}
                          create=${create}
                          move=${move}
                        />
                      `,
                    )}
                  </div>
                </section>
              `,
            )
      }
    </div>
  `;
}

/** How many cards a cell shows before "Show more": a long Done column costs nothing to draw. */
const CELL_PAGE = 40;

/** One column of one row: its cards, the box for a new one, and where a dragged card is dropped.
 *  A drop changes the card's STATUS and nothing else: a card dropped in another row stays in its
 *  own row, because the board writes no dimension of a file that exists. */
function Cell({
  column,
  columns,
  tasks,
  all,
  unsaved,
  view,
  group,
  composing,
  compose,
  closeComposer,
  create,
  move,
}) {
  const [over, setOver] = useState(false);
  const [limit, setLimit] = useState(CELL_PAGE);
  return html`
    <div
      class="board-cell"
      data-over=${over || undefined}
      data-column=${column.id}
      onDragOver=${(event) => {
        if (!event.dataTransfer.types.includes("application/x-task")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave=${(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOver(false);
      }}
      onDrop=${(event) => {
        setOver(false);
        const path = event.dataTransfer.getData("application/x-task");
        const task = all.find((each) => each.path === path);
        if (!task) return;
        event.preventDefault();
        move(task, column);
      }}
    >
      ${composing && html`<${Composer} create=${create} close=${closeComposer} />`}
      ${tasks
        .slice(0, limit)
        .map(
          (task) => html`
            <${Card}
              key=${task.path}
              task=${task}
              columns=${columns}
              unsaved=${unsaved.has(task.path)}
              view=${view}
              group=${group}
              move=${move}
            />
          `,
        )}
      ${
        tasks.length > limit &&
        html`
          <button class="tasks-link board-more" onClick=${() => setLimit(limit + CELL_PAGE)}>
            Show ${Math.min(CELL_PAGE, tasks.length - limit)} more of ${tasks.length - limit}
          </button>
        `
      }
      ${
        !composing &&
        html`
          <button
            class="board-cell-add"
            aria-label=${`New task in ${column.label}`}
            onClick=${compose}
          >
            <${PlusIcon} />
          </button>
        `
      }
    </div>
  `;
}

/** The box a new task's title is written in. Enter makes the task and leaves the box open for the
 *  next one; Escape, or leaving it empty, closes it. */
function Composer({ create, close }) {
  const [title, setTitle] = useState("");
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  return html`
    <form
      class="task task-composer"
      onSubmit=${(event) => {
        event.preventDefault();
        if (!title.trim()) return close();
        create(title);
        setTitle("");
      }}
    >
      <textarea
        ref=${ref}
        rows="2"
        placeholder="Task title"
        aria-label="Task title"
        value=${title}
        onChange=${(event) => setTitle(event.target.value.replace(/\n/g, " "))}
        onKeyDown=${(event) => {
          if (event.key === "Escape") close();
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form.requestSubmit();
          }
        }}
        onBlur=${() => !title.trim() && close()}
      ></textarea>
      <div class="task-composer-foot">
        <span>Enter to add · Esc to close</span>
        <${Button} type="submit" size="xs" disabled=${!title.trim()}>Add<//>
      </div>
    </form>
  `;
}

/** A value of a dimension on a card: a press filters the board by it, and a second press lets go. */
function Value({ view, dimension, value, className, title, children }) {
  const on = view.where[dimension.id].includes(value);
  return html`
    <button
      type="button"
      class=${`task-value ${className || ""}`}
      data-dimension=${dimension.id}
      data-value=${String(value).toLowerCase()}
      aria-pressed=${on}
      title=${title || `${dimension.one}: ${value}${on ? " (filters the board)" : ""}`}
      onClick=${() => pick(view, dimension, value)}
    >
      ${children ?? value}
    </button>
  `;
}

const DIMENSION = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension.id, dimension]));
/** The first letters of a name's first two words: "jonas templestein" is JT, "jonas" is JO. */
const initialsOf = (name) => {
  const words = name.split(/[\s._@-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
};

/** One task. Its title opens the task's sheet (a plain click; the link itself is the board with
 *  that sheet open, for a new tab); the card is dragged to another column, and
 *  its menu does the same for a finger or a keyboard. Under the title: the folder, and each
 *  dimension that the file holds (the one the board's rows are by is left out: the row says it). */
function Card({ task, columns, unsaved, view, group, move }) {
  const has = (id) => (group?.id === id && !DIMENSION[id].many ? [] : valuesOf(task, id));
  const [dragging, setDragging] = useState(false);
  return html`
    <article
      class="task"
      draggable="true"
      data-dragging=${dragging || undefined}
      data-unsaved=${unsaved || undefined}
      onDragStart=${(event) => {
        event.dataTransfer.setData("application/x-task", task.path);
        event.dataTransfer.setData("text/plain", task.title);
        event.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd=${() => setDragging(false)}
    >
      <div class="task-top">
        <a
          class="task-title"
          href=${taskHref(task.path)}
          draggable="false"
          onClick=${(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            openTask(task.path);
          }}
        >
          ${task.title}
        </a>
        <${DropdownMenu}>
          <${DropdownMenuTrigger}
            render=${html`<${Button}
              variant="ghost"
              size="icon-xs"
              className="task-menu"
              aria-label=${`Actions for ${task.title}`}
            />`}
          >
            <${EllipsisIcon} />
          <//>
          <${DropdownMenuContent} align="end" className="task-menu-popup">
            <${DropdownMenuGroup}>
              <${DropdownMenuLabel}>Status<//>
              <${DropdownMenuRadioGroup}
                value=${task.column}
                onValueChange=${(id) =>
                  move(
                    task,
                    columns.find((column) => column.id === id),
                  )}
              >
                ${columns.map(
                  (column) => html`
                    <${DropdownMenuRadioItem} key=${column.id} value=${column.id}>
                      <${StatusMark} column=${column.id} />${column.label}
                    <//>
                  `,
                )}
              <//>
            <//>
            <${DropdownMenuSeparator} />
            <${DropdownMenuItem}
              onClick=${() => window.open(docsHref(task.path), "_blank", "noreferrer")}
            >
              <${ExternalLinkIcon} />Open in Docs
            <//>
          <//>
        <//>
      </div>
      <div class="task-meta">
        ${task.folder && html`<span class="task-folder">${task.folder}</span>`}
        ${has("priority").map(
          (value) => html`
            <${Value} key=${value} view=${view} dimension=${DIMENSION.priority} value=${value}>
              <${Badge} variant="outline" className="task-tag task-priority"><i></i>${value}<//>
            <//>
          `,
        )}
        ${has("tags").map(
          (value) => html`
            <${Value} key=${value} view=${view} dimension=${DIMENSION.tags} value=${value}>
              <${Badge} variant="secondary" className="task-tag">${value}<//>
            <//>
          `,
        )}
        ${has("size").map(
          (value) => html`
            <${Value} key=${value} view=${view} dimension=${DIMENSION.size} value=${value}>
              <${Badge} variant="outline" className="task-tag">${value}<//>
            <//>
          `,
        )}
        ${
          has("agent").length + has("owner").length > 0 &&
          html`<span class="task-people">
            ${has("agent").map((value) =>
              // the agent's mark is a link to its chat in the Dash; a name that is no path filters, as the other values do
              agentHref(value)
                ? html`
                    <a
                      key=${value}
                      class="task-value task-agent"
                      data-dimension="agent"
                      href=${agentHref(value)}
                      target="_blank"
                      rel="noreferrer"
                      title=${`Agent: ${value} (opens its chat in the Dash)`}
                      aria-label=${`Chat with the agent ${valueLabel(DIMENSION.agent, value)}`}
                      draggable=${false}
                    >
                      <${BotIcon} />
                    </a>
                  `
                : html`
                    <${Value}
                      key=${value}
                      view=${view}
                      dimension=${DIMENSION.agent}
                      value=${value}
                      className="task-agent"
                    >
                      <${BotIcon} />
                    <//>
                  `,
            )}
            ${has("owner").map(
              (value) => html`
                <${Value}
                  key=${value}
                  view=${view}
                  dimension=${DIMENSION.owner}
                  value=${value}
                  className="task-owner"
                >
                  ${initialsOf(value)}
                <//>
              `,
            )}
          </span>`
        }
        ${unsaved && html`<span class="task-unsaved" title="Not in the repo yet"></span>`}
      </div>
    </article>
  `;
}

// ── the task sheet ──
// A TASK OPENS IN A SHEET AT THE RIGHT OF THE BOARD (`?task=<path>`), and is edited there:
//
//   - its TEXT in the Docs app's live editor (@iterate-com/ui's `DocEditor` on a `DocSession`):
//     several people type at once, comment on the text, and the doc's processor saves what they
//     type as a commit, a minute after the first unsaved edit or when the last one leaves;
//   - its TITLE AND PROPERTIES through the board's own changes (`board.change`), as a card's move:
//     shown at once on the card and on every open board, and one commit a moment later. The open
//     editors get that commit merged into their text by the doc's processor.
//
// So the sheet has two things that can be waiting, and its saving line names both. A changed
// title renames nothing: the file's path is the task's identity.
//
// The editor is the Docs app's, with the Docs app's processors (apps/docs/processors/): the page
// names them exactly as the Docs page does (/processors.json, apps/tasks/app.ts), so a file open
// in both is one doc. Its code is loaded when the first sheet opens, not with the board.

const PROCESSOR_PACKAGES = ["yjs", "diff", "node-diff3"];
let editorAsked;
/** The editor's module and the processors' facet spec, asked for once. A failure is asked again
 *  at the next sheet. */
function editorOf() {
  editorAsked ||= (async () => {
    const [kit, answer, manifestText] = await Promise.all([
      import("@iterate-com/ui/components/docs-editor/docs-editor"),
      fetch("/processors.json"),
      itx.repos.get(CODE_REPO).readFile("package.json"),
    ]);
    if (!answer.ok) throw new Error(`/processors.json answered ${answer.status}`);
    const processors = await answer.json();
    const manifest = JSON.parse(manifestText || "{}");
    const pins = PROCESSOR_PACKAGES.map(
      (name) => `${name}@${manifest.dependencies?.[name] || "none"}`,
    );
    const me = principal?.email || principal?.actor || "someone";
    return {
      DocEditor: kit.DocEditor,
      DocSession: kit.DocSession,
      user: { name: me, email: me, color: kit.cursorColor(me) },
      // the same spec and the same name as the Docs page's (apps/docs/public/app.js)
      facetSpec: (className) => ({
        className,
        mainModule: processors.mainModule,
        source: ["itx", ["cd", "/"], "repos", ["get", CODE_REPO], ["modules"]],
        cacheKey: `docs-processors:${processors.version}:${pins.join(",")}`,
      }),
    };
  })();
  editorAsked.catch(() => {
    editorAsked = undefined;
  });
  return editorAsked;
}

/** The board's link with one task open, and the same link with none. */
const taskHref = (path) => {
  const next = new URLSearchParams(location.search);
  if (path) next.set("task", path);
  else next.delete("task");
  const query = next.toString();
  return query ? `?${query}` : location.pathname;
};
/** Open a task's sheet: a new entry of the history, so Back closes it. */
function openTask(path) {
  history.pushState(null, "", taskHref(path));
  dispatchEvent(new PopStateEvent("popstate"));
}

/** The sheet: the kit's `Sheet` (a dialog: it keeps the focus inside while it is open, gives it
 *  back to the card when it closes, and Escape closes it). The focus goes to the sheet's top at
 *  the opening, not into a text box: on a phone that would raise the keyboard over the task. */
function TaskSheet({ path, state, columns, dimensions, move }) {
  // the task last opened: the sheet keeps showing it while it slides away
  const [last, setLast] = useState(path);
  if (path && path !== last) setLast(path);
  const top = useRef(null);
  const task = last ? state.tasks.find((each) => each.path === last) : undefined;
  return html`
    <${Sheet} open=${Boolean(path)} onOpenChange=${(open) => !open && setView({ task: undefined })}>
      <${SheetContent} className="task-sheet" initialFocus=${top}>
        <div class="task-sheet-top" ref=${top} tabindex="-1">
          <${SheetTitle} className="task-sheet-kind">Task<//>
          <${SheetDescription} className="task-sheet-path">${last}<//>
        </div>
        ${
          task
            ? html`<${TaskBody}
                key=${task.path}
                task=${task}
                columns=${columns}
                dimensions=${dimensions}
                save=${state.save}
                move=${move}
              />`
            : html`
                <p class="tasks-note" role=${state.loaded ? "alert" : undefined}>
                  ${state.loaded ? html`There is no task at <code>${last}</code>.` : "Reading the tasks…"}
                </p>
              `
        }
      <//>
    <//>
  `;
}

/** One open task: its head (the title and the properties), its saving line, and its text. */
function TaskBody({ task, columns, dimensions, save, move }) {
  // A DOC'S SESSION IS OF ONE SESSION OF THE PAGE'S ITX: its context and its subscriptions end
  // with that socket, and the kit's "Try again" syncs through the context it has. A publish of the
  // mind, or a deploy, cuts the socket for a few seconds. So the sheet makes a new DocSession at
  // each new session of the page (`epoch`), which opens the doc again by itself. WHAT THAT COSTS:
  // keys typed after the cut and before the new session is live were never sent, and are lost
  // (the editor is read-only while it opens, so the loss is the cut's own second or two).
  // `text` is what the editor shows until it is live: the file as the board has it at that moment.
  const { epoch } = useSyncExternalStore(pageSession.subscribe, pageSession.get, pageSession.get);
  const [opened, setOpened] = useState({ epoch, text: task.source });
  if (opened.epoch !== epoch) setOpened({ epoch, text: task.source });
  const [editor, setEditor] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    editorOf().then(
      (kit) => current && setEditor({ kit }),
      (error) => current && setEditor({ error: wordsOf(error) }),
    );
    return () => {
      current = false;
    };
  }, [attempt]);
  const session = useMemo(
    () =>
      editor?.kit
        ? new editor.kit.DocSession({
            itx,
            repo: REPO,
            path: task.path,
            kind: "markdown",
            text: opened.text,
            user: editor.kit.user,
            facetSpec: editor.kit.facetSpec,
            commentOnly: false,
          })
        : null,
    [editor, task.path, opened],
  );
  return html`
    <div class="task-sheet-body">
      <${TaskHead} task=${task} columns=${columns} dimensions=${dimensions} move=${move} />
      <p class="task-saving" role="status">
        <${PropertiesSaving} save=${save} />
        ${session && html`<${TextSaving} session=${session} />`}
      </p>
      ${
        session
          ? html`<${TaskText} session=${session} DocEditor=${editor.kit.DocEditor} />`
          : editor?.error
            ? html`
                <p class="tasks-note" role="alert">
                  Couldn't open the editor: ${editor.error}${" "}
                  <button
                    class="tasks-link"
                    onClick=${() => {
                      setEditor(null);
                      setAttempt(attempt + 1);
                    }}
                  >
                    Try again
                  </button>
                </p>
              `
            : html`<p class="tasks-note">Opening the editor…</p>`
      }
    </div>
  `;
}

/** Where the title and the properties stand: they are the board's changes. */
function PropertiesSaving({ save }) {
  if (save.state === "waiting" || save.state === "saving")
    return html`<span class="task-saving-part" data-pending
      ><${Spinner} />Title and properties: saving…</span
    >`;
  if (save.state === "failed")
    return html`
      <span class="task-saving-part" data-failed title=${save.error}>
        <${TriangleAlertIcon} />Title and properties: not saved
        <${Button} variant="outline" size="xs" onClick=${() => board.commitNow()}>Try again<//>
      </span>
    `;
  return html`<span class="task-saving-part"><${CheckIcon} />Title and properties: saved</span>`;
}

/** Where the text stands: it is the doc's, saved by the doc's processor. */
function TextSaving({ session }) {
  const { status } = useSyncExternalStore(session.subscribe, session.state, session.state);
  const words = {
    opening: "Text: opening…",
    editing:
      "Text: typed, not in the repo yet (it is saved within a minute, or when the sheet closes)",
    saved: "Text: saved",
    "save-failed": `Text: not saved: ${status.message}`,
    disconnected: "Text: the connection was lost; opening again…",
    unavailable: "Text: cannot be edited now",
  }[status.kind];
  const pending = status.kind === "editing" || status.kind === "opening";
  const failed = status.kind === "save-failed" || status.kind === "unavailable";
  return html`
    <span
      class="task-saving-part"
      data-pending=${pending || undefined}
      data-failed=${failed || undefined}
    >
      ${pending ? html`<${Spinner} />` : failed ? html`<${TriangleAlertIcon} />` : html`<${CheckIcon} />`}${words}
    </span>
  `;
}

/** The task's text in the Docs editor. */
function TaskText({ session, DocEditor }) {
  // TAB IN THE EDITOR. The editor takes Tab for itself (it indents the line), as a text editor
  // does. For a person who goes through the sheet with Tab that is a trap, and a harmful one: the
  // cursor of an editor just entered is on the file's first line, which is the frontmatter's
  // fence. So Tab passes THROUGH an editor that the keyboard brought the focus to, until the
  // person types or clicks in it: from then on Tab is the editor's. The handlers are on the way
  // down to the editor (capture), so the editor never sees a Tab that passes.
  const passing = useRef(false);
  const byPointer = useRef(false);
  const inEditor = (event) =>
    event.target instanceof Element && Boolean(event.target.closest(".cm-content"));
  return html`
    <div
      class="task-text"
      onPointerDownCapture=${() => {
        byPointer.current = true;
        passing.current = false;
      }}
      onFocusCapture=${(event) => {
        if (!inEditor(event)) return;
        passing.current = !byPointer.current;
        byPointer.current = false;
      }}
      onKeyDownCapture=${(event) => {
        byPointer.current = false;
        if (!inEditor(event)) return;
        // not prevented: the browser moves the focus on, which is what Tab does elsewhere
        if (event.key === "Tab" && passing.current) event.stopPropagation();
        else if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) passing.current = false;
      }}
    >
      <${DocEditor}
        session=${session}
        listHref=${taskHref(null)}
        listLabel="tasks"
        editHref=${taskHref(session.options.path)}
        onNavigate=${(href) => {
          history.pushState(null, "", href);
          dispatchEvent(new PopStateEvent("popstate"));
        }}
        unavailable=${html`
          <p>
            The task's text is edited through the Docs app's processors in this mind's config repo
            (<code>apps/docs/processors/</code>). The title and the properties above do not need
            them.
          </p>
        `}
      />
    </div>
  `;
}

/** The task's title and properties, each edited in place. A change is a change of the board: on
 *  the card at once, and in the file with the next commit. */
function TaskHead({ task, columns, dimensions, move }) {
  // a dimension the file does not hold, asked for with "Add property": shown empty until it has a value
  const [added, setAdded] = useState([]);
  // the agent is the task's own business (who has it is written by that agent): shown, not edited
  const editable = DIMENSIONS.filter((dimension) => dimension.id !== "agent");
  const asked = new Set(added);
  const shown = editable.filter(
    (dimension) => valuesOf(task, dimension.id).length > 0 || asked.has(dimension.id),
  );
  const isShown = new Set(shown);
  const hidden = editable.filter((dimension) => !isShown.has(dimension));
  return html`
    <div class="task-head">
      <${TextBox}
        className="task-title-box"
        label="Title"
        value=${task.title}
        multiline
        onCommit=${(title) => title && board.change({ kind: "title", path: task.path, title })}
      />
      <dl class="task-properties">
        <div class="task-property">
          <dt><label htmlFor="task-status">Status</label></dt>
          <dd>
            <${NativeSelect}
              id="task-status"
              size="sm"
              value=${task.column}
              onChange=${(event) =>
                move(
                  task,
                  columns.find((column) => column.id === event.target.value),
                )}
            >
              ${columns.map((column) => html`<${NativeSelectOption} key=${column.id} value=${column.id}>${column.label}<//>`)}
            <//>
          </dd>
        </div>
        ${shown.map(
          (dimension) => html`
            <div class="task-property" key=${dimension.id}>
              <dt><label htmlFor=${`task-${dimension.id}`}>${dimension.one}</label></dt>
              <dd>
                <${Property}
                  id=${`task-${dimension.id}`}
                  dimension=${dimension}
                  values=${valuesOf(task, dimension.id)}
                  inUse=${
                    dimensions
                      .find((each) => each.id === dimension.id)
                      ?.values.map(([value]) => value) ?? []
                  }
                  set=${(value) => board.change({ kind: "field", path: task.path, field: dimension.id, value })}
                />
              </dd>
            </div>
          `,
        )}
        ${
          task.agent &&
          html`
            <div class="task-property">
              <dt>Agent</dt>
              <dd class="task-property-text">
                ${
                  agentHref(task.agent)
                    ? html`<a
                        class="task-agent-link"
                        href=${agentHref(task.agent)}
                        target="_blank"
                        rel="noreferrer"
                        title="Opens the agent's chat in the Dash"
                        >${task.agent}</a
                      >`
                    : task.agent
                }
              </dd>
            </div>
          `
        }
      </dl>
      ${
        hidden.length > 0 &&
        html`
          <${DropdownMenu}>
            <${DropdownMenuTrigger}
              render=${html`<${Button} variant="ghost" size="xs" className="task-add-property" />`}
            >
              <${PlusIcon} data-icon="inline-start" />Add property
            <//>
            <${DropdownMenuContent} align="start" className="task-menu-popup">
              ${hidden.map(
                (dimension) => html`
                  <${DropdownMenuItem}
                    key=${dimension.id}
                    onClick=${() => setAdded([...added, dimension.id])}
                  >
                    ${dimension.one}
                  <//>
                `,
              )}
            <//>
          <//>
        `
      }
    </div>
  `;
}

/** One dimension's control: a list of chips for tags, a choice for a dimension that has choices
 *  (priority, size), a text box for the rest (owner). */
function Property({ id, dimension, values, inUse, set }) {
  if (dimension.many)
    return html`<${ChipsBox}
      id=${id}
      dimension=${dimension}
      values=${values}
      inUse=${inUse}
      set=${set}
    />`;
  const value = values[0] || "";
  if (dimension.choices) {
    // the dimension's own choices, then what the board's files use, then what this file says
    const choices = [...new Set([...dimension.choices, ...inUse, ...values])];
    return html`
      <${NativeSelect}
        id=${id}
        size="sm"
        value=${value}
        onChange=${(event) => set(event.target.value)}
      >
        <${NativeSelectOption} value="">None<//>
        ${choices.map((choice) => html`<${NativeSelectOption} key=${choice} value=${choice}>${choice}<//>`)}
      <//>
    `;
  }
  return html`<${TextBox}
    id=${id}
    label=${dimension.one}
    value=${value}
    suggestions=${inUse}
    placeholder="None"
    onCommit=${set}
  />`;
}

/** A text edited in place: what is typed is the box's own until Enter or until the box is left,
 *  then it is handed over once (`onCommit`), so a title typed letter by letter is one change.
 *  Escape gives the typing up. While nobody types, the box shows the value as it is now. */
function TextBox({ id, className, label, value, multiline, suggestions, placeholder, onCommit }) {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    if (draft === null) return;
    const next = draft.replace(/\s+/g, " ").trim();
    setDraft(null);
    if (next !== value) onCommit(next);
  };
  const props = {
    id,
    className: `task-box ${className || ""}`,
    "aria-label": label,
    placeholder,
    value: draft ?? value,
    onChange: (event) => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown: (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.currentTarget.blur();
      } else if (event.key === "Escape" && draft !== null) {
        // the first Escape gives up what was typed; the sheet stays open
        event.stopPropagation();
        setDraft(null);
      }
    },
  };
  if (multiline) return html`<textarea rows="1" ...${props}></textarea>`;
  const list = suggestions?.length > 0 ? `${id}-list` : undefined;
  return html`
    <input type="text" list=${list} autocomplete="off" ...${props} />
    ${list && html`<datalist id=${list}>${suggestions.map((each) => html`<option key=${each} value=${each}></option>`)}</datalist>`}
  `;
}

/** A dimension with several values (tags): a chip for each, taken away by its cross, and a box
 *  that adds one at Enter or at a comma. Backspace in the empty box takes the last one away. */
function ChipsBox({ id, dimension, values, inUse, set }) {
  const [draft, setDraft] = useState("");
  const has = new Set(values);
  const add = (text) => {
    const more = text
      .split(",")
      .map((each) => each.trim())
      .filter((each) => each && !has.has(each));
    setDraft("");
    if (more.length > 0) set([...values, ...more]);
  };
  const others = inUse.filter((each) => !has.has(each));
  return html`
    <span class="task-chips">
      ${values.map(
        (value) => html`
          <span class="task-chip" key=${value}>
            ${value}
            <button
              type="button"
              aria-label=${`Remove ${dimension.one.toLowerCase()} ${value}`}
              onClick=${() => set(values.filter((each) => each !== value))}
            >
              <${XIcon} />
            </button>
          </span>
        `,
      )}
      <input
        id=${id}
        class="task-box task-chips-box"
        type="text"
        list=${others.length > 0 ? `${id}-list` : undefined}
        autocomplete="off"
        placeholder=${values.length > 0 ? "Add…" : "None"}
        aria-label=${`Add a ${dimension.one.toLowerCase()}`}
        value=${draft}
        onChange=${(event) => (event.target.value.endsWith(",") ? add(event.target.value) : setDraft(event.target.value))}
        onBlur=${() => add(draft)}
        onKeyDown=${(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add(draft);
          } else if (event.key === "Backspace" && !draft && values.length > 0)
            set(values.slice(0, -1));
          else if (event.key === "Escape" && draft) {
            event.stopPropagation();
            setDraft("");
          }
        }}
      />
      ${
        others.length > 0 &&
        html`<datalist id=${`${id}-list`}>
          ${others.map((each) => html`<option key=${each} value=${each}></option>`)}
        </datalist>`
      }
    </span>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
