// asking-app.ts — THE APP OF THIS MIND THAT A SIGN-IN IS FOR. A page of an app's host
// (guestbook.<domain>) that asks who is there sends the browser to this issuer with an
// authorization request of the host's own: its resource is the host, its redirect is the host's
// own callback, and its client is the one this stack made for the host (./oauth.ts
// `hostClientOf`). The sign-in pages then say which app the person signs in to, so that a person
// who is no member of the mind knows where they are.
//
// WHAT IS TRUSTED. `next`, the request that a sign-in goes on to, is a query that anyone can
// write. So the app is read from it only when its three parts agree with what this stack holds:
// the test by which the authorization endpoint completes a host's own sign-in with no consent
// page. A link that passes it is the link that the host's own page makes.
//
// WHAT THE APP SAYS OF ITSELF, in its web app manifest at `/manifest.webmanifest` on its own
// host: its name, its icon, and whether it is for the mind's members alone:
//
//   { "name": "Dash", "icons": [{ "src": "/icon.svg" }], "iterate": { "for": "members" } }
//
// This Worker reads it over the public internet, as it reads an outside client's document, follows
// no redirect, and asks again after five minutes. An icon counts only from the app's own origin,
// so the page's policy allows that one origin. An app that says nothing is shown by its host and
// its initials. An app that DOES NOT ANSWER (no answer in two seconds, or a 5xx) has said nothing
// new: it is still what it last said, and it is asked again after a minute.
//
// "For members" changes the page's words and nothing else: who may come is the guard in the
// app's own code (the mind's worker.ts), which this Worker does not read.
//
// AN APP IS AN OAUTH CLIENT, as Codex is: the host's client holds the app's name and icon (its
// `clientName` and `logoUri`), written here whenever the manifest is read and says something
// else. So the list of a person's sign-ins by client (./oauth.ts `sessionsByClientOf`) names the
// app as the sign-in pages do, and asks no app for it.
import { z } from "zod";
import { type Env, issuerOf } from "./env.ts";
import {
  AUTHORIZE_ENDPOINT,
  hostCallbackOf,
  keptHostClientOf,
  knownResourceOf,
  mindHostResourceOf,
  oauthHelpers,
} from "./oauth.ts";

export type AskingApp = {
  /** The app's hostname, under the mind's domain. */
  host: string;
  origin: string;
  /** What the app calls itself, or its host when it says nothing. */
  name: string;
  /** Its icon, on its own origin, when it names one. */
  icon: string | null;
  /** The app says that it is for the mind's members alone. */
  members: boolean;
};

const text = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** The app whose own sign-in `next` goes on to (a path of this issuer), or null: for any other
 *  request, and for one whose parts this stack does not hold. */
export async function askingAppOf(env: Env, next: string): Promise<AskingApp | null> {
  const issuer = issuerOf(env);
  if (!URL.canParse(next, issuer)) return null;
  const url = new URL(next, issuer);
  if (url.origin !== issuer || url.pathname !== AUTHORIZE_ENDPOINT) return null;
  const asked = url.searchParams.get("resource");
  const origin = asked && mindHostResourceOf(env, knownResourceOf(env, asked));
  if (!origin || url.searchParams.get("redirect_uri") !== hostCallbackOf(origin)) return null;
  const client = await keptHostClientOf(env, new URL(origin).host);
  if (!client || client !== url.searchParams.get("client_id")) return null;
  return appOf(env, origin);
}

/** What an app said of itself (`saidIn`), and when to ask it again. */
type Kept = ReturnType<typeof saidIn> & { askAfter: number };

/** A host of this mind as an app: `origin` is one that `mindHostResourceOf` let through. */
export async function appOf(env: Env, origin: string): Promise<AskingApp> {
  const { host } = new URL(origin);
  const key = `iterate-app-said:${host}`;
  let kept = await env.OAUTH_KV.get<Kept>(key, "json");
  // a record with no time in it is one that an earlier version kept: it is asked again
  if (!kept || !(kept.askAfter > Date.now())) {
    const manifest = `${origin}/manifest.webmanifest`;
    const heard = await fetch(manifest, {
      headers: { accept: "application/manifest+json, application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(2000),
    })
      // an answer of the app: its manifest's text, which is empty for an app that has none (a
      // 404, a sign-in). Null: the app did not answer, or its answer broke off.
      .then(async (answer) => {
        if (answer.status >= 500) return null;
        return { manifest: answer.status === 200 ? await answer.text() : "" };
      })
      .catch(() => null);
    const last = kept || NOTHING;
    kept = heard
      ? // "nothing" is kept too: an app with no manifest is not asked at each page
        { ...saidIn(heard.manifest, manifest), askAfter: Date.now() + 5 * 60_000 }
      : // it did not answer: it is what it last said, and is asked again after a minute
        {
          name: last.name,
          icon: last.icon,
          members: Boolean(last.members),
          askAfter: Date.now() + 60_000,
        };
    await env.OAUTH_KV.put(key, JSON.stringify(kept));
    if (heard) await keepOnClient(env, origin, { name: kept.name || host, icon: kept.icon });
  }
  return { host, origin, name: kept.name || host, icon: kept.icon, members: Boolean(kept.members) };
}

/** The host's own client says what the app says: written when it says something else. */
async function keepOnClient(env: Env, origin: string, said: { name: string; icon: string | null }) {
  const clientId = await keptHostClientOf(env, new URL(origin).host);
  if (!clientId) return;
  const helpers = oauthHelpers(env, origin);
  const client = await helpers.lookupClient(clientId);
  if (!client || (client.clientName === said.name && (client.logoUri || null) === said.icon))
    return;
  await helpers.updateClient(clientId, { clientName: said.name, logoUri: said.icon || undefined });
}

const NOTHING = { name: null, icon: null, members: false };

const Manifest = z.object({
  name: z.string().optional(),
  short_name: z.string().optional(),
  icons: z.array(z.object({ src: z.string() })).optional(),
  // iterate's own member of the manifest; a browser passes over it
  iterate: z.object({ for: z.string().optional() }).optional().catch(undefined),
});

/** What a web app manifest's text says: a name of at most sixty characters, the first icon that
 *  is on the manifest's own origin, over https, and whether the app is for members
 *  (`"iterate": { "for": "members" }`). Anything else says nothing. */
export function saidIn(manifestText: string, manifestUrl: string) {
  const nothing = NOTHING;
  if (!manifestText || manifestText.length > 20_000) return nothing;
  let parsed: z.infer<typeof Manifest>;
  try {
    parsed = Manifest.parse(JSON.parse(manifestText));
  } catch {
    return nothing;
  }
  const name = (parsed.name || parsed.short_name || "")
    // a name is one line of text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim()
    .slice(0, 60);
  const { origin } = new URL(manifestUrl);
  const icon = (parsed.icons || [])
    .map(({ src }) => (URL.canParse(src, manifestUrl) ? new URL(src, manifestUrl) : null))
    .find((url) => url && url.protocol === "https:" && url.origin === origin && !url.username);
  return {
    name: name || null,
    icon: icon?.href || null,
    members: parsed.iterate?.for === "members",
  };
}

/** The app's tile (plain-page.css `.tile`): its icon, or its initials. Never a built-in mark of
 *  ./client-mark.ts: an app of a mind that calls itself "Codex" is not OpenAI's. `small` is for a
 *  row of a list. */
export function appTile(
  app: Pick<AskingApp, "name" | "icon">,
  { small = false }: { small?: boolean } = {},
): string {
  const tile = small ? "tile small" : "tile";
  if (app.icon)
    return `<div class="${tile}" data-app-mark="icon"><img src="${text(app.icon)}" alt="" referrerpolicy="no-referrer"></div>`;
  const initials = [...app.name.replace(/[^\p{L}\p{N}]/gu, "")].slice(0, 2).join("");
  return `<div class="${tile}" data-app-mark="initials">${text(initials.toUpperCase() || "?")}</div>`;
}
