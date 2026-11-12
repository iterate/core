// own-request.ts — WHAT THE MIND'S OWN REQUEST TO ONE OF ITS HOSTS CARRIES IN. The door hands such
// a request to the boundary's own handler (./door.ts), since a fetch inside the zone fails. It is
// nobody's request: no session rides in on it, and it says nothing about where it came from.
// Cloudflare sets a visitor's address on a request from outside (`cf-connecting-ip`), and the auth
// Worker counts its limits by that header (codes by email, passkey tries, device sign-ins). The
// mind's own code could name any address there, and so pass those limits or spend another
// visitor's. So every header that is the edge's word about a caller is dropped.
const THE_EDGES_WORD = /^(cf-|x-forwarded-|x-real-ip$|true-client-ip$|forwarded$)/;

export function ownRequestHeaders(headers: Headers): Headers {
  // Iterated header names are lowercase.
  return new Headers(
    [...headers].filter(([name]) => name !== "cookie" && !THE_EDGES_WORD.test(name)),
  );
}
