// home.js — the mind's home page in this app: a box whose first message starts a new agent, and
// the agents that were active most recently, each opening its chat.
import { html, useMemo, useRef, useState } from "@iterate-com/ui/page";
import { Button } from "@iterate-com/ui/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@iterate-com/ui/components/ui/card";
import { Textarea } from "@iterate-com/ui/components/ui/textarea";
import { BotIcon } from "lucide-react";
import { agentTitle, byRecentActivity, newWebAgentPath, topLevelAgents } from "./agent-rows.js";
import { agentHref, pageLink } from "./nav.js";

export function AgentsHome({ agents, onOpen, onCreate, onMessage }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState();
  // The agent born for a first message that then failed to send: sending again goes to it, so a
  // retry leaves no empty agent behind.
  const born = useRef(undefined);
  const recent = useMemo(() => byRecentActivity(topLevelAgents(agents)).slice(0, 8), [agents]);
  const send = async (event) => {
    event.preventDefault();
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setError(undefined);
    try {
      // An agent is its path; a new one is born at this moment's path.
      let path = born.current;
      if (!path) {
        path = newWebAgentPath(new Date());
        await onCreate(path);
        born.current = path;
      }
      await onMessage(path, text);
      born.current = undefined;
      onOpen(path);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  };
  return html`
    <div class="agents-home">
      <form class="flex flex-col gap-2" onSubmit=${send}>
        <${Textarea}
          name="message"
          aria-label="Message a new agent"
          placeholder="Message a new agent"
          rows="3"
          autoFocus
          value=${message}
          onChange=${(event) => setMessage(event.target.value)}
          onKeyDown=${(event) => {
            if (event.key === "Enter" && !event.shiftKey) send(event);
          }}
        />
        <div class="flex items-center justify-end gap-2">
          ${error && html`<span class="text-sm text-destructive">${error}</span>`}
          <${Button} type="submit" size="sm" disabled=${sending || !message.trim()}>
            ${sending ? "Starting…" : "Start agent"}
          <//>
        </div>
      </form>
      ${
        recent.length > 0 &&
        html`
          <section class="flex flex-col gap-2" aria-labelledby="recent-agents">
            <h2 id="recent-agents" class="text-sm font-medium text-muted-foreground">
              Recently active
            </h2>
            <ul class="agents-home-recent">
              ${recent.map(
                (row) => html`
                  <li key=${row.path} data-agent-path=${row.path}>
                    <${Card}
                      size="sm"
                      render=${pageLink(agentHref(row.path), () => onOpen(row.path))}
                    >
                      <${CardHeader}>
                        <${CardTitle} className="flex items-center gap-2">
                          <${BotIcon}
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span class="truncate">${agentTitle(row)}</span>
                        <//>
                        <${CardDescription} className="truncate font-mono text-2xs">${row.path}<//>
                      <//>
                    <//>
                  </li>
                `,
              )}
            </ul>
          </section>
        `
      }
    </div>
  `;
}
