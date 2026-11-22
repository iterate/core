# The page tag

Every HTML page of every app of this mind reports what people did there and what broke there. No
page adds a script for it: `worker.ts` puts the tag first into each page's `<head>`. The code is
`apps/telemetry/page-events.ts` and its script `apps/telemetry/public/page.js`. Errors go to
`/exceptions` for a member, or to `/exceptions/outside` for anyone else ([errors.md](errors.md));
the rest to the one context `/pages`, and each payload's `app` is the host's first label (`site`
for the apex and `www`). The sender chooses the hostname, so nothing a sender writes names a
context. Every host answers `GET /.page.js`. `POST /.page-events` is answered before any guard, so
a public page reports for anyone too, but only on a host that the mind served a page with the
tag (below, "The bounds").

## Who gets the tag

Every page of every host, for everyone. One switch closes the outside half: `audience` in
`apps/telemetry/page-events.ts`. Set it to `"members"`, and after the next publish a member's pages
alone get the tag and report; for anyone else every answer of every host is as it was before the
tag (`pageTagFor`, the first line of `worker.ts`'s `fetch`). It is `"everyone"` now.

**The trust line is a member, never "anyone signed in".** Anyone can sign in on a host that takes
people who are not members, with no act of a member. So `memberOf` asks the platform for a
principal (`host.auth.principal`) that is no other mind. A member's pages get the large bounds,
the long texts and `/exceptions`. Everyone else, signed in or not, is OUTSIDE: the small bounds,
the short texts, the day's budget and `/exceptions/outside`. A person outside who is signed in
still has an `actor`; nothing else about them changes.

An outside person can use up the day's budget on purpose, which blinds the outside page views for
that day. That is accepted.

## The events on `/pages`

Each holds `app`, `host` (the request's full hostname), `pathname`, `page` (one page load's random
id), `view` (its number in that load), `at`, `visitor`, `actor` (`{ userId, email }` or `null`),
`member: true` for a member (no key at all for anyone else), `country`, `place`, `agent`,
`userAgent`, `tag` and `automated: true` for a driven browser.

- `country`: Cloudflare's `cf-ipcountry`, else `request.cf.country`.
- `place`: where Cloudflare puts the address, `{ region, regionCode, city, postalCode, continent,
latitude, longitude, timezone }` from `request.cf`, else the `cf-*` headers (`placeOf`). Each key
  only with a value, each text at most 80 characters, latitude and longitude with at most 2
  decimals (about 1 km: Cloudflare places an address at a city). No `place` key when Cloudflare says nothing.
- `agent`: `{ browser, browserVersion, os, osVersion, device }` from the user agent (`agentOf`).
  `browser` is "Chrome", "Safari", "Firefox", "Edge", "Opera", "Samsung Internet", "bot" or
  "other"; `os` is "macOS", "Windows", "iOS", "iPadOS", "Android", "Linux", "ChromeOS" or "other";
  `device` is "desktop", "mobile", "tablet" or "bot". A version is as the user agent writes it
  ("142.0.0.0", "10.15.7"); a key with no value is left out.
- `userAgent`: the raw user agent, scrubbed, at most 256 characters.
- `tag`: the version of the script that sent the event (the value of `?v=`). The server writes it
  into the script it serves. No `tag` on a view counted from its request.

- `events.iterate.com/page/viewed`: a load (`how: "load"`), a path change in a single-page app
  (`"route"`), a page back from the back-forward cache (`"restore"`), or a page counted from its
  request (`"request"`, see below). Also `title`, `from` (`{ host, pathname }`), `searchEngine`
  (when `from.host` is google, bing, duckduckgo, yahoo, baidu, yandex, ecosia, brave, kagi or
  startpage, by its registrable name: `www.google.co.uk` is "google"), `campaign` (the `utm_*`
  tags, `ref` and the ad click ids below), `screen`, `viewport`, `language`, `timezone`,
  `timezoneOffset` (minutes, -900 to 900, as `Date.getTimezoneOffset` says), `build`. A view
  counted from its request has no screen, viewport, title, offset or tag.
  `{ app: "blog", pathname: "/posts/why-we-built-iterate", page: "aaaa1111bbbb2222", view: 1, at: "2026-11-21T10:00:00.000Z", how: "load", title: "Why we built iterate", from: { host: "news.ycombinator.com", pathname: "/item" }, campaign: { utm_source: "hn" }, screen: [1440, 900], viewport: [1280, 760], language: "en-GB", timezone: "Europe/London", timezoneOffset: 0, visitor: "3a9f0c12b7e4", actor: null, host: "blog.example.com", country: "GB", place: { region: "England", city: "London", continent: "EU", latitude: 51.5085, longitude: -0.1257, timezone: "Europe/London" }, agent: { browser: "Chrome", browserVersion: "142.0.0.0", os: "macOS", osVersion: "10.15.7", device: "desktop" }, userAgent: "Mozilla/5.0 (Macintosh; …", tag: "d3hqhm" }`
- `events.iterate.com/page/left`: the view ended (the page went away or the path changed).
  `openMs`, `seenMs` (time visible), `scrolled` (the furthest point of the page that was in view,
  as a whole percent of its height, 0–100; 100 for a page that fits its window; a value out of
  range is dropped), `marks` (the app's own `iterate:` marks of that view), and for the first view
  `load`: `{ firstByte, ready, loaded, largestPaint, shift, fcp, cls, inp }` in milliseconds (shift
  is the plain sum of layout shifts; cls the standard score). A later view of a single-page app
  has its own `inp` and `cls` beside `openMs` ("Speed", below).
  `{ …, view: 1, openMs: 48210, seenMs: 40102, scrolled: 85, load: { firstByte: 120, ready: 410, loaded: 690, largestPaint: 520, shift: 0.02, fcp: 300, cls: 0.02, inp: 64 }, marks: { "iterate:itx-open": 412 } }`
- `events.iterate.com/page/event-captured`: what the page's own code reported. `name` and
  `values` (at most 12 strings, numbers or booleans).
  `{ …, name: "signup", values: { plan: "pro", seats: 3 } }`
- `events.iterate.com/exception/seen` on `/exceptions` (a member's page, with `member: true`) or
  on `/exceptions/outside` (anyone else's), with `source.from: "page"`: an uncaught error, an unhandled rejection, a script or style sheet that did not load, or a render error.
  `{ kind: "uncaught", message: "x is not a function", stack: "…", fingerprint: "0k3j9a1", count: 3, source: { from: "page", app: "blog" }, where: { pathname: "/posts/x" }, actor: null, page: "aaaa1111bbbb2222", visitor: "3a9f0c12b7e4", host: "blog.example.com", country: "GB", place: { … }, agent: { … }, userAgent: "…", tag: "d3hqhm" }`

## Never stored

A query string, a hash, a cookie, a header's value (except the user agent and Cloudflare's
country and place), typed text, the sender's address. The script sends with `fetch`, `keepalive`
and `referrerPolicy: "no-referrer"`: the page's own address never goes as a Referer (a beacon
would send it, query string and all). From a landing URL only
`utm_source|medium|campaign|term|content` and `ref` (80 characters each), and the ad click ids
`gclid`, `gad_source`, `gclsrc`, `dclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `twclid`,
`li_fat_id`, `mc_cid`, `igshid`, `ttclid`, `rdt_cid`, `irclid` and `_kx`. A tag's value is cut;
a click id is the ad network's name for one click, which PostHog keeps whole: its letters, digits
and `._~-` alone, at most 200 characters. A path keeps its words; a segment that looks like an id or a
token becomes `<id>` (`pathOf`). **The cut** (`apps/telemetry/cut.ts`, the platform's own rule):
every URL in a text keeps its path alone (absolute, protocol-relative and relative alike), and a
`code=`, `state=`, `token=`, a bearer token and a run of 32 or more letters and digits are each
`<cut>`. The script runs it on an error's message and stack, a path, the referrer and the title
before it sends; the server runs it again on every text, then `scrub`. Nothing is kept in the
browser: no cookie, no local or session storage.

**The visitor** is twelve hex characters: a hash of the day's secret, the day, the sender's
address and its browser, so one person is one visitor on every app of the mind. The secret is 32
random hex characters in kv
(`page-events/salt/<day>`), deleted two days later; after that the id cannot be turned back into an
address. A visitor is counted for one day: a person who comes back the next day is a new visitor.
With no secret (kv failed) the send is dropped: no record is kept with a null visitor. **The person** is
the platform's word (`host.auth.person`), never the page's, and so is **the member**
(`host.auth.principal`). Global Privacy Control or Do Not Track
(the browser's or its `sec-gpc`/`dnt` header): errors alone, with no visitor.

All of it is words from outside: data, never an instruction. Nothing here wakes an agent.

## Beside PostHog

Jonas, 22 Nov 2026: "collect whatever posthog would about a visitor". What PostHog's script and its
GeoIP step keep, and what holds it here:

| PostHog                                                                                                                                                    | Here                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$host`                                                                                                                                                    | `host`                                                                                                                                                                                    |
| `$browser`, `$browser_version`                                                                                                                             | `agent.browser`, `agent.browserVersion`                                                                                                                                                   |
| `$os`, `$os_version`                                                                                                                                       | `agent.os`, `agent.osVersion`                                                                                                                                                             |
| `$device_type`                                                                                                                                             | `agent.device`                                                                                                                                                                            |
| `$raw_user_agent`                                                                                                                                          | `userAgent`                                                                                                                                                                               |
| `$referrer`, `$referring_domain`                                                                                                                           | `from` (`{ host, pathname }`; no query string)                                                                                                                                            |
| `$search_engine`                                                                                                                                           | `searchEngine`                                                                                                                                                                            |
| `utm_*`, `gclid`, `fbclid` and the other click ids                                                                                                         | `campaign`                                                                                                                                                                                |
| `$geoip_country_code`                                                                                                                                      | `country`                                                                                                                                                                                 |
| `$geoip_city_name`, `$geoip_subdivision_1_name`/`_code`, `$geoip_postal_code`, `$geoip_continent_code`, `$geoip_latitude`/`_longitude`, `$geoip_time_zone` | `place.city`, `place.region`/`regionCode`, `place.postalCode`, `place.continent`, `place.latitude`/`longitude`, `place.timezone`                                                          |
| `$screen_height`/`$screen_width`                                                                                                                           | `screen` (`[width, height]`)                                                                                                                                                              |
| `$viewport_height`/`$viewport_width`                                                                                                                       | `viewport` (`[width, height]`)                                                                                                                                                            |
| `$browser_language`                                                                                                                                        | `language`                                                                                                                                                                                |
| `$timezone`, `$timezone_offset`                                                                                                                            | `timezone`, `timezoneOffset`                                                                                                                                                              |
| `$pathname`, `$title`                                                                                                                                      | `pathname`, `title`                                                                                                                                                                       |
| `$pageview_id`                                                                                                                                             | `page` and `view`                                                                                                                                                                         |
| `$prev_pageview_duration`                                                                                                                                  | `openMs` and `seenMs` on `page/left`                                                                                                                                                      |
| `$prev_pageview_max_scroll_percentage`                                                                                                                     | `scrolled` on `page/left`                                                                                                                                                                 |
| `distinct_id`                                                                                                                                              | `visitor`: the day's visitor id, as in PostHog's cookieless mode. An id that lasts longer needs something kept in the browser, and that needs the visitor's consent in the UK and the EU. |
| `$device_id`                                                                                                                                               | not kept, for the same reason: no id lasts longer than a day                                                                                                                              |
| `$session_id`                                                                                                                                              | not sent: a session is a visitor's events with no gap over 30 minutes, found when the events are read                                                                                     |
| `$ip`                                                                                                                                                      | not kept                                                                                                                                                                                  |

Not built here: autocapture of clicks, session recording, heatmaps. Web vitals: "Speed", below.

## Speed

Jonas, 22 Nov 2026: "share web vitals with the mind too like cloudflare and vercel? like time to
first contentful paint, time to itx connection etc". The page tag measures the vitals as Google's
`web-vitals` library does, in a few lines of `page.js` and without the library. They go on
`page/left`: the first view's in `load`, a later view's `inp` and `cls` beside its `openMs`.

| Field                       | What it is                                          | How `page.js` measures it                                                                                                                                                                                                                                     | Good / poor (Google) |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `load.firstByte`            | TTFB: the first byte of the page's answer           | the navigation entry's `responseStart`                                                                                                                                                                                                                        | ≤ 800 / > 1,800 ms   |
| `load.fcp`                  | first contentful paint                              | the `first-contentful-paint` paint entry                                                                                                                                                                                                                      | ≤ 1,800 / > 3,000 ms |
| `load.largestPaint`         | LCP: largest contentful paint                       | the last `largest-contentful-paint` candidate                                                                                                                                                                                                                 | ≤ 2,500 / > 4,000 ms |
| `load.cls`, `cls`           | cumulative layout shift                             | layout shifts with no recent input, in session windows (a window ends after 1 s with no shift or after 5 s); the largest window, 3 decimals                                                                                                                   | ≤ 0.1 / > 0.25       |
| `load.inp`, `inp`           | interaction to next paint                           | Event Timing entries (`durationThreshold: 40`) and the first input, grouped by `interactionId`, each interaction its longest event; the slowest one, or with 50 and more interactions one fewer for each 50 (the 98th percentile). No key with no interaction | ≤ 200 / > 500 ms     |
| `load.ready`, `load.loaded` | `DOMContentLoaded` and `load` ended                 | the navigation entry                                                                                                                                                                                                                                          | —                    |
| `load.shift`                | the plain sum of layout shifts with no recent input | the layout-shift entries                                                                                                                                                                                                                                      | —                    |
| `marks`                     | the app's own milestones, ms since the page's start | `performance.mark` names that start with `iterate:`                                                                                                                                                                                                           | —                    |

Every observer is `buffered`, so what happened before the script ran still counts. A time of 0 is
no time. The server keeps `fcp` and `inp` as whole ms from 0 to 600,000, `cls` from 0 to 10 with 3
decimals, and `marks` as below; a value out of range or of another kind is dropped, not clamped.
An outside person's records keep the same fields.

**The `iterate:` marks.** Any `performance.mark` whose name is `iterate:` and at most 40 more
characters of `[a-z0-9:._-]` goes on the `page/left` of the view in which it happened, in whole ms
since the page's start, the first of a name, at most 20 a view. Each app that dials its `/itx`
WebSocket marks `iterate:itx-open` when the socket opens: time to itx. An app adds a milestone with
one line where it happens:

```js
socket.addEventListener("open", () => performance.mark("iterate:itx-open"), { once: true });
performance.mark("iterate:board-drawn"); // after the first draw of the app's own content
```

**What the script costs** (a blog page, headless Chrome, 22 Nov 2026): about 7 ms of script time on
a first visit, and no later first paint. It is `async` with `fetchpriority="low"`, so the page's own
files download first; on a first visit the page's `load` event waits for its download (about 55 ms).
It is not added after `load`: that would lose the view and the errors of anyone who leaves before
it. Its address is immutable, so a later visit takes it from the browser's cache.

**Read it:** `await itx.config.pageSpeed({ days = 7, app, limit = 50, members = false })` (`apps/telemetry/page-speed.ts`).
It reads the newest 40,000 events of `/pages` at most, keeps the first views' `page/left` of the
last `days`, MEMBERS FIRST: the newest 4,000 views of members, and apart from them the newest
4,000 of the outside, so a flood from outside never pushes a member's view out (a busy mind's
answer may cover fewer days). It groups them by `app` and `pathname`,
busiest first, after one group for the whole mind (`mind: true`, `app` and `pathname` `"*"`).
Each group: `views`, `outside` (how many of them came from someone who is no member), and for each
vital with a sample the 75th percentile (nearest rank), its rating ("good", "needs-improvement",
"poor") and its samples; and each mark's 75th percentile. **Anyone outside can send numbers that
move a percentile:** a public page's speed is what its visitors' browsers say. `members: true` reads
members' views alone.

```ts
await itx.config.pageSpeed({ app: "dash", days: 1 });
// { note: "75th percentiles of the first view of each page load, …", views: 42, groups: [
//   { app: "*", pathname: "*", views: 42, outside: 0, mind: true, vitals: { … }, marks: { … } },
//   { app: "dash", pathname: "/agents", views: 30, outside: 0,
//     vitals: { firstByte: { p75: 180, rating: "good", samples: 30 }, fcp: { p75: 420, rating: "good", samples: 30 },
//               lcp: { p75: 900, rating: "good", samples: 29 }, inp: { p75: 240, rating: "needs-improvement", samples: 12 },
//               cls: { p75: 0.01, rating: "good", samples: 30 } },
//     marks: { "iterate:itx-open": { p75: 610, samples: 30 } } }, … ] }
```

**Beside Vercel and Cloudflare** (checked against vercel.com/docs/speed-insights and
developers.cloudflare.com/web-analytics on 22 Nov 2026):

|                     | Vercel Speed Insights                            | Cloudflare Web Analytics                                 | Here                                                           |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------- |
| How                 | its script, with the `web-vitals` library        | its beacon script                                        | `page.js`, the `web-vitals` rules in a few lines               |
| Vitals              | TTFB, FCP, LCP, INP, CLS                         | LCP, INP, CLS, and the load's parts (TTFB, FCP and more) | TTFB, FCP, LCP, INP, CLS, `ready`, `loaded`                    |
| The app's own times | no                                               | no                                                       | `iterate:` marks (time to itx)                                 |
| Percentiles         | P75 by default, and others                       | P50 to P99                                               | P75                                                            |
| Split by            | route or path, device, country, the HTML element | path, host, browser, OS, country, the element            | app and path; each event also has browser, OS, device, country |
| Where it lives      | Vercel's dashboard and `vercel metrics`          | Cloudflare's dashboard and its GraphQL API               | events on `/pages`, read by an agent                           |
| Single-page apps    | soft navigations, in Chromium browsers alone     | route changes as page views                              | each view's INP and CLS; FCP and LCP of the first view         |

## The form of the tag, by the page's own content security policy (`tagFormOf`)

- No policy, or one that allows `'self'` and `'unsafe-inline'` scripts: **linked**, a few inline
  lines that keep early errors until the script runs, then `<script async fetchpriority="low"
src="/.page.js?v=…">`.
- Scripts from `'self'` (or `*`, `https:`) and no `'unsafe-inline'`: **src**, the script alone,
  `async` and `fetchpriority="low"`.
- `'unsafe-inline'` alone: **inline**, the whole script in the page.
- `sandbox`, a nonce or a hash, `'strict-dynamic'`, no `'self'` connect, or anything else: no tag.
  Such a page is counted from its request: one `page/viewed` with `how: "request"`, when the
  browser navigated to it (`sec-fetch-dest: document`), and no error, time or scroll.

No tag either for a framed document, a download, an encoded body, or a page whose answer says
`x-page-events: off` (it is then not counted at all).

## The page's two functions

- `window.capturePageEvent(name, values?)`: one named thing a person did.
- `window.reportPageError(error, kind?)`: for an error boundary (`kind` defaults to `render`).

## The bounds

Script: 30 sends a minute, 20 records a send, 100 waiting.

**A host reports only after the mind served it a page with the tag.** Any label under the domain
reaches this Worker. `worker.ts` calls `hostTagged` when an answer takes the tag, and the hostname
goes on the list `page-events/hosts` in kv (at most 200; an isolate keeps at most 200 too, and the
bound is checked before a host is added). Only an app's page takes the tag: the homepage of a label
that is no app answers with `x-page-events: off`, so an invented name never goes on the list. The
route asks `hostKnown`: the isolate's own set, else the list, read at most once in 10 s for an
isolate. A report to any other host gets what that host answers (an unknown label: the mind's 404).

Route: this host's origin alone (`origin`, else `sec-fetch-site: same-origin`; else 403), POST
alone (405), 64,000 bytes (413), a JSON object with a page id (400).

A sender is a **member** or **outside** ("Who gets the tag"). Per minute, in this isolate
(`BOUNDS`): each app 120 `viewed`, 120 `left`, 120 `captured` (errors: 30, exceptions.ts, and 30
more from outside, a minute of their own); a
member's visitor 60 records of any kind, all members 600; an outside visitor 20, all of the outside 60. The outside's texts are smaller: an error's message 300 characters and its stack 1,000 (a
member's 1,024 and 4,000), a title 80 (120), a captured event 6 values (12).

**The day's budget of the outside, for the whole mind, a HARD limit:** the facet `outside-days` on
`/pages` (`apps/telemetry/backend.ts`) holds a SQLite table with one row for each UTC day. A
send from outside reserves all its records there in ONE STATEMENT before anything is appended: it
adds them only when the day's sum stays at most 20,000, and a send that does not fit is dropped
whole. A Durable Object runs one call at a time, so the day never passes 20,000, however many
isolates send. After one refusal an isolate asks nothing more that day. A reservation that fails
drops the send. A view counted from its request (`how: "request"`) from outside asks the same
bounds and budget. The facet's class is in the app's `backend.ts`, the one file of an app that a
publication offers a facet's class from (apps.md, "A backend class"); the platform loads it from
this repo at its first call, by `mainModule` and `className`, and `worker.ts` needs no line.

A record over a bound is dropped silently; the answer stays 204. The page events of a send are one
`appendOffsets` call. ORDER: every record is read and bounded, then the outside's are reserved,
then appended. The route never throws: the body, every value the page sent and every call to the
mind are read inside its catch, and a failure (the body's stream, the day's secret, the
reservation, an append) answers 202 and appends nothing more.

## Read them

```ts
const { events } = await itx.cd("/pages").readEvents(0, 100); // each payload's `app` says whose
// the telemetry tables, once they are on (onboarding/telemetry.md): `events` has `type`, `path`
// and `payload` as text, the last `hours`
const { rows } = await itx.telemetry.query(
  `SELECT type, count(*) AS n FROM events WHERE path = '/pages' GROUP BY type ORDER BY n DESC`,
  { hours: 24 },
);
```

## Not there yet

Charts, sessions across page loads, click capture, and the control-plane pages (`core/`). In the
linked form a page that a person leaves before its `load` event sends nothing: the script has not
run yet. LCP and FCP of a prerendered page are not corrected for its activation, as `web-vitals` does. A
visitor who is known across days: that needs an id kept in the browser, the owner's decision.
Tests: `node --test apps/telemetry/*.test.mjs`.
