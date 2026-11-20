// open-files.ts — WHAT AN APP SAYS OF ITSELF TO ANYONE: its description, which the app writes as
// a typed object in its app.ts (iterate/sdk `AppDescription`), and its icon. The mind's sign-in
// pages ask for both before a person has signed in, and show the app's name and icon to the
// person who signs in from it. So worker.ts answers these two before its guard:
//
//   return dash.open?.(request) || this.auth.require(request) || dash.fetch(request, this);
//
// Every other file of an app stays behind the guard.
//
// THE ICON IS THE MIND'S, one file for every app: `profile/icon.svg` of the repo (../profile.ts).
// An app keeps no icon of its own, so the mind's apps and its website show one logo, and a tab
// says which mind it is. The icon is answered on the app's own host, at the path its description
// names: the sign-in pages take an icon from the app's own origin alone.
import { type AppDescription, serveAppDescription } from "iterate/sdk";
import { mindIcon } from "../profile.ts";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import profileFiles from "../profile/";

/** The answer for the app's description (at `/.well-known/iterate-app`) or for the icon that it
 *  names, and null for any other request. */
export function openFile(request: Request, app: AppDescription) {
  const described = serveAppDescription(request, app);
  if (described) return described;
  return new URL(request.url).pathname === app.icon ? mindIcon(profileFiles) : null;
}
