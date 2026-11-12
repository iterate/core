# Mind configuration

This repository is the mind's code. A commit to `main` publishes it: the platform loads
`worker.ts`, the `main` in `package.json`, and every context of the mind runs the new code.

`worker.ts` extends `IterateConfigEntrypoint` from `iterate/sdk`, which holds the hosts (a
processor imports `StreamProcessor` and `defineProcessorContract` from `iterate/stream/processor`):

- `processEvent({ event, itx })` sees every durable event of every context of the mind, one at
  a time, in no particular order and at least once, so each case must be idempotent. `itx` is the
  mind's root; `itx.cd(event.path)` is the event's own context. Keep no state in the worker:
  read it from the mind.
  - The `events.iterate.com/mind/worker-updated` case is the init hook. It runs after every
    published commit: it installs the agents app and creates the onboarding agent. It sets no
    schedule, so an idle mind sleeps; uncommenting the heartbeat there sets one that wakes it
    every five minutes.
  - The `events.iterate.com/email/received` case hands each email a member sends to the mind
    to an agent of its own per thread, `/agents/email/t<thread>`, once the `email` facet has
    folded it into its thread; the agent replies with `itx.email.send({ inReplyToOffset })`. An
    agent acts with the mind root's full reach: every context, secret-backed call, repository
    and the website. So only the platform's own record of a member's mail sent straight from their
    domain reaches one; a forward, a list's copy, a re-sent old message, an auto-reply or a bounce
    is ignored.
  - The `events.iterate.com/slack/webhook-received` case is the Slack agent (`slack.ts`): one agent
    for each Slack thread, at `/agents/slack/<team>/<channel>/<thread>`. A mention of the bot or a
    direct message starts one; a later message of the thread reaches the same agent. The agent
    answers by calling Slack's Web API itself: `await itx.config.slack("chat.postMessage", {
channel, thread_ts, text })`, and any other method the same way. The token stays in the vault
    (`/secrets/slack`, linked through iterate Cloud's Slack app). An agent holds the whole `itx`, so
    only a member of the mind reaches one (`slackSenderIsMember`): a full member of the workspace
    whose email, which Slack confirmed, is a member's address here (`itx.members.has(email)`).
    Anyone else gets one short refusal for a mention, and no agent.
  - The `events.iterate.com/x/message-received` case hands what a linked X account says to
    iterate's bot (a direct message, or a post that mentions it) to an agent of its own per
    account, `/agents/x/u<x user id>`. A member links an account with
    `itx.secrets.beginOAuth("/secrets/x", { client: { cloud: "x" } })` and opens the link. iterate
    Cloud then relays that account's messages, each signed by the Cloud's key, and only an event
    with that signer reaches an agent. The agent answers through the Cloud with the `itx.fetch` its
    context shows; the vault signs that request, and the Cloud sends it as the bot only to an
    account this mind linked. Link a member's own account alone: whoever writes from a linked
    account speaks to an agent with the mind's reach.
- `fetch` serves every host of the mind. The `x-iterate-routing-slug` header names the host
  (`blog` for `blog.<domain>`, absent on the apex), so `fetch` is a `switch` on it, one case for each
  host. The guard beside a case says who may come: none for a public site, `this.auth.require`
  for members, `this.auth.requirePerson` for anyone signed in. A request
  a fetch route takes never reaches it: the platform sends it to the route's target first
  (`iterate tunnel <port>` sets a route per tunnel; `itx.fetchRoutes.set` sets one by hand).
- `integrations` lists the integration packages this mind hosts (`Integration` from
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

The agents' runtime is `iterate/agents`, which comes from the platform like the rest of
`iterate/*`: the mind runs the deployment's own build, and a platform deploy upgrades it.
`apps/agents/backend.ts` re-exports its two classes and sets what a new agent pays with: a ChatGPT
plan, else an OpenAI API key, else the deployment's AI Gateway credit. Every agent runs from that
file's own bundle, so a commit that changes only `worker.ts` or the page leaves the agents running.

## Kinds of agent

Any context under `/agents` is an agent, and its kind is what the catalog lists it as: `iterate` for
the agents app's own, `claude` for a Claude Code session, or one of your own. A kind is one file
(`agent-kinds/<kind>.ts` by convention) whose default export `satisfies AgentKind`, named in
`worker.ts`. `iterate/agents/kinds` has `makeAgentKind` and `AgentKind`;
`@iterate-com/ui/agent-kind-view`'s `AgentKind` is the same with the view typed:

```ts
// worker.ts
import { makeAgentKind } from "iterate/agents/kinds";

const agentKinds = [
  makeAgentKind(import.meta, () => import("./agent-kinds/iterate.ts")),
  makeAgentKind(import.meta, () => import("./agent-kinds/grok.ts")),
];

// agent-kinds/grok.ts
import type { AgentKind } from "@iterate-com/ui/agent-kind-view";
import { createXai } from "@ai-sdk/xai"; // server only: fine to import, used in processEvent

export default {
  kind: "grok",
  // the Agents app reads the agent's durable log, and these ephemeral types for its view
  ephemeralEvents: ["x.ai/grok/token"],
  // its server half, an Integration's processEvent: every event of the mind
  processEvent: async ({ event, itx }) => {
    if (event.type !== "events.iterate.com/agent/message-received") return;
    if (!event.path.startsWith("/agents/grok/")) return;
    // answer it, appending to itx.cd(event.path)
  },
  // its chat: htm, not JSX, with iterate's chat parts (`ui.AgentShell`, `ui.Feed`, …)
  view:
    ({ html, useMemo, ui }) =>
    (props) =>
      html`<${ui.AgentShell} ...${props} />`,
} satisfies AgentKind;
```

Every kind shares two things: the catalog row (kind, status, activity, title), and words sent with
`itx.agents.get(path).message(…)`, which land on the agent's log as
`events.iterate.com/agent/message-received`. Everything else is the kind's own: its events, its
rows and its chat. `worker.ts` runs each kind's `processEvent` beside the integrations, and on every
publish writes where each kind's file is to the mind's KV (`agent-kinds`), where the Agents app
finds it. The app runs `view` in a sandboxed frame with only that agent's log and verbs; there, a
server-only import is a stand-in that throws if the view touches it. A kind whose agents run
elsewhere (iterate's in the platform) needs no `processEvent`.

`worker.ts` reaches the mind through the `itx` that `processEvent` is handed, or through
`using itx = this.getItx()`: when the block ends, the scope, every call made through it and every
handle it awaited are released. Put it in the smallest block that holds its calls, await every
call inside it, and hand data, not handles, out of it; an object that needs reach takes an
accessor, `() => this.getItx()`. Never keep a value from `this.env.ITX.get()`, which nothing
releases: a kept value keeps the mind's context, and any facet holding it, resident after the
mind goes idle.

Files may be TypeScript or JavaScript and import each other by relative path. Import packages by
name: `iterate/*` and `zod` come from the platform; list any other package in `package.json` and
it loads from npm through esm.sh (packages that need Node.js builtins are refused). Type-check
locally with `npm install && npx tsc`; the loader strips types but never checks them.

A page `fetch` serves can render iterate's own components (the stream viewer `ContextView`, buttons,
code views) with no build step: an import map points at `@iterate-com/ui` on esm.sh, pinned to the
version npm's `main` dist-tag names (`https://registry.npmjs.org/@iterate-com/ui`), and React comes
from that package too, so any other React library loads with `?external=react,react-dom`:

```html
<script type="importmap">
  {
    "imports": {
      "@iterate-com/ui/": "https://esm.iterate.com/@iterate-com/ui@<version>/",
      "react": "https://esm.iterate.com/@iterate-com/ui@<version>/react",
      "react/": "https://esm.iterate.com/@iterate-com/ui@<version>/react/",
      "react-dom": "https://esm.iterate.com/@iterate-com/ui@<version>/react-dom",
      "react-dom/": "https://esm.iterate.com/@iterate-com/ui@<version>/react-dom/"
    }
  }
</script>
<link rel="stylesheet" href="https://esm.iterate.com/@iterate-com/ui@<version>/styles.css" />
<script type="module">
  import { html, render, useState } from "@iterate-com/ui/page";
  import { ContextView } from "@iterate-com/ui/components/context-view/context-view";

  // the worker's `fetch` answers ./events with the context's events
  const events = await fetch("./events").then((response) => response.json());

  function Page() {
    const [state, setState] = useState({}); // the open inspector, the search, the filters
    const context = {
      events,
      caughtUp: true,
      processors: { rows: [] },
      presence: { actors: [], rpcStubs: [] },
      liveState: {},
    };
    return html`<${ContextView}
      title="/agents/email/t42"
      context=${context}
      state=${state}
      onStateChange=${(patch) => setState((previous) => ({ ...previous, ...patch }))}
      className="h-screen"
    />`;
  }
  render(html`<${Page} />`, document.body);
</script>
```

Each component is `@iterate-com/ui/components/<name>` (`context-view/context-view`,
`repo-ide/repo-ide`, `ui/card`, …). The package's README has a fuller page (polling, a React library
beside it), and its AGENTS.md the rest: https://github.com/iterate/packages/tree/main/packages/ui.

## Apps

An app is a folder under `apps/`, and a convention, not a framework. `apps/agents/` is the Agents
app, on `agents.<domain>` for members: copy the folder to start one of your own.
`apps/onboarding/` is the onboarding app, on `onboarding.<domain>` for members: one agent thread,
the chat with the agent at `/agents/onboarding`, where a new owner starts. `apps/onboarding/onboarding.md` is what
that agent is told: `apps/agents/backend.ts` names it as the agent's standing instructions, read
fresh before each request.
`apps/docs/` is the docs app, on `docs.<domain>` for members: this repo read in a browser, its files
in the sidebar, a file beside them (markdown rendered, code as code) and the commits that changed
it. It reads through the member's `itx` and writes nothing.
`apps/voice/` is the Voice app, on `voice.<domain>` for members: a call to the mind from a browser
("Voice", below).
`apps/dash/` is the Dash, on `dash.<domain>` for members: an overview with the way to every app,
any context of the mind, live, the config repo as a small IDE, the mind's secrets, and how to
connect a coding agent over MCP. Its larger parts are components of `@iterate-com/ui`, the ones
iterate's hosted Dash draws; `public/app.js` is the wiring, the sidebar and the overview, and it
is yours to change.

```
apps/<name>/
  index.html   the page; one file goes a long way
  public/      files served as they are, at the host's root: scripts, styles, images
  backend.ts   the app's Durable Object classes (stream processors too), if it has any
  app.ts       exports a function that makes an object with `fetch`
```

- **Mount it** in `worker.ts`: import the function, call it once, and give it a case in `fetch`:
  `case "agents": return this.auth.require(request) || agents.fetch(request, this);`.
- **No build.** A module imports a file that is not code and gets its text, or its bytes when it is
  not text (`import index from "./index.html"`). An import that ends in `/` is every file under
  that folder, by path (`import files from "./public/"`). `serveFiles(request, { index, files })`
  from `iterate/sdk` answers a path that names a file with that file, and any other page load with
  `index`. So a commit publishes the page with the worker, as one thing.
- **The page loads packages from a URL**, pinned in its import map (the page below shows how).
- **One look for every app: `apps/theme.css`.** Each app serves that one file at `/theme.css`
  (`app.ts`) and its page links it after the UI kit's style sheet. It holds the colours and the
  corners (shadcn's theme variables). The apps are light, whatever the visitor's system says; to
  make them all dark, change `light` to `dark` in the file's `color-scheme` line.
- **A page takes a new commit by itself: `apps/live-reload/live-reload.js`.** Each app serves
  that one file at `/live-reload.js` (`app.ts`), and its page loads it in its head.
  When a commit is published, a stylesheet that changed is swapped in place. A page whose
  script changed reloads once nobody types in it, and what the person saw stays over the app
  until the app has drawn itself again. A member's page hears of a publication at once; any
  page looks when its tab comes to the front. To turn it off for an app, take the line out of
  its `index.html`.
- **The member's `itx` in the page.** `host.auth.itx(request)`, answered from a path of the app's
  choosing, makes that path a WebSocket to the mind's `itx` for the member who is signed in on
  that host: `newWebSocketRpcSession(new WebSocket("/itx"))`, a capnweb session
  (`apps/agents/public/app.js`). The platform decides who the caller is, never the page. What the
  page appends shows `source.via.appPage`, and the socket closes when the sign-in ends.
- **Who asked.** A facet's code appends as its context, not as the person who called it. So when a
  signed-in person calls a facet (`itx.agents.get(path).message(...)` is such a call), what the
  facet then appends shows them as `source.onBehalfOf`: `principal`, `grant`, `via` when they
  came through a page, and `call` (`/agents#agents.get.message`). It says who asked, never what
  they may do: check `source.principal` for that. An agent takes a member's words as the owner's,
  from a page too, and the chat shows who said each message.
- **A backend class** in `apps/<name>/backend.ts` is a facet like any other:
  `itx.cd(path).facets.get(name, { className, mainModule: "apps/<name>/backend.ts", source: itx.cd("/").config })`.
- **People who are not members** never get `itx`. Their page talks to your code: answer its
  requests in the app's `fetch`, and check `host.auth.person(request)` there.

### Voice

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

## Accounts through iterate Cloud

When the stack's config names an iterate Cloud (`cloud: { origin }`), a member connects GitHub,
Google (Gmail) or X through iterate's own app there. The mind needs no OAuth client of its own.

- `const { authorizationUrl } = await itx.secrets.beginOAuth("/secrets/github", { client: { cloud: "github" } })`,
  then give the member the link. They confirm on the Cloud's page, then approve at the provider, and
  the tokens land in the secret. `"google"` and `"x"` work the same way. For GitHub, name the
  accounts whose repositories the mind works with, `client: { cloud: "github", accounts:
["acme"] }`: the mind gets the events and the installation tokens of those alone, where the
  member administers them, and none when it names none. `install: true` sends the member to the
  App's install page first, and connects the installation they choose there.
- Several accounts of one provider: connect each to a secret of its own, through the same client.
  `itx.secrets.beginOAuth("/secrets/google-personal", { client: { cloud: "google" }, extra: { login_hint: "ada@gmail.com" } })`
  beside `/secrets/google`: `login_hint` asks Google for that account. Each secret holds and
  refreshes its own tokens, and a request names the account by the secret it names.
- Use the account with a placeholder, never a token:
  `itx.fetch(new Request("https://api.github.com/user", { headers: { authorization: 'Bearer getSecret("/secrets/github", { field: "accessToken" })' } }))`.
  The Cloud keeps the app's secret and adds it at each refresh. The tokens stay in this mind's
  vault.
- GitHub's deliveries for an installation the member administers arrive as
  `events.iterate.com/github/webhook-received` on `/integrations/github/<installation id>`, signed
  by the Cloud's key: `event.source.signer.principal.actor` is `"iterate-cloud"`.
- To keep `/repos/config` and a GitHub repository one history through that App, a member links
  them once: `linkThroughCloud(itx, { repository: "acme/config" })` from
  `@iterate-com/github-sync/install`, after a connect that names the repository's account. From
  then on `worker.ts` keeps them in step (its `github/webhook-received` and
  `repo/commit-completed` case): a push to the repository's main is pulled, which publishes the
  mind, and a commit here is pushed. What moved, and what could not, is a
  `config/github-mirrored` fact on the mind's root. When the two histories have diverged nothing moves, until a member calls
  `pull({ force: true })` (GitHub's wins) or `push({ force: true })` (the mind's wins).

## People who are not members

Signing in says who someone is. Being a member is a separate list: a member reaches the whole
mind (its API, its MCP server, every context), and anyone else reaches only what `fetch` serves
them. So a page can serve people who are not members, an app's end users.

On every host of the mind, the platform holds the browser session. `fetch` gets each request
stamped: `this.auth.person(request)` is `{ userId, email }` for anyone signed in, and a member is
stamped as a principal too. Three guards, each `null` when the request may go on, else the answer
to return:

- `this.auth.requirePerson(request)`: anyone signed in. Signed out, a page load signs them in and
  comes back; a fetch gets a `401`.
- `this.auth.require(request)`: a member. Someone signed in who is no member gets a refusal page
  (a fetch gets a `403`).
- `this.auth.person(request)`: who they are, or `null`. Key what you keep for a person by
  `userId`, which never changes; an email can.

The paths under `/.iterate/` on every host are the platform's: a form that POSTs to
`/.iterate/sign-out` signs the person out.

A guestbook where anyone signed in keeps their own notes, each person's in a context of its own,
and only members see who wrote:

```ts
export default class extends IterateConfigEntrypoint {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/notes") {
      const refused = this.auth.requirePerson(request);
      if (refused) return refused;
      const person = this.auth.person(request)!;
      using itx = this.getItx();
      const notes = itx.cd(`/guestbook/${person.userId}`);
      if (request.method === "POST") {
        await notes.append({ type: "note-added", payload: { text: await request.text() } });
        await itx.cd("/guestbook").append({ type: "person-wrote", payload: person });
      }
      const { events } = await notes.readEvents(0, 100);
      return Response.json({ email: person.email, notes: events.map((event) => event.payload) });
    }
    if (url.pathname === "/notes/all") {
      const refused = this.auth.require(request);
      if (refused) return refused;
      using itx = this.getItx();
      const { events } = await itx.cd("/guestbook").readEvents(0, 100);
      return Response.json(events.map((event) => event.payload));
    }
    return new Response("Not found", { status: 404 });
  }
}
```

A person who is not a member never holds `itx`: only your code acts for them, so check every
path you build from their input stays under their own context.

`@iterate-com/ui/live` reads a context live, as the person viewing: guard the route with
`this.auth.require(request)`, and the page connects with the host's own session. A whole page and
its route, to copy beside `worker.ts`:
https://github.com/iterate/packages/blob/main/packages/ui/examples/mind-host-page.ts.

### The guestbook

`apps/guestbook` is a whole app for end users, to copy or to turn on. Anyone reads it at
`guestbook.<domain>`. Anyone signed in writes an entry or answers one. An entry waits until a
member approves it, and a member can remove any entry. Other agents write through the app's own
MCP server at `guestbook.<domain>/mcp`: an MCP client finds the mind's sign-in from there, its
person signs in, and its token is good for that host alone.

Each entry, approval and removal is an event on `/apps/guestbook` (`apps/guestbook/entries.ts`),
and the page is a reduction of that log.

It is off in a new mind. To turn it on:

1. In `worker.ts`, uncomment the three guestbook lines: the import, `guestbookApp()` and the
   `case "guestbook"` in `fetch`.
2. People who are not members sign in only when the stack's config opens that:
   `login.methods.email.anyone: true` mails a sign-in code to any address that asks (the stack
   must handle mail; at most 20 such codes an hour). Without it, only members can write.

## How the platform works

The source code of the platform is public at https://github.com/iterate/core. Read it before you
guess how a capability behaves. List the files first:
`https://data.jsdelivr.com/v1/packages/gh/iterate/core@main?structure=flat` (`files[].name`; the
list can be hours behind). GitHub's own list,
`https://api.github.com/repos/iterate/core/git/trees/main?recursive=1` (`tree[].path`), is exact, but
GitHub allows 60 listings an hour to everyone behind one address, so from a mind it often
answers 403. Then read `core/AGENTS.md`, then the file you need:
`https://raw.githubusercontent.com/iterate/core/main/<path>`. `main` can differ from the code this
mind runs: where they disagree, what a call answers is right.
