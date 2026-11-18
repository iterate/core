// open-files.ts — WHAT AN APP SAYS OF ITSELF TO ANYONE: its description, which the app writes as
// a typed object in its app.ts (iterate/sdk `AppDescription`), and its icon (public/icon.svg). The
// mind's sign-in pages ask for both before a person has signed in, and show the app's name and
// icon to the person who signs in from it. So worker.ts answers these two before its guard:
//
//   return dash.open?.(request) || this.auth.require(request) || dash.fetch(request, this);
//
// Every other file of an app stays behind the guard.
import { type AppDescription, serveAppDescription, serveFiles } from "iterate/sdk";

/** The answer for the app's description (at `/.well-known/iterate-app`) or for the icon that it
 *  names, and null for any other request. */
export function openFile(
  request: Request,
  app: AppDescription,
  files: Parameters<typeof serveFiles>[1]["files"],
) {
  const described = serveAppDescription(request, app);
  if (described) return described;
  return new URL(request.url).pathname === app.icon ? serveFiles(request, { files }) : null;
}
