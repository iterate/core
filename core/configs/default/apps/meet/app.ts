// app.ts — MEET, as worker.ts mounts it: one page for any agent's call, and the guest routes for the
// guests of a share link. It has no API of its own. A member's page talks to the mind over its
// `/itx` socket: the agent's chat, the call facet (../../call.ts), and `itx.config.startMeeting`
// (meeting.ts). A guest's page talks over the platform's view of the one agent's context, which
// the guest routes below open for a guest of a live share link (../../call/share.ts).
//
//   GET  /                          a member: start a meeting, and the recent ones
//   GET  /contexts/<agent>          a member: the agent's chat and its call
//   GET  /itx, /.auth/*             a member: the page's socket, and what the kit's shell asks
//   GET  /join/<agent>#<secret>     anyone: a guest's link; the page keeps the secret in the tab
//   GET  /in/<agent>                anyone signed in, a guest too: the platform's sign-in first
//   POST /guest/check/<agent>       anyone: { secret } → { live }
//   POST /guest/join/<agent>        anyone signed in: { secret } → the guest on the link
//   GET  /guest/itx/<agent>         a guest of a live link: the WebSocket of their view of the agent
//
// `<agent>` is the agent's path (`/agents/meet/2026-11-19-1030-standup`). Before anyone who is no
// member reaches an agent's context, the mind's catalog must list it: a stranger makes no context.
// Only the guest's routes take a guest (`{ guests: true }`); each counts before it reads.
import {
  type AppDescription,
  type IterateConfigEntrypoint,
  serveAppDescription,
  serveFiles,
} from "iterate/sdk";
import { errorCode, reportIssue } from "iterate/lib";
import { z } from "zod";
import { GUEST_JOINED, isLive, isLiveGuest, type ShareState } from "../../call/share.ts";
import theme from "../theme.css";
import index from "./index.html";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";

/** WHAT MEET SAYS OF ITSELF: its people sign in as guests (a typed name) or with a member's
 *  passkey; someone already signed in to the mind comes in as themselves. */
const MEET: AppDescription = { name: "Meet", icon: "/icon.svg", signIn: ["guest", "passkey"] };
/** An agent's path in a URL: under `/agents`, eight names at most. */
const AGENT = /^\/agents(?:\/[A-Za-z0-9][\w.@+-]{0,99}){1,8}$/;
/** What a check and a join send: the link's secret. */
const SecretBody = z.object({ secret: z.string().max(200) });
const ROUTE = /^\/(contexts|join|in|guest\/check|guest\/join|guest\/itx)(\/.*)$/;

type Host = Pick<IterateConfigEntrypoint, "auth" | "getItx">;
type Itx = ReturnType<Host["getItx"]>;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const notFound = () => new Response("Not found\n", { status: 404 });

/** The SHA-256 of a link's secret as the link writes it, lower-case hex. */
async function secretHashOf(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** How long a join waits for the call to show the guest on the link, so that the guest's socket,
 *  which the page opens next, finds them there. */
const JOIN_FOLD_MS = 3_000;

export function meetApp({ joinFoldMs = JOIN_FOLD_MS }: { joinFoldMs?: number } = {}) {
  /** Each route's count in the current minute, by key, in this isolate. */
  const counts = new Map<string, { minute: number; count: number }>();
  const over = (key: string, limit: number) => {
    const minute = Math.floor(Date.now() / 60_000);
    const seen = counts.get(key);
    const count = seen?.minute === minute ? seen.count + 1 : 1;
    if (counts.size >= 1_000 && !seen) counts.clear();
    counts.set(key, { minute, count });
    return count > limit;
  };
  /** Agents this isolate saw in the catalog; misses are asked again after 10 s. */
  const known = new Set<string>();
  const missed = new Map<string, number>();
  async function exists(itx: Itx, agent: string) {
    if (known.has(agent)) return true;
    if (Date.now() - (missed.get(agent) || 0) < 10_000) return false;
    // the catalog has no exact read: the agent's subtree, the most recently active first, in its
    // largest page, so that a busy agent's own children do not push it out
    const rows = await itx.contexts.list({ under: agent, limit: 1_000 });
    if (rows.some((row) => row.path === agent)) known.add(agent);
    else {
      if (missed.size >= 1_000) missed.clear();
      missed.set(agent, Date.now());
    }
    return known.has(agent);
  }
  /** The agent's share links, folded through its log now (the call facet's state); none when the
   *  agent has no call. */
  async function shareOf(itx: Itx, agent: string): Promise<ShareState> {
    const call = itx.cd(agent).facets.get<{ snapshot(): Promise<{ state: ShareState }> }>("call");
    return await call.snapshot().then(
      (snapshot) => snapshot.state,
      () => ({ links: [] }),
    );
  }
  /** The live link whose secret is `secret`, or undefined. */
  async function linkOf(itx: Itx, agent: string, secret: string) {
    if (!secret || !(await exists(itx, agent))) return undefined;
    const [state, hash] = await Promise.all([shareOf(itx, agent), secretHashOf(secret)]);
    return state.links.find((link) => link.secretHash === hash && isLive(link, Date.now()));
  }
  const page = (request: Request) =>
    serveFiles(new Request(new URL("/", request.url), request), { index, files });
  /** The guest's page: for anyone, never indexed, no referrer. */
  async function guestPage(request: Request) {
    const answer = await page(request);
    const headers = new Headers(answer.headers);
    headers.set("x-robots-tag", "noindex");
    headers.set("referrer-policy", "no-referrer");
    return new Response(answer.body, { status: answer.status, headers });
  }
  /** The secret of a link, from a small JSON body. */
  async function secretOf(request: Request) {
    const text = await request.text();
    if (text.length > 1_000) return "";
    try {
      return SecretBody.safeParse(JSON.parse(text || "{}")).data?.secret || "";
    } catch {
      return "";
    }
  }

  /** THE GUEST ROUTES, a guest's way in: the link's check, the join, and the socket that is the
   *  guest's view. */
  async function guestRoute(request: Request, host: Host, agent: string, route: string) {
    using itx = host.getItx();
    if (route === "guest/check") {
      if (over("check", 60)) return json({ error: "Too many checks. Try again in a minute." }, 429);
      return json({ live: Boolean(await linkOf(itx, agent, await secretOf(request))) });
    }
    const refused = host.auth.requirePerson(request, { guests: true });
    if (refused) return refused;
    const person = host.auth.person(request, { guests: true })!;
    // a member comes in as themselves, on the member's page
    if (!host.auth.require(request)) return json({ member: true });
    const ended = { error: "This link has ended. Ask for a new one." };
    if (route === "guest/join") {
      if (over(`join:${person.userId}`, 60))
        return json({ error: "Too many tries. Try again in a minute." }, 429);
      const link = await linkOf(itx, agent, await secretOf(request));
      if (!link) return json(ended, 410);
      const appended = await itx
        .cd(agent)
        .append({
          type: GUEST_JOINED,
          idempotencyKey: `${GUEST_JOINED}:${link.link}:${person.userId}`,
          payload: {
            link: link.link,
            guest: { userId: person.userId, name: person.name || "Guest" },
          },
        })
        .then(
          () => true,
          (error: unknown) => {
            // a guest who joined this link before under another name: the first join stands (the
            // same name again appends nothing and does not throw)
            if (errorCode(error) === "IDEMPOTENCY_CONFLICT") return true;
            reportIssue("config.meet.guest-join-failed", error, { agent });
            return false;
          },
        );
      const busy = { error: "The meeting could not let you in just now. Try again." };
      if (!appended) return json(busy, 503);
      // the socket admits a guest by the call's state, which folds the join a moment after the
      // append: answer once it shows them, or say so after `joinFoldMs`
      for (const until = Date.now() + joinFoldMs; ;) {
        if (isLiveGuest(await shareOf(itx, agent), person.userId, Date.now()))
          return json({ joined: true });
        if (Date.now() >= until) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      reportIssue(
        "config.meet.guest-join-not-folded",
        new Error("the call did not show the join"),
        {
          agent,
        },
      );
      return json(busy, 503);
    }
    // the socket: the platform's view of the ONE agent's context, for a guest of a live link now
    if (over(`itx:${person.userId}`, 120))
      return json({ error: "Too many tries. Try again in a minute." }, 429);
    if (
      !(await exists(itx, agent)) ||
      !isLiveGuest(await shareOf(itx, agent), person.userId, Date.now())
    )
      return json(ended, 403);
    return host.auth.personItx(request, agent, { guests: true });
  }

  return {
    async fetch(request: Request, host: Host): Promise<Response> {
      const described = serveAppDescription(request, MEET);
      if (described) return described;
      const { pathname } = new URL(request.url);
      // the member's socket, and what the kit's shell asks of its host
      const member = host.auth.memberPage(request);
      if (member) return member;
      // the page's files hold no data: anyone loads them, a guest too
      if (/^\/[^/]+\.[a-z]+$/.test(pathname))
        return serveFiles(request, { files: { ...files, "theme.css": theme } });
      const [, route = "", agent = ""] = ROUTE.exec(pathname) || [];
      if (route.startsWith("guest/")) {
        if (!AGENT.test(agent)) return notFound();
        if (route === "guest/itx" || request.method === "POST")
          return guestRoute(request, host, agent, route);
        return new Response("Method not allowed\n", { status: 405 });
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Method not allowed\n", { status: 405 });
      if (pathname !== "/" && !AGENT.test(agent)) return notFound();
      if (route === "join") return guestPage(request);
      if (route === "in")
        return host.auth.requirePerson(request, { guests: true }) || guestPage(request);
      return host.auth.require(request) || page(request);
    },
  };
}
