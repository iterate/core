// profile.ts — WHAT THE MIND SAYS OF ITSELF TO THE WORLD: its name, a plain text description and
// its icon. The owner writes them as two files of the folder `profile/`:
//
//   profile/profile.json   { "name": "Ada's mind", "description": "What it is, in plain text." }
//   profile/icon.svg       one square SVG: the mind's logo and its favicon
//
// website.ts imports the folder and answers three paths of the mind's website from it, for anyone:
//
//   /.well-known/iterate-profile   { name, description, icon } as JSON, and nothing else
//   /favicon.svg, /favicon.ico     the icon
//
// An agent reads the same object with `itx.config.profile()`, and changes the profile with a
// commit of those files. The Dash's header and the homepage show the name and the icon, and the
// icon is every app's too: each app of the template answers it at its own `/icon.svg`, as its
// favicon and as the icon the mind's sign-in pages show for it (apps/open-files.ts).
//
// THE PROFILE IS NOT THE MIND'S IDENTITY. `/.well-known/iterate` is the mind's signed key history
// (iterate/mind-identity-log): the platform answers it, this code never gets that path, and its
// signatures prove which mind a hostname is. The profile is the owner's own words and picture,
// unsigned: it proves nothing, and a reader never takes a name from it as proof of who a mind is.
//
// ONE FILE THAT IS MISSING OR BROKEN STOPS NOTHING. With no `profile.json`, or one that is not
// what the schema says, the name is the zone and the description is empty; `problem` says what is
// wrong, to an agent alone. With no `icon.svg`, or one over the bound, there is no icon: the two
// icon paths answer 404 and `icon` is null. A folder with no file left is no folder: the loader
// refuses the import of it, and that commit does not publish (`mind/worker-update-failed`
// says so). Keep `profile.json`.
//
// A READER OF ANOTHER MIND'S PROFILE treats all of it as an outside person's: the name and the
// description are text, and the icon is shown as an image (`<img src>`), never put into a page as
// markup. An SVG can carry script, so the icon is served here with a policy that lets none run
// when someone opens it as a page.
import { z } from "zod";

/** Where the mind's website answers its profile, for anyone. */
export const PROFILE_PATH = "/.well-known/iterate-profile";

/** The paths that answer the icon: the one a page names, and the one a browser asks for when a
 *  page names none. Chromium 155 and Firefox 158 show an SVG that `/favicon.ico` answers with the
 *  SVG content type (checked 20 Nov 2026). */
const ICON_PATHS = ["/favicon.svg", "/favicon.ico"];

/** Five minutes: a browser asks once for many pages, and the owner's change shows soon. */
const CACHE = { "cache-control": "public, max-age=300" };

/** An icon is served up to this size, in characters: a larger one is not served at all. */
const ICON_MAX_LENGTH = 256 * 1024;

/** No control character: a name is one line. */
const ONE_LINE = /^\P{Cc}*$/u;
/** No control character but the line feed: a description is plain text. */
const PLAIN_TEXT = /^[\P{Cc}\n]*$/u;

/** WHAT `profile/profile.json` HOLDS. Any other key is dropped, so the public answer holds these
 *  fields alone. */
const ProfileFile = z.object({
  /** What the mind wants to be known by. Empty: the zone. */
  name: z.string().trim().max(80).regex(ONE_LINE).default(""),
  /** What the mind is, in plain text. */
  description: z.string().trim().max(1000).regex(PLAIN_TEXT).default(""),
});

/** The folder `profile/` as the platform's loader hands it over: each file by its name. */
type ProfileFiles = Record<string, string | Uint8Array>;

/** What the mind says of itself: the route's answer. */
type Profile = {
  name: string;
  description: string;
  /** The icon's address, or null for a mind with no icon. */
  icon: string | null;
};

/** The profile of the mind whose website is `https://<zone>/`, and what is wrong with its files,
 *  if anything, in one short sentence. */
export function profileOf(files: ProfileFiles, zone: string): Profile & { problem?: string } {
  const icon = iconOf(files);
  const said = profileFileOf(files["profile.json"]);
  return {
    name: said.name || zone,
    description: said.description,
    icon: icon.body ? `https://${zone}${ICON_PATHS[0]}` : null,
    problem: [said.problem, icon.problem].filter(Boolean).join(" ") || undefined,
  };
}

/** THE ANSWER TO A REQUEST FOR THE PROFILE OR THE ICON, and null for any other request. The
 *  mind's name falls back to the hostname that was asked. */
export function serveProfile(request: Request, files: ProfileFiles): Response | null {
  const { hostname, pathname } = new URL(request.url);
  const asksProfile = pathname === PROFILE_PATH;
  if (!asksProfile && !ICON_PATHS.includes(pathname)) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
  if (!asksProfile) return mindIcon(files);
  const { name, description, icon } = profileOf(files, hostname);
  return Response.json(
    { name, description, icon },
    { headers: { ...CACHE, "access-control-allow-origin": "*" } },
  );
}

/** THE PROFILE AS THE TOP OF A PAGE of the mind's website: `head` holds the title and the icon's
 *  link; `body` the icon, the name as the heading, and the description under it when there is
 *  one. The owner's words are text: they are escaped, and a line feed of the description stays a
 *  line break. */
export function profileHtml(profile: Profile): { head: string[]; body: string[] } {
  const text = (words: string) => words.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const [icon] = ICON_PATHS;
  return {
    head: [
      `<title>${text(profile.name)}</title>`,
      ...(profile.icon ? [`<link rel="icon" href="${icon}" type="image/svg+xml">`] : []),
    ],
    body: [
      ...(profile.icon
        ? [`<img src="${icon}" alt="" width="64" height="64" style="border-radius:14px">`]
        : []),
      `<h1>${text(profile.name)}</h1>`,
      ...(profile.description
        ? [`<p style="white-space:pre-line">${text(profile.description)}</p>`]
        : []),
    ],
  };
}

/** THE MIND'S ICON AS AN ANSWER, or 404 for a mind with none. The website answers it at the icon
 *  paths above, and each app of the template at its own icon path (apps/open-files.ts): one file,
 *  `profile/icon.svg`, is the icon of the mind and of every app. */
export function mindIcon(files: ProfileFiles): Response {
  const { body } = iconOf(files);
  if (!body) return new Response("Not found\n", { status: 404 });
  return new Response(body, {
    headers: {
      ...CACHE,
      "content-type": "image/svg+xml",
      "x-content-type-options": "nosniff",
      // opened as a page, the SVG runs no script and loads nothing
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

/** The owner's words, or empty ones and the reason. */
function profileFileOf(file: string | Uint8Array | undefined): {
  name: string;
  description: string;
  problem?: string;
} {
  const empty = { name: "", description: "" };
  if (!file) return empty;
  if (typeof file !== "string") return { ...empty, problem: "profile/profile.json is not text." };
  let json: unknown;
  try {
    json = JSON.parse(file);
  } catch {
    return { ...empty, problem: "profile/profile.json is not valid JSON." };
  }
  const parsed = ProfileFile.safeParse(json);
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "the file");
  return {
    ...empty,
    problem: `profile/profile.json: ${fields.join(", ")} is not what a profile holds (name: one line of at most 80 characters; description: plain text of at most 1000).`,
  };
}

/** The icon's text, or none and the reason when the file is no text or is over the bound. */
function iconOf(files: ProfileFiles): { body?: string; problem?: string } {
  const body = files["icon.svg"];
  if (!body) return {};
  // an SVG is text: the loader hands over bytes only for a file that is not UTF-8
  if (typeof body !== "string")
    return { problem: "profile/icon.svg is not text and is not served." };
  if (body.length > ICON_MAX_LENGTH)
    return { problem: `profile/icon.svg is over ${ICON_MAX_LENGTH} characters and is not served.` };
  return { body };
}
