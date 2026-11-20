// share-links.js — PURE: what the Dash's Share pane (agent-share.js) appends to an agent's log, and
// the link it shows once. The events and their rules are the call's (../../../call/share.ts): a
// link lets a guest into that one agent's chat and call, through Meet's guest page
// (`https://meet.<zone>/join<agent>#<secret>`, ../../meet/app.ts), which checks the link by the
// call's state. A page cannot import a .ts file, so the event names are written here again, and
// core/lib's config-default-dash.test.ts folds what this makes through call/share.ts.

export const LINK_MADE = "share/link-made";
export const LINK_ENDED = "share/link-ended";

const HOUR = 3_600_000;
/** How long a new link lives: the choices (7 days at most, the share rules' own limit), and the
 *  one chosen first. */
export const LIFETIMES = [
  { label: "For 1 hour", ms: HOUR },
  { label: "For 1 day", ms: 24 * HOUR },
  { label: "For 7 days", ms: 7 * 24 * HOUR },
];
export const DEFAULT_LIFETIME = 24 * HOUR;

/** WHAT A GUEST GETS, right above "Make a link", so it is on screen at every press of it. True for
 *  an agent with tools and secrets: the platform's view of the context hides addresses, not what
 *  people typed. */
export const GUEST_GETS = [
  "Whoever has this link can read this whole conversation: everything people typed here, and the agent's scripts and their results.",
  "They can write to the agent and join its call, and the agent acts for them with everything it can reach: its tools, its secrets and its files.",
  "A link works until it ends, and you can end it here.",
];

/** One part of an agent's path: a letter or digit first, then letters, digits and `._:@+-`. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;

/** The agent's path if `value` is one, exactly as written, else null: `/agents/<part>(/<part>)*`,
 *  at most 300 characters. Nothing is decoded or resolved, so the path checked is the path used. */
export function agentPathOf(value) {
  if (typeof value !== "string" || value.length > 300) return null;
  const [empty, agents, ...rest] = value.split("/");
  if (empty !== "" || agents !== "agents" || rest.length === 0) return null;
  return rest.every((part) => SEGMENT.test(part)) ? value : null;
}

const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** A link's secret as the log knows it: the SHA-256 of its text, lower-case hex. */
export const hashOfSecret = async (secret) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** A new link to `agent`, on the zone `zone`: 32 random bytes as its secret (base64url), its hash,
 *  a UUID as its id. Answers the ONE event to append and the link to show once,
 *  `https://meet.<zone>/join<agent>#<secret>`: the secret is in the fragment alone, which no
 *  request carries, and the log keeps its hash alone. */
export async function makeLink({ zone, agent, lifetimeMs, now }) {
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const secretHash = await hashOfSecret(secret);
  const link = crypto.randomUUID();
  return {
    event: {
      type: LINK_MADE,
      idempotencyKey: `${LINK_MADE}:${link}`,
      payload: { link, secretHash, until: now + lifetimeMs },
    },
    url: `https://meet.${zone}/join${agent}#${secret}`,
  };
}

/** The event that ends `link`. */
export const endLink = (link) => ({
  type: LINK_ENDED,
  idempotencyKey: `${LINK_ENDED}:${link}`,
  payload: { link },
});
