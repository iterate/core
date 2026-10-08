# Project configuration

This repository is the project's code. A commit to `main` publishes it: the platform loads
`worker.ts`, the `main` in `package.json`, and every context of the project runs the new code.

`worker.ts` extends `IterateConfigEntrypoint` from `iterate/sdk`, which holds the hosts (a
processor imports `StreamProcessor` and `defineProcessorContract` from `iterate/stream/processor`):

- `processEvent({ event, itx })` sees every durable event of every context of the project, one at
  a time, in no particular order and at least once, so each case must be idempotent. `itx` is the
  project's root; `itx.cd(event.path)` is the event's own context. Keep no state in the worker:
  read it from the project.
  - The `events.iterate.com/project/worker-updated` case is the init hook. It runs after every
    published commit: it installs the agents app. It sets no schedule, so an idle project
    sleeps; uncommenting the heartbeat there sets one that wakes it every five minutes.
  - The `events.iterate.com/email/received` case hands each email a member sends to the project
    to an agent of its own per thread, `/agents/email/t<thread>`, once the `email` facet has
    folded it into its thread; the agent replies with `itx.email.send({ inReplyToOffset })`. An
    agent acts with the project root's full reach: every context, secret-backed call, repository
    and the website. So only the platform's own record of a member's mail sent straight from their
    domain reaches one; a forward, a list's copy, a re-sent old message, an auto-reply or a bounce
    is ignored.
- `fetch` serves every host of the project. The `x-iterate-routing-slug` header names the host
  (`blog` for `blog--<project>`, absent on the apex), so route on it with a plain `if`. A request
  a fetch route takes never reaches it: the platform sends it to the route's target first
  (`iterate tunnel <port>` sets a route per tunnel; `itx.fetchRoutes.set` sets one by hand).
- `integrations` lists the integration packages this project hosts (`Integration` from
  `iterate/sdk`: a Telegram bot, your own GitHub App, and more, one folder each in
  https://github.com/jonastemplestein/iterategrations, whose recipes add one). Each is one element,
  from its package (`telegram()`, `github()`). `fetch` hands a package the requests on its own
  routing slug, and `processEvent` hands every package every event after the project's own cases:
  a package's install hook is its `project/worker-updated` case, where it registers its card on
  `/integrations` for the Dash's Integrations page (`iterate/integrations`; writing a package of
  your own: https://github.com/jonastemplestein/iterategrations/blob/main/adding-an-integration.md). A hook returns for an
  event it does not handle: one that throws fails this event for the whole worker, which the
  platform retries, and a hook that throws on every event slows the project's own cases to a
  trickle. A package serves its
  own setup page and webhook on its host and keeps its credentials through `itx.secrets`; the
  Dash shows what it registered and links to its page.

The agents app is `iterate/agents`, which comes from the platform like the rest of `iterate/*`:
the project runs the deployment's own build, and a platform deploy upgrades it. `agents.ts`
re-exports its two classes, and every agent runs from that file's own bundle, so a commit that only
changes `worker.ts` leaves the agents running.

`worker.ts` reaches the project through the `itx` that `processEvent` is handed, or through
`using itx = this.getItx()`: when the block ends, the scope, every call made through it and every
handle it awaited are released. Put it in the smallest block that holds its calls, await every
call inside it, and hand data, not handles, out of it; an object that needs reach takes an
accessor, `() => this.getItx()`. Never keep a value from `this.env.ITX.get()`, which nothing
releases: a kept value keeps the project's context, and any facet holding it, resident after the
project goes idle.

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
      "@iterate-com/ui/": "https://esm.sh/@iterate-com/ui@<version>/",
      "react": "https://esm.sh/@iterate-com/ui@<version>/react",
      "react/": "https://esm.sh/@iterate-com/ui@<version>/react/",
      "react-dom": "https://esm.sh/@iterate-com/ui@<version>/react-dom",
      "react-dom/": "https://esm.sh/@iterate-com/ui@<version>/react-dom/"
    }
  }
</script>
<link rel="stylesheet" href="https://esm.sh/@iterate-com/ui@<version>/styles.css" />
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

`@iterate-com/ui/live` reads a context live, as the person viewing: guard the route with
`this.auth.require(request)`, and the page connects with the host's own session. A whole page and
its route, to copy beside `worker.ts`:
https://github.com/iterate/packages/blob/main/packages/ui/examples/project-host-page.ts.
