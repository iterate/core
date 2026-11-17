# Approvals

The owner should come away with: some acts wait for their passkey, and they watched one wait.

## Ready today

- `await itx.approvals.propose(rule)` answers `{ id, signAt }`: it holds nothing until signed there.
- A rule for acts: `{ verb: "email.send" }` holds every mail; with `to`, only a mail to a
  recipient that matches one pattern: `"jo@example.com"`, `"*@example.com"` or `"*"`. Or a verb,
  `itx.whatsapp.sendMessage`, or every verb under a name, `itx.whatsapp.*`.
- A rule for a request with a secret: `{ secret: "/secrets/<name>", methods, hosts }`, and
  `jsonStrings`, `freePaths`. Code never sets one: it proposes it.
- A held call waits five minutes for the owner, then throws ("this mail waits for a member's
  approval, at https://iterate.<domain>/secrets/approvals?digest=…"). The owner can still approve
  it for a day; it is done then, once. Never send it again.
- The rules for mail and calls start OPEN: until the owner presses "Lock these rules" there and
  signs, the mind's code can change them unsigned. Say so when they want a rule that binds you too.

## Not ready

- "Everyone but the owner" cannot be written: a rule names who waits, never who is free.
  `{ verb: "email.send" }` holds mail to the owner too, your follow-up mails among it.

## How

The demo, with a domain that reaches nobody:

```ts
return await itx.approvals.propose({ verb: "email.send", to: ["*@example.com"] });
```

Give the owner `signAt`; once signed, `(await itx.approvals.rules()).rules` shows it. A helper sends:

```ts
await itx.agents.create("/agents/onboarding/held");
await itx.agents
  .get("/agents/onboarding/held")
  .message(
    "Run `await itx.email.send({ from: 'onboarding@<domain>', to: 'nobody@example.com', subject: 'A mail that waits', text: 'This mail waits for your passkey.' })`. It waits up to five minutes, then throws. Report to /agents/onboarding in one plain sentence for the owner: sent, rejected, or still waiting.",
  );
```

Send the owner `https://iterate.<domain>/secrets/approvals`, where the mail waits. Ask them to
reject it (example.com is nobody), and offer to take the rule away. Your turn never waits on it.

The GitHub demo, once `/secrets/github` is set (`onboarding/github.md`). Propose
`{ secret: "/secrets/github", methods: ["POST"], hosts: ["api.github.com"] }`. When it is signed,
a helper sends one harmless request that the rule holds and that changes nothing at GitHub:

```ts
await itx.fetch(
  new Request("https://api.github.com/markdown", {
    method: "POST",
    headers: {
      authorization: 'Bearer getSecret("/secrets/github", { field: "accessToken" })',
      "content-type": "application/json",
      "user-agent": "iterate",
    },
    body: JSON.stringify({ text: "hello" }),
  }),
);
```

The owner presses "Approve the chosen requests" on the same page. With no answer in five minutes
the call answers 403; once approved, the same request sent again goes. Then ask whether to keep
the rule: every `POST` to `api.github.com` with that secret would wait.

## Say

- "Shall I add a rule that a mail from your mind to anyone at example.com waits for your
  passkey? Sign it here."
- "Your mind tried to send it. It is waiting for you here, and nothing has gone."
