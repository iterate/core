// How the CLI opens a sign-in page in this computer's browser. The URL comes from the metadata of
// the mind the person named (its `authorization_endpoint`), so it is another party's text: it is
// checked before anything is done with it, and it reaches no shell.

/** `url` when it is a page a sign-in may open: https, or http on this computer alone (a mind in
 *  local dev). Anything else is refused: `file:`, `javascript:` and an app's own scheme open
 *  things on this computer that a sign-in never needs. */
function signInPageUrl(url: URL): URL {
  const local =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url;
  throw new Error(
    `The sign-in page ${JSON.stringify(url.href)} is neither https nor on this computer: not opened. The mind's sign-in metadata names it.`,
  );
}

/** The program that opens `url` in the browser on `platform`, and its arguments. No shell reads
 *  them. On Windows it is `rundll32 url.dll,FileProtocolHandler`, never `cmd /c start`: `cmd`
 *  reads `&` and `|` in its arguments as its own, so a URL with a query was cut at its first `&`,
 *  and a mind's metadata could name a URL that ran a command. */
export function openPageCommand(url: URL, platform: NodeJS.Platform) {
  const { href } = signInPageUrl(url);
  if (platform === "darwin") return { command: "open", args: [href] };
  if (platform === "win32")
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", href] };
  return { command: "xdg-open", args: [href] };
}
