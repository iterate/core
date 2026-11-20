// agent-share.js — SHARE, the Dash's own button in an agent's header: links that let people who
// are not members into this one agent's chat and call, as guests. app.js draws <AgentShare>
// beside the kit's Agents page.
//
// IT GIVES WAY TO THE KIT'S SHARE: a kit build that knows the Agents row's `share` (app.js) draws
// Share itself, in a place `[data-slot=agent-header-share]`, and this file then draws nothing. Take
// this file out once index.html pins such a build.
//
// WHERE IT GOES. The pinned kit has no place for a page's own buttons in the agent's header. Its header
// has, with `presence` on (app.js), a span `[data-slot=agent-header-aside]` before Chat | Events.
// `useHeaderSlot` puts ONE span of ours before it, and the button is a portal into that span. The
// kit draws the header anew (from "reading" to the chat, for another agent), so a
// MutationObserver puts the span in the new header in the same task, before the browser paints.
// The span has its width from the moment it is made, so nothing in the header moves.
//
// THE LINKS are the call's (../../../call/share.ts): the first open turns the call on for the agent
// (as "Start a call" does: its facet holds the links and admits a guest), then the pane appends
// `share/link-made` and `share/link-ended` through the member's own stub, and lists the live links
// from the call's live state. A guest comes in on Meet's guest page,
// `https://meet.<zone>/join<agent>#<secret>` (../../meet/app.ts), with a name and no account.
import { html, useEffect, useLayoutEffect, useState } from "@iterate-com/ui/page";
import { createPortal } from "@iterate-com/ui/react-dom";
import { Button } from "@iterate-com/ui/components/ui/button";
import { CopyText } from "@iterate-com/ui/components/copy-text";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@iterate-com/ui/components/ui/popover";
import { useContextStub, useIterateContext } from "@iterate-com/ui/live";
import { CALL_FACET } from "./call-facet.js";
import {
  agentPathOf,
  DEFAULT_LIFETIME,
  endLink,
  GUEST_GETS,
  LIFETIMES,
  makeLink,
} from "./share-links.js";

/** The header's button: the kit's `size-7`, in pixels. */
const BUTTON = 28;

/** lucide's "share-2", inline: the kit's icons have no share icon, and all of lucide is large. */
const ShareIcon = () => html`
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
    <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
  </svg>
`;

/** OUR SPAN IN THE KIT'S AGENT HEADER, or null while there is no header. */
function useHeaderSlot(width) {
  const [slot, setSlot] = useState(null);
  useLayoutEffect(() => {
    let mine = null;
    const place = () => {
      // a kit that draws Share itself (the Agents row's `share`, app.js) has its own place: none here
      const kitShares = document.querySelector("[data-page-header] [data-slot=agent-header-share]");
      const aside =
        !kitShares && document.querySelector("[data-page-header] [data-slot=agent-header-aside]");
      if (mine?.isConnected && mine.nextElementSibling === aside) return;
      mine?.remove();
      mine = null;
      if (aside?.parentElement) {
        mine = document.createElement("span");
        mine.dataset.slot = "dash-agent-share";
        mine.className = "flex shrink-0 items-center justify-end gap-1";
        mine.style.width = `${width}px`;
        aside.parentElement.insertBefore(mine, aside);
      }
      setSlot(mine);
    };
    place();
    const watch = new MutationObserver(place);
    watch.observe(document.body, { childList: true, subtree: true });
    return () => {
      watch.disconnect();
      mine?.remove();
    };
  }, [width]);
  return slot;
}

/** THE SHARE BUTTON, drawn into the header of the agent at `path` (none for a path that is no
 *  agent's). `zone` is the zone of this page, where Meet is. */
export function AgentShare({ itx, path, zone }) {
  const agent = agentPathOf(path);
  const slot = useHeaderSlot(agent ? BUTTON : 0);
  if (!slot || !agent) return null;
  return createPortal(html`<${Share} key=${agent} itx=${itx} path=${agent} zone=${zone} />`, slot);
}

/** The button and its pane. The pane (and its read of the agent) is there only while it is open;
 *  the first open turns the agent's call on. */
function Share({ itx, path, zone }) {
  const [open, setOpen] = useState(false);
  // undefined: not asked yet; true: the call is on; a string: why it could not be turned on
  const [on, setOn] = useState(undefined);
  useEffect(() => {
    if (!open || on === true) return undefined;
    let live = true;
    itx
      .cd(path)
      .processors.enable("call", CALL_FACET)
      .then(
        () => live && setOn(true),
        (error) => live && setOn(`Links could not be turned on: ${error?.message ?? error}`),
      );
    return () => {
      live = false;
    };
  }, [open, on, itx, path]);
  return html`
    <${Popover} open=${open} onOpenChange=${setOpen}>
      <${PopoverTrigger} render=${html`<${Button} ...${SHARE_BUTTON} />`}>
        <${ShareIcon} />
      <//>
      <${PopoverContent}
        align="end"
        className="w-96 max-w-[calc(100vw-16px)]"
        data-slot="share-pane"
      >
        <div className="flex flex-col gap-3 text-sm">
          ${
            on === true
              ? html`<${SharePane} itx=${itx} path=${path} zone=${zone} />`
              : typeof on === "string"
                ? html`<p className="text-destructive" role="alert">${on}</p>`
                : html`<p className="text-muted-foreground">Turning links on…</p>`
          }
        </div>
      <//>
    <//>
  `;
}

const SHARE_BUTTON = {
  variant: "ghost",
  size: "icon-sm",
  title: "Share this agent",
  "aria-label": "Share this agent",
};

/** One choice of how long a link lives. */
const lifetimeOption = ({ ms, label }) =>
  html`<${NativeSelectOption} key=${ms} value=${ms}>${label}<//>`;

/** A date and a time, for the list. */
const when = (at) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
/** What the pane reads of the agent: its rows (whether it takes a guest's message) and the call's
 *  live state (its live links). */
const SHARE_READ = {
  consumes: ["share/link-made", "share/link-ended", "share/guest-joined"],
  liveState: ["call"],
};
/** In place of "Make a link", for a context that hosts no `agent` facet: a guest's message goes to
 *  that facet, so a link there would open a chat whose every message fails. */
const NO_GUEST_MESSAGES = "This agent takes no messages from a guest.";

/** What a guest gets, "Make a link" (and the new link, once), then the live links. */
function SharePane({ itx, path, zone }) {
  const agent = useContextStub(() => itx.cd(path), [itx, path]);
  const context = useIterateContext(agent.stub, SHARE_READ);
  const call = context.liveState.call;
  const takesGuests =
    !context.processors.loaded ||
    context.processors.rows.some((row) => row.hostedFacet?.name === "agent");
  const append = agent.stub ? (event) => agent.stub.append(event) : undefined;
  const [lifetime, setLifetime] = useState(DEFAULT_LIFETIME);
  const [made, setMade] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (work) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    } finally {
      setBusy(false);
    }
  };
  const make = () =>
    act(async () => {
      const { event, url } = await makeLink({
        zone,
        agent: path,
        lifetimeMs: lifetime,
        now: Date.now(),
      });
      await append(event);
      setMade(url);
    });
  if (!takesGuests) return html`<p className="text-muted-foreground">${NO_GUEST_MESSAGES}</p>`;
  return html`
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        ${GUEST_GETS.map((line) => html`<p key=${line}>${line}</p>`)}
      </div>
      <div className="flex items-center gap-2">
        <${NativeSelect}
          size="sm"
          aria-label="How long the link lives"
          value=${lifetime}
          onChange=${(event) => setLifetime(Number(event.target.value))}
        >
          ${LIFETIMES.map(lifetimeOption)}
        <//>
        <${Button} size="sm" disabled=${busy || !append} onClick=${make}>Make a link<//>
      </div>
      ${
        made &&
        html`
          <div className="flex flex-col gap-1" data-slot="share-made">
            <${CopyText} text=${made} label="the link" />
            <p className="text-xs text-muted-foreground">
              This link is shown once: its secret is not kept. Make another when you need one.
            </p>
          </div>
        `
      }
      ${error && html`<p className="text-destructive" role="alert">${error}</p>`}
      <${Links}
        call=${call}
        end=${(link) => act(() => append(endLink(link)))}
        busy=${busy || !append}
      />
    </div>
  `;
}

/** Who came by a link, in words. */
const guestsOf = ({ guests }) =>
  guests.length
    ? `${guests.length} ${guests.length === 1 ? "guest" : "guests"}: ${guests.join(", ")}`
    : "No guest yet";

/** The live links of the call's live state, newest last. No secret is here: the page never keeps
 *  one. */
function Links({ call, end, busy }) {
  if (call?.status === "error")
    return html`<p className="text-destructive">The links could not be read: ${call.error}</p>`;
  if (!call?.value) return html`<p className="text-muted-foreground">Reading the links…</p>`;
  const links = call.value.links ?? [];
  if (!links.length) return html`<p className="text-muted-foreground">No live link.</p>`;
  return html`
    <ul className="flex max-h-64 flex-col gap-2 overflow-auto" data-slot="share-links">
      ${links.map(
        (link) => html`
          <li key=${link.link} className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate">Made by ${link.madeBy}, until ${when(link.until)}</div>
              <div className="truncate text-xs text-muted-foreground">${guestsOf(link)}</div>
            </div>
            <${Button} size="xs" variant="outline" disabled=${busy} onClick=${() => end(link.link)}>
              End
            <//>
          </li>
        `,
      )}
    </ul>
  `;
}
