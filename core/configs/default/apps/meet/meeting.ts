// meeting.ts — A MEETING is an agent with a call: `/agents/meet/<YYYY-MM-DD>-<HHMM>-<slug>`. This
// file makes the name from a time and a title (pure), and `startMeeting`, the one function that
// starts a meeting. Meet's page calls it as `itx.config.startMeeting(…)` over its own socket, and
// an agent calls it the same way (api.ts).
import type { IterateContextApiWith } from "iterate/api";
import { CALL_FACET } from "../../call.ts";

/** Where the meetings that Meet starts are. Meet opens any agent's call, not only these. */
const MEET_AGENTS = "/agents/meet";
const WORDS =
  "amber birch cedar delta ember fern grove harbor iris juniper lumen meadow north opal pine quartz river slate tide willow".split(
    " ",
  );

/** A title as a name: lower-case letters, digits and dashes, 40 characters at most. A letter with
 *  a mark loses the mark ("é" is "e"); any other character is a dash. */
export function slugOf(title: string) {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** Three random words, for a meeting with no title. `random()` answers a number in [0, 1). */
const randomWords = (random: () => number) =>
  Array.from({ length: 3 }, () => WORDS[Math.floor(random() * WORDS.length)]).join("-");

/** The meeting's path for `now` (UTC) and `title`. */
export function meetingPath(now: Date, title: string, random: () => number = Math.random) {
  // 2026-11-19T10:30:59.000Z: the date, then the hour and the minute
  const iso = now.toISOString();
  const [date, hhmm] = [iso.slice(0, 10), iso.slice(11, 13) + iso.slice(14, 16)];
  return `${MEET_AGENTS}/${date}-${hhmm}-${slugOf(title) || randomWords(random)}`;
}

/** The mind's root, with the agents app's `agents`. */
export type MeetingItx = IterateContextApiWith<"agents">;

/**
 * STARTS A MEETING, and answers its path. With no `path`: a new agent under `/agents/meet/`, named
 * from now and the title (a name already taken gets "-2", "-3"). With `path`: that agent, which
 * must exist, and keeps its title. Either way the call is on for it. A new meeting's title is its
 * `itx/described` title. The meeting's page is `https://meet.<zone>/contexts<path>`.
 */
export async function startMeeting(
  itx: MeetingItx,
  options: { title?: string; path?: string } = {},
): Promise<{ path: string }> {
  const title = String(options.title || "")
    .trim()
    .slice(0, 80);
  // one path's own rows, not the list of every agent: an agent is a context with an `agent` row
  const rowsOf = async (at: string) => (await itx.cd(at).processors.list()).map((row) => row.name);
  let path = options.path;
  let rows: string[];
  if (path) {
    rows = await rowsOf(path);
    if (!rows.includes("agent")) throw new Error(`${path} is no agent of this mind.`);
  } else {
    const base = meetingPath(new Date(), title);
    path = base;
    for (let n = 2; (rows = await rowsOf(path)).includes("agent"); n += 1) path = `${base}-${n}`;
    await itx.agents.create(path);
  }
  const meeting = itx.cd(path);
  if (!rows.includes("call")) await meeting.processors.enable("call", CALL_FACET);
  // a new agent has no metadata yet, so the title is the whole record
  if (title && !options.path)
    await meeting.append({
      type: "events.iterate.com/itx/described",
      payload: { metadata: { title } },
    });
  return { path };
}
