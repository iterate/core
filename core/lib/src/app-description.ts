// app-description.ts — AN APP SAYS WHAT IT IS (`iterate/app-description`; the type and the helper
// are in `iterate/sdk` too). An app is one hostname of a mind's zones, served by the mind's own
// code, and an OAuth client of the mind's issuer. It says its name, its icon, whether it is for
// members and how its people sign in as a typed object in its own code, and answers that object as
// JSON at one well-known path of its hostname. The mind's issuer reads it there
// (core/auth-worker/src/asking-app.ts): its sign-in pages show the name and the icon, the mailed
// code names the app, and every sign-in for the app's hostname is held to `signIn`.
//
// It is no web app manifest: a browser reads none of it. An app that wants to be installable in a
// browser serves a manifest of its own, which the platform does not read.
import { z } from "zod";
import { OwnerEmailPattern } from "./mind-config.ts";
import { SignInMethod } from "./principal.ts";

/** Where an app answers its `AppDescription`, on its own hostname, for anyone. */
export const APP_DESCRIPTION_PATH = "/.well-known/iterate-app";

/** WHAT AN APP OF A MIND SAYS OF ITSELF, as an object in the app's own code:
 *
 *  ```ts
 *  const GUESTBOOK: AppDescription = { name: "Guestbook", icon: "/icon.svg", signIn: ["email"] };
 *  ```
 */
export const AppDescription = z.object({
  /** What the app calls itself. The sign-in pages show sixty characters of it. */
  name: z.string().min(1),
  /** The app's icon: a path on the app's own origin, which answers anyone. */
  icon: z.string().startsWith("/").optional(),
  /** "members": the app is for the mind's members alone. It changes the sign-in page's words and
   *  the default of `signIn`. Who may come is still the guard in the app's own code. */
  for: z.literal("members").optional(),
  /** HOW THE APP'S PEOPLE SIGN IN, in the app's order: the sign-in page opens on the first and
   *  offers the others below it, and offers no other. The issuer holds every sign-in for the
   *  app's hostname to the list, whoever asks for it: the app's own page, or an MCP client. A
   *  session that a passkey opened counts at every app, whatever the list. With none:
   *  `["passkey"]` for an app for members, `["email", "passkey"]` for any other. A mailed code
   *  signs in no member, so an app for members has no reason to name "email". */
  signIn: z.tuple([SignInMethod], SignInMethod).optional(),
  /** WHOSE ADDRESS A MAILED CODE SIGNS IN TO THE APP, as a mind's config names its owners
   *  (iterate/mind-config `ownerEmails`, `ownerEmailPatterns`, and their one matcher
   *  `isOwnerEmail`): `allowedEmails` names addresses, each whole, and `allowedEmailPatterns`
   *  names patterns, each `*@<domain>`: every address at exactly that domain, no sub-domain. An
   *  app that names either takes an address that one of the two names, and no other. The issuer
   *  then mails no code for the app's hostname to any other address, and gives no code for the
   *  hostname to a session that a mailed code opened for another address, whoever asks: the
   *  app's own page, or an MCP client. They bind the method "email" alone: a passkey's session
   *  still counts, so the guard in the app's own code says which members come. With neither, a
   *  mailed code signs in any address. */
  allowedEmails: z.array(z.email().toLowerCase()).min(1).optional(),
  allowedEmailPatterns: z.array(OwnerEmailPattern).min(1).optional(),
});
export type AppDescription = z.infer<typeof AppDescription>;

/** THE ANSWER TO A REQUEST FOR THE APP'S DESCRIPTION, and null for any other request. Call it
 *  before the app's guard: the issuer asks as nobody, before a person has signed in.
 *
 *  ```ts
 *  const described = serveAppDescription(request, GUESTBOOK);
 *  if (described) return described;
 *  ```
 *
 *  The object is parsed as it is served: a config repo runs with its types stripped, so code that
 *  no type checker read fails here, with the field's name, and never names a sign-in method that
 *  the issuer does not know. */
export function serveAppDescription(request: Request, app: AppDescription): Response | null {
  if (new URL(request.url).pathname !== APP_DESCRIPTION_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
  // A list of domains (`emailDomains`) is not read: the parse would drop it, and the app would
  // then be for any address. So it is refused by name, and the issuer keeps what it last read.
  if ("emailDomains" in app)
    throw new Error(
      'emailDomains is not read: name the people in allowedEmailPatterns, as "*@example.com"',
    );
  // the issuer keeps what it read for five minutes of its own: nothing between keeps it longer
  return Response.json(AppDescription.parse(app), { headers: { "cache-control": "no-store" } });
}
