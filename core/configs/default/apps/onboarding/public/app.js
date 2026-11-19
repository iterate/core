// app.js — THE ONBOARDING APP'S PAGE: a plain list of step cards above the chat with
// /agents/onboarding. The cards come from the host (`GET /steps.json`, ../app.ts), drawn again
// whenever the onboarding log moves; a button is one `POST /steps/<step>/<action>`, the same
// call as the agent's tool `itx.config.onboardingStep(step, action)` (../steps.ts). A card uses
// no model: it works before anything pays for one. Everything it draws is a component of
// @iterate-com/ui, loaded through the import map in index.html.
import { html, render, useCallback, useEffect, useState } from "@iterate-com/ui/page";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import { AgentChat } from "@iterate-com/ui/components/agent-chat/agent-chat";
import { Badge } from "@iterate-com/ui/components/ui/badge";
import { Button, buttonVariants } from "@iterate-com/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/ui/card";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/ui/sidebar";
import { newWebSocketRpcSession, useContextStub, useIterateContext } from "@iterate-com/ui/live";
import { LayoutDashboardIcon, SparklesIcon } from "@iterate-com/ui/icons";

const AGENT = "/agents/onboarding";

/** What the mind says first in the empty chat: the same words and key as the Dash's opener
 *  (apps/dash/public/app.js), so the first message is one, whichever page the owner opens. */
const OPENER =
  "The owner has just opened this chat for the first time and has typed nothing yet. Send your first message now: words only, no script (onboarding.md, 'Your first message').";

// ── the member's itx ──
// As ../../docs/public/app.js: one WebSocket to this host's /itx, a capnweb session whose root is
// the mind's itx, as the member the platform signed in on this host. Three closes in a minute
// stop the reloads.
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
// The mind's address is its control-plane hostname: this host says it (`/.auth/session.json`).
// index.html asks for it in its head, while the modules load.
const hostSession =
  window.__session ?? fetch("/.auth/session.json").then((answer) => answer.json());
const mind = new URL((await hostSession).issuer).hostname;
/** The zone this page is on: an app's hostname is one label under its zone. */
const zone = location.hostname.split(".").slice(1).join(".");

/** The host's answer as JSON, or a throw with its words. */
async function ask(path, method = "GET") {
  const response = await fetch(path, { method });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${path} answered ${response.status}`);
  return body;
}

/** Anything said in the chat: by a person, by the agent, or by an opener. Words that raise no
 *  turn (iterate Cloud's handover) are context, not a start. */
const said = (event) =>
  event.type === "events.iterate.com/agent/message-received" ||
  (event.type === "events.iterate.com/agent/context-added" &&
    event.payload?.role !== "system" &&
    event.payload?.llmRequestPolicy?.behaviour !== "dont-trigger-request");

function App() {
  return html`
    <${AppShell}
      app="Onboarding"
      mind=${mind}
      mindHref=${() => "./"}
      nav=${html`<${Nav} />`}
      account=${principal}
      locationKey="/"
    >
      <div className="onboarding">
        <${Steps} />
        <div className="onboarding-chat"><${Chat} /></div>
      </div>
    <//>
  `;
}

// ── the step cards ──

function Steps() {
  const [cards, setCards] = useState();
  const [error, setError] = useState();
  const [busy, setBusy] = useState();
  const reload = useCallback(
    () =>
      ask("/steps.json").then(
        (next) => {
          setCards(next);
          setError(undefined);
        },
        (failure) => setError(failure.message),
      ),
    [],
  );
  // the log of the steps, live: every event on it draws the cards again
  const log = useContextStub(() => itx.cd("/apps/onboarding"), []);
  const live = useIterateContext(log.stub, {
    consumes: [
      "onboarding/step-declined",
      "onboarding/step-action-requested",
      "onboarding/step-action-settled",
      "onboarding/step-checked",
    ],
  });
  const head = live.events.at(-1)?.offset;
  useEffect(() => void reload(), [reload, head]);
  // back to the tab, from the passkey page or the key's form: the facts may have changed
  useEffect(() => {
    const seen = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  }, [reload]);

  async function press(step, { action, opens }) {
    // a press whose answer may be a page opens its tab now: after an await the browser blocks it
    const tab = opens ? window.open("about:blank", "_blank") : null;
    setBusy(`${step}/${action}`);
    try {
      const answer = await ask(`/steps/${step}/${action}`, "POST");
      if (tab && answer.link) tab.location.href = answer.link;
      else tab?.close();
      await reload();
    } catch (failure) {
      tab?.close();
      setError(failure.message);
    } finally {
      setBusy(undefined);
    }
  }

  // no step offered on this mind (none yet, or each closed): the chat alone, with no empty box
  if (!error && !cards?.length) return null;
  return html`
    <section className="onboarding-steps" aria-label="Onboarding steps">
      ${error ? html`<p className="onboarding-error" role="alert">${error}</p>` : null}
      ${(cards || []).map(
        (card) => html`<${StepCard} key=${card.step} card=${card} busy=${busy} onPress=${press} />`,
      )}
    </section>
  `;
}

function StepCard({ card, busy, onPress }) {
  const short = card.text.length <= 1 && !card.points && !card.command;
  const content = card.points || card.command;
  const footer = card.buttons.length || card.footnote;
  // a refusal reads as an error
  const failed = card.status === "failed";
  return html`
    <${Card} data-step=${card.step} data-status=${card.status} size=${short ? "sm" : undefined}>
      <${CardHeader}>
        <${CardTitle}>
          ${card.title} ${card.optional ? html`<${Badge} variant="outline">optional<//>` : null}
        <//>
        ${card.text.map(
          (line) => html`
            <${CardDescription}
              key=${line}
              className=${failed ? "onboarding-error" : undefined}
              role=${failed ? "alert" : undefined}
            >
              ${line}
            <//>
          `,
        )}
      <//>
      ${content ? html`<${CardContent}><${Points} card=${card} /><//>` : null}
      ${footer ? html`<${Buttons} card=${card} busy=${busy} onPress=${onPress} />` : null}
    <//>
  `;
}

/** The card's points, and its command for the owner's own computer. */
function Points({ card }) {
  const points = (card.points || []).map((one) => html`<${Point} key=${one.title} point=${one} />`);
  return html`
    ${points.length ? html`<dl className="onboarding-points">${points}</dl>` : null}
    ${card.command ? html`<pre className="onboarding-command"><code>${card.command}</code></pre>` : null}
  `;
}

function Point({ point }) {
  return html`
    <div>
      <dt>${point.title}</dt>
      <dd>${point.text}</dd>
    </div>
  `;
}

/** The card's buttons: a link opens its page in a new tab; an action is one press. */
function Buttons({ card, busy, onPress }) {
  const shared = { step: card.step, busy, onPress };
  const buttons = card.buttons.map(
    (button) => html`<${StepButton} key=${button.label} button=${button} ...${shared} />`,
  );
  const footnote = card.footnote;
  return html`
    <${CardFooter} className="onboarding-buttons">
      ${buttons} ${footnote ? html`<span className="onboarding-footnote">${footnote}</span>` : null}
    <//>
  `;
}

function StepButton({ step, button, busy, onPress }) {
  const variant = button.primary ? "default" : "outline";
  if (button.href)
    return html`
      <a
        className=${buttonVariants({ variant })}
        href=${button.href}
        target="_blank"
        rel="noopener"
      >
        ${button.label}
      </a>
    `;
  return html`
    <${Button}
      variant=${variant}
      disabled=${Boolean(busy)}
      data-action=${button.action}
      onClick=${() => onPress(step, button)}
    >
      ${busy === `${step}/${button.action}` ? "…" : button.label}
    <//>
  `;
}

// ── the chat with the onboarding agent ──

function Chat() {
  const agent = useContextStub(() => itx.cd(AGENT), []);
  const context = useIterateContext(agent.stub, AgentChat.contextOptions);
  // THE MIND SPEAKS FIRST: once the whole log is read and nothing was said in it, the opener
  // starts the agent's first turn. The key makes it one event, whatever reloads or tabs.
  const { stub } = agent;
  const empty = context.caughtUp && !context.events.some(said);
  useEffect(() => {
    if (!stub || !empty) return;
    stub
      .append({
        type: "events.iterate.com/agent/context-added",
        idempotencyKey: `opener:${AGENT}`,
        payload: { role: "developer", content: OPENER },
      })
      .catch(() => {}); // another tab or the Dash said it first
  }, [stub, empty]);
  const [state, setState] = useState({});
  return html`
    <${AgentChat}
      path=${AGENT}
      me=${principal?.actor}
      context=${context}
      error=${agent.error}
      state=${state}
      onStateChange=${(patch) => setState((previous) => ({ ...previous, ...patch }))}
      onMessage=${(input) => itx.agents.get(AGENT).message(input)}
      onAppend=${agent.stub ? (events) => agent.stub.append(...events) : undefined}
      signedUrl=${async (file) => (await itx.files.get(file).url()).url}
      placeholder="Message your onboarding agent"
    />
  `;
}

/** The sidebar's two rows: this page, and the Dash. */
function Nav() {
  return html`
    <${SidebarGroup}>
      <${SidebarGroupContent}>
        <${SidebarMenu}>
          <${SidebarMenuItem}>
            <${SidebarMenuButton} isActive tooltip="Onboarding" render=${html`<a href="./" />`}>
              <${SparklesIcon} />
              <span>Onboarding</span>
            <//>
          <//>
          <${SidebarMenuItem}>
            <${SidebarMenuButton}
              tooltip="Dash"
              render=${html`<a href=${`https://dash.${zone}/?agent=${AGENT}`} />`}
            >
              <${LayoutDashboardIcon} />
              <span>Dash</span>
            <//>
          <//>
        <//>
      <//>
    <//>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
