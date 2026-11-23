// homepage.ts — THE MIND'S HOMEPAGE, for anyone: GET and HEAD of `/` on every hostname that is
// no app, a zone's apex too.
//
// To make the site yours, change this file alone: worker.ts calls `homepage` and keeps following
// the template. Any other path that nothing answers is not found (worker.ts), so a webhook to a
// hostname that nothing serves is not answered as taken.
import type { IterateConfigEntrypoint } from "iterate/sdk";
import { profileHtml, profileOf } from "./profile.ts";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import profileFiles from "./profile/";

/** The homepage: the mind's icon, name and description (profile/), and links to its setup and
 *  its Dash. Null for anything but GET or HEAD of `/`. */
export async function homepage(
  request: Request,
  host: Pick<IterateConfigEntrypoint, "getItx">,
): Promise<Response | null> {
  const { hostname, pathname } = new URL(request.url);
  if (pathname !== "/" || !["GET", "HEAD"].includes(request.method)) return null;
  using itx = host.getItx();
  const { mindSlug } = await itx.whoami();
  const zone = new URL(await itx.url()).hostname;
  const safeSlug = (mindSlug || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const safeZone = zone.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  // the mind's icon, its name as the heading and its description, as the owner wrote them
  const profile = profileHtml(profileOf(profileFiles, zone));
  // Any label of the zone gets this page, so only the zone's own name and www take the page
  // tag: a label that is no app never goes on the list of hosts that report
  // (apps/telemetry/page-events.ts `hostTagged`), however many names a stranger invents.
  const named = hostname === zone || hostname === `www.${zone}`;
  return new Response(
    [
      "<!doctype html>",
      '<meta charset="utf-8">',
      ...profile.head,
      '<body style="font-family:system-ui,-apple-system,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.25rem;line-height:1.6">',
      ...profile.body,
      `<p style="color:#71717a;font-size:0.875rem">Homepage of mind ${safeSlug}</p>`,
      `<p><a href="https://onboarding.${safeZone}/">Continue setup</a> &middot; <a href="https://dash.${safeZone}/">Open Dash</a></p>`,
      "</body>",
      "",
    ].join("\n"),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...(!named && { "x-page-events": "off" }),
      },
    },
  );
}
