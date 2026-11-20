# Apps

How an app of this mind is laid out and mounted, the UI components a page loads, the integration
packages, the call on an agent, Meet and voice devices: `apps/`, `apps/theme.css`,
`apps/live-reload/live-reload.js`, `apps/open-files.ts`, `apps/dash/public/app.js`,
`apps/onboarding/`, `call.ts`, `apps/meet/` and `integrations` in `worker.ts`.

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
- **An app says what it is in a typed object in its `app.ts`, and has an icon,
  `public/icon.svg`.** The object is an `AppDescription` of `iterate/sdk`:
  `const DASH: AppDescription = { name: "Dash", icon: "/icon.svg", for: "members" };`.
  `serveAppDescription(request, DASH)` answers it as JSON at `/.well-known/iterate-app` on the
  app's host, where the mind's sign-in reads it. `worker.ts` answers the description and the icon
  before its guard (`app.open`, `apps/open-files.ts`), so they are public. Every other file of an
  app is behind the guard. An app whose guard is `this.auth.require` says `for: "members"`: the
  sign-in page then says that the app works as the person, and opens on the passkey. An app for
  end users (the guestbook) leaves it out, and its sign-in page opens on the mailed code.
- **An app names how its people sign in: `signIn`, an ordered list of `"email"` and
  `"passkey"`.** The sign-in page opens on the first and offers the others below it. The mind's
  sign-in holds every sign-in for the app's host to the list, an MCP client's too, so the app's
  guard takes no list. A passkey's session counts at every app. With no `signIn`, an app for
  members gets the passkey alone, and any other app email then passkey. A mailed code signs in no
  member: it gives a person who is no member a session for the apps, so an app for members has no
  reason to name `"email"`. The code is mailed from
  `sign-in@<the zone of the app's host>`, under the app's name.
  `this.auth.person(request).method` says which of the two the person used. The platform reads no
  web app manifest: an app that wants to be installable in a browser serves one of its own.
- **A page takes a new commit by itself: `apps/live-reload/live-reload.js`.** The Dash, the docs
  and the guestbook apps serve that one file at `/live-reload.js` (`app.ts`), and each page loads
  it in its head.
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
  (`iterate tunnel <port>` sets a route per tunnel; a sandbox's `exposePort` sets one per port,
  `sandboxes.md`; `itx.fetchRoutes.set` sets one by hand).
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

**A page of your own, and a wrapper of your own around one of iterate's pages, is mounted anew
each time the page's connection comes back** (a deploy cuts it several times a day): what it shows
is drawn again, and a typed draft in it is lost. To keep them, say on the component that it stays,
`Notes.staysOverReconnect = true`, and then open its contexts with `useHeldContext` and
`useKeptContext` from `@iterate-com/ui/live`, which open them again by themselves. A wrapper that
only draws around one of iterate's pages needs the one line alone.

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
from its package (`telegram()`, `github()`). A package that serves pages gets a case of its own
in `fetch`, on its hostname's first label (`case "telegram": return telegram.fetch(request,
this)`), and `processEvent` hands every package every event after the mind's own cases:
a package's install hook is its `mind/worker-updated` case, where it registers its card on
`/integrations` for the Dash's Integrations page (`iterate/integrations`; writing a package of
your own: https://github.com/jonastemplestein/iterategrations/blob/main/adding-an-integration.md). A hook returns for an
event it does not handle: one that throws fails this event for the whole worker, which the
platform retries, and a hook that throws on every event slows the mind's own cases to a
trickle. A package serves its
own setup page and webhook on its host and keeps its credentials through `itx.secrets`; the
Dash shows what it registered and links to its page.

## Onboarding

`apps/onboarding/` is a centered, no-AI setup wizard that gets a new owner from a fresh deploy into
their Dash chat with `/agents/onboarding`:

1. **Connect to iterate Cloud (optional):** the owner signs the meld rule with a passkey and takes
   iterate's credit for OpenAI and Exa by iterate's proxy, or skips (`steps/connect-iterate-cloud.ts`).
2. **Configure AI:** ready to continue if iterate Cloud credit is connected; otherwise the owner
   adds an OpenAI API key (`itx.secrets.collectFromUser`), connects a ChatGPT Plus/Pro plan
   (`npx iterate@latest chatgpt connect <mind>`), or uses Cloudflare AI Gateway credit.
3. **Verify & wake:** a loading gate that runs a real server-side test LLM inference request
   (`POST /verify-ai`), triggers the idempotent opener on `/agents/onboarding`, and waits for the
   onboarding agent's first assistant response before redirecting to
   `https://dash.<zone>/agents?contextPath=/agents/onboarding`.

The step "Connect to iterate Cloud" writes four events on `/apps/onboarding` (`contract.ts`), and
every button of it is also the onboarding agent's call `itx.config.onboardingStep(step, action)`,
which answers `{ status, words, link? }`.

## Voice devices

To talk to the mind in a browser, start a call on any agent in the Dash and add the voice agent
("A call on an agent", below): nothing to install. The package `@iterate-com/voice` is for
devices outside the Dash, a phone line or a speaker: a live model (OpenAI's, with the mind's key
at `/secrets/openai`) listens and speaks, and hands what it cannot answer to the device's own
agent, `/agents/voice/<device>`, which remembers every call. Its README says how a call works.

It is off in a new mind. To turn it on, make this commit:

```text
package.json   "dependencies": { "@iterate-com/voice": "<a build of npm's main tag, pinned>" }
voice.ts       export { default, VoiceAgentDurableObject } from "@iterate-com/voice";
worker.ts      take the "// " off the import of installVoice, and off installVoice(itx) in the init case
```

To upgrade, change that pin. A commit that changes what `voice.ts` bundles ends the device calls
in progress.

## A call on an agent

Any agent's context can hold a call: everyone in it talks, and shares a camera and a screen,
through Cloudflare Realtime's SFU, and a member can add the voice agent, which everyone hears and
talks to. No app is needed and nothing is turned on: every agent's page in the Dash has "Start a
call", and the call offers the voice agent. It never joins by itself: a member adds it, since it
costs money each minute. A page draws the call with the UI kit's parts (`@iterate-com/ui`).
Meet (below) is the template's page for it.

- **The call is a facet on the agent's context**, the processor row `call`: `call.ts` at the
  config's root (a publication offers a facet's class only from a root module or an app's
  `backend.ts`), its rules in `call/rules.ts`. A member's page turns it on:
  `itx.cd(agent).processors.enable("call", CALL_FACET)`. A page calls its four methods over the
  session it already holds: `join`, `signal` (one step of the SFU's signalling), `leave` and
  `voiceAgent`. Its live state is what a page draws: who is in the call and what each page sends,
  the voice agent, which secrets the mind has (`setup`, null until its first read), and the live
  share links.
- **Who asks is the kernel's word** (`onBehalfOf()` of iterate/sdk). A page is its own subscription
  row on the agent's context, held by the asker: when that row is un-set (the page closed, or its
  socket went silent), the page is out of the call and its SFU sessions close. A call that names
  nobody (a script, an agent's tool) is refused in words: the agent is no participant, and it
  learns of the call by its notes.
- **Guests** are on a share link (`call/share.ts`: `share/link-made`, `share/link-ended`,
  `share/guest-joined` on the agent's own log; the secret only as its hash). From a page that holds
  a guest's view of the agent's context, a guest calls `join`, `signal` and `leave` (the facet's
  `personMethods`); the call checks the guest's link at each call, and a guest whose link ended is
  out at the call's next look. The voice agent is a member's alone.
- **What the call does outside the mind** (`call/outbound.ts`), with secrets by placeholder:
  `/secrets/cloudflare-realtime-sfu` and `/secrets/cloudflare-turn` (the stack's deploy makes them),
  and `/secrets/openai` for the voice agent. Each call outside the mind has a bound of 10 s. A
  member's relay credentials last 4 hours, a guest's 15 minutes. The voice agent leaves when its
  host's page leaves, when no member is in the call, when a member sends it away, and after 30
  minutes; a hang-up OpenAI did not take is tried again.
- **What the agent is told**: one quiet message for each fact (who joined and left, a camera or a
  screen on and off, the voice agent in and out, and what was said), `payload.callNote` beside its
  words, and no turn. A guest is named as "a guest who gives the name …": the name is the guest's
  claim, cut to 40 characters, with no bracket and no line break.
- **What is said reaches the agent.** Each page transcribes its own person's microphone with
  OpenAI's `gpt-live-transcribe` (a socket with a one-minute key that `transcription` makes from
  `/secrets/openai`, which never leaves the mind), and only speech is sent. Each finished line goes
  to `said`, and the agent reads it as `[call] <who> said: "…"`: a member as "<name> (a member)", never by
  their address (a guest's view reads the agent's log), and a guest as "a guest who gives the name
  …". Both methods are person methods, so a guest's words count, as
  words from outside. Bounds: 40 lines a minute for each speaker, 1,000 characters a line, 60
  transcription sessions in ten minutes for the call. A page transcribes only while it is in the
  call and its microphone is not muted: a mute closes the session. OpenAI bills
  `gpt-live-transcribe` by the minute of audio, $0.017 a minute
  ([price](https://developers.openai.com/api/docs/pricing)), so one person who speaks for an hour
  costs about $1.02; silence is not sent. What the voice agent said comes from its host
  page alone. A mind with no OpenAI key has no captions; the call works without them.
- **The voice agent can ask the agent of the context** (OpenAI's client delegation, its one way
  out). The model asks on its host tab; the tab hands the request to `delegate` (a member's call,
  from the host page alone), and the call puts it on the agent's log as a message that starts a
  turn and is owed an answer: who is in the call, the recent talk as quoted material, and a tag. The
  agent always answers, in one short spoken reply that begins with the tag, and may look things up
  for anyone; while a guest is in the call it takes no action with an effect on the transcript
  alone, and says that a member must type it in the chat. The answer comes back in the live state,
  and the host tab gives it to the model to say. One request at a time, 6 a minute; an answer
  waits 90 s at most, and the request ends when the voice agent leaves.
  Failures of the SFU and OpenAI go to the audit log `<agent>/call`.
- **The page's parts** (the UI kit): `useCall(context, page, liveValue)` holds the call in the tab;
  `CallBar` is its controls, small enough for an agent's header; `CallTiles` is the cameras, the
  screens and what the call says, beside the chat. TURN over TLS on 443 where UDP is blocked,
  pickers for the microphone, camera and speaker, repair of a failed connection, three simulcast
  layers for a camera. Capture starts only by the person's own press: a page that joins again by
  itself keeps the mute, and its camera and screen stay off. `useCallPip`, `CallPipButton` and
  `CallPipPlace` put the tiles in a floating window where the browser has Document
  Picture-in-Picture.

## Meet

`apps/meet/` is Meet, on `meet.<zone>`: "Start new meeting", the recent meetings, and any agent's
chat with its call at `/contexts/<agent>`. It has no API of its own: the page holds the member's
`/itx` socket.

- **A meeting is an agent** `/agents/meet/<YYYY-MM-DD>-<HHMM>-<slug>` (UTC; the slug from the title,
  or three random words). `itx.config.startMeeting({ title?, path? })` makes one and turns its call
  on, or turns the call on for the agent `path`; it answers `{ path }`. The page's button is this
  call, and an agent starts a meeting the same way (`apps/meet/meeting.ts`).
- **A meeting's page** is the agent's chat (Chat | Events: Events is the raw log), the call's bar,
  its tiles, a pop-out of the tiles, "Add to calendar" (Google Calendar's form, or an `.ics` file
  built in the page) and the links for guests (7 days at most). The pop-out works in Chrome and
  Edge alone (Document Picture-in-Picture): other browsers get no button.
- **Guests** come by a share link, `/join/<agent>#<secret>`: the page keeps the secret in the tab
  (in the address, when the tab cannot store it), the guest signs in with a name, and `app.ts`'s
  guest routes append `share/guest-joined`, then open the platform's view of the one agent's context for them (`personItx` with `{ guests: true }`). An
  invite that holds a guest link lets anyone who has it in until the link ends.
- **No live reload**: a reload for a commit would drop the call.
