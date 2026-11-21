// share-links.js — PURE: THE TEMPLATE'S ONE LINK-MAKING for guests, and the event that ends a link.
// The Dash's Share (the kit's, which app.js's `share` hands it to) and Meet's page append what it
// makes through the member's own stub; `itx.config.shareAgent` (../../../call/share-api.ts) appends it as the config.
// The events and their rules are the call's (../../../call/share.ts): a link lets a guest into that
// one agent's chat and call, through Meet's guest page (`https://meet.<zone>/join<agent>#<secret>`,
// ../../meet/app.ts), which checks the link by the call's state. It is a plain module because a
// page cannot import a .ts file; the config imports the Dash's file as it is.
// TWINS: apps/dash/public/share-links.js and apps/meet/public/share-links.js hold the same bytes,
// one in each app's folder, because an app follows the template whole. Change both together:
// core/lib's config-default-dash.test.ts holds them equal, and folds what they make through
// call/share.ts.

export const LINK_MADE = "share/link-made";
export const LINK_ENDED = "share/link-ended";

const HOUR = 3_600_000;
/** The longest life of a link: the share rules' own limit (call/share.ts `LONGEST_LIFETIME_MS`). */
export const LONGEST_LIFETIME = 7 * 24 * HOUR;
/** How long a link lives when its maker says nothing. */
export const DEFAULT_LIFETIME = 24 * HOUR;

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
 *  a UUID as its id. It lives `lifetimeMs`. Answers the ONE event to append, and the link to show
 *  once, `https://meet.<zone>/join<agent>#<secret>`, with its id and its end: the secret is in the
 *  fragment alone, which no request carries, and the log keeps its hash alone. A path that is no
 *  agent's, a life that is no positive number, or one longer than `LONGEST_LIFETIME`, throws: a
 *  link never lives another time than the one its maker asked for. */
export async function makeLink({ zone, agent, lifetimeMs, now }) {
  if (!agentPathOf(agent)) throw new Error(`${agent} is no agent's path.`);
  if (!(lifetimeMs > 0)) throw new Error("A link lives a positive number of milliseconds.");
  if (lifetimeMs > LONGEST_LIFETIME)
    throw new Error(
      `A link lives 7 days at most (${LONGEST_LIFETIME} ms); ${lifetimeMs} ms was asked for.`,
    );
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const secretHash = await hashOfSecret(secret);
  const link = crypto.randomUUID();
  const until = now + lifetimeMs;
  return {
    event: {
      type: LINK_MADE,
      idempotencyKey: `${LINK_MADE}:${link}`,
      payload: { link, secretHash, until },
    },
    url: `https://meet.${zone}/join${agent}#${secret}`,
    link,
    until,
  };
}

/** The event that ends `link`. */
export const endLink = (link) => ({
  type: LINK_ENDED,
  idempotencyKey: `${LINK_ENDED}:${link}`,
  payload: { link },
});
