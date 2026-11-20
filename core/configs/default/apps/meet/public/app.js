// app.js — MEET'S PAGE (../app.ts): start a meeting, and any agent's chat with its call.
//
//   /                    a member: "Start new meeting", and the recent meetings
//   /contexts/<agent>    a member: the agent's chat and call, its links for guests, and a
//                        calendar invite
//   /join/<agent>#…      a guest's link: the page keeps the secret in this tab and asks whether
//                        the link is live; then /in/<agent>, after the platform's sign-in (a
//                        guest types a name): the join, and the same chat and call on the guest's
//                        view
//
// The page has no API of its own. A member's page holds the member's `/itx` socket: a meeting
// starts by `itx.config.startMeeting` (../meeting.ts), the one function an agent calls too. A
// guest's page holds the platform's view of the one agent's context. The call is the kit's
// (`useCall`, `CallBar`, `CallTiles`); nothing polls. Join opens the kit's lobby (`CallLobby`)
// first: the person checks their camera and their sound, then joins with what they turned on.
import { html, render, useCallback, useEffect, useState } from "@iterate-com/ui/page";
import { AgentChat } from "@iterate-com/ui/components/agent-chat/agent-chat";
import { CallBar } from "@iterate-com/ui/components/call/call-bar";
import { CallLobby } from "@iterate-com/ui/components/call/call-lobby";
import { CallPipButton, CallPipPlace, useCallPip } from "@iterate-com/ui/components/call/call-pip";
import { CallTiles } from "@iterate-com/ui/components/call/call-tiles";
import { Button, buttonVariants } from "@iterate-com/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@iterate-com/ui/components/ui/dialog";
import { Input } from "@iterate-com/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/ui/native-select";
import { useCall } from "@iterate-com/ui/lib/call-engine";
import {
  memberItx,
  newWebSocketRpcSession,
  useContextStub,
  useIterateContext,
} from "@iterate-com/ui/live";
import { googleCalendarUrl, icsOf, localInput, nextQuarter } from "./invite.js";

const [, ROUTE = "", ...REST] = location.pathname.split("/");
const AGENT = `/${REST.join("/")}`;
const GUEST_PAGE = ROUTE === "join" || ROUTE === "in";
const ENDED = "This link has ended. Ask for a new one.";
const messageOf = (error) => String(error?.message ?? error);
const nameOf = (path) => path.split("/").pop();
const when = (at) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

// ── a member's front page ──
function Front({ itx }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    itx.agents.list().then(
      (agents) =>
        setList(
          agents
            .filter((agent) => agent.path.startsWith("/agents/meet/"))
            .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 50),
        ),
      (failure) => setError(messageOf(failure)),
    );
  }, [itx]);
  const start = async (event) => {
    event.preventDefault();
    const title = String(new FormData(event.currentTarget).get("title") || "");
    setStarting(true);
    try {
      const { path } = await itx.config.startMeeting({ title });
      location.assign(`/contexts${path}`);
    } catch (failure) {
      setError(messageOf(failure));
      setStarting(false);
    }
  };
  return html`
    <main className="meet-narrow">
      <h1 className="meet-title">Meet</h1>
      <form className="meet-row" onSubmit=${start}>
        <${Input}
          name="title"
          placeholder="Title (optional)"
          maxLength=${80}
          className="meet-grow"
        />
        <${Button} type="submit" disabled=${starting}>
          ${starting ? "Starting…" : "Start new meeting"}
        <//>
      </form>
      ${error && html`<p role="alert" className="meet-error">${error}</p>`}
      ${list?.length > 0 && html`<h2 className="meet-subtitle">Recent meetings</h2>`}
      ${list?.map(
        (agent) => html`
          <a key=${agent.path} className="meet-call-row" href=${`/contexts${agent.path}`}>
            <span>${agent.title || nameOf(agent.path)}</span>
            <span className="meet-note">${when(agent.createdAt)}</span>
          </a>
        `,
      )}
    </main>
  `;
}

// ── one meeting: the agent's chat with its call ──
/** The chat and the call on `stub`, the agent's context: a member's `itx.cd(agent)`, or a guest's
 *  view's. `session` is what the page holds (the member's itx, or the guest's view), which sends
 *  the agent words. `start` turns the call on (a member's alone); `aside(live)` draws a member's
 *  panes beside the chat, with the call's live state. */
function Meeting({ stub, session, me, title, member, start, aside }) {
  const [state, setState] = useState({});
  const patch = useCallback((change) => setState((previous) => ({ ...previous, ...change })), []);
  const context = useIterateContext(stub.stub, AgentChat.contextOptions);
  const { call, ui, live } = useCall(
    stub.stub,
    context.subscription,
    context.liveState.call?.value,
  );
  const pip = useCallPip(ui);
  const signedUrl = useCallback(
    async (file) => (await stub.stub.files.get(file).url()).url,
    [stub.stub],
  );
  // the lobby before a join, while it is open: a press of the person's opened it, so its
  // microphone is on (the kit's CallLobby says why)
  const [lobby, setLobby] = useState(false);
  const fromLobby = (media) => {
    setLobby(false);
    void call?.join({ ...media, listenOnly: !media.mic });
  };
  // "Start a call" only while the agent has no call (no live state): then the bar's Join, which
  // opens the lobby
  const bar = {
    call,
    ui,
    live,
    member,
    start: live ? undefined : start,
    join: () => setLobby(true),
  };
  return html`
    <div className="meet">
      <header className="meet-head">
        <div>
          <h1 className="meet-title">${title}</h1>
          ${
            member
              ? html`<a className="meet-note" href="/">All meetings</a>`
              : html`<span className="meet-note">You are a guest here.</span>`
          }
        </div>
        <div className="meet-row">
          <${CallBar} ...${bar} />
          ${live && html`<${CallPipButton} pip=${pip} />`}
        </div>
      </header>
      <${Dialog} open=${lobby} onOpenChange=${setLobby}>
        <${DialogContent} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <${DialogHeader}>
            <${DialogTitle}>Join the call<//>
            <${DialogDescription}>
              Check your camera and your sound first. Nothing is sent until you join.
            <//>
          <//>
          ${lobby && html`<${CallLobby} live=${live} action="join" micAtStart onJoin=${fromLobby} />`}
        <//>
      <//>
      <${CallPipPlace} pip=${pip}>
        <${CallTiles} call=${call} ui=${ui} live=${live} member=${member} />
      <//>
      <div className="meet-columns">
        <div className="meet-chat-pane">
          <${AgentChat}
            path=${AGENT}
            context=${context}
            error=${stub.error}
            state=${state}
            onStateChange=${patch}
            onMessage=${({ message, files, key }) =>
              session.agents.get(AGENT).message({ message, files }, { key })}
            onAppend=${stub.stub ? (events) => stub.stub.append(...events) : undefined}
            signedUrl=${signedUrl}
            me=${me}
            presence=${true}
            placeholder="Message this meeting's agent"
          />
        </div>
        ${aside?.(live)}
      </div>
    </div>
  `;
}

/** A member's meeting, on the member's own session. */
function MemberMeeting({ itx }) {
  const stub = useContextStub(() => itx.cd(AGENT), [itx]);
  const [me, setMe] = useState();
  const [title, setTitle] = useState(nameOf(AGENT));
  // the guest link made in this tab, while its secret is still known: { url, until, link }
  const [shared, setShared] = useState(null);
  useEffect(() => {
    itx.whoami().then(({ principal }) => setMe(principal?.email || principal?.actor));
    itx.agents.list().then((agents) => {
      const row = agents.find((agent) => agent.path === AGENT);
      if (row?.title) setTitle(row.title);
    });
  }, [itx]);
  useEffect(() => {
    document.title = `${title} · Meet`;
  }, [title]);
  const start = useCallback(() => itx.config.startMeeting({ path: AGENT }), [itx]);
  const aside = (live) => html`
    <aside className="meet-aside">
      <${Invite} title=${title} shared=${shared} links=${live?.links} />
      ${
        // a link admits by the call's state: with no call, the link would read as ended
        stub.stub &&
        live &&
        html`<${Guests} stub=${stub.stub} links=${live.links} onMade=${setShared} />`
      }
    </aside>
  `;
  const props = { stub, session: itx, me, title, member: true, start, aside };
  return html`<${Meeting} ...${props} />`;
}

/** "Add to calendar": a start and a length, then Google Calendar's form or an .ics file. The
 *  invite holds the meeting's page, or the guest link made in this tab when the member includes
 *  it. */
function Invite({ title, shared, links }) {
  const [start, setStart] = useState(() => localInput(nextQuarter(new Date())));
  const [minutes, setMinutes] = useState("30");
  const [withGuests, setWithGuests] = useState(false);
  const [uid] = useState(() => `${crypto.randomUUID()}@${location.hostname}`);
  // the link counts while the call's live state lists it: an ended link is in no invite
  const listed = links?.some((link) => link.link === shared?.link);
  const live = shared && listed && shared.until > Date.now() ? shared : null;
  const at = new Date(start);
  const invite = {
    title,
    start: Number.isNaN(at.getTime()) ? nextQuarter(new Date()) : at,
    minutes: Number(minutes),
    link: live && withGuests ? live.url : `${location.origin}/contexts${AGENT}`,
    uid,
    stamp: new Date(),
  };
  const checkbox = html`
    <input
      type="checkbox"
      checked=${withGuests}
      onChange=${(event) => setWithGuests(event.target.checked)}
    />
  `;
  const choice = live
    ? html`<label className="meet-row meet-note">${checkbox} Include the guest link</label>`
    : html`<p className="meet-note">The invite links to this page: members only.</p>`;
  // the one sentence beside the choice, when the invite holds the guest link
  const guestsNote =
    live &&
    withGuests &&
    html`<p className="meet-note">Anyone with this invite can join until ${when(live.until)}.</p>`;
  const download = () => {
    const file = new Blob([icsOf(invite)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(file);
    // an anchor in the document, which some browsers need for a download, and the file's URL
    // kept a while: the download may begin after this turn
    const anchor = Object.assign(document.createElement("a"), {
      href: url,
      download: `${nameOf(AGENT)}.ics`,
    });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  return html`
    <section className="meet-band">
      <h2 className="meet-subtitle">Add to calendar</h2>
      <div className="meet-row">
        <${Input}
          type="datetime-local"
          aria-label="Starts at"
          value=${start}
          onChange=${(event) => setStart(event.target.value)}
          className="meet-grow"
        />
        <${NativeSelect}
          aria-label="How long"
          value=${minutes}
          onChange=${(event) => setMinutes(event.target.value)}
        >
          ${[15, 30, 45, 60, 90].map(
            (n) => html`<${NativeSelectOption} key=${n} value=${String(n)}>${n} minutes<//>`,
          )}
        <//>
      </div>
      ${choice} ${guestsNote}
      <div className="meet-row">
        <a
          className=${buttonVariants({ variant: "outline", size: "sm" })}
          href=${googleCalendarUrl(invite)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Google Calendar
        </a>
        <${Button} variant="outline" size="sm" onClick=${download}>Download .ics<//>
      </div>
    </section>
  `;
}

/** A member's links for guests: make one (its secret is shown once, then only its hash is kept),
 *  and end one. A link opens this agent's chat and call to anyone who has it. */
function Guests({ stub, links, onMade }) {
  const [hours, setHours] = useState("24");
  const [made, setMade] = useState("");
  const [error, setError] = useState("");
  const make = async () => {
    setError("");
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const secret = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    const secretHash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const url = `${location.origin}/join${AGENT}#${secret}`;
    // 7 days at most, whatever the select holds: the share links' own limit
    const until = Date.now() + Math.min(Number(hours) || 24, 168) * 3_600_000;
    const link = crypto.randomUUID();
    try {
      await stub.append({ type: "share/link-made", payload: { link, secretHash, until } });
      await navigator.clipboard.writeText(url).catch(() => {});
      setMade(url);
      onMade({ url, until, link });
    } catch (failure) {
      setError(messageOf(failure));
    }
  };
  const end = (link) =>
    stub
      .append({ type: "share/link-ended", payload: { link } })
      .catch((failure) => setError(messageOf(failure)));
  return html`
    <section className="meet-band">
      <h2 className="meet-subtitle">Guests</h2>
      <p className="meet-note">
        A link lets anyone who has it into this meeting as a guest, with a name and no account: they
        read and write its chat and join its call, and reach nothing else of the mind. The agent
        acts for them with everything it can reach. A link ends at its time, or when you end it.
      </p>
      <div className="meet-row">
        <${NativeSelect}
          value=${hours}
          onChange=${(event) => setHours(event.target.value)}
          aria-label="How long the link lives"
        >
          <${NativeSelectOption} value="1">For 1 hour<//>
          <${NativeSelectOption} value="24">For 1 day<//>
          <${NativeSelectOption} value="168">For 7 days<//>
        <//>
        <${Button} size="sm" onClick=${make}>Make a link and copy it<//>
      </div>
      ${made && html`<p className="meet-note">Copied; it is shown here once: <code className="meet-text">${made}</code></p>`}
      ${error && html`<p role="alert" className="meet-error">${error}</p>`}
      <ul className="meet-links">
        ${links?.map(
          (link) => html`
            <li key=${link.link} className="meet-row">
              <span className="meet-note meet-grow">
                By ${link.madeBy}, until
                ${when(link.until)}${link.guests.length ? `; came: ${link.guests.join(", ")}` : ""}
              </span>
              <${Button} size="sm" variant="ghost" onClick=${() => end(link.link)}>End<//>
            </li>
          `,
        )}
      </ul>
    </section>
  `;
}

// ── a guest ──
/** A GUEST'S LINK'S SECRET, held for the sign-in's round trip; it leaves the browser only in the
 *  body of a check or a join. It comes from the address's fragment (`/join/<agent>#…`, or
 *  `/in/<agent>#…` when the tab could not store it), else from this tab's storage. When the
 *  storage takes it, the fragment leaves the address; when it does not (a browser that refuses
 *  storage), the fragment stays, and the next page's address carries it on. */
const SECRET_KEY = `meet-secret:${AGENT}`;
function stored() {
  try {
    return sessionStorage.getItem(SECRET_KEY) || "";
  } catch {
    return "";
  }
}
/** Stores `secret` in this tab: true when the storage holds it after. */
function store(secret) {
  try {
    sessionStorage.setItem(SECRET_KEY, secret);
    return sessionStorage.getItem(SECRET_KEY) === secret;
  } catch {
    return false;
  }
}
const fromAddress = GUEST_PAGE ? location.hash.slice(1) : "";
const guestSecret = fromAddress || (GUEST_PAGE ? stored() : "");
const secretStored = Boolean(guestSecret) && (guestSecret === stored() || store(guestSecret));
if (fromAddress && secretStored)
  history.replaceState(null, "", location.pathname + location.search);
/** The guest's next page: the platform's sign-in first, then the join. */
const signInPage = () => `/in${AGENT}${secretStored ? "" : `#${guestSecret}`}`;

/** A POST to a guest route (../app.ts); a refusal throws its words. */
async function post(route, body) {
  const answer = await fetch(`/guest/${route}${AGENT}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await answer.json().catch(() => ({}));
  if (!answer.ok) throw new Error(json.error || ENDED);
  return json;
}

/** The guest's page: the link's check, the platform's sign-in, the join, then the chat and the
 *  call on the guest's view of the one agent's context. */
function Guest() {
  // { say } a sentence; { view } the meeting
  const [held, setHeld] = useState({});
  useEffect(() => {
    const said = (failure) => setHeld({ say: messageOf(failure) });
    if (!guestSecret) return setHeld({ say: "Open the link you were given." });
    if (ROUTE === "join") {
      post("check", { secret: guestSecret }).then(
        ({ live }) => (live ? location.assign(signInPage()) : setHeld({ say: ENDED })),
        said,
      );
      return;
    }
    post("join", { secret: guestSecret }).then((joined) => {
      if (joined.member) return location.replace(`/contexts${AGENT}`);
      // THE GUEST'S VIEW of the agent's context. The platform closes it when the guest's session
      // ends (15 minutes); the page then says so, and the person's own press loads this page again,
      // with the secret from the tab's storage or the address's fragment
      const socket = new WebSocket(
        new URL(`/guest/itx${AGENT}`, location.href.replace(/^http/, "ws")),
      );
      socket.addEventListener("close", () =>
        setHeld({ say: "Your guest session ended.", again: true }),
      );
      setHeld({ view: newWebSocketRpcSession(socket) });
    }, said);
  }, []);
  if (held.view) return html`<${GuestMeeting} view=${held.view} />`;
  return html`
    <main className="meet-narrow">
      <p className="meet-note">${held.say || "Opening the link…"}</p>
      ${held.again && html`<${Button} onClick=${() => location.reload()}>Come in again<//>`}
    </main>
  `;
}

function GuestMeeting({ view }) {
  const stub = useContextStub(() => view.cd(AGENT), [view]);
  const props = { stub, session: view, title: nameOf(AGENT), member: false };
  return html`<${Meeting} ...${props} />`;
}

/** A member's session, once for the page: the mind's itx as the member (a guest's page has none). */
const itx = GUEST_PAGE ? null : memberItx();

function App() {
  if (!itx) return html`<${Guest} />`;
  return ROUTE === "contexts"
    ? html`<${MemberMeeting} itx=${itx} />`
    : html`<${Front} itx=${itx} />`;
}

render(html`<${App} />`, document.getElementById("root"));
