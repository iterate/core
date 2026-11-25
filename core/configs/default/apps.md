# Apps

How an app of this mind is laid out and mounted, the UI components a page loads, the integration
packages, the call on an agent, Meet and voice devices: `apps/`, `apps/theme.css`,
`apps/live-reload/live-reload.js`, `apps/open-files.ts`, `apps/dash/public/app.js`,
`apps/onboarding/`, `call.ts`, `apps/meet/` and `integrations` in `integrations.ts`.

An app is a folder under `apps/`, and a convention, not a framework: copy one to start one of your
own.

```
apps/<name>/
  index.html   the page; one file goes a long way
  public/      files served as they are, at the host's root: scripts, styles, images
  backend.ts   the app's Durable Object classes (stream processors too), if it has any
  app.ts       exports a function that makes an object with `fetch`
```

- **Mount it** in `worker.ts`: import the function, call it once, and give it a case in `fetch`
  (its `switch`):
  `case "notes": return this.auth.require(request) || notes.fetch(request, this);`. A changed
  `worker.ts` keeps `await init(itx)` in the init case: `init.ts` runs `installAgents(itx)` and
  `publishAgentKinds(itx, agentKinds)`.
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
- **An app says what it is in a typed object in its `app.ts`, and its icon is the mind's,
  `profile/icon.svg`.** The object is an `AppDescription` of `iterate/sdk`:
  `const DASH: AppDescription = { name: "Dash", icon: "/icon.svg", for: "members" };`.
  `serveAppDescription(request, DASH)` answers it as JSON at `/.well-known/iterate-app` on the
  app's host, where the mind's sign-in reads it. `worker.ts` answers the description and the icon
  before its guard (`app.open`, `apps/open-files.ts`), so they are public. The app keeps no icon
  file: `openFile` answers the mind's one icon at the app's `/icon.svg`, so every app and the
  website show one logo (`profile.ts`). An app of your own that wants another icon serves its own
  file at the path it names. Every other file of an
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
  An app for certain people names them as a mind's config names its owners: addresses in
  `allowedEmails`, and patterns in `allowedEmailPatterns`, each `*@<domain>` (every address at
  exactly that domain). The sign-in then mails a code for the app's host to an address that one
  of the two names, and takes no mailed code's session of any other address, so nobody else
  signs up. They bind the mailed code alone: which members come is still the app's guard.
  `this.auth.person(request).method` says which of the two the person used. The platform reads no
  web app manifest: an app that wants to be installable in a browser serves one of its own.
- **A page takes a new commit by itself: `apps/live-reload/live-reload.js`.** The Dash, the docs
  and the guestbook apps serve that one file at `/live-reload.js` (`app.ts`), and each page loads
  it in its head.
  When a commit is published, a stylesheet that changed is swapped in place. A page whose
  script changed reloads once nobody types in it, and what the person saw stays over the app
  until the app has drawn itself again. A member's page hears of a publication at once; any
  page looks when its tab comes to the front. Six seconds after a publication it heard of, the
  window gets the event `live-reload:published`: the Dash then reads the mind's name and icon
  again. To turn it off for an app, take the line out of
  its `index.html`.
- **The member's `itx` in the page.** `host.auth.itx(request)`, answered from a path of the app's
  choosing, makes that path a WebSocket to the mind's `itx` for the member who is signed in on
  that host: `newWebSocketRpcSession(new WebSocket("/itx"))`, a capnweb session
  (`memberItx()` of `@iterate-com/ui/live`, in `apps/dash/public/app.js`). The platform decides who the caller is, never the page. What the
  page appends shows `source.via.appPage`, and the socket closes when the sign-in ends.
- **MCP servers: the platform serves them, and a class of yours says what they offer.** The
  protocol, the sign-in and the skills catalog are the platform's, so none of it is in this
  repo's worker. A server is a class that extends `RpcTarget` (iterate/sdk `McpServerTarget`):
  `instructions()`, `tools()` (MCP's `Tool` entries; a call of a tool calls the method that has
  its name) and `skills()` (a folder: each folder in it with a `SKILL.md` is served by MCP's
  Skills extension, and as resources). Every method is optional.
  - **The mind's own server**, `https://iterate.<zone>/mcp`, for members, with the tool `run`:
    `mcp.ts` is its class, and `worker.ts` hands it over in the method `mcp(client)`. The deploy's
    config names that method (`"mcpTarget": "mcp"`); without it the platform's defaults answer.
    When the class fails, is slow or answers what the platform cannot use, the platform logs
    `mcp.config-target-failed` and its defaults answer: this file cannot break `run`.
  - **A server of an app**, at `/mcp` on the app's host: in `fetch`,
    `const mcp = this.auth.mcpServer(request, { target: "guestbookMcp", for: "people" }); if (mcp)
return mcp;`, and a method `guestbookMcp(client)` that answers the class
    (`apps/guestbook/`). `for` is who may connect: `"members"`, or `"people"` for anyone who
    signed in with an address. The platform decides that, from its own stamp on the request.
  - **`client`** is how the MCP client named itself (`client.name`: `claude-code`,
    `codex-mcp-client`) and who signed it in (`client.person`, `client.member`). Branch on the
    name for wording alone, as `mcp.ts` does for clients that do not list skills by themselves.
  - **Skills**: a folder under `skills/` with a `SKILL.md`
    ([Agent Skills](https://agentskills.io/specification)); `skills/mind-skills/SKILL.md` says
    how to add one. The server hands the files over and runs nothing from them.
  - An app that serves MCP by its own code can still hand a member's `tools/call` of `run` to
    the platform with `host.auth.mcpRun(request, message)`: the platform runs the script as the
    member the request was stamped with, never with the worker's reach.
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
active last. Its sidebar lists the agents active last above the foot rows (`Approvals` and
`Settings`, which opens `/settings` listing the mind's pages, access pages and apps); the account
popover holds `Your sessions` and `Sign out`, and clicking the mind header returns Home.
`apps/dash/public/app.js` is its contents, and it is yours to change: the list
of pages (pages with `row: false` stay routable and appear on Settings) and the apps and access
pages it links to (an optional `openers` map on the `agents` row can also seed an empty agent's
first turn, though the default config does not set one). `Dash` and its
pages are components of `@iterate-com/ui` (`components/dash`); a row can name a component of your
own instead, and the file's header says how.

Direction (Jonas, 2026-11-20):

- "the main UI, i think, should basically be the agents, though"
- "in general i only want a UI where we absolutely need one. where possible, we should just let people use their agents to interact with the systems"
- "i don't think 'Access' as a collapsible header is a good solution / i think just Settings or sth might be better"

**A page of your own, and a wrapper of your own around one of iterate's pages, is mounted anew
each time the page's connection comes back** (a deploy cuts it several times a day): what it shows
is drawn again, and a typed draft in it is lost. To keep them, say on the component that it stays,
`Notes.staysOverReconnect = true`, and then open its contexts with `useHeldContext` and
`useKeptContext` from `@iterate-com/ui/live`, which open them again by themselves. A wrapper that
only draws around one of iterate's pages needs the one line alone.

**Who else is here, and Share.** The Agents row has `presence: true`: an agent's chat shows who
else has it open and who is typing (from the context's own subscription rows; nothing durable is
written for it). It has `share` too: Share, a button after the call's controls in the agent's header (the
kit's `CallShare`, which Meet draws too), copies the members' link and makes links that let people who are not members into that one agent's chat and call, with
a name and no account. Its first open turns the agent's call on (the call's facet holds the links,
`call/share.ts`), and a link opens Meet's guest page, `https://meet.<zone>/join<agent>#<secret>`.
The link is shown once; the log keeps its secret's hash alone. A link lives an hour, a day or 7
days, and ends sooner when a member ends it there. Below the links, "Add to calendar" makes
Google Calendar's form or an .ics file, which holds the agent's page or the link just made.
`share.make` and `share.end` in `app.js` make and end a link with `share-links.js`, the one module
that makes a link: Meet's page (its twin in Meet's folder) and `itx.config.shareAgent`
(`call/share-api.ts`) use it too. The member's agent makes, lists and ends links with
`itx.config.shareAgent`, `shareLinks` and `endShare` ([AGENTS.md](AGENTS.md)).

**An agent's tools in the page are off.** `pageTools: true` on the Agents row of `app.js` makes
each member's open agent page lend that agent `itx.page.<person>.<tab>` while the page is open:
`banner.show(…)`, and, inside the element that `index.html` marks with `data-page-tools="scope"`
(`<body>` for the whole page), Playwright's locators with `fill`, `click`, `press`, `highlight` and
`textContent`. The member sees the agent's path on each banner, a label while a call runs, and
Stop; no call runs while the tab is in the background. What the agent does in the tab carries the
member's stamp in the log. The page's audit row for each call
(`events.iterate.com/page/tool-called`) carries that stamp too and names no caller: any unjailed
code of the mind can call a lent name. On your own Dash the scope and the fields that never match
are manners, no wall: an unjailed agent can commit to this repo, which is the Dash's code. The
walls are the jail (an agent whose scripts run in a jail gets no lend) and the passkey (no tool
reaches the pages where a member signs). `pageTools: { tools }` adds functions of your own: the
kit's README has the lines for an `evaluate` tool, and its price.

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

`integrations` in `integrations.ts` lists the integration packages this mind hosts (`Integration` from
`iterate/sdk`: a Telegram bot, your own GitHub App, and more, one folder each in
https://github.com/jonastemplestein/iterategrations, whose recipes add one). Each is one element,
from its package (`telegram()`, `github()`). A package that serves pages gets a case of its own
in `worker.ts`'s `fetch`, on its hostname's first label (`case "telegram": return
telegram.fetch(request, this)`), and `processEvent` hands every package every event after the
mind's own cases (`every-event.ts`):
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
their Dash chat with `/agents/main`. This repo keeps its routes and its steps; the page
(`index.html`, `public/`), the agent's guides and the cards of the Tasks board are the repo
`/repos/onboarding`, which a new mind starts with. Every request on `onboarding.<zone>` that the
app does not answer goes to the worker of that repo at its newest commit (`pageFromRepo` in
`apps/onboarding/app.ts`). Delete that repo to retire the page: the host then answers 404.

1. **Connect to iterate Cloud (optional):** the owner signs the meld rule with a passkey and takes
   iterate's credit for OpenAI and Exa by iterate's proxy, or skips (`steps/connect-iterate-cloud.ts`).
   Connected, `itx.ai` also runs through iterate Cloud once the Cloud recognises the mind
   (`cloud-ai.ts`); `await itx.iterateCloud.usage()` reads that spend.
2. **Configure AI:** ready to continue if iterate Cloud credit is connected; otherwise the owner
   adds an OpenAI API key (`itx.secrets.collectFromUser`), connects a ChatGPT Plus/Pro plan
   (`npx iterate@latest chatgpt connect <mind>`), or uses Cloudflare AI Gateway credit.
3. **Verify & wake:** a loading gate that runs a real server-side test LLM inference request
   (`POST /verify-ai`), triggers the idempotent opener on `/agents/main`, and waits for the
   onboarding agent's first assistant response before redirecting to
   `https://dash.<zone>/agents/agents/main`.

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
worker.ts      add the import beside the others, and the step after `await init(itx)` in the init case:
                 import { installVoice } from "@iterate-com/voice/install";
                 await step("voice", () => installVoice(itx));
```

The step makes the service at `itx.voice`.

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
  turn and is owed an answer: who is in the call, what video is shared, and the recent talk as
  quoted material. The agent always answers, in one short spoken reply, and may look things up
  for anyone; while a guest is in the call it takes no action with an effect on the transcript
  alone, and says that a member must type it in the chat. The answer is the agent's first message
  from a turn or a script that began after the request, never words written beside a script; it
  comes back in the live state, and the host tab gives it to the model to say. A request of the
  agent's turn that fails ends the delegation at once. One request at a time, 6 a minute; an answer
  waits 90 s at most, and the request ends when the voice agent leaves.
  Failures of the SFU and OpenAI go to the audit log `<agent>/call`.
- **"Let the agent look."** A member who shares a camera or a screen in Meet may turn it on for
  that source; it is off by default, and ends when the source stops or the page leaves. Then the
  agent of the call may take ONE still picture: `await itx.config.callSnapshot({ source: "screen" })`
  (or `"camera"`, and `of: "<name>"` to choose a person), from the agent's own context alone. The
  member's page takes the picture and sends it to Meet (`POST /snapshot<agent>`); it comes to the
  agent as a quiet note with the JPEG attached, stored at `/call-snapshots<agent>/`, outside the
  agent's path, so a guest's view cannot read it. An upload that is refused (no JPEG, too long)
  fails its request, and one for an agent that is not there or has no call answers 404 and makes
  nothing (`itx.config.shareAgent`, `shareLinks` and `endShare` refuse a path with no agent the
  same way: by the mind's catalog, with no call to the path). A refusal says why (`{ status: "refused",
reason }`); never try again without asking. A request lives 20 s, one at a time, 10 a minute;
  each step is on `<agent>/call` (`call/snapshot-requested`, `-taken`, `-failed`, `-refused`).
- **What is said shows in Meet**, from the call's notes: a caption strip over the composer, which
  opens to the whole transcript. `caption` takes a page's words while they are still spoken, as
  an ephemeral `call/caption-frame` on the agent's context (never stored); the template's pages do
  not send them yet.
- **An agent calls a member to a call, on their Mac.** A member's Mac with the iterate menu-bar
  app (`@iterate-com/mac-app`, lent as `itx.<name>`, for example `itx.jane.mac`) is an endpoint
  device of the mind, and banners on its screen are one of its outputs (Banners not Off in its
  panel). `mac.banner.show` shows a title, text and one to three buttons, and answers the label
  pressed (`{ pressed }`, or `{ pressed: null, why }`); a button's `open` page, on the mind's own
  domain, opens in the browser after the press. `mac.call.ring` is a banner that looks like a call:
  Accept opens the agent's page in the Dash with `call=join`, which opens the call's lobby: the
  person checks their camera and sound, then presses Join now (or Start the call, when it is off)
  (`{ accepted }`, or `{ accepted: false, why }`). Show one only
  when the person asked for it or said it may interrupt them, and read first whether they are at
  the Mac: `(await mac.state()).presence` is `{ idleSeconds, screenLocked, displayAsleep }`; idle
  under a few minutes, not locked and a display awake is the sign.

  ```js
  const mac = itx.jane.mac; // the Macs: (await itx.rewriteRules.list()).filter((rule) => rule.description?.includes("iterate menu-bar app"))
  await mac.call.ring({
    agent: "/agents/lunch",
    from: "Lunch planner",
    reason: "Friday's table needs a yes",
  });
  await mac.banner.show({
    title: "Design review is starting",
    body: "Misha asks you to join",
    buttons: [
      {
        label: "Join",
        style: "accept",
        open: "https://meet.<zone>/contexts/agents/meet/<meeting>",
      },
      { label: "Not now" },
    ],
  });
  ```

- **The page's parts** (the UI kit): `useCall(context, page, liveValue)` holds the call in the tab;
  `CallLobby` comes before a join on arrival (below): the person's camera picture, their microphone's level, the
  devices, a test sound, who is in the call, then Join now or Join muted; the tracks it opened go
  to the call as they are. `CallHeaderControls` is its controls for a header. Out of the call it is
  one button: Start call when nobody is in the call (it turns the call on when the agent has none),
  or Join call with how many are in it; a press joins with the microphone, or listening when the
  browser refuses the microphone. In the call it is one button group of icon buttons with tooltips
  (the microphone, the camera, the screen, the voice agent, the devices) and Leave. The Dash and Meet draw it, and Share
  (`CallShare`) beside it. `CallBar` is the older row with a main button in words. `CallTiles` is the cameras, the
  screens and what the call says, beside the chat. TURN over TLS on 443 where UDP is blocked,
  pickers for the microphone, camera and speaker, repair of a failed connection, three simulcast
  layers for a camera. Capture starts only by the person's own press: a page that joins again by
  itself keeps the mute, and its camera and screen stay off. A Dash link with `call=join`
  (`/agents<agent>?call=join`) opens the lobby as the page loads, but anyone can send a member
  such a link, so that lobby opens no microphone and no camera by itself, and nothing joins until
  the person presses Join now. `useCallPip`, `CallPipButton` and
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
- **A meeting's page** is the Dash's agent page, drawn by the same kit part
  (`AgentPageHeader`): one header row (a back arrow to the meetings, the title and path, who is
  here with the mind's face first, the call's button group, Share, and Chat | Events), the call's
  tiles, then the chat, which fills the window. Share (a member's) holds the members' link, the
  links for guests (7 days at most) and "Add to calendar" (Google Calendar's form, or an `.ics`
  file built in the page). While the call is on, a line under the header holds the pop-out of the
  tiles and "Let the agent look". The mind's face is its profile's icon and name
  (`https://<zone>/.well-known/iterate-profile`, as the Dash reads it). A guest always comes in
  here. The pop-out works in Chrome and
  Edge alone (Document Picture-in-Picture): other browsers get no button.
- **Guests** come by a share link, `/join/<agent>#<secret>`: the page keeps the secret in the tab
  (in the address, when the tab cannot store it), the guest signs in with a name, and `app.ts`'s
  guest routes append `share/guest-joined`, then open the platform's view of the one agent's context for them (`personItx` with `{ guests: true }`). An
  invite that holds a guest link lets anyone who has it in until the link ends.
- **No live reload**: a reload for a commit would drop the call.
