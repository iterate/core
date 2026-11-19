# Cloudflare

The mind's connection to its own Cloudflare account: how a member connects it, what it reads,
the REST tool and Cloudflare's MCP server, the names of the mind's Workers, two telemetry
queries, the billing token, and telemetry for a mind that exists: `cloudflare.ts` and
`itx.config.cloudflare`.

A mind runs in its owner's Cloudflare account. A member connects the mind to that account with
one approval on Cloudflare's own page. The consent is kept as the secret `/secrets/cloudflare`,
and the vault refreshes it each hour. `(await itx.secrets.describe("/secrets/cloudflare")).set`
says whether this mind is connected. With it you look at what the account runs and how it is
set up, and you query its logs and traces. You change nothing in the account with it.

## Connect

- `await itx.config.cloudflareConnect({ tell: "<your own path>" })` answers `{ way, link }`.
  Give a member the ONE `link`, in the turn that made it: it lasts an hour. `tell` is the agent
  that asks (`/agents/onboarding`): when the consent has landed, that agent gets a note that
  starts its turn, and Cloudflare's page brings the member back to its chat.
- `way: "stack-client"`: the stack has an OAuth client of its own in the account
  (`await itx.secrets.hasStackClient("cloudflare")`). The link is Cloudflare's consent page. The
  member approves there, and it is done. Only a member of that Cloudflare account can approve.
- `way: "own-client"`: the stack has no client, because the credential that deployed it may not
  make one. Then a member makes one by hand, once. The answer has `makeTheClient`:
  `{ where, name, redirectUri, grantTypes, tokenEndpointAuthMethod, scopes }`. Say those to the
  member in plain words. The `link` is a form of this mind: it shows the same steps and takes the
  client's ID and secret, which you never see. It leads back to the Dash's Integrations page,
  where the card's "Connect" begins the consent: tell the member to press it. The consent begun
  there tells no agent: read the card afterwards. When
  the mind holds such a client already (`/secrets/cloudflare-client`), the `link` is the consent
  page.
- **The vault is the guard.** Before it keeps a consent through the stack's client, it checks
  that Cloudflare granted only scopes of the list, and that the consent reaches exactly one
  account, the one that the stack runs in. Otherwise nothing is kept, and the mind's page that
  Cloudflare sends the member back to shows why, and to connect again and select only that
  account. The agent that asked
  gets the same words in its note, at the mind's next publish or next consent. A consent through a member's own client is kept as it is;
  when it does not reach the mind's zone, the card and the note say it is for another account.
- The Dash's Integrations page has the card (`cloudflare.ts` `cloudflareConnectionEvent`):
  "Connected" with the account, who consented and the time of the last check, or "Not connected"
  with a "Connect" button that calls `cloudflareConnect` at the press, as the member, and goes on
  to its link.

## What it reads

- **What it may do:** query the Workers' logs and traces; read the Workers' names, settings and
  deployments (a plain-text variable's value is a setting), their routes, the zones with their
  DNS records and settings, the Email Routing rules, the pipelines, and the names and settings
  of D1 databases, KV namespaces, R2 buckets and queues; and read who consented. Thirteen
  scopes, each named in iterate/api `CLOUDFLARE_READ_SCOPES`.
- **What it may not do:** every change. Also not: read a Worker's code, tail a Worker, run SQL
  or an analytics query, run a model, read a KV value, an R2 object or a queue's messages, or
  read the account's settings, API tokens, members, notifications, Access applications or
  bills. The consent holds read scopes alone (iterate/api
  `CLOUDFLARE_READ_SCOPES`), and the vault refuses a connect through the stack's client that asks
  for any other. Every member and agent of the mind can use the consent, so it must not be a way
  to take the stack over. Cloudflare refuses what it may not do (403): tell a member, and do not
  look for a way round. A member changes the account in Cloudflare's dashboard or through a
  deploy of the stack.
- **The mind's own code changes by a commit to this repo, never through Cloudflare.**
- **What the logs show of a request:** the `cookie` and `authorization` headers are redacted;
  every other header reads in clear, and a URL is redacted only where a value looks like a long
  token. So never send a credential in another header or in a URL, to this mind or from it: who
  reads the logs would read it.
- The account may hold other people's things: say which Worker or zone you looked at, and look
  at what is not this mind's only on a member's word.

## The REST tool and the MCP server

Use the REST tool when you know the request. Use Cloudflare's MCP server to find a request that
you do not know, or to run several in one go. Both go with the same consent.

- `await itx.config.cloudflare("whoami")` answers
  `{ status, user, account: { id, name }, zone, workers }`: who consented, the account that
  holds this mind (its id goes into most paths), the mind's first zone, and `workers`, the start
  of the names of the mind's own Workers (`iterate-example-com-`; they end in `mind`,
  `boundary`, `secrets`, `auth` and `telemetry`). When `status` is not 200, `body` says why.
- `await itx.config.cloudflare("execute", { method, path, body })` is one request to Cloudflare's
  REST API, `https://api.cloudflare.com/client/v4` + `path`, and answers `{ status, body }`
  (`method` is GET when not given). An answer over 24,000 characters comes as
  `{ status, cut: true, text }`: ask for less, with `per_page`, a filter or a limit.
- `await itx.config.cloudflareLastHour()` answers who the mind is connected as, each of the
  mind's own Workers' requests of the last hour by outcome, and the newest five error lines.
  Show it right after a connect.
- `await itx.config.cloudflareMcp(tool, args)` calls one tool of Cloudflare's own MCP server,
  `https://mcp.cloudflare.com/mcp`. `"search"` finds the API call for a task: `{ code }` is an
  async arrow function as text, and `spec.paths` is Cloudflare's OpenAPI spec in it. `"execute"`
  runs code against the API: in its `{ code }`, `cloudflare.request({ method, path, body })` is
  the API and `accountId` is the account. `"docs"` searches Cloudflare's documentation
  (`{ query }`). The server reaches what the consent reaches and no more.
- Both are `itx.fetch` and `itx.connectToMcp` with the header
  `authorization: 'Bearer getSecret("/secrets/cloudflare", { field: "accessToken" })'`: a
  placeholder, never the token. The vault sends the token to Cloudflare's API and its MCP server
  alone.
- Name a Worker by its name, never by a list. The second example below groups invocations by
  `$metadata.service`: without its service filter it names every Worker of the account that ran
  in the hour.

The mind Worker's newest log lines (for its errors alone, add the filter
`{ key: "$metadata.level", operation: "eq", type: "string", value: "error" }`):

```js
const { account, workers } = await itx.config.cloudflare("whoami");
const now = Date.now();
const answer = await itx.config.cloudflare("execute", {
  method: "POST",
  path: `/accounts/${account.id}/workers/observability/telemetry/query`,
  body: {
    queryId: "newest-lines",
    view: "events",
    limit: 20,
    timeframe: { from: now - 3_600_000, to: now },
    parameters: {
      datasets: ["cloudflare-workers"],
      filters: [
        { key: "$metadata.service", operation: "eq", type: "string", value: `${workers}mind` },
      ],
    },
  },
});
return answer.body.result.events.events.map((line) => ({
  at: new Date(line.timestamp).toISOString(),
  level: line.$metadata.level,
  said: line.$metadata.message || line.$metadata.type,
}));
```

A count is the same query with `view: "calculations"`. The stack's invocations of the last hour,
by Worker and outcome (`cloudflareLastHour` runs this one):

```js
const { account, workers } = await itx.config.cloudflare("whoami");
const now = Date.now();
const answer = await itx.config.cloudflare("execute", {
  method: "POST",
  path: `/accounts/${account.id}/workers/observability/telemetry/query`,
  body: {
    queryId: "invocations-by-outcome",
    view: "calculations",
    timeframe: { from: now - 3_600_000, to: now },
    parameters: {
      datasets: ["cloudflare-workers"],
      filters: [
        { key: "$metadata.service", operation: "includes", type: "string", value: workers },
        { key: "$metadata.type", operation: "eq", type: "string", value: "cf-worker-event" },
      ],
      calculations: [{ operator: "count" }],
      groupBys: [
        { type: "string", value: "$metadata.service" },
        { type: "string", value: "$workers.outcome" },
      ],
    },
  },
});
return answer.body.result.calculations[0].aggregates.map((row) => ({
  ...Object.fromEntries(row.groups.map((group) => [group.key, group.value])),
  count: row.value,
}));
```

An invocation that ended `canceled` is logged at level `info`: for what went wrong, ask for
`$workers.outcome` `neq` `ok` as well as for the level `error`.

## Billing has a token of its own

The consent cannot read the account's bills: Cloudflare has no billing permission for one. So a
member makes a token with "Billing Read" alone, and gives it to the mind.

- `await itx.config.cloudflareBillingToken()` answers `{ set: true }`, or
  `{ set: false, makeTheTokenAt, pasteItAt }`: give a member both links in one message. The
  first opens Cloudflare's form with the permission filled in (they pick the account and press
  Create); the second is a page of this mind where they paste the token. You never see it.
- `await itx.config.cloudflareBilling(account, "billable-usage")` answers `{ status, body }`:
  the usage by product in this billing period (`?from=<date>&to=<date>` for another, at most 31
  days). Also `"billing/history"` (invoices), `"billing/credits"` and `"subscriptions"`.
- That token is at `/secrets/cloudflare-billing` and is used for those reads alone. The mind
  makes no API token itself, and must not be given the right to: who can make a token can make
  one that deploys. A 403 with the billing token means that the token lacks the permission or is
  of another account: say so, and ask the member to make it again from the link.

## Telemetry

When telemetry is turned on for a mind that exists, each context starts to send its events at
its next wake, with its whole log from the first event. A context that never wakes again sends
nothing: touch it (any read of it) to send its history.
