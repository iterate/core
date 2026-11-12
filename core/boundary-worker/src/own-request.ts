// own-request.ts — WHAT THE MIND'S OWN REQUEST TO ONE OF ITS HOSTS CARRIES IN. The door hands such
// a request to the boundary's own handler (./door.ts), since a fetch inside the zone fails. It is
// nobody's request: no session rides in on it, and it says nothing about where it came from.
// Cloudflare sets a visitor's address on a request from outside (`cf-connecting-ip`), and the auth
// Worker counts its limits by that header (codes by email, passkey tries, device sign-ins). The
// mind's own code could name any address there, and so pass those limits or spend another
// visitor's. So every header that is the edge's word about a caller is dropped, and the boundary
// says the one thing it knows: the request is the mind's own. All such requests carry one fixed
// address, so they share one client's limit, and cannot use up the stack's limits, which would
// stop the members' sign-ins.
const THE_EDGES_WORD = /^(cf-|x-forwarded-|x-real-ip$|true-client-ip$|forwarded$)/;

/** The address every request of the mind's own carries: IANA's IPv4 dummy address (RFC 7600),
 *  which no visitor has. */
export const OWN_REQUEST_ADDRESS = "192.0.0.8";

export function ownRequestHeaders(headers: Headers): Headers {
  // Iterated header names are lowercase.
  const kept = new Headers(
    [...headers].filter(([name]) => name !== "cookie" && !THE_EDGES_WORD.test(name)),
  );
  kept.set("cf-connecting-ip", OWN_REQUEST_ADDRESS);
  return kept;
}
