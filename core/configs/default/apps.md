# Apps

How an app of this mind is laid out and mounted, the UI components a page loads, the integration
packages and Voice: `apps/`, `apps/theme.css`, `apps/live-reload/live-reload.js`,
`apps/open-files.ts`, `apps/dash/public/app.js`, `apps/voice/` and `integrations` in `worker.ts`.

An app is a folder under `apps/`, and a convention, not a framework: copy one to start one of your
own.

```
apps/<name>/
  index.html   the page; one file goes a long way
  public/      files served as they are, at the host's root: scripts, styles, images
  backend.ts   the app's Durable Object classes (stream processors too), if it has any
  app.ts       exports a function that makes an object with `fetch`
```

- **Mount it** in `worker.ts`: import the function, call it once, and give it a case in `fetch`:
  `case "notes": return this.auth.require(request) || notes.fetch(request, this);`. A changed
  `worker.ts` keeps `installAgents(itx)`, `publishAgentKinds(itx, agentKinds)` and the onboarding
  agent's `itx.agents.create` in the init case.
- **No build.** A module imports a file that is not code and gets its text, or its bytes when it is
  not text (`import index from "./index.html"`). An import that ends in `/` is every file under
  that folder, by path (`import files from "./public/"`). `serveFiles(request, { index, files })`
  from `iterate/sdk` answers a path that names a file with that file, and any other page load with
  `index`. So a commit publishes the page with the worker, as one thing.
- **The page loads packages from a URL**, pinned in its import map ("UI components in a page", below, shows how).
- **Icons come from the UI package: `@iterate-com/ui/icons`.** It has the icons these apps use
  and the common ones (`BotIcon`, `PlusIcon`, …; Lucide's, by lucide-react's names). Do not import
  `lucide-react` in a page: from a module server it is one module of every icon Lucide has,
  826 kB for the few a page shows. The import map still names it, so a page that does import it
  keeps working. For an icon the package does not have, import its own file, which is 4 kB:
  `import CompassIcon from "https://esm.iterate.com/lucide-react@1.48.0/dist/esm/icons/compass.js?external=react"`.
- **One look for every app: `apps/theme.css`.** Each app but the guestbook serves that one file
  at `/theme.css` (`app.ts`) and its page links it after the UI kit's style sheet. It holds the
  colours and the corners (shadcn's theme variables). The apps are light, whatever the visitor's
  system says; to make them all dark, change `light` to `dark` in the file's `color-scheme` line.
- **An app says what it is called and has an icon: `public/manifest.webmanifest` and
  `public/icon.svg`.** Its page links both, so a browser tab shows the icon. `worker.ts` answers
  these two files before its guard (`app.open`, `apps/open-files.ts`), so they are public: the
  mind's sign-in pages read them. Every other file of an app is behind the guard. An app whose
  guard is `this.auth.require` says `"iterate": { "for": "members" }` in its manifest: the
  sign-in page then says "Dash is an app of iterate.<domain>" and "Dash is for people with access to it", and invites no new address. An app
  for end users (the guestbook) leaves it out. An app whose guard names its ways
  (`this.auth.requirePerson(request, { methods: ["cloudflare"] })`) names them in its manifest
  too, `"iterate": { "methods": ["cloudflare"] }`: an MCP client sends no ways of its own, so its
  sign-in for the app's `/mcp` then offers the app's ways.
- **A page takes a new commit by itself: `apps/live-reload/live-reload.js`.** The Dash, the docs
  and the guestbook apps serve that one file at `/live-reload.js` (`app.ts`), and each page loads
  it in its head; the Voice app does not.
  When a commit is published, a stylesheet that changed is swapped in place. A page whose
  script changed reloads once nobody types in it, and what the person saw stays over the app
  until the app has drawn itself again. A member's page hears of a publication at once; any
  page looks when its tab comes to the front. To turn it off for an app, take the line out of
  its `index.html`.
- **The member's `itx` in the page.** `host.auth.itx(request)`, answered from a path of the app's
  choosing, makes that path a WebSocket to the mind's `itx` for the member who is signed in on
  that host: `newWebSocketRpcSession(new WebSocket("/itx"))`, a capnweb session
  (`memberItx()` of `@iterate-com/ui/live`, in `apps/dash/public/app.js`). The platform decides who the caller is, never the page. What the
  page appends shows `source.via.appPage`, and the socket closes when the sign-in ends.
- **Who asked.** A facet's code appends as its context, not as the person who called it. So when a
  signed-in person calls a facet (`itx.agents.get(path).message(...)` is such a call), what the
  facet then appends shows them as `source.onBehalfOf`: `principal`, `grant`, `via` when they
  came through a page, and `call` (`/agents#agents.get.message`). It says who asked, never what
  they may do: check `source.principal` for that. An agent takes a member's words as the owner's,
  from a page too, and the chat shows who said each message.
- **A backend class** in `apps/<name>/backend.ts` is a facet like any other:
  `itx.cd(path).facets.get(name, { className, mainModule: "apps/<name>/backend.ts", source: ["itx", ["cd", "/"], "config"] })`.
  Write the source as that expression, an array that the platform resolves, in a page, in a
  script and in an app's own code alike. A live handle in its place (`source: itx.cd("/").config`)
  fails with "Cannot read properties of undefined (reading 'length')": seen on 16 Nov 2026 from a
  page, from the CLI's connection and from a script run in the mind. A file map
  (`source: { "package.json": …, … }`, at most 1,048,576 characters) is the form for a candidate.
- **A fetch route.** A request
  a fetch route takes never reaches `fetch`: the platform sends it to the route's target first
  (`iterate tunnel <port>` sets a route per tunnel; `itx.fetchRoutes.set` sets one by hand).
- **People who are not members** never get `itx`. Their page talks to your code: answer its
  requests in the app's `fetch`, and check `host.auth.person(request)` there.

## The Dash

The Dash's home has a composer that starts an agent, what waits for the member and the agents
active last, and it says how to connect a coding agent over MCP. Its sidebar lists the agents active last, and ⌘K finds
an agent, any context, or a path (type `/`). `apps/dash/public/app.js` is its contents, and it is yours to change: the list
of pages (the sidebar comes from it), the apps and access pages it links to, and what the mind says
first in an agent's empty chat (`openers`). `Dash` and its
pages are components of `@iterate-com/ui` (`components/dash`); a row can name a component of your
own instead, and the file's header says how.

## UI components in a page

A page `fetch` serves can render iterate's own components (the stream viewer `ContextView`, buttons,
code views) with no build step: an import map points at `@iterate-com/ui` on esm.sh, pinned to the
version npm's `main` dist-tag names (`https://registry.npmjs.org/@iterate-com/ui`), and React comes
from that package too, so any other React library loads with `?external=react,react-dom`.

Each component is `@iterate-com/ui/components/<name>` (`context-view/context-view`,
`repo-ide/repo-ide`, `ui/card`, …). The package's README has a whole page, with its import map (polling, a React library
beside it): https://github.com/iterate/packages/blob/main/packages/ui/README.md#a-one-off-page-esmsh.
Its AGENTS.md has the rest: https://github.com/iterate/packages/tree/main/packages/ui.

The source of every component is public in that repository, under `packages/ui/src`: read it before
you guess at a prop, and copy a component into your app when you want to change it. An import of
`@iterate-com/ui/components/<name>` is `src/components/<name>.tsx` there. `main` is the newest
build; the README's "The source of a version" says how to read the source of the version a page
pins.

## Integration packages

`integrations` in `worker.ts` lists the integration packages this mind hosts (`Integration` from
`iterate/sdk`: a Telegram bot, your own GitHub App, and more, one folder each in
https://github.com/jonastemplestein/iterategrations, whose recipes add one). Each is one element,
from its package (`telegram()`, `github()`). `fetch` hands a package the requests on its own
routing slug, and `processEvent` hands every package every event after the mind's own cases:
a package's install hook is its `mind/worker-updated` case, where it registers its card on
`/integrations` for the Dash's Integrations page (`iterate/integrations`; writing a package of
your own: https://github.com/jonastemplestein/iterategrations/blob/main/adding-an-integration.md). A hook returns for an
event it does not handle: one that throws fails this event for the whole worker, which the
platform retries, and a hook that throws on every event slows the mind's own cases to a
trickle. A package serves its
own setup page and webhook on its host and keeps its credentials through `itx.secrets`; the
Dash shows what it registered and links to its page.

## Voice

`apps/voice/` makes a browser a voice device of the mind. Call opens the microphone; a live model
(OpenAI's, with the mind's key at `/secrets/openai`) listens and speaks; what it cannot answer it
hands to the device's own agent, `/agents/voice/<device>`, an agent like any other, which
remembers every call. The code is the package `@iterate-com/voice`; its README says how a call
works.

Voice is off in a new mind, because it needs that package and a key. The page says so, and its
"Turn voice on" makes this commit in the member's name. To make it by hand:

```text
package.json   "dependencies": { "@iterate-com/voice": "<a build of npm's main tag, pinned>" }
voice.ts       export { default, VoiceAgentDurableObject } from "@iterate-com/voice";
worker.ts      take the "// " off the import of installVoice, and off installVoice(itx) in the init case
```

The page then asks for the OpenAI key once, if the mind has none. The page loads its voice code
from the build that `package.json` pins, so the page and the mind's relay are one build: to
upgrade, change that pin. A commit that changes what `voice.ts` bundles ends the calls in progress.
