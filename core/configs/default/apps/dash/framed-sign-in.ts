// framed-sign-in.ts — what the Dash's host answers a signed-out request that comes from a frame.
// worker.ts wraps the member guard's answer with it, on the Dash's host alone.

/** A SIGNED-OUT REQUEST FOR THE DASH IN A FRAME (another app of the mind shows an agent's chat in
 *  one: the Tasks app's "Chat with …", `?embed=1`). Each host of the mind has a session of its
 *  own, and the platform signs a person in on a host only for a page load of the whole tab
 *  (`sec-fetch-dest: document`): a frame gets the guard's plain 401, the words "Sign in" with no
 *  link, and a person cannot go on from there. `refused` is the guard's answer, or null for a
 *  member. For a frame's GET this answers the SAME refusal, the same status and challenge, with
 *  words that say what to do: open the Dash once in a tab of its own, where the platform signs
 *  the person in, and come back; the frame then loads again by itself. Nobody is signed in here,
 *  and nothing of the mind is shown: the page names this host alone. Any other request gets the
 *  guard's answer as it is. */
export function framedSignIn(request: Request, refused: Response | null): Response | null {
  if (
    !refused ||
    refused.status !== 401 ||
    request.method !== "GET" ||
    request.headers.get("sec-fetch-dest") !== "iframe"
  )
    return refused;
  const headers = new Headers(refused.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  const dash = `${new URL(request.url).origin}/`;
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to the Dash</title>
<style>body{margin:0;padding:1.5rem;font:14px/1.5 system-ui,sans-serif;color:#18181b;background:#fff}@media (prefers-color-scheme:dark){body{color:#fafafa;background:#09090b}a{color:#fafafa}}p{margin:0 0 .75rem;max-width:34rem}</style>
<p><strong>This browser is not signed in to the Dash yet.</strong></p>
<p><a href="${dash}" target="_blank" rel="noopener">Open the Dash</a> once in a tab of its own. Then come back: this chat loads by itself.</p>
<script>
  // back from the Dash's own tab: the session is there now, so load the frame again
  addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") location.reload(); });
  addEventListener("focus", () => location.reload());
</script>
`,
    { status: 401, headers },
  );
}
