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
import { AppShell } from "@iterate-com/ui/components/app-shell";
import { AgentChat } from "@iterate-com/ui/components/agent-chat/agent-chat";
import { Toaster } from "@iterate-com/ui/components/ui/sonner";
import { newWebSocketRpcSession, useContextStub, useIterateContext } from "@iterate-com/ui/live";
import { agentRowsOf } from "./agent-rows.js";
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

// The mind is its domain, and this host is one label under it.
const domain = location.hostname.split(".").slice(1).join(".") || location.hostname;

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
  const open = useCallback((path) => navigate({ agent: path, chat: undefined }), [navigate]);
  const chat =
    agent &&
    html`
      <${Chat}
        key=${agent}
        path=${agent}
        row=${agents.find((row) => row.path === agent)}
        saved=${params.get("chat")}
        onSave=${(saved) => navigate({ chat: saved }, { replace: true })}
      />
    `;
  const home =
    !agent &&
    html`
      <${AgentsHome}
        agents=${agents}
        onOpen=${open}
        onCreate=${(path) => itx.agents.create(path)}
        onMessage=${(path, message) => itx.agents.get(path).message({ message })}
      />
    `;
  return html`
    <${AppShell}
      app="Agents"
      mind=${domain}
      mindHref=${() => "./"}
      nav=${html`<${AgentsNav} mind=${domain} agents=${agents} agent=${agent} onOpen=${open} />`}
      header=${agent ? html`<span class="truncate font-mono text-sm">${agent}</span>` : null}
      account=${principal}
      locationKey=${href}
    >
      ${chat || home}
    <//>
    <${Toaster} theme="dark" />
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

/** One agent's chat: this page holds the agent's context and reads it live; `AgentChat` draws
 *  everything inside. An agent iterate does not run (a coding session, say) opens on its Events
 *  tab: the chat draws an iterate agent's events. */
function Chat({ path, row, saved, onSave }) {
  const [state, setState] = useState(() => {
    try {
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {}; // a hand-edited value is an absent one
    }
  });
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
      onStateChange=${(patch) => {
        const next = { ...state, ...patch };
        setState(next);
        onSave(JSON.stringify(next));
      }}
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

render(html`<${App} />`, document.getElementById("root"));
