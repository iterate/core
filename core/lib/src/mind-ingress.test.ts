// mind-ingress.test.ts — the two ingress mechanisms as `{ url, names }` rows (parse), `{ target,
// url }` rows (compose), every rejection, and the one invariant that matters: composing then parsing
// gives the target back, for every row of both modes.
import { expect, test } from "vitest";
import {
  mindAddressOf,
  mindUrlOf,
  type IngressRouting,
  type MindAddress,
  customHostnameCandidatesOf,
  pinnedHostnameOf,
  primaryHostnameUrlOf,
  mindPublicUrlOf,
  mindWildcardHostOf,
} from "./mind-ingress.ts";

const subdomains: IngressRouting = { type: "subdomains", hostname: "iterate.app" };
const paths: IngressRouting = { type: "paths" };
const PRD = "https://platform.example";
const DEV = "http://localhost:8788";

// ── mindAddressOf — subdomains ──
const subdomainRows: { url: string; names: MindAddress | null; why: string }[] = [
  {
    url: "https://site--p.iterate.app/x?y",
    names: { routingSlug: "site", mind: "p", basePath: "" },
    why: "<routingSlug>--<mind>",
  },
  { url: "https://site.p.iterate.app/", names: null, why: "two labels under the hostname" },
  {
    url: "https://p.iterate.app/",
    names: { routingSlug: null, mind: "p", basePath: "" },
    why: "the apex names no routing slug",
  },
  {
    url: "https://My-App--My-Proj.Iterate.App./",
    names: { routingSlug: "my-app", mind: "my-proj", basePath: "" },
    why: "lowercased, the trailing dot dropped",
  },
  { url: "https://platform.example/site--p", names: null, why: "not under the hostname" },
  { url: "https://iterate.app/", names: null, why: "the hostname itself has no labels" },
  { url: "https://a.b.c.iterate.app/", names: null, why: "three labels under the hostname" },
  {
    url: "https://xn--bcher-kva.iterate.app/",
    names: null,
    why: "an IDN label (punycode) is never <routingSlug>--<mind>, and is not a DNS label",
  },
  { url: "https://--p.iterate.app/", names: null, why: "an empty routing slug" },
  {
    url: "https://9site--p.iterate.app/",
    names: null,
    why: "a routing slug starts with a letter",
  },
  {
    url: "https://site--p-.iterate.app/",
    names: null,
    why: "a trailing hyphen is not a DNS label",
  },
  { url: "https://site..iterate.app/", names: null, why: "two labels, one of them empty" },
];
test.for(subdomainRows)("$url → $why", ({ url, names }) => {
  expect(mindAddressOf(subdomains, new URL(url), PRD)).toEqual(names);
});

// ── mindAddressOf — paths ──
const pathRows: { url: string; names: MindAddress | null; why: string }[] = [
  {
    url: `${PRD}/minds/p/site/x?y`,
    names: { routingSlug: "site", mind: "p", basePath: "/minds/p/site" },
    why: "<mind>/<routingSlug>/…",
  },
  {
    url: `${PRD}/minds/p/site`,
    names: { routingSlug: "site", mind: "p", basePath: "/minds/p/site" },
    why: "<mind>/<routingSlug>",
  },
  {
    url: `${PRD}/minds/p/`,
    names: { routingSlug: null, mind: "p", basePath: "/minds/p" },
    why: "the apex, trailing slash",
  },
  {
    url: `${PRD}/minds/p`,
    names: { routingSlug: null, mind: "p", basePath: "/minds/p" },
    why: "the apex, bare",
  },
  { url: `${PRD}/`, names: null, why: "the platform's root" },
  { url: `${PRD}`, names: null, why: "the origin alone" },
  { url: "https://other.example/minds/p/site", names: null, why: "another origin" },
  { url: `${PRD}/minds/P/site`, names: null, why: "a slug is lowercase" },
  { url: `${PRD}/minds/p/9site`, names: null, why: "a routing slug starts with a letter" },
  { url: `${PRD}/minds/p/Site`, names: null, why: "a routing slug is lowercase" },
  { url: `${PRD}/p/site`, names: null, why: "not under /minds/ — the platform's own paths" },
  { url: `${PRD}/api`, names: null, why: "a platform endpoint" },
  { url: `${PRD}/minds`, names: null, why: "the prefix alone" },
  { url: `${PRD}/minds/`, names: null, why: "the prefix alone, trailing slash" },
];
test.for(pathRows)("$url → $why", ({ url, names }) => {
  expect(mindAddressOf(paths, new URL(url), PRD)).toEqual(names);
});

test("the platform origin compares normalized", () => {
  expect(
    mindAddressOf(paths, new URL(`${PRD}/minds/p/site`), "https://Platform.Example:443"),
  ).toEqual({
    routingSlug: "site",
    mind: "p",
    basePath: "/minds/p/site",
  });
});

// ── mindUrlOf ──
const urlRows: {
  routing: IngressRouting;
  origin: string;
  target: { mind: string; routingSlug?: string | null; path?: string };
  url: string | null;
  why: string;
}[] = [
  {
    routing: subdomains,
    origin: PRD,
    target: { mind: "p", routingSlug: "site" },
    url: "https://site--p.iterate.app/",
    why: "a routing slug, the root",
  },
  {
    routing: subdomains,
    origin: PRD,
    target: { mind: "p", routingSlug: "site", path: "/a/b?c=1" },
    url: "https://site--p.iterate.app/a/b?c=1",
    why: "a routing slug, a path with a query",
  },
  {
    routing: subdomains,
    origin: PRD,
    target: { mind: "p" },
    url: "https://p.iterate.app/",
    why: "the apex",
  },
  {
    routing: subdomains,
    origin: PRD,
    target: { mind: "p", routingSlug: null, path: "/hooks" },
    url: "https://p.iterate.app/hooks",
    why: "the apex, a path",
  },
  {
    routing: { type: "subdomains", hostname: "localhost" },
    origin: DEV,
    target: { mind: "p", routingSlug: "site" },
    url: "http://site--p.localhost:8788/",
    why: "local dev keeps the scheme and port",
  },
  {
    routing: { type: "subdomains", hostname: "localhost" },
    origin: DEV,
    target: { mind: "p" },
    url: "http://p.localhost:8788/",
    why: "local dev, the apex",
  },
  {
    routing: paths,
    origin: PRD,
    target: { mind: "p", routingSlug: "site" },
    url: `${PRD}/minds/p/site/`,
    why: "a routing slug, the root — a trailing slash so relative URLs resolve inside it",
  },
  {
    routing: paths,
    origin: PRD,
    target: { mind: "p", routingSlug: "site", path: "/a/b?c=1" },
    url: `${PRD}/minds/p/site/a/b?c=1`,
    why: "a routing slug, a path with a query",
  },
  {
    routing: paths,
    origin: PRD,
    target: { mind: "p" },
    url: `${PRD}/minds/p/`,
    why: "the apex",
  },
  {
    routing: paths,
    origin: DEV,
    target: { mind: "p", routingSlug: "site" },
    url: `${DEV}/minds/p/site/`,
    why: "local dev",
  },
  {
    routing: null,
    origin: PRD,
    target: { mind: "p", routingSlug: "site" },
    url: null,
    why: "no ingress",
  },
  {
    routing: subdomains,
    origin: PRD,
    target: { mind: "P", routingSlug: "site" },
    url: null,
    why: "a bad slug composes nothing",
  },
  {
    routing: paths,
    origin: PRD,
    target: { mind: "p", routingSlug: "9site" },
    url: null,
    why: "a bad routing slug composes nothing",
  },
  {
    routing: paths,
    origin: PRD,
    target: { mind: "p", routingSlug: "site", path: "/../other" },
    url: null,
    why: "a path may not climb out of its routing slug",
  },
  {
    routing: paths,
    origin: PRD,
    target: { mind: "p", routingSlug: "site", path: "/../../q/x" },
    url: null,
    why: "nor out of its mind",
  },
];
test.for(urlRows)("$why", ({ routing, origin, target, url }) => {
  expect(mindUrlOf(routing, origin, target)?.href ?? null).toBe(url);
});

test("a path without a leading slash is a programmer error", () => {
  expect(() => mindUrlOf(paths, PRD, { mind: "p", path: "x" })).toThrow(/must start with/);
});

test("every composed URL parses back to its target", () => {
  for (const { routing, origin, target, url } of urlRows) {
    if (!url) continue;
    const parsed = mindAddressOf(routing, new URL(url), origin);
    expect(parsed, url).toMatchObject({
      mind: target.mind,
      routingSlug: target.routingSlug || null,
    });
    // and the config worker sees the path it was given, once the edge strips basePath
    const seen = new URL(url).pathname.slice(parsed!.basePath.length) + new URL(url).search;
    expect(seen, url).toBe(target.path || "/");
  }
});

// ── mindWildcardHostOf ──
const wildcard = {
  hostname: "iterate.com",
  mind: "iterate",
  excludedHostnames: [
    "cloud.iterate.com",
    "mcp.iterate.com",
    "dash.iterate.com",
    "k.iterate.com",
    "voice.iterate.com",
  ],
};
test.for([
  { hostname: "iterate.com", mind: "iterate" },
  { hostname: "Iterate.COM.", mind: "iterate" },
  { hostname: "www.iterate.com", mind: "iterate" },
  { hostname: "Blog.Iterate.com.", mind: "iterate" },
  { hostname: "deep.www.iterate.com", mind: null },
  { hostname: "notiterate.com", mind: null },
  { hostname: "www.iterate.app", mind: null },
  ...wildcard.excludedHostnames.map((hostname) => ({ hostname, mind: null })),
])("mind wildcard $hostname → $mind", ({ hostname, mind }) => {
  expect(mindWildcardHostOf(hostname, wildcard)?.mind ?? null).toBe(mind);
});

test("no mind wildcard names no mind", () => {
  expect(mindWildcardHostOf("iterate.com", undefined)).toBeNull();
});

// ── customHostnameCandidatesOf ── a mind's own hostname is its apex; one label under it, a routing slug
test.for([
  {
    host: "iterate.somedomain.com",
    candidates: [
      { hostname: "iterate.somedomain.com", routingSlug: null },
      { hostname: "somedomain.com", routingSlug: "iterate" },
    ],
  },
  {
    host: "notes.iterate.somedomain.com",
    candidates: [
      { hostname: "notes.iterate.somedomain.com", routingSlug: null },
      { hostname: "iterate.somedomain.com", routingSlug: "notes" },
    ],
  },
  {
    host: "Notes.Iterate.SomeDomain.com.",
    candidates: [
      { hostname: "notes.iterate.somedomain.com", routingSlug: null },
      { hostname: "iterate.somedomain.com", routingSlug: "notes" },
    ],
  },
  // a bare domain's parent is a TLD, never a mind's hostname
  { host: "garple.com", candidates: [{ hostname: "garple.com", routingSlug: null }] },
  // a first label that is no routing slug (a digit first, `--`) names no routing slug: only the exact host
  {
    host: "1st.iterate.somedomain.com",
    candidates: [{ hostname: "1st.iterate.somedomain.com", routingSlug: null }],
  },
  {
    host: "a--b.iterate.somedomain.com",
    candidates: [{ hostname: "a--b.iterate.somedomain.com", routingSlug: null }],
  },
  { host: "localhost", candidates: [{ hostname: "localhost", routingSlug: null }] },
])("custom hostname candidates of $host", ({ host, candidates }) => {
  expect(customHostnameCandidatesOf(host)).toEqual(candidates);
});

// ── primaryHostnameUrlOf ── a routing slug is one label under the primary hostname; the apex is the hostname
test.for([
  { target: {}, url: "https://templestein.com/" },
  { target: { routingSlug: null, path: "/a?b=1" }, url: "https://templestein.com/a?b=1" },
  { target: { routingSlug: "here-public" }, url: "https://here-public.templestein.com/" },
  {
    target: { routingSlug: "blog", path: "/posts/1" },
    url: "https://blog.templestein.com/posts/1",
  },
  { target: { routingSlug: "9lives" }, url: null },
  { target: { routingSlug: "a--b" }, url: null },
  // a path never changes the host: the edge passes a visitor's own path here
  { target: { path: "//evil.test/x" }, url: "https://templestein.com//evil.test/x" },
  { target: { path: "/\\evil.test/x" }, url: "https://templestein.com//evil.test/x" },
  { target: { path: "/@evil.test/x" }, url: "https://templestein.com/@evil.test/x" },
])("primary hostname URL of $target", ({ target, url }) => {
  expect(primaryHostnameUrlOf("templestein.com", target)?.href ?? null).toBe(url);
});

test("a primary hostname URL's path without a leading slash is a programmer error", () => {
  expect(() => primaryHostnameUrlOf("templestein.com", { path: "x" })).toThrow(/must start with/);
});

test("a primary hostname URL parses back to its routing slug as a custom hostname candidate", () => {
  const url = primaryHostnameUrlOf("templestein.com", { routingSlug: "blog" })!;
  expect(customHostnameCandidatesOf(url.hostname)).toContainEqual({
    hostname: "templestein.com",
    routingSlug: "blog",
  });
});

// ── mindPublicUrlOf ── `itx.url` and `whoami().mindUrl`: the primary hostname when there is one, else the ingress
test.for([
  {
    primaryHostname: null,
    routing: subdomains,
    target: {},
    url: "https://templestein.iterate.app/",
  },
  {
    primaryHostname: null,
    routing: subdomains,
    target: { routingSlug: "blog", path: "/a" },
    url: "https://blog--templestein.iterate.app/a",
  },
  {
    primaryHostname: null,
    routing: paths,
    target: { routingSlug: "blog" },
    url: "https://platform.example/minds/templestein/blog/",
  },
  { primaryHostname: null, routing: null, target: {}, url: null },
  {
    primaryHostname: "templestein.com",
    routing: subdomains,
    target: {},
    url: "https://templestein.com/",
  },
  {
    primaryHostname: "templestein.com",
    routing: subdomains,
    target: { routingSlug: "blog", path: "/a" },
    url: "https://blog.templestein.com/a",
  },
  // the primary is the mind's own hostname, whatever the deployment's ingress
  {
    primaryHostname: "templestein.com",
    routing: paths,
    target: {},
    url: "https://templestein.com/",
  },
  {
    primaryHostname: "templestein.com",
    routing: null,
    target: {},
    url: "https://templestein.com/",
  },
  {
    primaryHostname: "templestein.com",
    routing: subdomains,
    target: { routingSlug: "a--b" },
    url: null,
  },
] satisfies {
  primaryHostname: string | null;
  routing: IngressRouting;
  target: { routingSlug?: string; path?: string };
  url: string | null;
}[])(
  "public URL of $target with primary $primaryHostname under $routing",
  ({ primaryHostname, routing, target, url }) => {
    expect(
      mindPublicUrlOf(routing, PRD, { mind: "templestein", primaryHostname, ...target })?.href ??
        null,
    ).toBe(url);
  },
);

// ── pinnedHostnameOf — the deployment's config names a mind by id or by slug; the first wins ──
const PINNED = [
  { hostname: "templestein.com", mind: "mind_0000000000000000000000000000000a" },
  { hostname: "second.example", mind: "mind_0000000000000000000000000000000a" },
  { hostname: "by-slug.example", mind: "jeeves" },
];
test.for([
  {
    mind: { id: "mind_0000000000000000000000000000000a", slug: "jeeves" },
    hostname: "templestein.com",
    why: "the first entry naming the id, before a later one and before one naming the slug",
  },
  {
    mind: { id: "mind_0000000000000000000000000000000b", slug: "jeeves" },
    hostname: "by-slug.example",
    why: "an entry naming the slug",
  },
  {
    mind: { id: "mind_0000000000000000000000000000000b", slug: null },
    hostname: null,
    why: "no slug known and no entry naming the id",
  },
  { mind: { id: "mind_0000000000000000000000000000000c" }, hostname: null, why: "no entry" },
])("pinnedHostnameOf: $why", ({ mind, hostname }) => {
  expect(pinnedHostnameOf(PINNED, mind)).toBe(hostname);
});
test("pinnedHostnameOf: no entries, no hostname", () => {
  expect(
    pinnedHostnameOf([], { id: "mind_0000000000000000000000000000000a", slug: "x" }),
  ).toBeNull();
});
