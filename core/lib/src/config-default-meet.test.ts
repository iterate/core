// The default config's Meet (core/configs/default/apps/meet): a meeting's name, the one function
// that starts one, the guest routes on a fake mind, and the calendar invite the page builds.
/// <reference path="../../configs/default/files.d.ts" />
import { expect, test } from "vitest";
import { meetApp } from "../../configs/default/apps/meet/app.ts";
import {
  meetingPath,
  type MeetingItx,
  slugOf,
  startMeeting,
} from "../../configs/default/apps/meet/meeting.ts";
import { CALL_FACET } from "../../configs/default/call.ts";
import type { ShareState } from "../../configs/default/call/share.ts";
import { stampJsonOf } from "./principal.ts";
import { auth } from "./sdk/auth.ts";

const LINK = "11111111-2222-4333-8444-555555555555";
const AGENT = "/agents/meet/2026-11-19-1030-standup";
const NOW = new Date("2026-11-19T10:30:59Z");

test("a meeting's name: the time in UTC, then the title's slug, or three random words", () => {
  expect(meetingPath(NOW, "Stand-up: Ünïcode, & more!")).toBe(
    "/agents/meet/2026-11-19-1030-stand-up-unicode-more",
  );
  expect(slugOf(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
  expect(slugOf("日本")).toBe("");
  expect(meetingPath(NOW, "  ", () => 0)).toBe("/agents/meet/2026-11-19-1030-amber-amber-amber");
  expect(meetingPath(NOW, "", () => 0.99)).toMatch(
    /^\/agents\/meet\/2026-11-19-1030-[a-z]+-[a-z]+-[a-z]+$/,
  );
});

test("startMeeting makes the agent, turns its call on, titles it; a taken name gets a number", async () => {
  const mind = fakeStart(["/agents/meet/x"]);
  const { path } = await startMeeting(mind.itx, { title: "Plan" });
  expect(path).toMatch(/^\/agents\/meet\/\d{4}-\d\d-\d\d-\d{4}-plan$/);
  expect(mind).toMatchObject({
    done: [
      ["create", path],
      ["enable", path, "call", CALL_FACET],
      [
        "append",
        path,
        { type: "events.iterate.com/itx/described", payload: { metadata: { title: "Plan" } } },
      ],
    ],
  });
  mind.done.length = 0;
  mind.agents.push(path);
  expect(await startMeeting(mind.itx, { title: "Plan" })).toEqual({ path: `${path}-2` });
  // an agent that exists: its call on, nothing made, its title kept; one that does not: refused
  mind.done.length = 0;
  mind.calls.add("/agents/meet/x");
  expect(await startMeeting(mind.itx, { path: "/agents/meet/x", title: "No" })).toEqual({
    path: "/agents/meet/x",
  });
  expect(mind).toMatchObject({ done: [] });
  await expect(startMeeting(mind.itx, { path: "/agents/nowhere" })).rejects.toThrow(
    "/agents/nowhere is no agent of this mind.",
  );
  // a context that is no agent is not in the agents' catalog: no call is turned on for it
  await expect(startMeeting(mind.itx, { path: "/repos/config" })).rejects.toThrow(
    "/repos/config is no agent of this mind.",
  );
  expect(mind).toMatchObject({ done: [] });
});

test("a guest's way in: a live link's check, the join as the platform's guest, and the socket that is their view of the one agent", async () => {
  const mind = fakeMind();
  const secret = "the-link-secret";
  mind.share = await liveLink(secret);
  // an agent that does not exist is asked of the catalog alone, and its link is not live
  expect(await mind.post(nobody, "/guest/check/agents/nowhere", { secret })).toEqual([
    200,
    { live: false },
  ]);
  expect(mind).toMatchObject({ facetAsked: [] });
  expect(await mind.post(nobody, `/guest/check${AGENT}`, { secret: "wrong" })).toEqual([
    200,
    { live: false },
  ]);
  expect(await mind.post(nobody, `/guest/check${AGENT}`, { secret })).toEqual([
    200,
    { live: true },
  ]);
  // the join needs a sign-in, a guest's too
  expect((await mind.post(nobody, `/guest/join${AGENT}`, { secret }))[0]).toBe(401);
  expect(await mind.post(guest, `/guest/join${AGENT}`, { secret: "wrong" })).toEqual([
    410,
    { error: "This link has ended. Ask for a new one." },
  ]);
  // a guest not on a live link gets no socket
  expect(await mind.get(guest, `/guest/itx${AGENT}`)).toMatchObject({ status: 403 });
  expect(await mind.post(guest, `/guest/join${AGENT}`, { secret })).toEqual([
    200,
    { joined: true },
  ]);
  expect(mind).toMatchObject({
    appended: [
      {
        path: AGENT,
        event: {
          type: "share/guest-joined",
          idempotencyKey: `share/guest-joined:${LINK}:guest:grace`,
          payload: { link: LINK, guest: { userId: "guest:grace", name: "Grace" } },
        },
      },
    ],
  });
  // the join answers once the call's state shows her on the link: the socket is then the
  // platform's view of the agent
  const socket = await mind.get(guest, `/guest/itx${AGENT}`, { upgrade: "websocket" });
  expect(socket).toMatchObject({ status: 426 });
  expect(socket.headers.get("x-iterate-serve")).toBe("person-itx");
  expect(socket.headers.get("x-iterate-serve-context")).toBe(AGENT);
  // the platform asks the call whether she still reaches the agent (call.ts `admits`)
  expect(socket.headers.get("x-iterate-serve-admits")).toBe("call");
  // a member who opens a link comes in as themselves
  expect(await mind.post(member, `/guest/join${AGENT}`, { secret })).toEqual([
    200,
    { member: true },
  ]);
});

test("a join that the log refuses is said to the guest; the same guest joining again under another name passes", async () => {
  const mind = fakeMind();
  mind.share = await liveLink("s");
  // the key was used before with another payload: this guest joined already, and is in
  mind.share.links[0]!.guests.push({ userId: "guest:grace", name: "Grace", at: "" });
  mind.appendThrows = Object.assign(new Error("key used"), { code: "IDEMPOTENCY_CONFLICT" });
  expect(await mind.post(guest, `/guest/join${AGENT}`, { secret: "s" })).toEqual([
    200,
    { joined: true },
  ]);
  // any other failure is no join: the page shows these words
  mind.appendThrows = new Error("the context is busy");
  expect(await mind.post(guest, `/guest/join${AGENT}`, { secret: "s" })).toEqual([
    503,
    { error: "The meeting could not let you in just now. Try again." },
  ]);
});

test("a join waits for the call to show the guest, and says so when it does not in time", async () => {
  const mind = fakeMind();
  mind.share = await liveLink("s");
  mind.holdFold = true;
  expect(await mind.post(guest, `/guest/join${AGENT}`, { secret: "s" })).toEqual([
    503,
    { error: "The meeting could not let you in just now. Try again." },
  ]);
  // the fold lands while the join waits: the join answers then
  const later = mind.post(guest, `/guest/join${AGENT}`, { secret: "s" });
  setTimeout(
    () => mind.share.links[0]!.guests.push({ userId: "guest:grace", name: "Grace", at: "" }),
    100,
  );
  expect(await later).toEqual([200, { joined: true }]);
});

test("a guest is refused on a member's page, and taken on the pages for guests", async () => {
  const mind = fakeMind();
  for (const path of ["/", `/contexts${AGENT}`])
    expect(await mind.get(guest, path)).toMatchObject({ status: 401 });
  expect(await mind.get(member, `/contexts${AGENT}`)).toMatchObject({ status: 200 });
  expect(await mind.get(member, "/contexts/repos/config")).toMatchObject({ status: 404 });
  expect(await mind.get(nobody, `/join${AGENT}`)).toMatchObject({ status: 200 });
  expect(await mind.get(nobody, `/in${AGENT}`)).toMatchObject({ status: 401 });
  expect(await mind.get(guest, `/in${AGENT}`)).toMatchObject({ status: 200 });
  expect(await mind.get(nobody, "/invite.js")).toMatchObject({ status: 200 });
  // the app describes itself: a guest's sign-in, or a member's passkey
  expect(await (await mind.get(nobody, "/.well-known/iterate-app")).json()).toEqual({
    name: "Meet",
    icon: "/icon.svg",
    signIn: ["guest", "passkey"],
  });
});

test("the calendar invite: Google's form filled in, and an .ics with escaped text, CRLF and folded lines", async () => {
  const invite = await inviteModule();
  const start = invite.nextQuarter(new Date("2026-11-19T10:31:00Z"));
  expect(start.toISOString()).toBe("2026-11-19T10:45:00.000Z");
  const meeting = {
    title: "Plan; budget, Q1\nwith Zoë",
    start,
    minutes: 30,
    link: "https://meet.example.org/join/agents/meet/x#secret",
    uid: "u1@meet.example.org",
    stamp: new Date("2026-11-19T10:31:00Z"),
  };
  const google = new URL(invite.googleCalendarUrl(meeting));
  expect(Object.fromEntries(google.searchParams)).toEqual({
    action: "TEMPLATE",
    text: meeting.title,
    dates: "20261119T104500Z/20261119T111500Z",
    details: `Join the meeting: ${meeting.link}`,
    location: meeting.link,
  });
  const ics = invite.icsOf(meeting);
  expect(ics.split("\r\n")).toContain("SUMMARY:Plan\\; budget\\, Q1\\nwith Zoë");
  expect(ics).toContain("DTSTART:20261119T104500Z\r\nDTEND:20261119T111500Z\r\n");
  expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
  expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  expect(invite.escapeText("a\\b")).toBe("a\\\\b");
  // a title that tries to end its line and add one of its own stays inside SUMMARY
  const forged = invite.icsOf({ ...meeting, title: "Plan\r\nATTENDEE:mailto:x@example.com" });
  expect(forged.split("\r\n")).toContain("SUMMARY:Plan\\nATTENDEE:mailto:x@example.com");
  expect(forged.split("\r\n").filter((line) => line.startsWith("ATTENDEE"))).toEqual([]);
  // and Google's link holds it encoded, never as a line end of its own
  const link = invite.googleCalendarUrl({ ...meeting, title: "Plan\r\nATTENDEE:x" });
  expect(link).not.toMatch(/[\r\n]/);
  expect(new URL(link).searchParams.get("text")).toBe("Plan\r\nATTENDEE:x");
  // a long title folds: no line over 75 octets, each next line starts with a space, and no
  // character is split
  const long = invite.icsOf({ ...meeting, title: "ä".repeat(100) });
  const lines = long.split("\r\n");
  const summary = lines.slice(lines.findIndex((line) => line.startsWith("SUMMARY:")));
  expect(summary[1]).toMatch(/^ ä+$/);
  for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  expect(long.replace(/\r\n /g, "")).toContain(`SUMMARY:${"ä".repeat(100)}\r\n`);
});

// ── who asks of the app, as the boundary stamps a request ──
const nobody = {};
const guest = {
  "x-itx-person": stampJsonOf({ userId: "guest:grace", email: "", name: "Grace", method: "guest" }),
};
const member = {
  "x-itx-person": stampJsonOf({
    userId: "user_owner",
    email: "owner@example.net",
    name: "owner",
    method: "passkey",
  }),
  "x-itx-principal": JSON.stringify({ actor: "user_owner", email: "owner@example.net" }),
};

/** A link live for an hour, whose secret is `secret`, made by the owner. */
async function liveLink(secret: string): Promise<ShareState> {
  return {
    links: [
      {
        link: LINK,
        secretHash: await sha256(secret),
        until: Date.now() + 3_600_000,
        madeAt: "",
        madeBy: { actor: "user_owner", name: "owner" },
        endedAt: null,
        guests: [],
      },
    ],
  };
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Invite = {
  title: string;
  start: Date;
  minutes: number;
  link: string;
  uid: string;
  stamp: Date;
};
/** The page's plain JavaScript, loaded by its address. */
async function inviteModule(): Promise<{
  nextQuarter(now: Date): Date;
  googleCalendarUrl(invite: Invite): string;
  icsOf(invite: Invite): string;
  escapeText(text: string): string;
}> {
  return await import(
    new URL("../../configs/default/apps/meet/public/invite.js", import.meta.url).href
  );
}

/** The root that `startMeeting` reaches: which agents exist, which have a call, what it did. */
function fakeStart(agents: string[]) {
  const mind = { agents, calls: new Set<string>(), done: [] as unknown[][] };
  const itx = {
    // no `list`: a meeting reads one path's rows, never the list of every agent
    agents: {
      create: async (path: string) => {
        mind.done.push(["create", path]);
        return { path };
      },
    },
    cd: (path: string) => ({
      append: async (event: unknown) => mind.done.push(["append", path, event]),
      processors: {
        list: async () => [
          ...(mind.agents.includes(path) ? [{ name: "agent" }] : []),
          ...(mind.calls.has(path) ? [{ name: "call" }] : []),
        ],
        enable: (name: string, spec: unknown) => mind.done.push(["enable", path, name, spec]),
      },
    }),
  };
  // the few calls startMeeting makes, of the root's whole API
  return Object.assign(mind, { itx: itx as unknown as MeetingItx });
}

/** The app on a fake mind: the catalog lists the agent AGENT, and its call facet's state is
 *  `share`. */
function fakeMind() {
  const mind = {
    share: { links: [] } as ShareState,
    appended: [] as { path: string; event: unknown }[],
    facetAsked: [] as string[],
    /** What the next append throws, if anything. */
    appendThrows: null as unknown,
    /** The call does not fold a join. */
    holdFold: false,
  };
  const itx = {
    [Symbol.dispose]() {},
    contexts: {
      // the agent's subtree, the most recently active first: ten busy children come before it
      list: async ({ under, limit }: { under: string; limit: number }) =>
        under === AGENT
          ? [
              ...Array.from({ length: 10 }, (_, n) => ({ path: `${AGENT}/sandbox-${n}` })),
              { path: AGENT },
            ].slice(0, limit)
          : [],
    },
    cd: (path: string) => ({
      append: async (event: unknown) => {
        if (mind.appendThrows) throw mind.appendThrows;
        mind.appended.push({ path, event });
        // the call's processor folds a guest's join into its state, unless the test holds it
        const joined = event as {
          type: string;
          payload: { link: string; guest: { userId: string; name: string } };
        };
        if (joined.type === "share/guest-joined" && !mind.holdFold)
          mind.share.links
            .find((link) => link.link === joined.payload.link)
            ?.guests.push({ ...joined.payload.guest, at: "" });
      },
      facets: {
        get: () => ({
          snapshot: async () => {
            mind.facetAsked.push(path);
            return { offset: 0, state: mind.share };
          },
        }),
      },
    }),
  };
  const host = { auth, getItx: () => itx } as unknown as Parameters<
    ReturnType<typeof meetApp>["fetch"]
  >[1];
  const app = meetApp({ joinFoldMs: 300 });
  const fetch = (who: Record<string, string>, path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`https://meet.example.org${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-iterate-control-plane-hostname": "iterate.example.com",
          ...who,
          ...(init.headers as Record<string, string>),
        },
      }),
      host,
    );
  return Object.assign(mind, {
    get: (who: Record<string, string>, path: string, headers: Record<string, string> = {}) =>
      fetch(who, path, { headers }),
    async post(
      who: Record<string, string>,
      path: string,
      body: unknown,
    ): Promise<[number, unknown]> {
      const answer = await fetch(who, path, { method: "POST", body: JSON.stringify(body) });
      return [answer.status, await answer.json().catch(() => null)];
    },
  });
}
