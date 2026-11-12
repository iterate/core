// open-files.ts — WHAT AN APP SAYS OF ITSELF TO ANYONE: its web app manifest and its icon
// (public/manifest.webmanifest, public/icon.svg). A browser asks for them before a person has
// signed in, and so do the mind's sign-in pages, which show the app's name and icon to the person
// who signs in from it. So worker.ts answers these two before its guard:
//
//   return dash.open?.(request) || this.auth.require(request) || dash.fetch(request, this);
//
// Every other file of an app stays behind the guard.
import { serveFiles } from "iterate/sdk";

const OPEN = new Set(["/manifest.webmanifest", "/icon.svg"]);

/** The answer for the app's manifest or its icon, and null for any other request. */
export function openFile(request: Request, files: Parameters<typeof serveFiles>[1]["files"]) {
  return OPEN.has(new URL(request.url).pathname) ? serveFiles(request, { files }) : null;
}
