// home.js — the mind's home page in this app: a box whose first message starts a new agent, and
// the agents that were active most recently, each opening its chat. A new agent is iterate's
// unless the picker above the box names another kind's choice ("codex (acp)", from each kind
// file's `newAgent`): then that kind starts it, with the picked choice's fields, and the message
// goes to it after.
import { html, useMemo, useRef, useState } from "@iterate-com/ui/page";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@iterate-com/ui/components/ui/card";
import { Input } from "@iterate-com/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/ui/native-select";
import { Textarea } from "@iterate-com/ui/components/ui/textarea";
import { BotIcon } from "@iterate-com/ui/icons";
import {
  agentTitle,
  byRecentActivity,
  mineFirst,
  newAgentPath,
  topLevelAgents,
} from "./agent-rows.js";
import { agentHref, pageLink } from "./nav.js";

/** `offers`: other kinds' choices, `{ value: "<kind>/<choice>", label, kind, choice, fields,
 *  byPerson }`.
 *  `choice`: the picked offer's value, or `iterate`. `typed(name)`: a field's value as typed, if
 *  it was; `onField(name, value)` types it. `describe(offer, fields)`: the kind's line about them.
 *  `onStart(offer, path, fields)` starts the picked kind's agent; `onStarted(path, kind)` opens it.
 *  `person`: the folder of the person signed in (agent-rows.js `personOf`): a new agent is born
 *  in it, and their agents come first. */
export function AgentsHome({
  agents,
  person,
  offers = [],
  ready,
  choice,
  typed,
  onChoice,
  onField,
  describe,
  onStart,
  onStarted,
  onOpen,
  onCreate,
  onMessage,
}) {
  const picked = offers.find((offer) => offer.value === choice);
  const fields = Object.fromEntries(
    (picked?.fields || []).map((field) => [field.name, typed(field.name) ?? field.defaultValue]),
  );
  const [message, setMessage] = useState("");
  // The agent born for a first message that then failed to send, and the choice it was born
  // of: sending again with the same choice goes to it, so a retry leaves no empty agent behind.
  const born = useRef(undefined);
  const recent = useMemo(
    () => mineFirst(byRecentActivity(topLevelAgents(agents)), person).slice(0, 8),
    [agents, person],
  );
  // A remembered kind's choice before the kinds have reported their offers: Start waits for them,
  // rather than start iterate's agent in its place.
  const waiting = !picked && choice !== "iterate" && !ready;
  const sending = useMutation({
    mutationFn: async (text) => {
      // An agent is its path; a new one is born at this moment's path, by its kind's own start
      // (`picked`) or as iterate's.
      let path = born.current?.choice === choice ? born.current.path : undefined;
      if (!path) {
        // iterate's own agent, and a kind's choice that says so, are born in the person's folder
        path = picked
          ? newAgentPath(picked.kind, new Date(), picked.byPerson ? person : undefined)
          : newAgentPath("web", new Date(), person);
        if (picked) await onStart(picked, path, fields);
        else await onCreate(path);
        born.current = { path, choice };
      }
      await onMessage(path, text);
      born.current = undefined;
      if (picked) onStarted(path, picked.kind);
      else onOpen(path);
    },
  });
  const send = (event) => {
    event.preventDefault();
    const text = message.trim();
    if (text && !sending.isPending && !waiting) sending.mutate(text);
  };
  const error = sending.error && (sending.error.message || String(sending.error));
  return html`
    <div class="agents-home">
      <form class="flex flex-col gap-2" onSubmit=${send}>
        ${
          offers.length > 0 &&
          html`<${KindPicker} ...${{ offers, picked, fields, onChoice, onField, describe }} />`
        }
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
          <${Button}
            type="submit"
            size="sm"
            disabled=${sending.isPending || waiting || !message.trim()}
          >
            ${sending.isPending ? "Starting…" : waiting ? "Loading…" : "Start agent"}
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
                        <${CardDescription} className="truncate text-2xs">${row.path}<//>
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

/** The picker above the box: iterate, or another kind's choice, the picked choice's fields, and
 *  under them the kind's own line about the choice as typed (`newAgent.describe`). */
function KindPicker({ offers, picked, fields, onChoice, onField, describe }) {
  const line = useQuery({
    queryKey: ["new-agent-line", picked?.value, fields],
    queryFn: () => describe(picked, fields),
    enabled: Boolean(picked),
    placeholderData: keepPreviousData,
  });
  const input = (field) => html`
    <${Input}
      key=${`${picked.value}/${field.name}`}
      name=${field.name}
      aria-label=${field.label}
      placeholder=${field.label}
      value=${fields[field.name]}
      onInput=${(change) => onField(field.name, change.target.value)}
      className="h-7 w-40 font-mono text-xs"
    />
  `;
  return html`
    <div class="flex flex-wrap items-center gap-2">
      <${NativeSelect}
        size="sm"
        aria-label="Kind of agent"
        value=${picked?.value || ""}
        onChange=${(change) => onChoice(change.target.value || undefined)}
      >
        <${NativeSelectOption} value="">iterate<//>
        ${offers.map(
          (offer) =>
            html`<${NativeSelectOption} key=${offer.value} value=${offer.value}>${offer.label}<//>`,
        )}
      <//>
      ${picked?.fields.map(input)}
    </div>
    ${picked && line.data && html`<p class="text-xs text-muted-foreground">${withCode(line.data)}</p>`}
  `;
}

/** Text with `backticks` around code: the code in <code>, which a person can select and copy. */
function withCode(text) {
  return text
    .split("`")
    .map((part, index) =>
      index % 2
        ? html`<code class="select-all rounded bg-muted px-1 font-mono">${part}</code>`
        : part,
    );
}
