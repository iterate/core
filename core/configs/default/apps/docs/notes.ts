// notes.ts — A STORED HTML NOTE, READ IN A MEMBER'S BROWSER: docs.<zone>/notes/<name>.html
// answers the mind's file /notes/<name>.html inline. A stored file's own link is a download; this
// is a link a member opens in a browser. worker.ts guards the docs app, so a member alone gets here.
//
// THE NOTE MUST NOT ACT AS THE MEMBER. Anyone who can write a file under /notes/ (an agent, with a
// stranger's words in its context) writes this page, and it opens on a host where the member is
// signed in. So the answer carries a sandbox with no `allow-scripts` and no `allow-same-origin`:
// no script runs, and the page has no origin, no cookie and no storage. Nothing loads from
// anywhere: styles are the note's own, images are data: URLs. A link to an anchor of the same page
// still works; a link out and a form do nothing.

/** The one shape of a note's address: lower-case letters, digits and hyphens, then `.html`. */
const NOTE = /^\/notes\/[a-z0-9][a-z0-9-]{0,99}\.html$/;

const NOTE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  "x-content-type-options": "nosniff",
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
};

/** Whether the docs app answers this path as a note (`fetch` asks before anything else). */
export const isNotePath = (pathname: string) => pathname.startsWith("/notes/");

/** The answer for a path under /notes/: the file inline, or a 404 for a name outside the pattern,
 *  another method, or a file that is not there. `read` hands back the file's bytes and throws when
 *  there is none (`itx.files.get(path).bytes()`). */
export async function noteResponse(
  request: Request,
  read: (path: string) => Promise<ArrayBuffer | Uint8Array>,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const none = () =>
    new Response("No such note.", {
      status: 404,
      headers: { ...NOTE_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  if ((request.method !== "GET" && request.method !== "HEAD") || !NOTE.test(pathname))
    return none();
  let bytes: ArrayBuffer | Uint8Array;
  try {
    bytes = await read(pathname);
  } catch (error) {
    // the platform's words for a path with no file; anything else is a fault and is thrown on
    if (/nothing at/.test(String(error instanceof Error ? error.message : error))) return none();
    throw error;
  }
  // a view's bytes copied to a buffer of their own: the platform's view may sit on a shared
  // buffer, which a body does not take
  const own = bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes;
  const body = request.method === "HEAD" ? null : own;
  return new Response(body, { headers: NOTE_HEADERS });
}
