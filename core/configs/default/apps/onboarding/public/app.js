// app.js — THE ONBOARDING APP'S PAGE: one agent thread, the chat with /agents/onboarding, in
// @iterate-com/ui's shell with its sidebar collapsed. Nothing else. The agent speaks first. Everything it draws is a
// component of @iterate-com/ui, loaded through the import map in index.html.
import { html, render, useEffect, useState } from "@iterate-com/ui/page";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import { AgentChat } from "@iterate-com/ui/components/agent-chat/agent-chat";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/ui/sidebar";
import { Toaster } from "@iterate-com/ui/components/ui/sonner";
import { newWebSocketRpcSession, useContextStub, useIterateContext } from "@iterate-com/ui/live";
import { BotIcon, MessageCircleIcon } from "@iterate-com/ui/icons";

// app.ts says the same: the mind's one onboarding agent.
const AGENT = "/agents/onboarding";

// The sidebar starts collapsed: the shell reads this cookie once, and keeps what a person then
// chooses in it.
if (!document.cookie.includes("sidebar_state="))
  document.cookie = "sidebar_state=false; path=/; max-age=31536000";

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

/** Anything said in the chat: by a person, by the agent, or by this page (below). Words that raise
 *  no turn, like iterate Cloud's handover (../../cloud-handover.ts), are context, not a start. */
const said = (event) =>
  event.type === "events.iterate.com/agent/message-received" ||
  (event.type === "events.iterate.com/agent/context-added" &&
    event.payload?.role !== "system" &&
    event.payload?.llmRequestPolicy?.behaviour !== "dont-trigger-request");

function App() {
  const agent = useContextStub(() => itx.cd(AGENT), []);
  const context = useIterateContext(agent.stub, AgentChat.contextOptions);
  // THE AGENT SPEAKS FIRST. When the chat is empty, this page says once that the owner has opened
  // it: a developer note, not the owner's words, which starts the agent's first turn. The key makes
  // it one event for the mind, whatever reloads or how many tabs are open.
  const { stub } = agent;
  const empty = context.caughtUp && !context.events.some(said);
  useEffect(() => {
    if (!stub || !empty) return;
    stub
      .append({
        type: "events.iterate.com/agent/context-added",
        idempotencyKey: "onboarding:first-open",
        payload: {
          role: "developer",
          content:
            "The owner has just opened the onboarding app for the first time. Begin with step 1.",
        },
      })
      .catch(() => {}); // another tab said it first, or the chat is not empty after all
  }, [stub, empty]);
  // The chat's own state (its tab, the open trace), for this page's life.
  const [state, setState] = useState({});
  return html`
    <${AppShell}
      app="Onboarding"
      mind=${domain}
      mindHref=${() => "./"}
      nav=${html`<${Nav} />`}
      account=${principal}
      locationKey="/"
    >
      <${AgentChat}
        path=${AGENT}
        context=${context}
        error=${agent.error}
        state=${state}
        onStateChange=${(patch) => setState((previous) => ({ ...previous, ...patch }))}
        onMessage=${(input) => itx.agents.get(AGENT).message(input)}
        onAppend=${agent.stub ? (events) => agent.stub.append(...events) : undefined}
        signedUrl=${async (file) => {
          if (!agent.stub) throw new Error("not connected");
          return (await agent.stub.files.get(file).url()).url;
        }}
        listing=${undefined}
      />
    <//>
    <${Toaster} theme=${document.documentElement.classList.contains("dark") ? "dark" : "light"} />
  `;
}

/** The sidebar's two rows: this chat, and the way to every other agent. */
function Nav() {
  return html`
    <${SidebarGroup}>
      <${SidebarGroupContent}>
        <${SidebarMenu}>
          <${SidebarMenuItem}>
            <${SidebarMenuButton} isActive tooltip="Onboarding" render=${html`<a href="./" />`}>
              <${MessageCircleIcon} />
              <span>Onboarding</span>
            <//>
          <//>
          <${SidebarMenuItem}>
            <${SidebarMenuButton}
              tooltip="All agents"
              render=${html`<a href=${`https://agents.${domain}`} />`}
            >
              <${BotIcon} />
              <span>All agents</span>
            <//>
          <//>
        <//>
      <//>
    <//>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
