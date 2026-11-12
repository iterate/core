// home.js — the mind's home page in this app: a box whose first message starts a new agent, and
// the agents that were active most recently, each opening its chat. A new agent is iterate's
// unless the picker above the box names another kind's choice ("codex (acp)", from each kind
// file's `newAgent`): then that kind starts it, with the picked choice's fields, and the message
// goes to it after. The picker and the rules that read a kind's file are the UI kit's
// (`new-agent-picker`, `lib/new-agent`), the ones iterate's hosted Agents app has.
import { html, useMemo, useRef, useState } from "@iterate-com/ui/page";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/ui/button";
import { NewAgentPicker } from "@iterate-com/ui/components/new-agent-picker";
import { Card, CardDescription, CardHeader, CardTitle } from "@iterate-com/ui/components/ui/card";
import { Textarea } from "@iterate-com/ui/components/ui/textarea";
import { BotIcon } from "@iterate-com/ui/icons";
import { newAgentValues } from "@iterate-com/ui/lib/new-agent";
import {
  agentTitle,
  byRecentActivity,
  mineFirst,
  newAgentPath,
  topLevelAgents,
} from "./agent-rows.js";
import { agentHref, linkClick } from "./nav.js";

/** `offers`: other kinds' choices, `{ value: "<kind>/<choice>", label, kind, choice, fields,
 *  byPerson }`.
 *  `choice`: the picked offer's value, or `iterate`. `typed(name)`: a field's value as typed, if
 *  it was; `onField(name, value)` types it. A field is a line of text, or a tick box
 *  (`type: "checkbox"`), whose value is "on" when ticked and "" when not. `describe(offer, fields)`: the kind's line about them.
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
  // the picked choice's fields: as typed, else as the kind's file starts them, for this person
  const fields = newAgentValues(picked, typed, person);
  // the kind's line about them (`newAgent.describe`); the line of the fields as they were stays
  // until the kind has said the new one
  const line = useQuery({
    queryKey: ["new-agent-line", picked?.value, fields],
    queryFn: () => describe(picked, fields),
    enabled: Boolean(picked),
    placeholderData: keepPreviousData,
  });
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
          html`
            <${NewAgentPicker}
              offers=${offers}
              picked=${picked}
              values=${fields}
              onChoice=${onChoice}
              onField=${onField}
              line=${line.data}
            />
          `
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
                // the link holds the card: the kit's Card is a plain div, and takes no link
                (row) => html`
                  <li key=${row.path} data-agent-path=${row.path}>
                    <a
                      href=${agentHref(row.path)}
                      onClick=${linkClick(() => onOpen(row.path))}
                      class="block rounded-xl outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <${Card} size="sm" className="transition-colors hover:bg-accent/40">
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
                    </a>
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
