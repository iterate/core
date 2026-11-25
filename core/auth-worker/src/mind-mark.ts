// mind-mark.ts — THE MIND'S OWN LOGO, at the head of the pages where a person signs in to the
// mind or lets a client in: the sign-in page, the chooser, the consent page and a device's
// confirmation. A person sees which mind they give access to by its own picture, where the pages
// showed iterate's mark before.
//
// WHERE THE LOGO COMES FROM. The mind's website answers what the mind says of itself, for anyone,
// at `/.well-known/iterate-profile` of its zone: `{ name, description, icon }` (the template's
// profile.ts). This Worker reads it over the public internet, as it reads an app's description
// (./asking-app.ts), and follows no redirect. The icon counts only over https from the website's
// own origin, so the page's policy allows that one origin. Nothing else of the profile is read
// here: the pages name the mind by its control-plane hostname, which the mind's code cannot write.
//
// THE MIND'S CODE WROTE IT, and that code may be hostile. So the logo is shown as an image
// (`<img>`, which runs nothing), with no referrer, and it proves nothing: the words of each page
// say which mind it is and where access goes. A mind that draws another's mark as its own logo
// changes no word of the page.
//
// NO PAGE WAITS FOR IT TWICE. The answer is kept for five minutes. A page that finds it older
// shows what is kept and asks again after the answer (`waitUntil`). Only a page that finds
// nothing kept waits, for two seconds at most. A website that does not answer, or whose answer
// is no profile, has said nothing new: the logo is what it was, or iterate's mark, and the
// website is asked again after a minute. A website with no icon (`icon: null`, a 404) has said
// so: the pages show iterate's mark.
import { waitUntil } from "cloudflare:workers";
import { reportIssue } from "iterate/lib";
import { zoneOf } from "iterate/mind-config";
import { z } from "zod";
import { configOf, type Env } from "./env.ts";
import { text } from "./pages.ts";

/** Where a mind's website answers its profile (the template's profile.ts `PROFILE_PATH`). */
const PROFILE_PATH = "/.well-known/iterate-profile";

const KEY = "iterate-mind-mark";
/** A profile is a name, a description of a thousand characters and an address. */
const PROFILE_MAX_BYTES = 20_000;

/** The mind's logo for a page: the tile's HTML, and the one origin that its image comes from. */
export type MindMark = { html: string; origin: string };

type Kept = { icon: string | null; askAfter: number };

/** The mind's logo as a page shows it, or null for a mind that has none: the page then shows
 *  iterate's mark. */
export async function mindMarkOf(env: Env): Promise<MindMark | null> {
  // A LOGO NEVER STOPS A PAGE: when the store fails, the page shows iterate's mark.
  return shown(env).catch((error) => {
    reportIssue("mind-mark.failed", error);
    return null;
  });
}

async function shown(env: Env): Promise<MindMark | null> {
  const config = configOf(env);
  // the mind's website is the apex of the zone that its control plane is in
  const origin = `https://${zoneOf(config, config.controlPlaneHostname) || config.zones[0]}`;
  let kept = await env.OAUTH_KV.get<Kept>(KEY, "json");
  if (!kept) kept = await read(env, origin, null);
  else if (kept.askAfter <= Date.now())
    waitUntil(read(env, origin, kept).catch((error) => reportIssue("mind-mark.failed", error)));
  // a row is read again as it is shown: only an icon of the website's own origin is one
  const icon = kept.icon && iconAt(kept.icon, origin);
  if (!icon) return null;
  return {
    html: `<div class="tile" data-mind-mark="icon"><img src="${text(icon)}" alt="" referrerpolicy="no-referrer"></div>`,
    origin,
  };
}

/** Asks the website, and keeps what it said. `last` is what was kept before. */
async function read(env: Env, origin: string, last: Kept | null): Promise<Kept> {
  const heard = await fetch(`${origin}${PROFILE_PATH}`, {
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(2000),
  })
    .then(async (answer) => {
      // a website with no profile has no logo; any other answer but a profile is no word of it
      if (answer.status === 404) return { icon: null };
      if (answer.status !== 200) return null;
      const profile = await textUpTo(answer, PROFILE_MAX_BYTES);
      // too long, or empty: no profile
      if (!profile) return null;
      const said = z
        .object({ icon: z.string().max(2048).nullable() })
        .safeParse(JSON.parse(profile));
      return said.success ? { icon: said.data.icon && iconAt(said.data.icon, origin) } : null;
    })
    .catch(() => null);
  const kept = heard
    ? { ...heard, askAfter: Date.now() + 5 * 60_000 }
    : { icon: last?.icon || null, askAfter: Date.now() + 60_000 };
  // a row that could not be written is asked for again by the next page: this page has its answer
  await env.OAUTH_KV.put(KEY, JSON.stringify(kept), { expirationTtl: 24 * 3600 }).catch((error) =>
    reportIssue("mind-mark.not-kept", error),
  );
  return kept;
}

/** The answer's text, read up to `maxBytes` and no further: null for a longer one, whose rest is
 *  not read. The profile is anyone's to write, so its length is not trusted. */
async function textUpTo(answer: Response, maxBytes: number): Promise<string | null> {
  if (!answer.body) return "";
  const reader = answer.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

/** `icon` as an address of the website's own origin over https, or null. */
function iconAt(icon: string, origin: string): string | null {
  if (!URL.canParse(icon)) return null;
  const url = new URL(icon);
  return url.origin === origin && url.protocol === "https:" ? url.href : null;
}
