# core/alchemy

One Alchemy script that deploys one mind into its owner's own Cloudflare account. Read
`src/stack.ts` from top to bottom: it declares every resource, and its header says what each
Worker is. `alchemy.run.ts` is the entry that Alchemy's CLI runs. This file says only what the
script does not.

[`iterate deploy`](../lib/src/cli/README.md#deploy-a-mind) is the command for a person: it signs in
to Cloudflare, writes the one input below and runs this script. `iterate recover` gives an owner
with no passkey left a way back in. What follows is the deploy by hand.

## What it makes

- Five Workers: telemetry, auth, secrets, mind and boundary. Only the boundary has routes. With
  the topology `external-mind-connects-into-cloudflare-boundary`, the stack has no mind Worker
  and nothing that only a mind Worker binds.
- `src/stack-bindings.snapshot.json` lists each Worker's bindings, by name and kind and never by
  value, as `src/stack.ts` declares them for three fixed configs. A pull request that adds,
  removes or renames a binding must change that file, so the change shows in its diff:
  `src/stack-bindings.test.ts` fails until it does. If the change is meant, rewrite the file with
  `UPDATE_STACK_BINDINGS=1 pnpm --filter core-alchemy test`.
- Every resource of the account is named `iterate-<alchemy.stageName>-…` (`namesOf` in
  `src/config.ts`).
- The stack's state, with the generated keys, the telemetry API token's value and the secrets of
  the SFU app and the TURN key, is in the Worker `iterate-<alchemy.stageName>-state` of the same account.
- No OAuth client. A member connects the mind to its own account through Cloudflare's MCP
  server, for which the mind is its own client (core/configs/default/cloudflare.ts). A stack
  deployed before 19 Nov 2026 has a client `iterate-<alchemy.stageName>-cloudflare`: its row
  leaves the state at the next deploy with no call (`src/retired-cloudflare-oauth-client.ts`),
  and the client stays in the account until a member deletes it (Manage Account, OAuth
  clients).
- One Realtime SFU app, `iterate-<alchemy.stageName>-realtime-sfu`, and one TURN key,
  `iterate-<alchemy.stageName>-turn`, by Alchemy's own resources. The secrets Worker alone holds
  their secrets, and serves them as `/secrets/cloudflare-realtime-sfu` and
  `/secrets/cloudflare-turn`. They cost nothing until a call uses them.
- Our own providers beside the script handle what Alchemy does not do yet (read in 2.0.0-beta.85
  and beta.87, the version that `pnpm-workspace.yaml` pins), along with thin wrappers of Alchemy's
  providers (`src/realtime.ts`, `src/telemetry-token.ts`). The header of each file says what, and
  when the file can go.

## The one input

A JSON file that `ITERATE_MIND_CONFIG` names, parsed by `MindConfig` in `src/config.ts`, where
each field has its doc. No environment variable changes what it means. The boundary Worker keeps
the whole input as its variable `DEPLOY_CONFIG`, which no Worker reads: `iterate deploy` over a
mind starts from it, so a field that no Worker holds, such as `cloudflare.containerImage`, stays.

```json
{
  "mindId": "<the mind's id: 64 hex characters>",
  "controlPlaneHostname": "iterate.example.com",
  "ownerEmails": ["ada@example.org"],
  "topology": "full-cloudflare",
  "alchemy": { "stageName": "example" },
  "cloudflare": { "accountId": "<the account's id>", "zones": ["example.com"] }
}
```

A mind takes each of its zones whole: nothing else may use them.

Each mail to an address at a zone reaches the mind: the boundary stores it on the mind's
`/integrations/email` (`email/received`), and only that step can fail the delivery, so Cloudflare
delivers again. Then the mind's config gets it while the delivery is live, in its `email` method
(iterate/sdk `IterateConfigEntrypoint`). There `forward(to)` sends the original on, as it arrived,
with Email Routing's own forward: its From is the sender's, so a reply goes to the sender.

- The address must be a verified destination address of the account's Email Routing: add it in
  the dashboard (Email Routing, Destination addresses) and confirm the link Cloudflare mails to it.
- Cloudflare forwards only a mail whose sender is proven. `forward` throws a coded error instead of
  forwarding: NOT_FORWARDABLE, FORWARDED_BEFORE (a mail goes to one address once, and never to an
  address that its `X-Forwarded-To` names, so an address that leads back makes no loop), REFUSED
  (Cloudflare's words) or EXPIRED (after the delivery, or after the hook's time).
- Each forward is an `events.iterate.com/email/forwarded` fact. The boundary gives the hook 15 s
  of its own time: the clock stops while Cloudflare answers a forward, which took 3 to 10 s on
  19 Nov 2026. A forward whose answer does not come within 20 s more is the same fact with
  `answered: false`. A hook that throws, that runs past its own time, or that the mind could not
  be reached for, and a config with no `email` (one fact for each config commit), are
  `events.iterate.com/email/hook-failed` facts: the delivery stands.

**The older way, which goes:** with `"mail": { "forwardTo": "team@example.org" }` the boundary
forwards each mail there itself, before the config's hook and through the same forward, so the
hook cannot forward the same mail there again. The config refuses an address at a zone of the
mind: its mail would come back. Each forward that fails is an
`events.iterate.com/email/forward-failed` fact, with Cloudflare's words; a mail whose sender is not
proven stays in the mind alone, and the delivery stands. **The cost of a forward address that does
not work:** while the address is not verified, is removed from the account, or refuses mail, every
mail to the mind fails for its sender: the mind keeps the mail, the delivery fails, the sender gets
it back, and the config's hook does not run. A mind's config forwards in its own `email` instead.

`mindId` is the SHA-256 of the mind's signed genesis record (`iterate/mind-identity`). The stack
signs and checks nothing with it: every Worker gets it as config, and the auth Worker accepts the
genesis that hashes to it at `POST https://<controlPlaneHostname>/.well-known/iterate`. Until a
record lists a working key of the stack, the mind signs nothing as itself; all else works.

## Deploy and destroy

From `core/alchemy`, with the config in `mind.config.local.json` (git ignores that name):

```sh
export ITERATE_MIND_CONFIG=mind.config.local.json
pnpm exec alchemy login                        # or CLOUDFLARE_API_TOKEN, a token of the config's account
pnpm run deploy --stage <alchemy.stageName>
pnpm run destroy --stage <alchemy.stageName>   # --yes with nobody at the terminal
```

- `deploy` is the mind Worker's build (`core/mind-worker/scripts/build.ts`: the SDK and the
  templates that the Worker carries), then `alchemy deploy alchemy.run.ts`. No step comes before
  or after. Alchemy's other commands and flags work the same way:
  `pnpm exec alchemy plan alchemy.run.ts --stage <alchemy.stageName>`.
- A command for another stage or another account than the config's is refused before it opens
  the state. This holds for a deploy and for a destroy.
- What a sign-in or an API token must hold for a deploy is one list with a reason for each entry:
  `STACK_SCOPES` in [cloudflare-access.ts](../lib/src/cli/cloudflare-access.ts). A sign-in's
  scope is an API token's permission under another spelling (`workers-scripts.write` is "Workers
  Scripts Write").
- Telemetry tables (`events`, `logs`, `spans`, and `metrics` SQL) have three modes, read from the
  stack's state (`src/telemetry-token.ts`, `telemetryModeOf`). A deploy takes no telemetry token.
  - **`minted`:** the state holds `TelemetryCatalogToken` or `TelemetryAnalyticsToken`: the stack
    declares those two `AccountApiToken` resources, the catalog, sinks and pipelines, so its sinks
    keep their credentials.
  - **`given`:** the state holds `TelemetryToken`, an owner-created token: the stack keeps using
    it. **Do not delete or roll it:** the sinks keep the token they were made with.
  - **`off`:** neither. The stack makes the telemetry bucket, the three streams and the OTLP
    destinations, and no catalog, sink, pipeline or token. The mind makes and reads its tables
    itself, with a token kept as its secret `/secrets/cloudflare-telemetry`
    (core/configs/default/telemetry.ts); the streams keep what they are sent until then. A
    destroy removes what the mind made (`src/mind-made-telemetry-tables.ts`).
- The deploy makes a Realtime SFU app and a TURN key (`src/realtime.ts`), which need the
  permission to make Realtime (Calls) resources: "Calls Write" (`calls.write`), which the deploy
  asks for, or "Realtime" or "Realtime Admin". A credential without it is no failure either: the deploy makes neither,
  says so in one line, and the secrets Worker answers `/secrets/cloudflare-realtime-sfu` and
  `/secrets/cloudflare-turn` as not set, with that reason. Each later deploy asks again.
- Every zone must be in the account already. Alchemy does not take over a resource that exists,
  such as a DNS record of the zone: remove it, or pass `--adopt`.

Two refusals of a first deploy are known:

- **The new state store.** A first deploy makes the state store, and a new store can refuse
  requests in its first seconds ("State store request failed"), also in the middle of the
  apply. It did so for every new store in the proofs of 18 Nov 2026. Nothing is made without
  state: run the deploy again.
- **Another stack's records in the store.** The live minds' earlier stack used the same store's
  name. A deploy over such a stack's records, not moved by hand, stops in its plan with
  "OwnedBySomeoneElse" for the zone's records and routes, and changes nothing. Destroy that
  stack, or move it with its runbook; never pass `--adopt` to get past it: the old records
  would then delete what the new ones took over. The first deploy over a Worker record of the
  earlier stack ends with Alchemy's "Reconciling worker routes (0)": it deletes every route of
  the boundary in the zone, also the two that the Route resources adopted in the same run: the
  mind answered 522 for 54 s on one move and for 2 s on the other (18 and 19 Nov 2026). After that
  deploy the record holds no route, and later deploys delete none.

## What a destroy leaves

A destroy erases the mind: its contexts, files, repos, members and secrets. It leaves:

- The state store: the Worker `iterate-<alchemy.stageName>-state`, and its two secrets
  in the account's Secrets Store, which are named after the Worker. A Secrets Store holds a
  limited number.
- The TXT record `_dmarc.<zone>`, which Cloudflare's Email Sending wrote.
- R2's record of the telemetry bucket's data catalog, as inactive. No API removes it.
- The OAuth client of a stack deployed before 19 Nov 2026: a member deletes it in the
  dashboard.
- The SFU app and the TURN key, when the destroy's credential lacks the permission to delete Realtime (Calls)
  resources: the destroy
  says so and goes on.
- A sandbox's saved snapshots: tags in the registry repository
  `<account>/cloudchamber-snapshots/<id>`, which may also hold other applications' snapshots.
  Cloudflare's container registry refuses their delete, and Cloudflare keeps them after the
  container application is deleted (measured 20 Nov 2026). The destroy names each repository with
  the number of this mind's tags and goes on. Each tag holds a copy of a sandbox's files
  (`src/container-snapshots.ts`).
- The account's Zero Trust organization and its one-time PIN login. They belong to the account,
  and other things in it may use them (`src/access-team.ts`).
- The zones.

A deploy of the same stage one second after its destroy can fail with "This Worker does not
exist": run it again.
