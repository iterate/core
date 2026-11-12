# iterate

The SDK for Iterate: context APIs, stream processors, reactive clients, React
bindings, and OAuth app sessions, under `iterate/*`. The package exports source in this
workspace and compiled JavaScript with declarations when packed. Its `iterate` bin is the CLI
([src/cli/README.md](src/cli/README.md)).

## The SDK/platform line

The SDK holds what a mind's own code and apps run or speak: a loaded worker, a facet, a
processor, a browser or Node client, and the wire contract between them and the platform. The
Workers of a mind's stack (`core/*-worker`, with their shared kernel in `core/itx`) are its first
user. Each subpath in `package.json`'s `exports` is one public module; nothing else is importable.

Code that only a Worker of the stack runs belongs in that Worker or in `core/itx`, not here.
Nothing in `core/` imports outside `core/` ([core/AGENTS.md](../AGENTS.md);
`lint/oxlintrc-core-boundary.test.ts` pins it).

## One path per symbol

Code the platform loads for a mind (the config entrypoint, a facet, a worker behind a rewrite rule)
imports each symbol from one path, and the loader links this deployment's own build of it:

| Path                       | What it holds                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iterate/sdk`              | The workerd hosts: `IterateConfigEntrypoint`, `FacetDurableObject`, `StreamProcessorDurableObject`, their types, and capnweb's constructors                                                             |
| `iterate/stream/processor` | A processor's surface: `StreamProcessor`, `defineProcessorContract`, `LiveState`, the event and contract types. It runs in Node too                                                                     |
| `iterate/stream/contract`  | `defineProcessorContract` and the contract types alone, which `iterate/stream/processor` re-exports. Code a browser loads imports it: the engine needs `node:async_hooks`                               |
| `iterate/email`            | The `email` facet's contract, `email/received` and `email/sent` and the threads they fold into                                                                                                          |
| `iterate/agents`           | The agents app's two classes, which a config's `apps/agents/backend.ts` re-exports; `iterate/agents/install` installs it; `iterate/agents/kinds` is kinds of agent ([its README](src/agents/README.md)) |
| `zod`                      | zod, one copy per isolate, so a schema user code makes is the one the SDK checks                                                                                                                        |

```js
import { StreamProcessorDurableObject } from "iterate/sdk";
import { StreamProcessor, defineProcessorContract } from "iterate/stream/processor";
import { z } from "zod";

const Contract = defineProcessorContract({
  slug: "hoarder",
  version: "1.0.0",
  description: "keeps every blob it reduces",
  stateSchema: z.object({ blobs: z.array(z.string()).default([]) }),
  consumes: ["blob"],
  emits: [],
});
class Hoarder extends StreamProcessor {
  contract = Contract;
  reduce({ event, state }) {
    return { blobs: [...state.blobs, event.payload.blob] };
  }
}
export class HoarderDurableObject extends StreamProcessorDurableObject {
  processor = new Hoarder();
}
```

## Reaching the context from loaded code

Loaded code reaches its context with `using itx = this.getItx()`: when the block ends, the scope,
every call made through it and every handle it awaited are released. Every loaded
`WorkerEntrypoint` has `getItx`, and so do the SDK's hosts (`IterateConfigEntrypoint`,
`FacetDurableObject`, `StreamProcessorDurableObject`).

```js
import { IterateConfigEntrypoint } from "iterate/sdk";

export default class extends IterateConfigEntrypoint {
  async fetch() {
    using itx = this.getItx();
    const { mindSlug } = await itx.whoami();
    return new Response(`Homepage of ${mindSlug}`);
  }
}
```

Bind each scope with `using` in the smallest block that holds its calls, await every call inside
it, and hand data, not handles, out of it: a kept scope, step or handle keeps the context, and any
facet holding it, resident after the mind goes idle. An object that needs reach takes an
accessor (`() => this.getItx()`), never a scope; work that outlives the call runs under a
processor's `runInBackground` claim. Lint refuses a raw `ITX.get()` and a `getItx()` no `using`
binds in this repository (`iterate/no-raw-itx-get`).

A config worker's `getItx()` is the root's scope whoever called it: every context linked to the
root inherits the root's rules, so a script in `/child` that calls `itx.voice.setupVoiceAgent(…)`
runs the worker as the root. Inside any method but `fetch`, `this.callerPath()` names the context
the call came from (`/child`), as the platform stamps it, so what the worker creates for the caller
can hold no more than the caller does:

```js
async setupVoiceAgent({ streamPath }) {
  using itx = this.getItx();
  await itx.agents.at(this.callerPath()).create(streamPath); // linked to the caller, not to `/`
}
```

## Who wrote an event

Anyone in a mind can append any event to any context, and every event says where it came from.
The platform stamps `source.origin`, the context whose code or session wrote it, beside
`source.principal` (the member) and `source.platform`. A writer's own values are dropped. The one
field a writer keeps is `source.processor`, the engine's label for which processor wrote it.

```js
// A script in /agents/a:
await itx.cd("/agents/b").append({
  type: "events.iterate.com/agent/context-added",
  payload: { role: "user", content: "hello" },
});
// Stamped { origin: "/agents/a" }. Agent b's model reads "[from /agents/a] hello",
// and the same from `itx.agents.get("/agents/b").message("hello")`.
```

Words from `/` (a member's session, the dash) read as a person's, with no sender. `origin` is the
context whose code ran, not who asked it to run (`core/itx/src/caller.ts` `stampCaller` says why
that makes it advisory). Batch writes: `append(...events)` is one commit, however many events it
carries.

Runaway reactions stop on their own: code that reacts to other code's output faster than the clock
— two agents answering each other at once, a handler that appends what it handles — is stopped with
one error naming where the chain of reactions began, and the context records one `itx/loop-limit`
fact. Reading still works. What counts is speed: each hand-off adds a step and every two minutes
takes one away, so a job that waits, like one that re-arms itself for tomorrow, never trips it.

The exception is a jail, a context with a bare `itx ⇒ null` row plus the grants beside it. A bare
jail is closed both ways: its code appends nowhere, and no code appends into it. Grant it
`itx.append` and every context can append into it too; its own code still cannot lift the null. A
jail confines the code that runs in it, not the contexts it creates through a grant: jail those too.

## Testing a processor

`iterate/stream/test-support` (Node) is the harness the SDK's own engine tests use:

```ts
import { reduceProcessor } from "iterate/stream/test-support";

// durable ticks are reduced, ephemeral pokes are not
const state = reduceProcessor(new PresenceProcessor(), [{ type: "tick" }, { type: "poke" }]);
// state.ticks === 1
```

`memoryStream`, `memoryStorage` and `settle` drive a whole `ProcessorEngine` against an
in-memory log (`src/stream/processor.test.ts` shows how).

## A multi-step run

A processor whose work takes steps is still one contract, one state, one `reduce` and one
`processEvent`.

1. **The request is a fact.** A verb appends `<x>-requested` and answers its offset, which is the
   run's id. The fact holds every input the run needs, or names what the facet keeps for it in
   its own storage: the next incarnation reads the log and that storage, never the call.
2. **Each step lands a fact**, keyed by the request's offset and the attempt
   (`<slug>/<fact>:<requestOffset>:<attempt>`), so a repeated append lands once. A keyed payload
   holds no key whose value is `undefined`: the stream compares a repeated append with the stored
   JSON, which has no such key.
3. **The state says where the run stands:** the request, the attempt, the last step and the offset
   of its fact. `snapshot()` shows it, and a page can watch it live.
4. **`processEvent` advances from the state at head.** At `delivery.caughtUp`, a run that no work of
   this incarnation drives gets one driver in `runInBackground`. The driver's claim revives the
   facet if the facet dies. A run found mid-attempt lost its incarnation, or its driver's own fact
   did not land, so the driver starts the next attempt at once: if anything goes wrong, the work is
   run again.
5. **Every step is safe to repeat.** An attempt starts again from its first step, and each effect
   accepts its own earlier success. Facts record progress; they do not skip work that dies with an
   incarnation (`/tmp`, an open plan).
6. **Attempts are counted in facts and bounded.** An `attempt-started` fact lands before each
   attempt. An attempt that ends settles the run at once, whatever its outcome: no retry waits
   inside the processor, the caller runs it again. Only an attempt that ended before it settled the
   run (its incarnation died) is run again, a bounded number of times, under the engine's five
   deaths, so that a run whose attempts all die is still revived to settle.
7. **One terminal fact,** `<x>-settled { requestOffset, status, error? }`, keyed by the request. Its
   `status` is one of four: `succeeded`; `refused`, an expected outcome; `failed`, any other error
   (run it again); `unavailable`, the platform's failure (run it again). A request that opens no run is settled
   `refused` while it is processed, in `blockProcessorWhile`: no state remembers the request, so no
   later pass could settle it. A caller follows with
   `waitForEvent({ type, payload: { requestOffset }, afterOffset })`.
8. **Test it as tables:** events through `reduceProcessor`, states through `processEvent` with a fake
   effect on a fake clock, and a re-reduce row.

## Node connections

`iterate/node` connects a Node script to a mind at its address, with the same protocol, sign-in
and cleanup as the CLI. `ITERATE_MIND_TOKEN`, when set, is used in place of a sign-in:

```js
import { connectMind } from "iterate/node";

using connection = await connectMind({ address: "example.com" });
console.log(await connection.itx.whoami());
```

## Event types

A platform event type is `events.iterate.com/<namespace>/<event>`: one namespace segment and one
event segment, both lowercase kebab-case, and never a third segment.

Every type under `events.iterate.com/` follows these rules, test types included. A type without
that prefix belongs to whoever appends it and is opaque to the platform: tests use types like
`demo/ping` on purpose, and a mind may use its own domain (`events.garple.com/sales/…`).

### Namespaces

- **`itx`** holds the context engine's own events: everything the core contract
  (`core/itx/src/stream/core-processor.ts`) reduces, validates or refuses, plus the records the
  Stream, the context Durable Object and the SDK processor host write themselves. Where the schema
  and the reduce live decides it, not which contexts hold the event: fetch routes and the apex
  ingress target are core state, so they are `itx` even though only a mind root's copy is read.
  A domain processor may consume an `itx` event (the agent consumes `itx/run-*`, the Mind
  processor `itx/ingress-configured`); it names the core's catalog in its `processorDeps` rather than
  defining the event itself. The core's checkpoint slug is `core`: it is a storage key, not a type
  prefix.
- **A domain namespace** is the singular name of the kind of context whose log the event belongs
  to, which is the defining contract's slug when there is one: `account`, `organization`,
  `mind`, `repo`, `workspace`, `sandbox`, `secret`, `approval`, `agent`,
  `voice-agent`. A fact
  cross-posted to another log keeps its own namespace: `repo/created` on `/` is still a repo fact.
- **An integration** uses its own name as its namespace, for example `chrome`, `slack`, `google`,
  `github`.
- **An app** of a mind uses its own name too: `ai-subscriptions` (the Claude and Codex accounts'
  app, internal-packages/ai-subscriptions, and `apps/ai-subscriptions/` of a mind's config repo).
- **`test`** holds types that only tests append. Production code never matches a `test/*` type. A
  test contract may keep a slug of its own (`counter`), but its events go under `test/`. A test must
  not borrow a production namespace for a type that does not exist.

### Event names

- **A fact is past tense**: `<object>-<verb-ed>`, or a bare `<verb-ed>` when the object is the
  namespace's own subject (`itx/created` is the context, `agent/paused` is the agent). The object
  comes first and is singular.
- **Spell words out.** Clipped words are not allowed (`spk`); a real word is (`mic`), and so is an
  acronym the API already spells (`llm`, `rpc`, `itx`).
- **Asking and answering.** `<x>-requested` asks, and its offset identifies the ask. The answer
  takes one of three shapes:
  - `<x>-settled` is the one terminal fact when the asker reads a result. It names
    `requestOffset` and carries the outcome: succeeded, failed or cancelled, a status, or an error.
    Examples: `itx/run-*`, `agent/llm-request-*`.
  - `<verb-ed>` or `<verb>-failed` is used when success is a fact that other logs wait on, like a
    certificate: `create-requested` → `created` or `create-failed`, `delete-requested` → `deleted`.
    A failure that is retried rather than reported gets no `-failed` fact.
  - An answer that is also a fact of its own names the ask's offset: the assistant's
    `agent/context-added` carries the `llmRequestOffset` of the `llm-request-requested` it answers.
- **One verb pair per kind of change:**
  - `added` / `removed` for membership in a set: `account/member-added`, `account/key-added`.
  - `created` / `deleted` for an entity with a lifecycle: minds, repos, workspaces, sandboxes,
    agents.
  - `set` / `deleted` for a keyed value: `secret/*`.
  - `set` / `cancelled` for a schedule: `itx/schedule-*`. Each occurrence is `fired` or `failed`.
  - `-configured` for one fact that sets a row or clears it with `null`
    (`itx/subscription-configured`, `itx/rewrite-rule-configured`, `itx/fetch-route-configured`),
    sets a singleton (`itx/ingress-configured`), or merges a partial configuration
    (`agent/configured`: omitted keys keep their values).
- **Things the platform does on its own** are plain facts about the object: `itx/schedule-fired`,
  `itx/schedule-failed`, `itx/subscription-delivery-halted`.
- **Ephemeral events.** An ephemeral event that records something happening is named like any other
  fact: `itx/rpc-stub-attached`, `itx/live-state-changed`, `chrome/navigated`. Three kinds may be
  singular nouns: a sequenced slice of a live stream is a `<stream>-frame`
  (`voice-agent/mic-frame`, `agent/llm-response-frame`), a heartbeat (`voice-agent/keepalive`), and
  a diagnostic record (`itx/alarm-trace`). A durable event is never a noun.
- **Families and prefixes.** Code matches some families by prefix: `…/itx/run-`,
  `…/itx/subscription-`, `…/itx/schedule-`. Before naming a new type, check
  it doesn't join one of these families by accident. Never match `…/itx/` as a whole: it is not a
  permission boundary, and it catches live-state deltas, stub presence and child
  announcements.
- **Code follows the type.** A constant, schema, test fixture or idempotency key built from a type
  follows its name (`itx/child-created:<path>`). Broader concepts, modules and Workers log
  event names keep theirs: the Stream, scheduled appends, `core`, `scheduled-append.completed`.
- **Renaming.** A rename has to serve one of these rules, not taste. If a type is stored outside the
  platform's Durable Objects (device firmware, a published SDK, a mind's config repo),
  rename it only in a change that migrates that store too.

| Namespace                              | Defined in                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `itx`                                  | `core/itx/src/stream/core-processor.ts` (and its leaf event catalog), `stream.ts`, `scheduled-appends.ts`, `subscription-delivery.ts`, `core/itx/src/context/built-ins.ts`, `core/itx/src/fetch-routes.ts`, `core/itx/src/iterate-context-durable-object.ts`, `core/lib/src/stream/{run,processor}.ts` |
| `account`                              | `core/auth-worker/src/account-facts.ts`                                                                                                                                                                                                                                                                |
| `organization`                         | none: the namespace is allowed, and no code defines one                                                                                                                                                                                                                                                |
| `mind`, `repo`, `workspace`, `sandbox` | `core/mind-worker/src/mind/contract.ts` and `core/mind-worker/src/<name>/contract.ts` (repo, workspace and sandbox also use `mind/entity-lifecycle.ts`)                                                                                                                                                |
| `secret`                               | `core/secrets-worker/src/secret/contract.ts`                                                                                                                                                                                                                                                           |
| `approval`                             | `core/lib/src/acts.ts` (the acts a gate holds for a member's yes, and their rules)                                                                                                                                                                                                                     |
| `agent`                                | `core/lib/src/agents/contract.ts`                                                                                                                                                                                                                                                                      |
| `voice-agent`                          | `packages/voice/src/voice-agent.ts`                                                                                                                                                                                                                                                                    |
| `chrome`                               | `packages/browser-extension/public/panel.js`                                                                                                                                                                                                                                                           |
| `email`                                | `core/lib/src/email.ts`                                                                                                                                                                                                                                                                                |
| `mcp`                                  | `core/mind-worker/src/integrations/mcp.ts` (a delivery to a context's MCP webhook)                                                                                                                                                                                                                     |
| `webhook`                              | `core/mind-worker/src/integrations/webhooks.ts` (a delivery to a webhook context of a mind stack)                                                                                                                                                                                                      |
| `cloud`                                | `core/auth-worker/src/device/protocol.ts` (the statement the iterate Cloud signs to ask to be let in: shown with the request, never appended)                                                                                                                                                          |
| `integration`                          | `core/lib/src/integrations.ts` (the registry a mind's packages write into; its fold is `core/mind-worker/src/integrations/registry.ts`)                                                                                                                                                                |
| `test`                                 | tests only                                                                                                                                                                                                                                                                                             |

`note/added` is only an example in the Agents composer; no contract defines `note`.
