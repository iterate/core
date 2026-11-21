// call/share-api.ts — AN AGENT'S LINKS FOR GUESTS, as functions of the config: worker.ts offers them
// as `itx.config.shareAgent`, `itx.config.shareLinks` and `itx.config.endShare`, so the member's
// own agent does what the Dash's Share and Meet's Guests do. The link is made by the one module
// that the pages use too (../apps/dash/public/share-links.js); the events and the rules that admit
// a guest are ./share.ts's. Nothing here is a new rule: a link this appends admits only when
// ./share.ts folds it, so this function waits for that fold and answers only a link that admits.
//
// WHO A LINK MADE HERE NAMES AS ITS MAKER is the stamp the platform puts on the config's append,
// never a word of the caller's: the person a script or an agent's turn runs for, when the platform
// names one. It names nobody for a call that a member's own script makes straight on its socket
// (`itx.config.shareAgent(…)` with no script run between): the append is then the config's own,
// from `/`, and the link says "this mind's own code" (./share.ts `MADE_BY_THE_MIND`), with
// `madeBy.actor` null. The link admits all the same. The Dash's own button appends through the
// member's stub, so its link names the member.
import { reportIssue } from "iterate/lib";
import { CALL_FACET } from "../call.ts";
// @ts-expect-error -- a plain browser module of the Dash, with no types; `Links` below says what it exports
import * as untypedLinks from "../apps/dash/public/share-links.js";
import { isLive, type ShareState } from "./share.ts";

/** What share-links.js exports, of what this file uses. A cast, safe: the module is the template's
 *  own, and core/lib's config-default-dash.test.ts calls each of these as typed here. */
type Links = {
  makeLink(input: { zone: string; agent: string; lifetimeMs: number; now: number }): Promise<{
    event: { type: string; idempotencyKey: string; payload: object };
    url: string;
    link: string;
    until: number;
  }>;
  endLink(link: string): { type: string; idempotencyKey: string; payload: { link: string } };
  agentPathOf(value: unknown): string | null;
  DEFAULT_LIFETIME: number;
};
const links = untypedLinks as Links;

/** What these functions reach of the mind: the catalog, one agent's context, its call, and the
 *  zone. */
export type ShareItx = {
  url(): Promise<string>;
  contexts: { list(options: { under: string; limit: number }): Promise<{ path: string }[]> };
  cd(path: string): {
    append(event: object): Promise<unknown>;
    processors: {
      list(): Promise<{ name: string }[]>;
      enable(name: string, spec: object): Promise<unknown>;
    };
    facets: { get(name: string): { snapshot(): Promise<{ state: ShareState }> } };
  };
};

/** How long `shareAgent` waits for the call to fold its link. */
const FOLD_MS = 3_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The agent's path as written, when it is an agent of this mind; else it throws. The mind's
 *  catalog is asked first: a call to a path makes its context, so a path that the catalog does not
 *  list is refused with no call to it (the catalog lists a new agent at its creation: measured,
 *  21 Nov 2026). */
async function agentOf(itx: ShareItx, agent: unknown) {
  const path = links.agentPathOf(agent);
  if (!path) throw new Error(`${String(agent)} is no agent's path.`);
  // the catalog has no exact read: the agent's subtree in its largest page (apps/meet/app.ts)
  const listed = await itx.contexts.list({ under: path, limit: 1_000 });
  if (!listed.some((row) => row.path === path))
    throw new Error(`${path} is no agent of this mind.`);
  const rows = (await itx.cd(path).processors.list()).map((row) => row.name);
  // a guest's message goes to the `agent` facet: a link to a context with none opens a chat whose
  // every message fails
  if (!rows.includes("agent")) throw new Error(`${path} is no agent of this mind.`);
  return { path, callOn: rows.includes("call") };
}

/** The agent's share state now, folded by its call; none when it has no call yet. */
const shareOf = (itx: ShareItx, path: string): Promise<ShareState> =>
  itx
    .cd(path)
    .facets.get("call")
    .snapshot()
    .then(
      (snapshot) => snapshot.state,
      () => ({ links: [] }),
    );

/**
 * A NEW LINK FOR GUESTS to the agent `agent`: anyone who has it comes into that one agent's chat
 * and call, with a name and no account, until `until` or until a member ends it. It lives
 * `lifetimeMs` (a day when not given). More than 7 days is refused, before anything is turned on
 * or written: a link never lives another time than the one asked for. The call is turned on for
 * the agent first when it is off: its facet holds the links and admits a guest. Answers
 * `{ url, until, link }`:
 * `url` is the one place the secret is, so give it to the person and keep it nowhere else.
 */
export async function shareAgent(
  itx: ShareItx,
  input: { agent: string; lifetimeMs?: number },
  { foldMs = FOLD_MS }: { foldMs?: number } = {},
) {
  const { path, callOn } = await agentOf(itx, input.agent);
  const agent = itx.cd(path);
  const zone = new URL(await itx.url()).hostname;
  // the link first: a life that is refused (over 7 days, or no positive number) turns no call on
  const made = await links.makeLink({
    zone,
    agent: path,
    lifetimeMs: input.lifetimeMs ?? links.DEFAULT_LIFETIME,
    now: Date.now(),
  });
  if (!callOn) await agent.processors.enable("call", CALL_FACET);
  await agent.append(made.event);
  // the call admits by its own fold of the link (./share.ts `admitsAsMade`): answer once it shows
  // the link live, or end the link and say so
  for (const until = Date.now() + foldMs; ;) {
    const { links: known } = await shareOf(itx, path);
    if (known.some((one) => one.link === made.link && isLive(one, Date.now())))
      return { url: made.url, until: made.until, link: made.link };
    if (Date.now() >= until) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await agent.append(links.endLink(made.link));
  reportIssue("config.share.link-not-folded", new Error("the call did not show the link"), {
    agent: path,
  });
  throw new Error(
    `The link to ${path} admits nobody: the call did not take it. A link made for someone who is no member admits nobody.`,
  );
}

/** THE AGENT'S LIVE LINKS: who made each, until when, and the guests who came by it. No secret
 *  and no hash: neither is in the answer. */
export async function shareLinks(itx: ShareItx, input: { agent: string }) {
  const { path } = await agentOf(itx, input.agent);
  const now = Date.now();
  return (await shareOf(itx, path)).links
    .filter((one) => isLive(one, now))
    .map(({ link, until, madeAt, madeBy, guests }) => ({ link, until, madeAt, madeBy, guests }));
}

/** ENDS THE LINK `link` to the agent `agent`: its guests are out at the call's next look. Ending
 *  a link that has ended, or one that never was, changes nothing and answers the same. */
export async function endShare(itx: ShareItx, input: { agent: string; link: string }) {
  const { path } = await agentOf(itx, input.agent);
  if (!UUID.test(String(input.link))) throw new Error(`${String(input.link)} is no link's id.`);
  await itx.cd(path).append(links.endLink(input.link));
  return { link: input.link };
}
