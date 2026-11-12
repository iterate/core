// app.js — THE AGENTS APP'S PAGE: the mind's agents in the sidebar, and beside them one agent's
// chat or, with no agent in the URL, the home page that starts one. Everything it draws is a
// component of @iterate-com/ui, loaded through the import map in index.html. This folder holds the
// wiring, the sidebar's rows and the home page: change them here.
import {
  html,
  render,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from "@iterate-com/ui/page";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  AgentKindHiddenFrame,
  AgentKindViewFrame,
  useAgentKindViewLink,
  useAgentKindViewLinks,
} from "@iterate-com/ui/agent-kind-view/host";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import { AgentChat } from "@iterate-com/ui/components/agent-chat/agent-chat";
import { Toaster } from "@iterate-com/ui/components/ui/sonner";
import { newWebSocketRpcSession, useContextStub, useIterateContext } from "@iterate-com/ui/live";
import { agentRowsOf, personOf } from "./agent-rows.js";
import { AgentsHome } from "./home.js";
import { AgentsNav } from "./nav.js";

// ── the member's itx ──
// One WebSocket to this host's /itx, which app.ts answers: a capnweb session whose root is the
// mind's itx, as the member the platform signed in on this host. The platform ends it when the
// sign-in ends; a reload signs in again. Three closes in a minute stop the reloads.
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

// Who is signed in, as the session itself says: the foot of the sidebar shows them.
const { principal } = await itx.whoami();
// the folder of this person's agents, from the address they signed in with
const person = personOf(principal?.email);

// The mind is its domain, and this host is one label under it.
const domain = location.hostname.split(".").slice(1).join(".") || location.hostname;

// ── the kinds of agent ──
// A kind of agent can bring its own chat view: its file in this repo (`agent-kinds/<kind>.ts`)
// exports `view`. worker.ts writes each kind's file to the mind's KV at every publish
// (`publishAgentKinds`), and this page reads that once: `{ <kind>: <file> }`.
const kindFiles = await itx.kv.get("agent-kinds").then(
  (text) => JSON.parse(text || "{}"),
  () => ({}), // no such key, or not JSON: no kind has a view of its own
);
// A kind's view runs in a frame that the UI kit makes, sandboxed from this page. The frame's
// script is one file of the same build of the kit that this page pins in its import map: a
// classic script, so it is named by its place in the package, and `?raw` asks the server for the
// file as it is (without it, the server answers a module that wraps the file).
const importMap = JSON.parse(
  document.querySelector('script[type="importmap"]')?.textContent || "{}",
);
const kit = importMap.imports?.["@iterate-com/ui/"] || "";
const kindFrameScript = `${kit}dist/agent-kind-view-frame.js?raw`;
/** THE FRAME HAS NO SIGN-IN, so it cannot ask this host for a file: a request from it is answered
 *  as nobody's. The kit's frame copies this page's style sheets into its own document, links as
 *  links. So this host's own sheets (theme.css, app.css) are put into the page as text first, in
 *  their places, and the frame carries the text with it. Once for the page. */
let ownStylesInPage;
function ownStyleSheetsAsText() {
  ownStylesInPage ||= Promise.all(
    [...document.querySelectorAll('link[rel="stylesheet"]')]
      .filter((link) => new URL(link.href).origin === location.origin)
      .map(async (link) => {
        const answer = await fetch(link.href).catch(() => null);
        if (!answer?.ok) return;
        const style = document.createElement("style");
        style.textContent = await answer.text();
        link.replaceWith(style);
      }),
  );
  return ownStylesInPage;
}

/** A kind's file, as the config repo has it now, or null when it cannot be read (the frame then
 *  shows the agent's events). Read once for each file: its query is never stale. */
const kindSourceQuery = (file) => ({
  queryKey: ["kind-source", file],
  queryFn: () =>
    itx.repos
      .get("/repos/config")
      .readFile(file)
      .then(
        (source) => (typeof source === "string" ? source : null),
        () => null,
      ),
  staleTime: Infinity,
});

// ── the last start ──
// HOW THE LAST NEW AGENT WAS STARTED, in this browser: its choice (`iterate`, or an offer's
// `<kind>/<choice>`) and its fields, which New agent offers again. Storage that can't be read is
// no last start.
const LAST_START = `agents/last-start/${location.hostname}`;
function lastStart() {
  try {
    return (
      JSON.parse(localStorage.getItem(LAST_START) || "null") || { choice: "iterate", fields: {} }
    );
  } catch {
    return { choice: "iterate", fields: {} };
  }
}
function rememberStart(start) {
  try {
    localStorage.setItem(LAST_START, JSON.stringify(start));
  } catch {
    // no storage: nothing remembered
  }
}

/** The page's reads that aren't live: kind files, the kinds' New agent lines. */
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

// ── the URL ──
// THE PAGE IS A LINK: `?agent=<path>` is the open agent, and `?chat=<json>` the chat's own choices
// (its tab, the open trace, the Events tab's filter).
const subscribeToUrl = (listener) => {
  addEventListener("popstate", listener);
  return () => removeEventListener("popstate", listener);
};

function useUrl() {
  const search = useSyncExternalStore(subscribeToUrl, () => location.search);
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const navigate = useCallback((change, { replace = false } = {}) => {
    const next = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(change))
      if (value === undefined) next.delete(key);
      else next.set(key, value);
    const query = next.toString();
    history[replace ? "replaceState" : "pushState"](null, "", query ? `?${query}` : "./");
    dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  return { params, href: location.pathname + search, navigate };
}

// The catalog on `/agents`: its live state alone, none of its events.
const CATALOG = { liveState: ["agents"], consumes: ["events.iterate.com/agent/none"] };

function App() {
  const { params, href, navigate } = useUrl();
  const agent = params.get("agent") || undefined;
  const catalog = useContextStub(() => itx.cd("/agents"), []);
  // ONE subscription for the whole list: it reads no agent, so the sidebar wakes none of them
  const { liveState } = useIterateContext(catalog.stub, CATALOG);
  const listed = liveState.agents?.value;
  const agents = useMemo(() => agentRowsOf(listed), [listed]);
  const open = useCallback(
    (path) => navigate({ agent: path, chat: undefined, kind: undefined, new: undefined }),
    [navigate],
  );
  const row = agents.find((one) => one.path === agent);
  // iterate's own kind is the chat this page draws itself; another kind with a file draws its own.
  // An agent New agent just started has no catalog row yet: `?kind=` names its kind until it does.
  const kind = row?.kind || params.get("kind");
  const kindFile = kind && kind !== "iterate" ? kindFiles[kind] : undefined;
  const chat =
    agent &&
    html`
      <${kindFile ? KindChat : Chat}
        key=${agent}
        path=${agent}
        row=${row}
        file=${kindFile}
        saved=${params.get("chat")}
        onSave=${(saved) => navigate({ chat: saved }, { replace: true })}
      />
    `;
  // New agent's choice and its fields: the URL's (`?new=`, `?field.<name>=`), else how the last
  // agent was started here
  const last = lastStart();
  const choice = params.get("new") || last.choice;
  const home =
    !agent &&
    html`
      <${NewAgentKinds}>
        ${({ offers, ready, start, describe }) => html`
          <${AgentsHome}
            agents=${agents}
            person=${person}
            offers=${offers}
            ready=${ready}
            choice=${choice}
            typed=${(name) =>
              params.get(`field.${name}`) ??
              (last.choice === choice ? last.fields[name] : undefined)}
            onChoice=${(next) => navigate({ new: next || "iterate" }, { replace: true })}
            onField=${(name, value) => navigate({ [`field.${name}`]: value }, { replace: true })}
            describe=${describe}
            onStart=${async (offer, path, fields) => {
              await start(offer, path, fields);
              rememberStart({ choice: offer.value, fields });
            }}
            onStarted=${(path, started) => navigate({ agent: path, kind: started, new: undefined })}
            onOpen=${open}
            onCreate=${async (path) => {
              await itx.agents.create(path);
              rememberStart({ choice: "iterate", fields: {} });
            }}
            onMessage=${(path, message) => itx.agents.get(path).message({ message })}
          />
        `}
      <//>
    `;
  return html`
    <${AppShell}
      app="Agents"
      mind=${domain}
      mindHref=${() => "./"}
      nav=${html`
        <${AgentsNav}
          mind=${domain}
          agents=${agents}
          agent=${agent}
          person=${person}
          onOpen=${open}
        />
      `}
      header=${agent ? html`<span class="truncate text-sm">${agent}</span>` : null}
      account=${principal}
      locationKey=${href}
    >
      ${chat || home}
    <//>
    <${Toaster} theme=${document.documentElement.classList.contains("dark") ? "dark" : "light"} />
  `;
}

/** Who said a message, as the platform stamped its event: the person who appended it, or the
 *  person the agent's own code wrote it for (`onBehalfOf`), and the page they came through. */
function saidBy(source) {
  const who = source?.principal ? source : source?.onBehalfOf;
  if (!who?.principal) return undefined;
  const script = who.run ? " (a script)" : "";
  const page = who.via ? ` via ${who.via.appPage}` : "";
  return `${who.principal.email || who.principal.actor}${script}${page}`;
}

/** The chat's own choices (its tab, the open trace), kept in the URL. */
function useSavedState(saved, onSave) {
  const [state, setState] = useState(() => {
    try {
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {}; // a hand-edited value is an absent one
    }
  });
  // the frame's and the chat's verbs are this render's, so `state` here is the newest
  const change = (patch) => {
    const next = { ...state, ...patch };
    setState(next);
    onSave(JSON.stringify(next));
  };
  return [state, change];
}

/** NEW AGENT'S OTHER KINDS: each kind's file but iterate's, loaded in a frame no one sees (a kind's
 *  code runs only in a frame), which reports the kind's `newAgent` choices and fields (the
 *  picker's offers) and makes the events that start one. None until the files are read. */
function NewAgentKinds({ children }) {
  const files = useQuery({
    queryKey: ["new-agent-kinds"],
    queryFn: () =>
      Promise.all(
        Object.entries(kindFiles)
          .filter(([kind]) => kind !== "iterate")
          .map(async ([kind, file]) => ({
            kind,
            name: file,
            source: await queryClient.fetchQuery(kindSourceQuery(file)),
          })),
      ).then((read) => read.filter((one) => one.source)),
    staleTime: Infinity,
  });
  const kinds = useMemo(() => files.data || [], [files.data]);
  const { links, loaded } = useAgentKindViewLinks(kinds);
  // every kind's file read, and each one's frame has reported (its offers, or none)
  const ready = files.isSuccess && kinds.every((_, index) => loaded[index]);
  const offers = useMemo(
    () =>
      kinds.flatMap(({ kind }, index) => {
        const report = loaded[index];
        const newAgent = report && "newAgent" in report ? report.newAgent : undefined;
        return (newAgent?.choices || []).map((option) => ({
          value: `${kind}/${option.id}`,
          // a choice named as its kind is said once: "claude", not "claude (claude)"
          label: option.label === kind ? option.label : `${option.label} (${kind})`,
          kind,
          choice: option.id,
          // the kind's word that this choice's agents may live in a person's folder
          byPerson: option.byPerson === true,
          // a field may be for some of the kind's choices alone (`choices`)
          fields: (newAgent?.fields || []).filter(
            (field) => !field.choices || field.choices.includes(option.id),
          ),
        }));
      }),
    [kinds, loaded],
  );
  // the kind's own start events, appended as the member who sent them
  const start = useCallback(
    async (offer, path, fields) => {
      const link = links[kinds.findIndex(({ kind }) => kind === offer.kind)];
      if (!link) throw new Error(`no kind ${offer.kind}`);
      const events = await link.startEvents({ choice: offer.choice, fields, path });
      await itx.cd(path).append(...events);
    },
    [kinds, links],
  );
  // the kind's line about the choice as typed (`newAgent.describe`), for under the picker
  const describe = useCallback(
    async (offer, fields) => {
      const link = links[kinds.findIndex(({ kind }) => kind === offer.kind)];
      return link ? await link.describe({ choice: offer.choice, fields, mind: domain }) : null;
    },
    [kinds, links],
  );
  return html`
    ${links.map(
      (link) => html`
        <${AgentKindHiddenFrame} key=${link.name} link=${link} frameScript=${kindFrameScript} />
      `,
    )}
    ${children({ offers, ready, start, describe })}
  `;
}

/** AN AGENT OF A KIND THAT BRINGS ITS OWN CHAT VIEW (a coding session's, say). The view's code is
 *  a file of the config repo, which any member or any member's agent can change, so it does not
 *  run in this page: the UI kit puts it in a sandboxed frame. This page reads the agent's log live
 *  and hands it to the frame, and answers the frame's few verbs for this one agent. */
function KindChat({ path, file, saved, onSave }) {
  const source = useQuery(kindSourceQuery(file));
  // the page's own style sheets first: the frame is made with what the page holds then
  const styles = useQuery({
    queryKey: ["own-style-sheets"],
    queryFn: ownStyleSheetsAsText,
    staleTime: Infinity,
  });
  if (source.isPending || styles.isPending)
    return html`<p class="p-4 text-sm text-muted-foreground">Loading…</p>`;
  return html`
    <${KindFrame} path=${path} file=${file} source=${source.data} saved=${saved} onSave=${onSave} />
  `;
}

function KindFrame({ path, file, source, saved, onSave }) {
  const [state, setState] = useSavedState(saved, onSave);
  const agent = useContextStub(() => itx.cd(path), [path]);
  const { link, loaded } = useAgentKindViewLink(file, source);
  // every durable event (the frame's Events tab is the whole log) and, by name, the ephemeral
  // ones the view reads, which a wildcard never matches; nothing until the frame has said which
  const options = useMemo(
    () => ({
      consumes: ["*", ...(loaded && "ephemeralEvents" in loaded ? loaded.ephemeralEvents : [])],
    }),
    [loaded],
  );
  const log = useIterateContext(loaded ? agent.stub : undefined, options);
  const { loading, exhausted } = log.older;
  const older = useMemo(() => (exhausted ? null : { loading, exhausted }), [loading, exhausted]);
  const inputs = {
    path,
    events: log.events,
    caughtUp: log.caughtUp,
    error: log.error,
    head: log.head,
    older,
    processors: log.processors,
    presence: log.presence,
    liveState: log.liveState,
    hostError: agent.error || (loaded && "error" in loaded ? loaded.error : undefined),
    state,
    // this page's theme, for the frame's own
    documentClass: document.documentElement.className,
  };
  // everything the frame may do, to this agent alone: never the agent's stub, which reaches the
  // whole mind
  const verbs = {
    message: async ({ message, files }) => {
      await itx.agents.get(path).message({ message, files });
    },
    append: async (events) => {
      if (!agent.stub) throw new Error("not connected");
      await agent.stub.append(...events);
    },
    fileUrl: async (filePath) => {
      if (!agent.stub) throw new Error("not connected");
      if (!filePath.startsWith(`${path}/`)) throw new Error(`${filePath} is not a file of ${path}`);
      return (await agent.stub.files.get(filePath).url()).url;
    },
    setState,
    loadOlder: log.older.loadOlder,
  };
  return html`
    <${AgentKindViewFrame}
      link=${link}
      frameScript=${kindFrameScript}
      inputs=${inputs}
      verbs=${verbs}
    />
  `;
}

/** One agent's chat: this page holds the agent's context and reads it live; `AgentChat` draws
 *  everything inside. An agent of a kind that is not iterate's own and has no view of its own
 *  opens on its Events tab: the chat draws an iterate agent's events. */
function Chat({ path, row, saved, onSave }) {
  const [state, setState] = useSavedState(saved, onSave);
  const agent = useContextStub(() => itx.cd(path), [path]);
  const context = useIterateContext(agent.stub, AgentChat.contextOptions);
  const shown =
    state.view || !row?.kind || row.kind === "iterate" ? state : { ...state, view: "events" };
  // A label under each message a person said. A later build of the chat draws it itself, and its
  // items then carry `saidBy`: this row goes when the pin in index.html moves to one.
  const sources = useMemo(
    () => new Map(context.events.map((event) => [event.offset, event.source])),
    [context.events],
  );
  const saidByRow = useCallback(
    (item) => {
      if (item.kind !== "user" || item.saidBy) return null;
      // words sent with `message()` are an `agent/message-received`, which names who asked; the
      // bubble is the `context-added` the agent's loop made of it
      const source = sources.get(item.offset);
      const relayed = source?.processor?.whileProcessing;
      const label =
        saidBy(source) ||
        (relayed?.type === "events.iterate.com/agent/message-received" &&
          saidBy(sources.get(relayed.offset)));
      return label ? html`<p class="said-by" data-said-by>${label}</p>` : null;
    },
    [sources],
  );
  return html`
    <${AgentChat}
      path=${path}
      context=${context}
      error=${agent.error}
      state=${shown}
      onStateChange=${setState}
      onMessage=${({ message, files }) => itx.agents.get(path).message({ message, files })}
      onAppend=${agent.stub ? (events) => agent.stub.append(...events) : undefined}
      signedUrl=${async (file) => {
        if (!agent.stub) throw new Error("not connected");
        return (await agent.stub.files.get(file).url()).url;
      }}
      listing=${row}
      itemFooter=${saidByRow}
    />
  `;
}

render(
  html`<${QueryClientProvider} client=${queryClient}><${App} /><//>`,
  document.getElementById("root"),
);
