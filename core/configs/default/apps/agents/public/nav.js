// nav.js — the sidebar's body (the frame around it is @iterate-com/ui's AppShell): "New agent",
// then the project's agents at the top, most recently active first. Each shows its title with its
// path beneath, an icon for what runs it and a dot for what it is doing. Pinned agents sit in a
// list of their own, the pins kept per project in this browser.
import { html, useCallback, useMemo, useState } from "@iterate-com/ui/page";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/ui/sidebar";
import { BotIcon, BoxIcon, PinIcon, SquarePenIcon, SquareTerminalIcon } from "lucide-react";
import { agentTitle, byRecentActivity, topLevelAgents } from "./agent-rows.js";

/** A link that changes this page's URL: a plain left click stays on the page, and any other click
 *  is the browser's (a new tab). */
export function pageLink(href, go) {
  const onClick = (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    go();
  };
  return html`<a href=${href} onClick=${onClick} />`;
}

export const agentHref = (path) => `?agent=${encodeURIComponent(path)}`;

export function AgentsNav({ project, agents, agent, onOpen }) {
  const { pinned, togglePinned } = usePinnedAgents(project);
  const ordered = useMemo(() => byRecentActivity(topLevelAgents(agents)), [agents]);
  const row = (item) => html`
    <${AgentsNavRow}
      key=${item.path}
      row=${item}
      active=${item.path === agent}
      pinned=${pinned.has(item.path)}
      onOpen=${onOpen}
      onTogglePinned=${() => togglePinned(item.path)}
    />
  `;
  const pins = ordered.filter((item) => pinned.has(item.path));
  return html`
    <${SidebarGroup}>
      <${SidebarGroupContent}>
        <${SidebarMenu}>
          <${SidebarMenuItem}>
            <${SidebarMenuButton}
              isActive=${!agent}
              tooltip="New agent"
              render=${pageLink("./", () => onOpen(undefined))}
            >
              <${SquarePenIcon} />
              <span>New agent</span>
            <//>
          <//>
        <//>
      <//>
    <//>
    ${
      pins.length > 0 &&
      html`
        <${SidebarGroup}>
          <${SidebarGroupLabel}>Pinned<//>
          <${SidebarGroupContent}><${SidebarMenu}>${pins.map(row)}<//><//>
        <//>
      `
    }
    <${SidebarGroup}>
      <${SidebarGroupLabel}>Agents<//>
      <${SidebarGroupContent}>
        <${SidebarMenu}>
          ${
            agents.length === 0 &&
            html`<p class="px-2 py-1 text-xs text-muted-foreground">No agents yet.</p>`
          }
          ${ordered.filter((item) => !pinned.has(item.path)).map(row)}
        <//>
      <//>
    <//>
  `;
}

function AgentsNavRow({ row, active, pinned, onOpen, onTogglePinned }) {
  const KindIcon = kindIcon(row.kind);
  return html`
    <${SidebarMenuItem} data-agent-path=${row.path}>
      <${SidebarMenuButton}
        size="lg"
        isActive=${active}
        tooltip=${row.activity ? `${row.path}: ${row.activity}` : row.path}
        render=${pageLink(agentHref(row.path), () => onOpen(row.path))}
      >
        <span class="relative">
          <${KindIcon} data-agent-kind=${row.kind || undefined} />
          ${
            row.status &&
            html`<span class="agent-status" data-agent-status=${row.status} title=${row.status} />`
          }
        </span>
        <span class="flex min-w-0 flex-col">
          <span class="truncate text-sm">${agentTitle(row)}</span>
          <span class="truncate font-mono text-2xs text-muted-foreground">${row.path}</span>
        </span>
      <//>
      <button
        type="button"
        class="agent-pin"
        aria-label=${pinned ? "Unpin agent" : "Pin agent"}
        aria-pressed=${pinned}
        onClick=${onTogglePinned}
      >
        <${PinIcon} className=${pinned ? "fill-current" : ""} />
      </button>
    <//>
  `;
}

/** What runs the agent: iterate's own, a coding session, or something else. */
function kindIcon(kind) {
  if (!kind || kind === "iterate") return BotIcon;
  if (kind === "claude" || kind === "codex" || kind === "opencode") return SquareTerminalIcon;
  return BoxIcon;
}

/** The agents this person pinned, per project, in this browser's localStorage: a viewer's
 *  convenience, never the project's data. Storage that throws leaves pins in memory only. */
function usePinnedAgents(project) {
  const key = `iterate-agents:pinned:${project}`;
  const [pinned, setPinned] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) || "[]");
      return new Set(
        Array.isArray(stored) ? stored.filter((path) => typeof path === "string") : [],
      );
    } catch {
      return new Set();
    }
  });
  const togglePinned = useCallback(
    (path) =>
      setPinned((previous) => {
        const next = new Set(previous);
        if (!next.delete(path)) next.add(path);
        try {
          localStorage.setItem(key, JSON.stringify([...next]));
        } catch {
          // storage refused: the pin holds for this page's life
        }
        return next;
      }),
    [key],
  );
  return { pinned, togglePinned };
}
