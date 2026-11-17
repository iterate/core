# Connecting the owner's tools

The owner should come away with: the mind connects to what they already use, one thing at a time, with their approval.

## Ready today

- iterate Cloud has its own apps at services, so the mind needs no app of its own. Which ones this
  mind can use: `(await itx.secrets.cloud())?.clients` (null for a stack with no Cloud). Each is one
  call of yours and one approval by the owner:
  - Google (Gmail, Calendar): `itx.secrets.beginOAuth("/secrets/google", { client: { cloud: "google" } })`
  - Slack: `itx.secrets.beginOAuth("/secrets/slack", { client: { cloud: "slack" } })`
  - X: `itx.secrets.beginOAuth("/secrets/x", { client: { cloud: "x" } })`
  - GitHub: `onboarding/github.md`.
- The owner opens the `authorizationUrl`, confirms on the Cloud's page, approves at the service,
  and the tokens land in the secret. They never pass through the chat.
- An MCP server: `itx.connectToMcp(url, { headers })` gives a live handle with `listTools()` and
  `callTool(name, args)`. It keeps no record of the server: keep its key in a secret named for
  it (`/secrets/linear-mcp`), pinned to the server's origin; that row is what the Integrations
  page shows (`accounts.md`).
- Any API with a key: collect the key (`onboarding/secrets.md`), then `itx.fetch` with a
  placeholder. An OpenAPI service: `itx.connectToOpenApi(specOrUrl, { headers })`.

## Not ready

- An MCP server that signs in with OAuth: the mind does not do MCP's sign-in by itself. One that
  takes a key in a header works.
- A tool with no app, no MCP server and no key: look in the guide `apps.md` ("Integration packages") and
  https://github.com/jonastemplestein/iterategrations before you say the mind can use it.

## How

Connect one when the owner asks, or when what they want needs it. One at a time, and say what
the mind can do with it. Never the whole list unasked.

```ts
const { authorizationUrl } = await itx.secrets.beginOAuth("/secrets/google", {
  client: { cloud: "google" },
});
return authorizationUrl;
```

Afterwards `(await itx.secrets.describe("/secrets/google")).set` must be true. Then make one
request with a placeholder, never a token, and tell the owner which account answered.
`accounts.md` has the rest: Gmail's and Calendar's events, more scopes, several accounts.

An MCP server that takes a key:

```ts
const mcp = await itx.connectToMcp("https://mcp.example.com/mcp", {
  headers: { authorization: 'Bearer getSecret("/secrets/example-mcp")' },
});
return (await mcp.listTools()).map((tool) => tool.name);
```

Then `await mcp.callTool("<name>", { … })`. The last step of every connect: read
`await itx.integrations.list()`; when the page does not say what is true now, correct it.

## Say

- "I can read your Gmail for you. Here is the link: approve it, then come back to this tab."
- "It answered as ana@studio.pt. Shall I tell you each morning what came in overnight?"
