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
// WHAT THE APP SAYS OF ITSELF: its name and its icon, in its web app manifest at
// `/manifest.webmanifest` on its own host. This Worker reads it over the public internet, as it
// reads an outside client's document, follows no redirect, and keeps the answer for five minutes.
// An icon counts only from the app's own origin, so the page's policy allows that one origin. An
// app that says nothing is shown by its host and its initials. An app that DOES NOT ANSWER (no
// answer in two seconds, or a 5xx) has said nothing new: it is still what it last said, and it is
// asked again after a minute.
//
// AN APP IS AN OAUTH CLIENT, as Codex is: the host's client holds what the app says (its
// `clientName` and `logoUri`), written here whenever the manifest is read and says something
// else. So a list of a person's sign-ins by client names the app as the sign-in pages do
// (`appOfClient`), and asks no app for it.
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

/** A host of this mind as an app: `origin` is one that `mindHostResourceOf` let through. */
export async function appOf(env: Env, origin: string): Promise<AskingApp> {
  const { host } = new URL(origin);
  const key = `iterate-app-said:${host}`;
  let said = await env.OAUTH_KV.get<ReturnType<typeof saidIn>>(key, "json");
  if (!said) {
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
    if (!heard) {
      said = await lastSaid(env, origin);
      await env.OAUTH_KV.put(key, JSON.stringify(said), { expirationTtl: 60 });
    } else {
      said = saidIn(heard.manifest, manifest);
      // "nothing" is kept too: an app with no manifest is not asked at each page
      await env.OAUTH_KV.put(key, JSON.stringify(said), { expirationTtl: 300 });
      await keepOnClient(env, origin, { name: said.name || host, icon: said.icon });
    }
  }
  return { host, origin, name: said.name || host, icon: said.icon };
}

/** What the app last said, which its host's own client holds (`keepOnClient`): for an app that
 *  does not answer now. An app with no client yet has said nothing. */
async function lastSaid(env: Env, origin: string): Promise<ReturnType<typeof saidIn>> {
  const { host } = new URL(origin);
  const clientId = await keptHostClientOf(env, host);
  const client = clientId
    ? await oauthHelpers(env, origin)
        .lookupClient(clientId)
        .catch(() => null)
    : null;
  const app = client && (await appOfClient(env, client));
  return { name: app && app.name !== host ? app.name : null, icon: app?.icon || null };
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

/** The app that an OAuth client is, when it is the client this stack made for a host of the
 *  mind: its name and icon as the client holds them. Null for every other client. */
export async function appOfClient(
  env: Env,
  client: { clientId: string; clientName?: string; clientUri?: string; logoUri?: string },
): Promise<AskingApp | null> {
  const origin = mindHostResourceOf(env, client.clientUri);
  if (!origin) return null;
  const { host } = new URL(origin);
  if ((await keptHostClientOf(env, host)) !== client.clientId) return null;
  // the icon is the app's own word, so it counts from its own origin alone, as when it was read
  const icon =
    client.logoUri && URL.canParse(client.logoUri) && new URL(client.logoUri).origin === origin
      ? client.logoUri
      : null;
  return { host, origin, name: client.clientName || host, icon };
}

const Manifest = z.object({
  name: z.string().optional(),
  short_name: z.string().optional(),
  icons: z.array(z.object({ src: z.string() })).optional(),
});

/** What a web app manifest's text says: a name of at most sixty characters, and the first icon
 *  that is on the manifest's own origin, over https. Anything else says nothing. */
export function saidIn(manifestText: string, manifestUrl: string) {
  const nothing = { name: null, icon: null };
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
  return { name: name || null, icon: icon?.href || null };
}

/** The app's tile (plain-page.css `.tile`): its icon, or its initials. Never a built-in mark of
 *  ./client-mark.ts: an app of a mind that calls itself "Codex" is not OpenAI's. `small` is for a
 *  row of a list. */
export function appTile(app: AskingApp, { small = false }: { small?: boolean } = {}): string {
  const tile = small ? "tile small" : "tile";
  if (app.icon)
    return `<div class="${tile}" data-app-mark="icon"><img src="${text(app.icon)}" alt="" referrerpolicy="no-referrer"></div>`;
  const initials = [...app.name.replace(/[^\p{L}\p{N}]/gu, "")].slice(0, 2).join("");
  return `<div class="${tile}" data-app-mark="initials">${text(initials.toUpperCase() || "?")}</div>`;
}
