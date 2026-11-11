// mind-ingress.ts — HOW MINDS ARE REACHED OVER HTTP, both directions in ONE pure file. A
// deployment's `urls.ingressRouting` (core/lib/src/app-config.ts) names the mechanism; `mindAddressOf`
// parses a request's URL into the mind and routing slug it names, `mindUrlOf` composes the URL
// of a routing slug in a mind. The platform's edge parses; the platform, the dash and an app
// compose — one implementation, table-tested to round-trip (mind-ingress.test.ts). No imports.
//
// The edge picks the MIND only: every host of a mind reaches the mind's config worker
// `fetch`, with the routing slug in `x-iterate-routing-slug` (absent on the apex), and the config
// worker routes on it in plain code.
//
//   subdomains  `<routingSlug>--<mind>.<hostname>`, the apex `<mind>.<hostname>` — every routing
//               slug its own origin, one label under one wildcard on `hostname`.
//   paths       `<platformOrigin>/minds/<mind>/<routingSlug>/…`, the apex `<platformOrigin>/minds/<mind>/`
//               — one origin (workers.dev has no wildcard), every mind under `/minds/` so the
//               platform's own paths (`/api`, `/mcp`, `/login`, …) need no reserved list; every
//               mind's pages share that origin with the platform.

/** THE ROUTING SLUG a mind host named (`notes` for `notes--<mind>.<hostname>`), as the mind's
 *  config worker `fetch` reads it; absent on the apex. Written only by the platform: the edge sets or
 *  deletes it on every mind-host request, and the context DO deletes it from every other
 *  expression fetch, so neither a visitor nor loaded code can pick a routing slug. */
export const ITERATE_ROUTING_SLUG_HEADER = "x-iterate-routing-slug";

/** WHAT A CONFIG WORKER'S ANSWER ASKS THE PLATFORM TO SERVE IN ITS PLACE, on a mind host:
 *  `itx` is the visitor's own itx over a WebSocket (iterate/sdk `auth.itx`). An answer, never a
 *  call: the platform serves it for the caller the boundary stamped on the request it still holds,
 *  so the config worker names no caller. The platform drops the header from every answer it does
 *  not honour, so it never reaches a browser. */
export const ITERATE_SERVE_HEADER = "x-iterate-serve";

/** THE BASE PATH a mind host is served under (`MindAddress.basePath`, under paths
 *  `/minds/<mind>[/<routingSlug>]`): the edge strips it from the URL the config worker sees
 *  and says it here, so a site composes the paths the browser addresses.
 *  Set or deleted by the edge on every mind request, so a visitor's spelling never reaches the
 *  mind. Absent under subdomains, where each routing slug owns its origin. */
export const ITERATE_BASE_PATH_HEADER = "x-iterate-base-path";

/** How minds are reached over HTTP; null ⇒ no ingress (`/api` and `/mcp` still answer). */
export type IngressRouting = { type: "subdomains"; hostname: string } | { type: "paths" } | null;

/** What a request names: the mind (its slug, as written — whether it EXISTS is the directory's
 *  answer), the routing slug (null ⇒ the apex; either way the mind's config worker answers), and
 *  the path prefix the edge strips before the config worker sees the URL ("" under subdomains;
 *  "/minds/<mind>" or "/minds/<mind>/<routingSlug>" under paths). */
export type MindAddress = { mind: string; routingSlug: string | null; basePath: string };

/** A DNS label: lowercase letters and digits, single hyphens inside. */
const DNS_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A ROUTING SLUG: a DNS label starting with a letter. It is a convenience: the one address
 *  component both ingress modes can express. Paths routing shares one host, so there it is the
 *  `/minds/<mind>/<routingSlug>` segment; subdomains make it `<routingSlug>--<mind>` or
 *  `<routingSlug>.<custom hostname>`. If paths routing is removed, the routing slug,
 *  `x-iterate-routing-slug` and the `--` host form can be deleted, and a mind's code matches
 *  hostnames directly. */
export const ROUTING_SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The ONE label `host` has under `hostname` — `site--p.iterate.app` ⇒ `site--p` — lowercased, a
 *  trailing dot (a fully-qualified Host, `site--p.base.`) dropped; null when `host` is not under
 *  `hostname`, or is more than one label under it: a mind host is one label, the one level a
 *  wildcard certificate covers. */
function labelUnder(host: string, hostname: string): string | null {
  const name = host.toLowerCase().replace(/\.$/, "");
  const suffix = `.${hostname.toLowerCase()}`;
  const label = name.endsWith(suffix) ? name.slice(0, -suffix.length) : null;
  return label?.includes(".") ? null : label;
}

/** The mind + routing slug `url` names under `routing`, or null when it names none. Pure. */
export function mindAddressOf(
  routing: IngressRouting,
  url: URL,
  platformOrigin: string,
): MindAddress | null {
  if (!routing) return null;
  if (routing.type === "subdomains") {
    const label = labelUnder(url.hostname, routing.hostname);
    if (!label) return null;
    const separator = label.startsWith("xn--") ? -1 : label.indexOf("--"); // `xn--…` is an IDN label (punycode), never `<routingSlug>--<mind>`
    const [routingSlug, mind] =
      separator === -1
        ? [null, label] // the apex, `<mind>`
        : [label.slice(0, separator), label.slice(separator + 2)]; // `<routingSlug>--<mind>`
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty routing slug (`--<mind>.<base>`) must still be rejected by ROUTING_SLUG; truthiness would skip the check and admit it
    if (!DNS_LABEL.test(mind) || (routingSlug !== null && !ROUTING_SLUG.test(routingSlug)))
      return null;
    return { routingSlug, mind, basePath: "" };
  }
  if (url.origin !== new URL(platformOrigin).origin) return null;
  const [, prefix, mind = "", routingSlug] = url.pathname.split("/");
  if (prefix !== "minds" || !DNS_LABEL.test(mind)) return null;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- `/minds/<mind>` and `/minds/<mind>/` are both the apex; a present-but-empty next segment is not a routing slug
  if (routingSlug === undefined || routingSlug === "")
    return { routingSlug: null, mind, basePath: `/minds/${mind}` };
  if (!ROUTING_SLUG.test(routingSlug)) return null;
  return { routingSlug, mind, basePath: `/minds/${mind}/${routingSlug}` };
}

/** A MIND WILDCARD — an owned zone served as one mind's apex (core/os
 *  `urls.mindWildcard`, `{ hostname: "iterate.com", mind: "iterate" }`): the zone's apex and
 *  every first-level name under it but the excluded ones, in the apex shape, `routingSlug: null`, so the
 *  mind's config worker `fetch` answers exactly as it does on `<mind>.<hostname>`. Null for
 *  anything else. Case and a trailing dot are forgiven. Pure. */
export function mindWildcardHostOf(
  hostname: string,
  wildcard: { hostname: string; mind: string; excludedHostnames?: string[] } | undefined,
): { routingSlug: null; mind: string } | null {
  if (!wildcard) return null;
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (wildcard.excludedHostnames?.includes(normalized)) return null;
  return normalized === wildcard.hostname || labelUnder(normalized, wildcard.hostname)
    ? { routingSlug: null, mind: wildcard.mind }
    : null;
}

/** A MIND'S OWN HOSTNAME — `iterate.example.com`, added by the mind (core/os
 *  mind/custom-hostnames.ts) — is that mind's apex, and one label under it names a routing
 *  slug: `notes.iterate.example.com` carries `notes`, as `notes--<mind>.<hostname>` does. The
 *  hostnames a request's host could be a mind's own hostname for, most specific first: the host
 *  itself (the apex), then its parent with the first label as the routing slug. The caller
 *  looks them up in that order; the first a mind holds wins. Case and a trailing dot are
 *  forgiven. Pure. */
export function customHostnameCandidatesOf(
  host: string,
): { hostname: string; routingSlug: string | null }[] {
  const hostname = host.toLowerCase().replace(/\.$/, "");
  const dot = hostname.indexOf(".");
  const [routingSlug, parent] = [hostname.slice(0, dot), hostname.slice(dot + 1)];
  return [
    { hostname, routingSlug: null },
    ...(dot > 0 && parent.includes(".") && ROUTING_SLUG.test(routingSlug)
      ? [{ hostname: parent, routingSlug }]
      : []),
  ];
}

/** The URL of `routingSlug` (null ⇒ the apex) in `mind` under `routing`, at `path` (default "/",
 *  must start with "/"). Null when there is no ingress, or when the result would not parse back to
 *  the same address (a bad slug; a `path` that climbs out of its routing slug). subdomains: the
 *  protocol and port are `platformOrigin`'s (local dev is `http://localhost:8788`, so
 *  `http://<routingSlug>--<mind>.localhost:8788/…`); paths:
 *  `<platformOrigin>/minds/<mind>[/<routingSlug>]<path>`. Pure. */
export function mindUrlOf(
  routing: IngressRouting,
  platformOrigin: string,
  target: { mind: string; routingSlug?: string | null; path?: string },
): URL | null {
  if (!routing) return null;
  const path = target.path || "/";
  if (!path.startsWith("/")) throw new Error(`mindUrlOf: path must start with "/": ${path}`);
  const routingSlug = target.routingSlug || null;
  const origin = new URL(platformOrigin);
  const url =
    routing.type === "subdomains"
      ? new URL(
          path,
          `${origin.protocol}//${routingSlug ? `${routingSlug}--` : ""}${target.mind}.${routing.hostname}${origin.port ? `:${origin.port}` : ""}`,
        )
      : new URL(
          `/minds/${target.mind}${routingSlug ? `/${routingSlug}` : ""}${path}`,
          origin.origin,
        );
  const parsed = mindAddressOf(routing, url, platformOrigin);
  return parsed && parsed.mind === target.mind && parsed.routingSlug === routingSlug ? url : null;
}

/** The URL of `routingSlug` (null ⇒ the apex) at `path` (default "/", must start with "/") on a
 *  mind's PRIMARY HOSTNAME, one of its own live hostnames (core/mind-worker/src/mind/contract.ts
 *  `primaryHostname`): `https://<routingSlug>.<primaryHostname><path>`, or
 *  `https://<primaryHostname><path>` for the apex. Null for a bad routing slug. Pure. */
export function primaryHostnameUrlOf(
  primaryHostname: string,
  target: { routingSlug?: string | null; path?: string },
): URL | null {
  const path = target.path || "/";
  if (!path.startsWith("/"))
    throw new Error(`primaryHostnameUrlOf: path must start with "/": ${path}`);
  const routingSlug = target.routingSlug || null;
  if (routingSlug && !ROUTING_SLUG.test(routingSlug)) return null;
  // one absolute string, never `path` resolved against a base: `//other.host/…` resolved that way
  // leaves the primary, and so the host is checked too
  const hostname = `${routingSlug ? `${routingSlug}.` : ""}${primaryHostname}`;
  const url = new URL(`https://${hostname}${path}`);
  return url.hostname === hostname ? url : null;
}

/** THE HOSTNAME A DEPLOYMENT'S CONFIG PINS TO A MIND (core/os iterate-config.ts
 *  `urls.mindHostnames`, each entry naming its mind by id or by slug): the first entry's that
 *  names `mind`, or null. It is the mind's primary hostname before any it claimed itself: the
 *  operator's own zone, served by the deployment's own routes, which no mind can claim or
 *  release. Pure. */
export function pinnedHostnameOf(
  entries: readonly { hostname: string; mind: string }[],
  mind: { id: string; slug?: string | null },
): string | null {
  const own = entries.find(
    (entry) => entry.mind === mind.id || (!!mind.slug && entry.mind === mind.slug),
  );
  return own?.hostname || null;
}

/** THE PUBLIC URL of `routingSlug` (null ⇒ the apex) at `path` in `mind` — the one rule behind
 *  `itx.url` and `itx.whoami().mindUrl`: on the mind's `primaryHostname` when it has one
 *  (`primaryHostnameUrlOf`), else under the deployment's ingress (`mindUrlOf`). Null as those
 *  answer null. Pure. */
export function mindPublicUrlOf(
  routing: IngressRouting,
  platformOrigin: string,
  target: {
    mind: string;
    primaryHostname: string | null;
    routingSlug?: string | null;
    path?: string;
  },
): URL | null {
  return target.primaryHostname
    ? primaryHostnameUrlOf(target.primaryHostname, target)
    : mindUrlOf(routing, platformOrigin, target);
}
