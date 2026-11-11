// entries.ts — THE GUESTBOOK'S ENTRIES, as its log tells them. Every change is an event on the
// context GUESTBOOK_PATH, and the page is a reduction of that log:
//
//   guestbook/entry-written   { text, replyTo?, by: { userId, email } }   the entry's id is this event's offset
//   guestbook/entry-approved  { entry, by }                               a member showed it to everyone
//   guestbook/entry-removed   { entry, by }                               a member took it away
//
// The types have no `events.iterate.com/` prefix: they are this app's own, and the platform reads
// none of them.
import type { Person } from "iterate/principal";

export const GUESTBOOK_PATH = "/apps/guestbook";
export const ENTRY_WRITTEN = "guestbook/entry-written";
export const ENTRY_APPROVED = "guestbook/entry-approved";
export const ENTRY_REMOVED = "guestbook/entry-removed";

const MAX_TEXT_CHARACTERS = 1000;
/** How many entries one person may have waiting: more are refused until a member decides. */
const MAX_WAITING_PER_PERSON = 5;

export type Entry = {
  id: number;
  text: string;
  /** The entry this one answers. */
  replyTo?: number;
  by: Person;
  at: string;
  status: "waiting" | "approved" | "removed";
};

type LogEvent = { type: string; offset: number; createdAt: string; payload?: unknown };

export function entriesOf(events: readonly LogEvent[]): Map<number, Entry> {
  const entries = new Map<number, Entry>();
  for (const event of events) {
    const payload = (event.payload || {}) as Record<string, unknown>;
    if (event.type === ENTRY_WRITTEN)
      entries.set(event.offset, {
        id: event.offset,
        text: String(payload.text),
        ...(typeof payload.replyTo === "number" && { replyTo: payload.replyTo }),
        by: payload.by as Person,
        at: event.createdAt,
        status: "waiting",
      });
    const entry = entries.get(Number(payload.entry));
    if (!entry) continue;
    // a removed entry stays removed
    if (event.type === ENTRY_APPROVED && entry.status === "waiting") entry.status = "approved";
    if (event.type === ENTRY_REMOVED) entry.status = "removed";
  }
  return entries;
}

/** Why `person` may not write this, or null. A reply names an entry everyone can see. */
export function refusalOf(
  entries: ReadonlyMap<number, Entry>,
  person: Person,
  input: { text: unknown; replyTo?: unknown },
): string | null {
  if (typeof input.text !== "string" || !input.text.trim()) return "An entry needs some text.";
  if (input.text.length > MAX_TEXT_CHARACTERS)
    return `An entry is ${MAX_TEXT_CHARACTERS} characters at most.`;
  if (input.replyTo) {
    const answered = typeof input.replyTo === "number" ? entries.get(input.replyTo) : undefined;
    if (answered?.status !== "approved") return "The entry you answer is not in the guestbook.";
  }
  const waiting = [...entries.values()].filter(
    (entry) => entry.status === "waiting" && entry.by.userId === person.userId,
  );
  if (waiting.length >= MAX_WAITING_PER_PERSON)
    return `You have ${MAX_WAITING_PER_PERSON} entries waiting for approval. Wait for a member to read them.`;
  return null;
}

/** What one viewer sees: everyone the approved entries, a person their own waiting ones too, a
 *  member every waiting one. Only a member sees a whole address. */
export function viewOf(
  entries: ReadonlyMap<number, Entry>,
  viewer: { person: Person | null; member: boolean },
) {
  return [...entries.values()]
    .filter(
      (entry) =>
        entry.status === "approved" ||
        (entry.status === "waiting" &&
          (viewer.member || entry.by.userId === viewer.person?.userId)),
    )
    .map(({ by, ...entry }) => ({
      ...entry,
      author: viewer.member ? by.email : by.email.split("@")[0],
      mine: by.userId === viewer.person?.userId,
    }));
}
