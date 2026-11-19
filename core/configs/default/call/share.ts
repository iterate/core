// call/share.ts — A CONTEXT'S SHARE LINKS: who may come in as a guest. Three events on the shared
// context's own log, and their state, folded here. Pure: zod alone, so a Node test loads it. The
// call's processor (../call.ts) folds them into its own state, and the call (rules.ts) reads it to
// let a guest in. It is the template's one copy of the share rules: iterate.com's config keeps its
// own (`share-links/`), which the template cannot import, and the two are the same rules.
//
//   share/link-made     { link, secretHash, until }   a new link: its public id, the SHA-256 of
//                                                      its secret (lower-case hex), its end (ms)
//   share/link-ended    { link }                       the link works no more, before its end
//   share/guest-joined  { link, guest: { userId, name } }  a guest came in by it (the page where
//                                                      guests land writes it)
//
// Who made or ended a link is the event's `source`, which the platform stamps, never a payload
// field. The log holds a link's secret only as its hash: a guest reads the whole context. A link
// is live while it is not ended and `now < until`.
//
// A `share/link-made` COUNTS ONLY AS MADE (`admitsAsMade`): the rule iterate.com's Dash applies
// (its config's `apps/dash/guest-rules.ts`, ported here word for word, with its tests). A link with
// no stamp (an agent's own script) or a member's stamp counts; any other stamp, or a mark of no
// speaker, admits nobody; and a link may live 7 days, with 10 minutes for the browser's clock.
import { z } from "zod";

const LINK_MADE = "share/link-made";
const LINK_ENDED = "share/link-ended";
const GUEST_JOINED = "share/guest-joined";
export const SHARE_EVENTS = [LINK_MADE, LINK_ENDED, GUEST_JOINED];

const LinkMade = z.object({
  link: z.string().uuid(),
  secretHash: z.string().regex(/^[0-9a-f]{64}$/),
  until: z.number().int().positive(),
});
const LinkEnded = z.object({ link: z.string().uuid() });
const GuestJoined = z.object({
  link: z.string().uuid(),
  guest: z.object({ userId: z.string().min(1), name: z.string().trim().min(1).max(80) }),
});

/** Who made or ended a link, as a page draws them: an id and a name, never an address, because a
 *  guest reads this state. `actor` is null when no person wrote the event. */
const By = z.object({ actor: z.string().nullable(), name: z.string() });
const ShareLink = z.object({
  link: z.string(),
  secretHash: z.string(),
  until: z.number(),
  madeAt: z.string(),
  madeBy: By,
  endedAt: z.string().nullable(),
  guests: z.array(z.object({ userId: z.string(), name: z.string(), at: z.string() })),
});
export type ShareLink = z.infer<typeof ShareLink>;
export const ShareState = z.object({ links: z.array(ShareLink).default([]) });
export type ShareState = z.infer<typeof ShareState>;

/** What the fold reads of an event: the platform's `StreamEvent`, structurally. */
export type ShareEvent = {
  type: string;
  payload?: unknown;
  createdAt: string;
  source: {
    origin?: string;
    principal?: { email?: string; actor?: string; name?: string } | null;
    onBehalfOf?: { principal?: { email?: string; actor?: string; name?: string } };
  };
};

/** The longest life a link may have: the Dash's longest choice, 7 days. */
export const LONGEST_LIFETIME_MS = 7 * 24 * 3_600_000;
/** The pane sets `until` by the browser's clock, the platform `createdAt` by its own: a browser
 *  clock this far ahead still makes a 7-day link that admits. */
export const CLOCK_SLACK_MS = 600_000;
/** Marks of a source that name no speaker of this mind (as iterate/agents `speakerOf` reads them):
 *  a schedule fired it, a row copied it, the platform wrote it, or a key signed it. */
const NO_SPEAKER_MARKS = ["schedule", "copiedFrom", "platform", "signer"] as const;
/** A stamp field that is there at all. A stamp of `""`, `0` or `false` is there, and admits nobody:
 *  so this is no truthiness check (iterate.com's guest-rules.ts reads it the same way). */
// oxlint-disable-next-line iterate/simple-truthiness-check -- a falsy stamp that is not null is a stamp of no member, never "no stamp"
const present = (value: unknown) => value !== undefined && value !== null;
/** A member's stamp, as the platform writes one: an object with a non-empty string `actor` and no
 *  `kind` (a guest's is `kind: "guest"`, a mind's `kind: "mind"`: iterate/principal). */
const MemberStamp = z.object({ actor: z.string().min(1), kind: z.never().optional() });
const OnBehalfOfMember = z.object({ principal: MemberStamp });

/** WHETHER A `share/link-made` MAY ADMIT, by the platform's stamp and its life, never by who asked:
 *   - its source has neither `principal` nor `onBehalfOf` (an agent's own script, which carries no
 *     stamp), or the stamp is a member's (`MemberStamp`): the principal when there is one (it
 *     decides alone), else `onBehalfOf.principal`. Any other stamp (a guest's, a mind's, `{}`, an
 *     `onBehalfOf` with no principal), or a source with a mark of no speaker, admits nobody.
 *   - its `until` is at most `LONGEST_LIFETIME_MS` + `CLOCK_SLACK_MS` after its `createdAt`. */
export function admitsAsMade(event: Pick<ShareEvent, "source" | "createdAt" | "payload">): boolean {
  const source: Record<string, unknown> = { ...event.source };
  if (NO_SPEAKER_MARKS.some((mark) => source[mark])) return false;
  // the principal decides alone when there is one; else `onBehalfOf.principal`; else no stamp
  const byMember = present(source.principal)
    ? MemberStamp.safeParse(source.principal).success
    : !present(source.onBehalfOf) || OnBehalfOfMember.safeParse(source.onBehalfOf).success;
  if (!byMember) return false;
  const at = Date.parse(event.createdAt);
  const made = z.object({ until: z.number() }).safeParse(event.payload);
  return made.success && made.data.until - at <= LONGEST_LIFETIME_MS + CLOCK_SLACK_MS;
}

/** Who wrote an event: the person by their id and a name (the stamp's own, else the part of the
 *  address before the "@"), else the context it was written from. Never the address. */
function byOf(event: Pick<ShareEvent, "source">) {
  const person = event.source.principal || event.source.onBehalfOf?.principal;
  if (!person?.actor) return { actor: null, name: event.source.origin || "unknown" };
  const name = person.name || person.email?.split("@", 1)[0] || person.actor;
  return { actor: person.actor, name };
}

/** The state after `event`; the same object when it changes nothing. A `link-made` that
 *  `admitsAsMade` refuses, a second one for a known id, and an event for an unknown link, change
 *  nothing; a guest who joins again is updated. */
export function reduceShare(state: ShareState, event: ShareEvent): ShareState {
  const update = (link: string, change: (known: ShareLink) => ShareLink) => ({
    links: state.links.map((known) => (known.link === link ? change(known) : known)),
  });
  if (event.type === LINK_MADE) {
    const made = LinkMade.safeParse(event.payload);
    if (!made.success || !admitsAsMade(event)) return state;
    if (state.links.some((known) => known.link === made.data.link)) return state;
    const link = { ...made.data, madeAt: event.createdAt, madeBy: byOf(event), endedAt: null };
    return { links: [...state.links, { ...link, guests: [] }] };
  }
  if (event.type === LINK_ENDED) {
    const ended = LinkEnded.safeParse(event.payload);
    if (!ended.success || !state.links.some((known) => known.link === ended.data.link))
      return state;
    return update(ended.data.link, (known) => ({
      ...known,
      endedAt: known.endedAt || event.createdAt,
    }));
  }
  if (event.type === GUEST_JOINED) {
    const joined = GuestJoined.safeParse(event.payload);
    if (!joined.success || !state.links.some((known) => known.link === joined.data.link))
      return state;
    const guest = { ...joined.data.guest, at: event.createdAt };
    return update(joined.data.link, (known) => ({
      ...known,
      guests: [...known.guests.filter((g) => g.userId !== guest.userId), guest],
    }));
  }
  return state;
}

/** The link works at `now`: not ended, and before its end. */
export const isLive = (link: ShareLink, now: number) => !link.endedAt && now < link.until;

/** Whether a person is a guest of a live link of this state now: the one rule that lets a person
 *  who is no member into the call, and keeps them in it. */
export const isLiveGuest = (state: ShareState, userId: string, now: number) =>
  state.links.some((link) => isLive(link, now) && link.guests.some((g) => g.userId === userId));
