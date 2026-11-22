// app.js — MEET'S PAGE (../app.ts): start a meeting, and any agent's chat with its call.
//
//   /                    a member: "Start new meeting", and the recent meetings
//   /contexts/<agent>    a member: the agent's chat and call, and Share: the members' link,
//                        the links for guests, and a calendar invite
//   /join/<agent>#…      a guest's link: the page keeps the secret in this tab and asks whether
//                        the link is live; then /in/<agent>, after the platform's sign-in (a
//                        guest types a name): the join, and the same chat and call on the guest's
//                        view
//
// The page has no API of its own. A member's page holds the member's `/itx` socket: a meeting
// starts by `itx.config.startMeeting` (../meeting.ts), the one function an agent calls too. A
// guest's page holds the platform's view of the one agent's context. The call is the kit's
// (`useCall`, `CallHeaderControls`, `CallTiles`), and so is Share (`CallShare`). A meeting's page is
// the Dash's agent page: the kit's one header row (`AgentPageHeader`: the way back to the meetings,
// the title and path, who is here with the mind's face first, the call's controls, Share, and
// Chat | Events), then the call's tiles, then the chat, which fills the rest of the page. Nothing
// polls. Out of the call the controls are one button: Start call (it turns the call on when the
// meeting has none) or Join call, which joins with the microphone. In the call they are the
// microphone, the camera, the screen, the voice agent and the devices, and Leave.
//
// What is said runs along the kit's caption strip over the composer, and opens to the whole
// transcript. A member who shares a camera or a screen may turn on "Let the agent look" for it:
// then, when the agent asks (`itx.config.callSnapshot`, ../../../call/snapshot.ts), this page takes
// ONE picture of its own video and sends it (snapshot-capture.js). It is off by default, and ends
// when the source stops.
import {
  html,
  render,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "@iterate-com/ui/page";
import { createPortal } from "react-dom";
import { AgentChat } from "@iterate-com/ui/components/agent-chat/agent-chat";
import {
  AgentPageHeader,
  heldRowsOf,
} from "@iterate-com/ui/components/agent-chat/agent-page-header";
import { CallHeaderControls } from "@iterate-com/ui/components/call/call-controls";
import { CallPipButton, CallPipPlace, useCallPip } from "@iterate-com/ui/components/call/call-pip";
import { CallShare } from "@iterate-com/ui/components/call/call-share";
import { CallTiles } from "@iterate-com/ui/components/call/call-tiles";
import { CaptionStrip } from "@iterate-com/ui/components/call/caption-strip";
import { TranscriptHistory } from "@iterate-com/ui/components/call/transcript-history";
import { Button } from "@iterate-com/ui/components/ui/button";
import { Input } from "@iterate-com/ui/components/ui/input";
import { ChevronLeftIcon } from "@iterate-com/ui/icons";
import { useCall } from "@iterate-com/ui/lib/call-engine";
import {
  memberItx,
  newWebSocketRpcSession,
  useContextStub,
  useIterateContext,
} from "@iterate-com/ui/live";
import { sendSnapshot } from "./snapshot-capture.js";
// the template's one link-making for guests: the twin of the Dash's file (its header says why)
import { endLink, makeLink } from "./share-links.js";

const [, ROUTE = "", ...REST] = location.pathname.split("/");
const AGENT = `/${REST.join("/")}`;
const GUEST_PAGE = ROUTE === "join" || ROUTE === "in";
const ENDED = "This link has ended. Ask for a new one.";
const messageOf = (error) => String(error?.message ?? error);
const nameOf = (path) => path.split("/").pop();
/** The zone this page is on: an app's hostname is one label under its zone. */
const ZONE = location.hostname.split(".").slice(1).join(".");

// The mind's name and icon, as its owner wrote them (profile.ts), which the zone's website answers
// to anyone: the first face of who is here, as on the Dash. The page never waits for it: it draws
// with the zone's name and iterate's mark at once, and takes the profile when it comes.
const profile = fetch(`https://${ZONE}/.well-known/iterate-profile`)
  .then((answer) => answer.json())
  .catch(() => null);

/** The mind's face for the header and the chat: `{ name, logo }`. */
function useMindFace() {
  const [said, setSaid] = useState(null);
  useEffect(() => {
    void profile.then((answer) => answer && setSaid(answer));
  }, []);
  return useMemo(
    () => ({
      name: said?.name || ZONE,
      logo: said?.icon ? html`<img src=${said.icon} alt="" />` : undefined,
    }),
    [said],
  );
}

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
            // the meetings alone: a meeting's own call (`<meeting>/call`) is a context under it,
            // which the catalog lists too, and which has no agent and no chat
            .filter((agent) => /^\/agents\/meet\/[^/]+$/.test(agent.path))
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
            <span className="meet-note"
              >${new Date(agent.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span
            >
          </a>
        `,
      )}
    </main>
  `;
}

// ── what is said, and "Let the agent look" ──
const CONTEXT_ADDED = "events.iterate.com/agent/context-added";
const SOURCES = ["camera", "screen"];
/** The caption strip's live words: none yet, the strip shows the lines said. */
const NO_CAPTIONS = { captions: [], pending: 0 };
const NO_OLDER = { loading: false, exhausted: true, load: () => {} };

/** The lines said, from the call's quiet notes (`callNote.kind === "said"`, ../../../call/rules.ts
 *  `said`), oldest first, as the kit's caption strip and transcript take them. */
function saidLines(events) {
  const lines = [];
  for (const event of events) {
    const note = event?.type === CONTEXT_ADDED ? event.payload?.callNote : null;
    if (note?.kind !== "said" || typeof note.text !== "string") continue;
    lines.push({
      key: note.id || `said:${event.offset}`,
      offset: typeof event.offset === "number" ? event.offset : undefined,
      who:
        note.who?.actor === "voice-agent"
          ? "The voice agent"
          : note.who?.name || note.who?.actor || "Someone",
      text: note.text,
      at: typeof note.at === "number" ? note.at : Date.parse(event.createdAt ?? "") || Date.now(),
    });
  }
  return lines;
}

/** A snapshot note with its picture taken off: what a guest's page shows. */
function withoutSnapshotFiles(event) {
  if (event?.type !== CONTEXT_ADDED || event.payload?.callNote?.kind !== "snapshot") return event;
  return { ...event, payload: { ...event.payload, files: undefined } };
}

/** "Let the agent look" on this page: the switch for the page's own camera and screen (the call's
 *  `look`), and the answer to the agent's request for one picture of one of them. The page answers
 *  only a request for its own page and a source it shares with the switch on; the call checks the
 *  same again at the upload. */
function useLook({ stub, page, member, call, ui, rawLive }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // what the switch holds now, read at the capture too: a switch turned off stops a capture
  const allowed = useRef({});
  const videos = useRef([]);
  const handled = useRef(new Set());
  const server = page ? rawLive?.inCall?.[page]?.look : undefined;
  const camera = Boolean(ui.joined && ui.camera && server?.camera);
  const screen = Boolean(ui.joined && ui.screen && server?.screen);
  const on = useMemo(
    () => ({ ...(camera && { camera: true }), ...(screen && { screen: true }) }),
    [camera, screen],
  );
  useEffect(() => {
    allowed.current = on;
  }, [on]);
  useEffect(() => {
    videos.current = ui.videos;
  }, [ui.videos]);

  const toggle = useCallback(async () => {
    if (!member || !stub || !page || !ui.joined) return;
    const anyOn = SOURCES.some((kind) => ui[kind] && allowed.current[kind]);
    const desired = anyOn
      ? { camera: false, screen: false }
      : Object.fromEntries(SOURCES.filter((kind) => ui[kind]).map((kind) => [kind, true]));
    if (!Object.keys(desired).length) return;
    // off at once on this page: no capture goes on while the call takes the change
    if (anyOn) allowed.current = {};
    setBusy(true);
    try {
      const answer = await stub.invoke(["itx", "facets", ["get", "call"], ["look", page, desired]]);
      allowed.current = { ...answer?.look };
    } catch (failure) {
      call?.fail(`"Let the agent look" could not change: ${messageOf(failure)}`);
    } finally {
      setBusy(false);
    }
  }, [member, stub, page, ui, call]);

  // the agent's request for one picture, when it is this page's
  const pending = rawLive?.snapshot;
  useEffect(() => {
    if (!member || !page || pending?.status !== "requested" || pending.page !== page) return;
    const { id, source, requestedAt } = pending;
    if (!id || handled.current.has(id) || Date.now() - requestedAt > 20_000) return;
    handled.current.add(id);
    const own = videos.current.find((video) => video.local && video.kind === source);
    const preview = own?.stream
      ? [...document.querySelectorAll('[data-slot="call-tiles"] video')].find(
          (element) => element.srcObject === own.stream,
        )
      : null;
    void sendSnapshot({
      url: `/snapshot${AGENT}`,
      requestId: id,
      page,
      stream: own?.stream,
      checkAllowed: () => Boolean(allowed.current[source]),
      fallbackVideo: preview,
    }).then((result) => {
      if (result.ok) setNotice(`The agent took one picture of your ${source}. It is in the chat.`);
    });
  }, [member, page, pending]);

  // who has it on now, for everyone in the call to see
  const lookingNow = Object.values(rawLive?.inCall || {}).flatMap((row) => {
    const kinds = SOURCES.filter((kind) => row?.look?.[kind] && kind in (row?.tracks || {}));
    return kinds.length ? [`${row.who?.name || "Someone"} (${kinds.join(" and ")})`] : [];
  });
  return { on, busy, toggle, notice, setNotice, lookingNow };
}

/** The switch, while the member's page shares a camera or a screen. */
function LookButton({ look, ui }) {
  const shared = SOURCES.filter((kind) => ui[kind]);
  if (!ui.joined || !shared.length) return null;
  const onNow = shared.filter((kind) => look.on[kind]);
  const title = onNow.length
    ? `The agent may take one picture of your ${onNow.join(" and ")} when it is asked to look. Each picture shows in the chat. Press to stop.`
    : `Let the agent take one picture of your ${shared.join(" and ")} when it is asked to look. Off until you press.`;
  return html`
    <${Button}
      size="sm"
      variant=${onNow.length ? "default" : "outline"}
      aria-pressed=${onNow.length > 0}
      title=${title}
      disabled=${look.busy}
      onClick=${() => void look.toggle()}
    >
      ${onNow.length ? "The agent may look" : "Let the agent look"}
    <//>
  `;
}

/** The way back to the meetings, before a meeting's title: an arrow, named in its tooltip. */
function AllMeetings() {
  return html`
    <${Button}
      variant="ghost"
      size="icon-sm"
      nativeButton=${false}
      render=${html`<a href="/" />`}
      aria-label="All meetings"
      title="All meetings"
    >
      <${ChevronLeftIcon} />
    <//>
  `;
}

// ── one meeting: the agent's chat with its call ──
/** The chat and the call on `stub`, the agent's context: a member's `itx.cd(agent)`, or a guest's
 *  view's. `session` is what the page holds (the member's itx, or the guest's view), which sends
 *  the agent words. `start` turns the call on (a member's alone); `share` makes and ends the links
 *  for guests (a member's alone): Share in the header. */
function Meeting({ stub, session, me, title, member, start, share }) {
  const mind = useMindFace();
  const [state, setState] = useState({});
  const patch = useCallback((change) => setState((previous) => ({ ...previous, ...change })), []);
  const context = useIterateContext(stub.stub, AgentChat.contextOptions);
  const rawLive = context.liveState.call?.value;
  const { call, ui, live } = useCall(stub.stub, context.subscription, rawLive);
  const pip = useCallPip(ui);
  const signedUrl = useCallback(
    async (file) => (await stub.stub.files.get(file).url()).url,
    [stub.stub],
  );
  const said = useMemo(() => saidLines(context.events), [context.events]);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const look = useLook({ stub: stub.stub, page: context.subscription, member, call, ui, rawLive });
  // a guest sees that a picture was taken, never the picture: its file is no guest's to read
  const chatContext = useMemo(
    () => (member ? context : { ...context, events: context.events.map(withoutSnapshotFiles) }),
    [context, member],
  );
  const transcript = transcriptOpen
    ? html`<${TranscriptHistory} said=${said} older=${context.older || NO_OLDER} me=${me || ""} />`
    : null;
  const strip = html`
    <${CaptionStrip}
      said=${said}
      live=${NO_CAPTIONS}
      me=${me || ""}
      open=${transcriptOpen}
      onOpen=${() => setTranscriptOpen((was) => !was)}
    />
  `;
  const aboveComposer =
    ui.joined || live?.voiceAgent || said.length > 0
      ? html`<div className="meet-transcript">${transcript}${strip}</div>`
      : undefined;
  // the header's places, once it has drawn them: who is here (the chat draws it), the call's
  // controls and Share (drawn here, into the header)
  const [aside, setAside] = useState(null);
  const [callIn, setCallIn] = useState(null);
  const [shareIn, setShareIn] = useState(null);
  const tabs = {
    view: state.view,
    hasChat: true,
    // no count until the first read has answered
    held: context.caughtUp || context.events.length ? heldRowsOf(context.events) : undefined,
    wholeLogHeld: context.older?.exhausted ?? true,
    onStateChange: patch,
  };
  const back = member ? html`<${AllMeetings} />` : html`<span className="meet-note">Guest</span>`;
  const lookLine =
    look.lookingNow.length > 0 &&
    html`<span>The agent may look: ${look.lookingNow.join(", ")}</span>`;
  const lookNotice =
    look.notice &&
    html`
      <span className="meet-row">
        ${look.notice}
        <${Button} size="xs" variant="ghost" onClick=${() => look.setNotice("")}>Dismiss<//>
      </span>
    `;
  return html`
    <div className="meet-page">
      <${AgentPageHeader}
        path=${AGENT}
        title=${title}
        before=${back}
        mind=${mind}
        presence=${true}
        aside=${setAside}
        call=${true}
        callIn=${setCallIn}
        share=${Boolean(share)}
        shareIn=${setShareIn}
        tabs=${tabs}
      />
      ${
        callIn &&
        createPortal(
          html`
            <${CallHeaderControls}
              call=${call}
              ui=${ui}
              live=${live}
              member=${member}
              start=${live ? undefined : start}
            />
          `,
          callIn,
        )
      }
      ${
        share &&
        shareIn &&
        createPortal(
          html`
            <${CallShare}
              share=${share}
              title=${title}
              pageUrl=${`${location.origin}/contexts${AGENT}`}
              context=${context}
              enable=${start}
            />
          `,
          shareIn,
        )
      }
      ${
        live &&
        html`
          <div className="meet-call-strip">
            ${member && html`<${LookButton} look=${look} ui=${ui} />`}
            <${CallPipButton} pip=${pip} />
            <span className="meet-row" role="status">${lookLine}${lookNotice}</span>
          </div>
        `
      }
      <div className="meet-tiles">
        <${CallPipPlace} pip=${pip}>
          <${CallTiles}
            call=${call}
            ui=${ui}
            live=${live}
            member=${member}
            className="mx-auto w-full max-w-3xl px-4 pt-2 md:px-6"
          />
        <//>
      </div>
      <div className="meet-chat">
        <${AgentChat}
          path=${AGENT}
          context=${chatContext}
          error=${stub.error}
          state=${state}
          onStateChange=${patch}
          tabsInHeader=${true}
          asideIn=${aside}
          onMessage=${({ message, files, key }) =>
            session.agents.get(AGENT).message({ message, files }, { key })}
          onAppend=${stub.stub ? (events) => stub.stub.append(...events) : undefined}
          signedUrl=${signedUrl}
          me=${me}
          presence=${true}
          mind=${mind}
          aboveComposer=${aboveComposer}
          placeholder="Message this meeting's agent"
        />
      </div>
    </div>
  `;
}

/** A member's meeting, on the member's own session. */
function MemberMeeting({ itx }) {
  const stub = useContextStub(() => itx.cd(AGENT), [itx]);
  const [me, setMe] = useState();
  const [title, setTitle] = useState(nameOf(AGENT));
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
  // the links for guests, by the template's one link-making; appended through the member's own
  // stub, so the link names the member as its maker
  const share = useMemo(
    () => ({
      make: async (lifetimeMs) => {
        if (!stub.stub) throw new Error("The meeting is not open yet.");
        const { event, url, until, link } = await makeLink({
          zone: ZONE,
          agent: AGENT,
          lifetimeMs,
          now: Date.now(),
        });
        await stub.stub.append(event);
        return { url, until, link };
      },
      end: (link) => stub.stub.append(endLink(link)),
    }),
    [stub.stub],
  );
  const props = { stub, session: itx, me, title, member: true, start, share };
  return html`<${Meeting} ...${props} />`;
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
      socket.addEventListener("open", () => performance.mark("iterate:itx-open"), { once: true });
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
