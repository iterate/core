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
- Every resource of the account is named `iterate-<alchemy.stageName>-…` (`namesOf` in
  `src/config.ts`).
- The stack's state, with the generated keys, the two API tokens' values and the secrets of the
  OAuth client, the SFU app and the TURN key, is in the Worker `iterate-<alchemy.stageName>-state` of the same account.
- One private OAuth client of the account, `iterate-<alchemy.stageName>-cloudflare`, registered
  with read scopes alone (iterate/api `CLOUDFLARE_READ_SCOPES`). A member connects the mind to
  its own account through it, and the secrets Worker alone holds its secret.
- One Realtime SFU app, `iterate-<alchemy.stageName>-realtime-sfu`, and one TURN key,
  `iterate-<alchemy.stageName>-turn`, by Alchemy's own resources. The secrets Worker alone holds
  their secrets, and serves them as `/secrets/cloudflare-realtime-sfu` and
  `/secrets/cloudflare-turn`. They cost nothing until a call uses them.
- Six providers of our own are beside the script, each for one thing that Alchemy does not do
  (read in 2.0.0-beta.85 and in beta.87, the version that `pnpm-workspace.yaml` pins), and one
  wrapper of Alchemy's own (`src/realtime.ts`). The header of each file says what, and when the
  file can go.

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

Each mail to an address at a zone reaches the mind. With `"mail": { "forwardTo": "team@example.org" }`
the boundary then forwards each mail there as it arrived, with Email Routing's own forward: its
From is the sender's, so a reply goes to the sender. The mind has the mail first.

- The address must be a verified destination address of the account's Email Routing: add it in
  the dashboard (Email Routing, Destination addresses) and confirm the link Cloudflare mails to it.
  The config refuses an address at a zone of the mind: its mail would come back.
- Cloudflare forwards only a mail whose sender is proven: one that is not stays in the mind alone,
  and the delivery stands.
- **The cost of a forward address that does not work.** While the address is not verified, is
  removed from the account, or refuses mail, every mail to the mind fails for its sender: the mind
  keeps the mail, the delivery fails, and the sender gets it back.
- Each forward that fails is an `events.iterate.com/email/forward-failed` fact on the mind's
  `/integrations/email`, with Cloudflare's words. A mail whose `X-Forwarded-To` already names the
  address is not forwarded again (such a fact too), so an address that leads back makes no loop.

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
- The OAuth client needs the permission "OAuth Client Write". A person's sign-in can never hold
  it: Cloudflare's sign-in has no scope for it, and a token that a sign-in makes may not hold it.
  So the deploy takes one more API token, with that one permission, in
  `CLOUDFLARE_OAUTH_CLIENT_API_TOKEN`: when it is set, every call for the client uses it, and the
  deploy's credential makes none (`src/cloudflare-oauth-client.ts`). `iterate deploy` asks for it
  and sets it. A deploy's own API token that holds the permission needs no second token.
- A deploy with neither is no failure: it takes about 24 seconds longer, makes no client and says
  so, and each later deploy asks again. The secrets Worker's plain-text variable
  `CLOUDFLARE_CLIENT_ID` says which: the client's id, or `none`.
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
- **The catalog's new token.** Cloudflare's data catalog does not know a new API token at once
  ("InvalidCredential"). `src/data-catalog-token-wait.ts` tries again for two minutes. A deploy
  that still fails there leaves a catalog that is on and is not in the stack's state: the next
  deploy needs `--adopt`.
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
- The OAuth client, when the destroy's credential may not delete OAuth clients: the destroy
  says so and goes on.
- The SFU app and the TURN key, when the destroy's credential lacks the permission to delete Realtime (Calls)
  resources: the destroy
  says so and goes on.
- The account's Zero Trust organization and its one-time PIN login. They belong to the account,
  and other things in it may use them (`src/access-team.ts`).
- The zones.

A deploy of the same stage one second after its destroy can fail with "This Worker does not
exist": run it again.
