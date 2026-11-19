// call/rules.ts — ONE CALL, on an agent's context: who is in it, what each page sends, and the
// voice agent. The facet `call` (../call.ts) hosts it as a processor row on the agent's context, and a
// page reaches it over the session it already holds: a member's `/itx` socket, or a guest's
// one-context view (person methods, `join`, `signal` and `leave` alone). This file is the call's
// rules, with what it does outside handed in (`CallDeps`), so a test runs it with no mind.
//
// THE RULES, each in one place:
// - WHO ASKS is the kernel's word alone: `onBehalfOf()` of the method's call (`Asked`). A member has
//   `member: true`; anyone else is a person who must be a guest of a live share link of this same
//   context (share.ts), checked at every call. A call that code made names nobody (a member's
//   script, an agent's own tool, another facet or worker): the call refuses it, on purpose, in
//   words. The agent is not a participant: it learns of the call by its notes (below), and a tool
//   of its own, when it gets one, will be a method that answers nobody's page.
// - EVERY CALL OUTSIDE THE MIND waits `outboundMs` at most (10 s): a method that a guest could keep
//   busy for 60 s would get the facet restarted, and every member's call with it.
// - A PAGE is the asker's own live subscription row on this context: the row the page's
//   `useIterateContext` holds (`subscription`). It must be held by the asker and lent now. So a page
//   cannot speak for another, and no page makes up an id of its own.
// - LEAVING WITHOUT A WORD: when a page's row is un-set (its socket closed, or went silent), the
//   processor tells `pageGone`, and the page is out of the call and its SFU sessions close. A guest
//   whose link ended, or whom a member let out, is out at the next call or look. When the last page
//   is out, the call ends. No beat, no timer per page.
// - OUTBOUND (the SFU, TURN, OpenAI) runs outside the queue, with secrets by placeholder
//   (outbound.ts); the result is then recorded under the queue. SFU session ids stay in this facet's
//   storage: never in live state, never on a log.
// - THE AGENT is told each fact once, quietly: one `agent/context-added` with `payload.callNote`
//   (never `call`, which the agent's contract keeps for a `run` call) and no turn. SFU and provider
//   failures go to the audit log `<agent>/call`.
// - A GUEST'S NAME IS THEIR CLAIM: the agent's model reads each note, and a guest types their name.
//   So a note names a guest as "a guest who gives the name …", as the agent's own label of a guest's
//   words does (iterate/agents render.ts), with the name cut short and stripped of brackets and of
//   control, format and line-break characters (`claimedName`). That holds whoever's stamp the note
//   carries: a guest's own call stamps it as the guest; the sweep at the head runs under the cause
//   of the last event the processor read, which can be a member's (iterate/stream/processor
//   `#headCause`), and `pageGone` under the row's un-set.
// - BOUNDS: at most `MAX_PAGES` pages in a call and `MAX_PAGES_PER_ACTOR` for one person; the
//   stored call is parsed (`CallData`), and a shape that does not parse starts a fresh call.
// - THE VOICE AGENT: a member alone starts it (it bills the mind's owner, and the host's tab holds
//   its control channel). It ends when its host's page leaves, when no member is in the call, when
//   a member in the call sends it away, and after 30 minutes. A session OpenAI made is hung up whatever
//   fails after it, and a hang-up OpenAI did not take is tried again, 30 s apart, ten times at most.
//   While the call is live, the voice agent is in, or a hang-up is owed, the call schedules one look
//   at itself (`CALL_DUE`) within a minute.
import { z } from "zod";
import {
  closeSession,
  type Outbound,
  setupOf,
  sfu,
  TURN_TTL_S,
  turnServers,
  voiceAgentHangup,
  voiceAgentStart,
  VoiceRefused,
} from "./outbound.ts";
import { isLiveGuest, type ShareState } from "./share.ts";

/** The call's own look at itself: an event on the agent's context that its processor consumes. */
export const CALL_DUE = "call/due";
/** The voice agent's longest stay. */
const VOICE_AGENT_MAX_MS = 30 * 60_000;
/** How often a hang-up OpenAI did not take is tried, 30 s apart, before it is given up. */
const HANGUP_TRIES = 10;
const KINDS = ["mic", "camera", "screen", "ai"] as const;
/** Who asked, as the kernel tells a facet (iterate/sdk `onBehalfOf()`), structurally. */
export type Asked =
  | {
      principal?: { actor?: string; email?: string; name?: string; kind?: string };
      member?: true;
    }
  | undefined;
/** Pages in one call, and pages one person holds in it: all rows are one stored value, and the
 *  sweep makes two calls a row in series. */
const MAX_PAGES = 50;
const MAX_PAGES_PER_ACTOR = 4;
/** A person as the call draws them: the platform's shape (an `actor`), so a guest's view of the
 *  live state reads no address. */
const Who = z.object({
  actor: z.string(),
  name: z.string(),
  kind: z.literal("guest").optional(),
});
export type Who = z.infer<typeof Who>;
const Track = z.object({ sessionId: z.string(), trackName: z.string(), gen: z.number() });
const Row = z.object({
  who: Who,
  member: z.boolean(),
  since: z.number(),
  /** The page's SFU sessions: `pub` sends, `sub` receives. */
  pub: z.string().optional(),
  sub: z.string().optional(),
  tracks: z.partialRecord(z.enum(KINDS), Track),
  /** This page's admission: each join's own id. Work of an earlier admission of the same row
   *  (its leave, its offers, its voice agent) is refused, so it never touches this one. */
  admission: z.string().optional(),
});
/** An admission's id, as a page sends it back. A call with no id (a kit from before admissions)
 *  keeps the earlier behaviour until every pin has moved. */
const Admission = z.string().min(1).max(64).optional();
const GONE = "This page's call ended.";
/** The row is there, and `admission` (when the page sent one) is its current one. */
const isCurrent = (row: { admission?: string } | undefined, admission: string | undefined) =>
  Boolean(row) && (!admission || row!.admission === admission);
const JoinInput = z
  .union([
    z.object({ admit: z.string().min(1).max(64) }),
    z.object({ admission: z.string().min(1).max(64) }),
  ])
  .optional();
/** The call as it is stored: parsed at each load, so a wrong shape starts a fresh call rather
 *  than throwing in every change and every live state. */
const CallData = z.object({
  since: z.number().nullable(),
  pages: z.record(z.string(), Row),
  ai: z
    .object({
      page: z.string(),
      host: Who,
      since: z.number(),
      providerSession: z.string().optional(),
      /** This claim's own id: a late answer of an earlier claim on the same page touches no other. */
      claim: z.string().optional(),
      /** The host's admission it was claimed in: a new admission of the host's row ends it. */
      admission: z.string().optional(),
    })
    .nullable(),
  hangups: z.array(
    z.object({ providerSession: z.string(), tries: z.number(), triedAt: z.number() }),
  ),
  /** The last number given to a track: a track published anew (a repair) has a new one. */
  n: z.number(),
});
export type CallData = z.infer<typeof CallData>;
// WHAT A PAGE SENDS, parsed where each method begins: a guest's view hands over any JSON.
/** A page: the name of its own subscription row. */
const Page = z.string().regex(/^[\w:.@-]{1,200}$/);
const Sdp = z.string().min(1).max(20_000);
const Mid = z.string().min(1).max(64);
/** One step of the SFU's signalling. A track is "<page>:<kind>"; a layer is "f", "h" or "q". */
const StepInput = z.union([
  z.object({ publish: z.enum(KINDS), sdp: Sdp, mid: Mid }),
  z.object({ unpublish: z.enum(KINDS), mid: Mid }),
  z.object({
    subscribe: z.array(z.string().max(250)).max(64),
    layers: z
      .record(z.string().max(250), z.string().max(4))
      .refine((layers) => Object.keys(layers).length <= 64)
      .optional(),
  }),
  z.object({ layer: z.string().max(250), mid: Mid, rid: z.string().max(4) }),
  z.object({ renegotiate: Sdp }),
  z.object({ close: z.array(Mid).max(64) }),
  z.object({ reset: z.enum(["pub", "sub"]) }),
]);
/** The voice agent's act: start it with the host page's SDP offer, or stop it. */
const ActInput = z.union([z.object({ start: Sdp }), z.object({ stop: z.string().max(200) })]);

/** What the call does outside its own data, handed in by its facet (../call.ts) or a test. */
export type CallDeps = {
  /** The agent's context. */
  path: string;
  now(): number;
  load(): Promise<CallData | undefined>;
  save(data: CallData): Promise<void>;
  /** The context's share links, folded through the log now. */
  share(): Promise<ShareState>;
  /** Whether `page` is a live-callback row of this context that `actor` holds, lent now. */
  holds(page: string, actor: string): Promise<boolean>;
  /** One fact for the agent: a quiet message (no turn), with the fact as data (`callNote`). */
  note(content: string, callNote: Record<string, unknown>): Promise<void>;
  /** SFU and provider detail, on the audit log `<agent>/call`. */
  audit(type: string, payload: Record<string, unknown>): Promise<void>;
  /** A look at the call at `at`: one `CALL_DUE` on the agent's context, the one schedule. */
  schedule(at: number): Promise<void>;
  /** The mind's `fetch` and secrets, for the SFU, TURN and OpenAI. */
  outbound(): Outbound;
  /** How long one call outside the mind may take: 10 s when absent. */
  outboundMs?: number;
  /** The live state changed outside a batch. */
  publish(): void;
};

const SIMULCAST = (rid: string) => ({
  preferredRid: ["f", "h", "q"].includes(rid) ? rid : "h",
  priorityOrdering: "asciibetical",
  ridNotAvailable: "asciibetical",
});
const refuse = (message: string): never => {
  throw new Error(message);
};
/** A name as a note may hold it: cut short, with no bracket and no control, format or line-break
 *  character (as iterate/agents render.ts `inLabel`). A guest's name is the guest's own claim. */
export const claimedName = (name: string) =>
  name
    .normalize("NFKC")
    .replace(/[[\]\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
/** Who, in a note's words: a member by name; a guest as a guest who gives a name. */
const nameOf = (who: Who) => {
  const name = claimedName(who.name);
  if (!who.kind) return name || "A member";
  return name ? `A guest who gives the name ${name}` : "A guest";
};
const fresh = (): CallData => ({ since: null, pages: {}, ai: null, hangups: [], n: 0 });

export class Call {
  readonly #deps: CallDeps;
  #data: CallData | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #setup: { at: number; value: Awaited<ReturnType<typeof setupOf>> } | null = null;
  /** The first read of the setup has been started (`live`). */
  #setupAsked = false;
  /** Each member's calls in the current minute (a person's are counted by the kernel). */
  #asked = new Map<string, { minute: number; count: number }>();
  /** When the next look is set for. */
  #armedAt = 0;

  constructor(deps: CallDeps) {
    this.#deps = deps;
  }

  // ── what a page calls ──

  /** Come in. `{ admit: id }`: a new admission of this page, by the id the page chose (so the
   *  page knows it also when the answer never comes); the earlier admission's work is refused
   *  from here. `{ admission }`: fresh TURN credentials for that
   *  admission while it is the row's, which admits nobody. Nothing: a kit from before admissions,
   *  as before (a join again keeps the row's admission). Answers the ICE servers, how long they
   *  last (a member's 4 hours, a guest's 15 minutes, a guest's session) and the admission. */
  async join(asked: Asked, page: unknown, input?: unknown) {
    const parsed = JoinInput.safeParse(input);
    if (!parsed.success) refuse("A join takes nothing, { admit: id } or { admission: id }.");
    const refresh = parsed.data && "admission" in parsed.data ? parsed.data.admission : undefined;
    const admit = parsed.data && "admit" in parsed.data ? parsed.data.admit : undefined;
    const { who, member, own } = await this.#admit(asked, page);
    let admission = refresh || admit || crypto.randomUUID();
    const closes: string[] = [];
    await this.#locked((data, after) => {
      if (refresh) {
        if (data.pages[own]?.admission !== refresh) refuse(GONE);
        Object.assign(data.pages[own]!, { who, member });
        if (data.ai?.page === own && !member) this.#endAi(data, after, "its host is no member");
        return;
      }
      if (Object.hasOwn(data.pages, own)) {
        if (admit) {
          // a new admission of the same row: the earlier one's work is refused from here, its
          // voice agent too
          const row = data.pages[own]!;
          closes.push(...[row.pub, row.sub].filter((id): id is string => Boolean(id)));
          Object.assign(row, { admission, pub: undefined, sub: undefined, tracks: {} });
          if (data.ai?.page === own) this.#endAi(data, after, "its host joined again");
        } else admission = data.pages[own]!.admission ?? admission;
        // who and whether a member, from this call's stamp: a member's row is never swept as a
        // guest's, nor a guest's kept as a member's
        Object.assign(data.pages[own]!, { who, member });
        // the voice agent's host is a member's page: when it joins again as no member, the voice
        // agent leaves (and so no call keeps it with no member in it)
        if (data.ai?.page === own && !member) this.#endAi(data, after, "its host is no member");
        return;
      }
      const rows = Object.values(data.pages);
      if (rows.length >= MAX_PAGES) refuse(`This call has ${MAX_PAGES} pages in it, its most.`);
      if (rows.filter((one) => one.who.actor === who.actor).length >= MAX_PAGES_PER_ACTOR)
        refuse(`You are in this call on ${MAX_PAGES_PER_ACTOR} pages. Leave on one first.`);
      data.pages[own] = { who, member, since: this.#deps.now(), tracks: {}, admission };
      data.since ??= this.#deps.now();
      after.notes.push([`${nameOf(who)} joined the call.`, { kind: "joined", who }]);
    });
    const { turnKeyId, appId } = await this.setup();
    // the earlier admission's SFU sessions: the new one makes its own
    for (const sessionId of closes)
      if (appId)
        await closeSession(this.#out(), appId, sessionId).catch(async (error) => {
          await this.#deps.audit("call/close-failed", { error: String(error) }).catch(() => {});
        });
    const ttlS = member ? TURN_TTL_S.member : TURN_TTL_S.guest;
    let iceServers: unknown[] = [];
    if (turnKeyId)
      iceServers = await turnServers(this.#out(), turnKeyId, ttlS).catch(async (error) => {
        await this.#deps.audit("call/turn-failed", { error: String(error) }).catch(() => {});
        return [];
      });
    return { iceServers, ttlS, admission };
  }

  /** One step of the SFU's signalling for this page. Answers the SFU's description (an answer to
   *  a publish, an offer for a subscribe or a layer) and, for a subscribe, each track's mid. */
  async signal(asked: Asked, page: unknown, input: unknown, admission?: unknown) {
    const parsed = StepInput.safeParse(input);
    if (!parsed.success) refuse("No such step.");
    const step = parsed.data!;
    const { own } = await this.#admit(asked, page);
    this.#current((await this.#load()).pages[own], admission);
    // checked again at each write and session below: a join of a newer admission may land while
    // this signal waits on the SFU, and this signal then changes nothing of it
    const id = Admission.parse(admission);
    const ours = (row: z.infer<typeof Row> | undefined) => isCurrent(row, id);
    const { appId } = await this.setup();
    if (!appId) refuse("This mind has no Cloudflare Realtime SFU app yet.");
    const call = (method: string, path: string, body?: unknown) =>
      sfu(this.#out(), appId!, method, path, body).catch(async (error: unknown) => {
        // the path with no session id: those stay in this facet's storage
        const where = path.replace(/^\/sessions\/[^/]+/, "/sessions/…");
        await this.#deps
          .audit("call/sfu-failed", { path: where, error: String(error) })
          .catch(() => {});
        throw error;
      });
    if ("publish" in step) {
      const kind = step.publish;
      if (kind === "ai" && this.#data?.ai?.page !== own)
        refuse("Only the voice agent's host publishes its voice.");
      const sessionId = await this.#session(own, "pub", id);
      const made = await call("POST", `/sessions/${sessionId}/tracks/new`, {
        sessionDescription: { type: "offer", sdp: step.sdp },
        tracks: [{ location: "local", mid: step.mid, trackName: kind }],
      });
      let kept = false;
      await this.#locked((data, after) => {
        const row = data.pages[own];
        if (!ours(row) || row?.pub !== sessionId) return;
        kept = true;
        const again = Boolean(row.tracks[kind]);
        row.tracks[kind] = { sessionId, trackName: kind, gen: ++data.n };
        if (!again && (kind === "camera" || kind === "screen"))
          after.notes.push([
            `${nameOf(row.who)} turned the ${kind} on.`,
            { kind: `${kind}-on`, who: row.who },
          ]);
      });
      if (!kept) refuse(GONE);
      return { sdp: made.sessionDescription?.sdp };
    }
    if ("unpublish" in step) {
      const kind = step.unpublish;
      let sessionId: string | undefined;
      await this.#locked((data, after) => {
        const row = data.pages[own];
        if (!ours(row) || !row?.tracks[kind]) return;
        sessionId = row.tracks[kind].sessionId;
        delete row.tracks[kind];
        if (kind === "camera" || kind === "screen")
          after.notes.push([
            `${nameOf(row.who)} turned the ${kind} off.`,
            { kind: `${kind}-off`, who: row.who },
          ]);
      });
      if (sessionId)
        await call("PUT", `/sessions/${sessionId}/tracks/close`, {
          tracks: [{ mid: step.mid }],
          force: true,
        }).catch(() => {});
      return {};
    }
    if ("subscribe" in step) {
      const tracks = step.subscribe.flatMap((track) => {
        const found = this.#trackOf(track, own);
        return found ? [{ track, ...found }] : [];
      });
      if (!tracks.length) return { tracks: [] };
      const sessionId = await this.#session(own, "sub", id);
      const layers = step.layers || {};
      const made = await call("POST", `/sessions/${sessionId}/tracks/new`, {
        tracks: tracks.map(({ track, ...remote }) => ({
          location: "remote",
          ...remote,
          ...(track.endsWith(":camera") && { simulcast: SIMULCAST(String(layers[track])) }),
        })),
      });
      const results = made.tracks || [];
      return {
        sdp: made.sessionDescription?.sdp,
        tracks: tracks.map((asked) => ({
          track: asked.track,
          mid:
            results.find((r) => r.sessionId === asked.sessionId && r.trackName === asked.trackName)
              ?.mid || null,
        })),
      };
    }
    if (!ours(this.#data?.pages[own])) refuse(GONE);
    const sub = this.#data?.pages[own]?.sub;
    if ("layer" in step) {
      const found = this.#trackOf(step.layer, own);
      if (!sub || !found || !step.layer.endsWith(":camera")) refuse("No such camera in this call.");
      const made = await call("PUT", `/sessions/${sub}/tracks/update`, {
        tracks: [{ location: "remote", ...found, mid: step.mid, simulcast: SIMULCAST(step.rid) }],
      });
      return { sdp: made.sessionDescription?.sdp };
    }
    if ("renegotiate" in step) {
      if (!sub) refuse("Nothing to renegotiate.");
      await call("PUT", `/sessions/${sub}/renegotiate`, {
        sessionDescription: { type: "answer", sdp: step.renegotiate },
      });
      return {};
    }
    if ("close" in step) {
      if (sub && step.close.length)
        await call("PUT", `/sessions/${sub}/tracks/close`, {
          tracks: step.close.map((mid) => ({ mid })),
          force: true,
        });
      return {};
    }
    // a repair: the page's connection is made anew, so its session is too; what the old one sent
    // is published again on the new one (with new numbers, which the others subscribe to)
    let old: string | undefined;
    await this.#locked((data) => {
      const row = data.pages[own];
      if (!row || !ours(row)) return;
      if (step.reset === "pub") {
        old = row.pub;
        row.pub = undefined;
        row.tracks = {};
      } else {
        old = row.sub;
        row.sub = undefined;
      }
    });
    if (old) await closeSession(this.#out(), appId!, old).catch(() => {});
    return {};
  }

  /** Out of the call: the page's SFU sessions close. */
  async leave(asked: Asked, page: unknown, admission?: unknown) {
    const actor = asked?.principal?.actor;
    const own = Page.safeParse(page);
    const id = Admission.safeParse(admission);
    if (!actor || !own.success || !id.success) return;
    const pages = (await this.#load()).pages;
    if (!Object.hasOwn(pages, own.data) || pages[own.data]!.who.actor !== actor) return;
    // an earlier admission's leave: the page is in the call again, and stays
    if (id.data && pages[own.data]!.admission !== id.data) return;
    await this.#remove(own.data, "left", id.data);
  }

  /** The voice agent: start it with the host page's SDP offer (a member alone), or send it away.
   *  An expected refusal is an answer, not an error: `{ error, credit? , noKey? }`. */
  async voiceAgent(asked: Asked, page: unknown, input: unknown, admission?: unknown) {
    const parsed = ActInput.safeParse(input);
    if (!parsed.success) refuse("The voice agent takes { start: an SDP offer } or { stop }.");
    const act = parsed.data!;
    const { who, member, own } = await this.#admit(asked, page);
    this.#current((await this.#load()).pages[own], admission);
    if (!member) refuse("Only a member can invite the voice agent.");
    if ("stop" in act) {
      await this.#locked((data, after) => this.#endAi(data, after, `${nameOf(who)} sent it away`));
      return {};
    }
    if (!(await this.setup()).openai)
      return { error: "This mind has no OpenAI key for the voice agent.", noKey: true };
    let claimed = false;
    let busy = "";
    const claim = crypto.randomUUID();
    const id = Admission.parse(admission);
    let gone = false;
    await this.#locked((data, after) => {
      // the host's admission, still the row's: one that left while the call checked its setup
      // claims nothing, so no paid session starts for it
      const row = data.pages[own];
      if (!row || (id && row.admission !== id)) {
        gone = true;
        return;
      }
      if (data.ai) {
        busy = data.ai.host.name;
        return;
      }
      data.ai = { page: own, host: who, since: this.#deps.now(), claim, admission: row.admission };
      claimed = true;
      after.notes.push(["The voice agent joined the call.", { kind: "voice-agent-joined", who }]);
    });
    if (gone) return { error: GONE };
    if (!claimed) return { error: `The voice agent is in the call, with ${busy}.` };
    // the session OpenAI made, once it made one: whatever fails after that, it is hung up
    let providerSession = "";
    try {
      const started = await voiceAgentStart(this.#out(), act.start);
      providerSession = started.providerSession;
      let kept = false;
      await this.#locked((data) => {
        // this claim's agent, not a later one of the same page (a leave, a join and a new invite
        // came while OpenAI answered)
        if (data.ai?.claim !== claim) return;
        data.ai.providerSession = providerSession;
        kept = true;
      });
      if (!kept) {
        await this.#locked((data) => this.#owe(data, providerSession));
        return { error: "The voice agent was sent away." };
      }
      return { sdp: started.sdp };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      await this.#deps.audit("call/voice-agent-failed", { error: why }).catch(() => {});
      await this.#locked((data, after) => {
        if (data.ai?.claim === claim) this.#endAi(data, after, "it could not start");
        if (providerSession) this.#owe(data, providerSession);
      });
      const credit = error instanceof VoiceRefused && error.status === 402;
      return { error: why, ...(credit && { credit: true }) };
    }
  }

  /** The stored call, read: its facet waits for this before anything else, so the first live
   *  state after a wake shows who is in the call, not an empty call. */
  async ready() {
    await this.#load();
  }

  // ── what the processor tells the call ──

  /** A page's row was un-set: its socket closed, or went silent. */
  async pageGone(page: string) {
    if (Object.hasOwn((await this.#load()).pages, page)) await this.#remove(page, "gone");
  }

  /** The call's look at itself: guests who are out leave, a page whose row is no longer held
   *  leaves (if its un-set never came), the voice agent's bounds hold, owed hang-ups are tried, and
   *  the next look is set while one is needed. `share`: the processor's folded state, when it has
   *  it at hand. */
  async sweep(share?: ShareState) {
    const links = share || (await this.#deps.share());
    const now = this.#deps.now();
    for (const [page, row] of Object.entries((await this.#load()).pages)) {
      if (!row.member && !isLiveGuest(links, row.who.actor, now)) await this.#remove(page, "out");
      else if (!(await this.#deps.holds(page, row.who.actor))) await this.#remove(page, "gone");
    }
    await this.#locked(() => {});
  }

  /** What a page draws: who is in the call and what each sends (by a number that changes when a
   *  track is published anew), the voice agent, and which secrets the mind has. No session id. */
  live() {
    const data = this.#data || fresh();
    const setup = this.#setup?.value;
    // a fresh call reads its setup at once, so that its page can join before anyone has: the
    // answer publishes the live state again
    if (!this.#setupAsked) {
      this.#setupAsked = true;
      void this.setup().catch(() => (this.#setupAsked = false));
    }
    return {
      since: data.since,
      inCall: Object.fromEntries(
        Object.entries(data.pages).map(([page, row]) => [
          page,
          {
            who: row.who,
            tracks: Object.fromEntries(
              Object.entries(row.tracks).map(([kind, track]) => [kind, track.gen]),
            ),
          },
        ]),
      ),
      voiceAgent: data.ai && {
        host: data.ai.host,
        page: data.ai.page,
        since: data.ai.since,
        until: data.ai.since + VOICE_AGENT_MAX_MS,
      },
      // null until the first read answers: a page waits for no value that only a join would fill
      setup: setup
        ? {
            sfu: Boolean(setup.appId),
            turn: Boolean(setup.turnKeyId),
            voice: Boolean(setup.openai),
          }
        : null,
    };
  }

  /** Which secrets the mind has, read once a minute at most. */
  async setup() {
    const now = this.#deps.now();
    if (!this.#setup || now - this.#setup.at > 60_000) {
      const before = JSON.stringify(this.#setup?.value);
      this.#setup = { at: now, value: await setupOf(this.#out()) };
      this.#setupAsked = true;
      if (JSON.stringify(this.#setup.value) !== before) this.#deps.publish();
    }
    return this.#setup.value;
  }

  // ── inside ──

  /** The mind's `fetch` and secrets, each call bounded: past `outboundMs` it fails in words. */
  #out(): Outbound {
    const outbound = this.#deps.outbound();
    const ms = this.#deps.outboundMs ?? 10_000;
    const within = async <T>(work: Promise<T>, what: string) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms / 1000} s`)), ms);
      });
      try {
        return await Promise.race([work, late]);
      } finally {
        clearTimeout(timer);
      }
    };
    return {
      fetch: (request) => within(outbound.fetch(request), new URL(request.url).hostname),
      secrets: {
        describe: (path) => within(outbound.secrets.describe(path), `the secret ${path}`),
      },
    };
  }

  /** Who asks, by the kernel's word, and that `page` is their own row: else a refusal. */
  async #admit(asked: Asked, page: unknown) {
    const principal = asked?.principal;
    const actor = principal?.actor;
    if (!actor)
      refuse(
        "A call answers a person's own call from their page: a script or an agent's tool names nobody.",
      );
    const member = asked?.member === true;
    if (member) {
      // a member's calls, 600 a minute (a person's are counted by the kernel, 120 a minute)
      const minute = Math.floor(this.#deps.now() / 60_000);
      const seen = this.#asked.get(actor!);
      const count = seen?.minute === minute ? seen.count + 1 : 1;
      if (this.#asked.size >= 1_000 && !seen) this.#asked.clear();
      this.#asked.set(actor!, { minute, count });
      if (count > 600) refuse("Too many calls this minute. Try again in a minute.");
    } else if (!isLiveGuest(await this.#deps.share(), actor!, this.#deps.now())) {
      refuse("This link has ended, or a member let you out of the call.");
    }
    const own = Page.safeParse(page);
    if (!own.success || !(await this.#deps.holds(own.data, actor!)))
      refuse("That page is not yours.");
    const name = (principal!.name || principal!.email?.split("@", 1)[0] || "").slice(0, 40);
    const who: Who = member
      ? { actor: actor!, name: name || "A member" }
      : { actor: actor!, name: name || "Guest", kind: "guest" };
    return { who, member, own: own.data! };
  }

  /** A track another page in this call publishes, by "<page>:<kind>". */
  #trackOf(track: string, asking: string) {
    const at = track.lastIndexOf(":");
    const pages = this.#data?.pages || {};
    const owner = Object.hasOwn(pages, track.slice(0, at)) ? pages[track.slice(0, at)] : undefined;
    const kind = KINDS.find((one) => one === track.slice(at + 1));
    const published = kind && owner?.tracks[kind];
    if (!published || track.slice(0, at) === asking) return null;
    return { sessionId: published.sessionId, trackName: published.trackName };
  }

  /** The page's SFU session for sending or receiving, made on first use. */
  /** The page's session `which`, made on first use, for `admission` (when the page sent one) while
   *  it is the row's: one made for an admission that a newer one replaced meanwhile is closed. */
  async #session(page: string, which: "pub" | "sub", admission?: string): Promise<string> {
    if (!isCurrent(this.#data?.pages[page], admission)) refuse(GONE);
    const had = this.#data?.pages[page]?.[which];
    if (had) return had;
    const { appId } = await this.setup();
    const made = await sfu(this.#out(), appId!, "POST", "/sessions/new");
    const sessionId = made.sessionId || "";
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) refuse("The SFU made no session.");
    let kept = "";
    await this.#locked((data) => {
      const row = data.pages[page];
      if (!row || !isCurrent(row, admission)) return;
      row[which] ??= sessionId;
      kept = row[which]!;
    });
    // left meanwhile, a newer admission came, or another call made one first: this one is closed
    if (kept !== sessionId) await closeSession(this.#out(), appId!, sessionId).catch(() => {});
    return kept || refuse(GONE);
  }

  /** The page's row, when `admission` (if the page sent one) is its current one; else refused. */
  #current(row: z.infer<typeof Row> | undefined, admission: unknown) {
    if (!row) refuse("Join the call first.");
    const id = Admission.safeParse(admission);
    if (!id.success || !isCurrent(row, id.data)) refuse(GONE);
  }

  /** A page out of the call, for `how`: its sessions close, and the voice agent and the call end
   *  with it when they must. */
  async #remove(page: string, how: "left" | "gone" | "out", admission?: string) {
    const closes: string[] = [];
    await this.#locked((data, after) => {
      const row = data.pages[page];
      // a newer admission came in while this leave waited for the lock: it stays
      if (!row || (admission && row.admission !== admission)) return;
      delete data.pages[page];
      closes.push(...[row.pub, row.sub].filter((id): id is string => Boolean(id)));
      const words = {
        left: "left the call",
        gone: "dropped out of the call",
        out: "is out of the call",
      }[how];
      after.notes.push([`${nameOf(row.who)} ${words}.`, { kind: how, who: row.who }]);
      if (data.ai?.page === page) this.#endAi(data, after, "its host left");
      if (data.ai && !Object.values(data.pages).some((one) => one.member))
        this.#endAi(data, after, "no member is in the call");
      if (!Object.keys(data.pages).length) data.since = null;
    });
    const { appId } = closes.length ? await this.setup() : { appId: null };
    for (const sessionId of closes)
      if (appId)
        await closeSession(this.#out(), appId, sessionId).catch(async (error) => {
          await this.#deps.audit("call/close-failed", { error: String(error) }).catch(() => {});
        });
  }

  #endAi(data: CallData, after: After, why: string) {
    if (!data.ai) return;
    if (data.ai.providerSession) this.#owe(data, data.ai.providerSession);
    after.notes.push([`The voice agent left the call: ${why}.`, { kind: "voice-agent-left", why }]);
    data.ai = null;
  }

  #owe(data: CallData, providerSession: string) {
    if (!data.hangups.some((owed) => owed.providerSession === providerSession))
      data.hangups.push({ providerSession, tries: 0, triedAt: 0 });
  }

  async #load() {
    if (!this.#data) {
      const stored = CallData.safeParse(await this.#deps.load());
      this.#data = stored.success ? stored.data : fresh();
      // a page is a person's string ("constructor" passes `Page`): no lookup may find a prototype's
      this.#data.pages = Object.assign(Object.create(null), this.#data.pages);
    }
    return this.#data;
  }

  /** One change at a time: `change` reads and changes the call's data under the queue; then,
   *  outside it, the facts go to the agent, owed hang-ups are tried, the live state is published,
   *  and the next look is set. The voice agent's bounds are checked at every change. */
  async #locked(change: (data: CallData, after: After) => void) {
    const after: After = { notes: [], abandoned: [] };
    const run = this.#queue.then(async () => {
      const data = await this.#load();
      const before = JSON.stringify(data);
      const now = this.#deps.now();
      change(data, after);
      if (data.ai && now - data.ai.since >= VOICE_AGENT_MAX_MS)
        this.#endAi(data, after, `its ${VOICE_AGENT_MAX_MS / 60_000} minutes are over`);
      // the hang-ups owed now: at most every 30 s each, ten tries in all; after the tenth has
      // failed, the hang-up is given up, and the audit log says so
      const due = data.hangups.filter(
        (owed) => owed.tries < HANGUP_TRIES && (!owed.tries || now - owed.triedAt >= 30_000),
      );
      for (const owed of due) Object.assign(owed, { tries: owed.tries + 1, triedAt: now });
      for (const owed of data.hangups)
        if (owed.tries >= HANGUP_TRIES && now - owed.triedAt >= 30_000)
          after.abandoned.push(owed.providerSession);
      data.hangups = data.hangups.filter(
        (owed) => owed.tries < HANGUP_TRIES || now - owed.triedAt < 30_000,
      );
      if (JSON.stringify(data) !== before) await this.#deps.save(data);
      return due.map((owed) => owed.providerSession);
    });
    this.#queue = run.catch(() => {});
    const due = await run;
    this.#deps.publish();
    for (const providerSession of after.abandoned)
      await this.#deps
        .audit("call/voice-agent-hangup-abandoned", { providerSession, tries: HANGUP_TRIES })
        .catch(() => {});
    for (const [content, callNote] of after.notes)
      await this.#deps.note(`[call] ${content}`, callNote).catch(() => {});
    for (const providerSession of due)
      if (await voiceAgentHangup(this.#out(), providerSession))
        await this.#locked((data) => {
          data.hangups = data.hangups.filter((owed) => owed.providerSession !== providerSession);
        });
    const data = this.#data!;
    const now = this.#deps.now();
    // a look within a minute while the call is live, the voice agent is in, or a hang-up is owed:
    // the backstop for a page whose row's un-set never came (one schedule per call, never per page)
    const at = data.ai
      ? Math.min(data.ai.since + VOICE_AGENT_MAX_MS, now + 60_000)
      : data.since !== null || data.hangups.length
        ? now + 60_000
        : 0;
    // an earlier look that is still to come sets the next one itself
    if (at && !(this.#armedAt > now && this.#armedAt <= at)) {
      this.#armedAt = Math.max(at, now + 5_000);
      await this.#deps.schedule(this.#armedAt).catch(() => (this.#armedAt = 0));
    }
  }
}

/** What a change leaves to do outside the queue: the agent's notes, and the hang-ups given up. */
type After = { notes: [string, Record<string, unknown>][]; abandoned: string[] };
