# Secrets beyond tokens, approvals and services

What `itx.secrets` does besides holding a token (a key that signs for other minds, derived keys, a
GitHub App's JWT), the rules that make an act wait for a member's yes (`itx.approvals`), and the
services of the account (`itx.services`).

## A key that signs for other minds

A secret can hold a P-256 key that signs statements to other minds, the way the iterate Cloud
writes into a mind's `/integrations/`. `itx.secrets.generateSigningKey("/secrets/signer",
{ statementPaths: ["/integrations/"] })` makes the key inside the secrets Worker and answers its
`publicKey` and `keyId`; `describe` answers them too, so a page can publish them. The other mind
trusts that public key in its config (`auth.keys`, with the same `paths`).
`itx.secrets.signStatement("/secrets/signer", { mind, path, type, payload })` answers the
envelope to `POST` to `https://iterate.<mind>/statements`. The private key never leaves: the
secret is never sent with a request and is lent to nothing, and it signs only paths under its
`statementPaths`. To keep a key made elsewhere, collect it with `collectFromUser` (one field
`privateKey`, the private JWK as JSON, and `operations: ["signStatement"]`).

One secret can serve several purposes through keys derived from it (HKDF-SHA256 with an `info`
string: from a signing key's private scalar, else from the secret's string). `itx.secrets.seal(path,
{ info, plaintext })` answers `sealed.<iv>.<ciphertext>` (AES-256-GCM) and `unseal(path, { info,
sealed })` opens it; `signHmac` and `verifyHmac` take `derive: { info }` to sign under the derived
key. Each needs its name in the secret's `operations`.

A secret `{ appId, privateKey }` (a GitHub App's id and its PEM key) can send the App's JWT without
the key leaving: `getSecret("/secrets/github-app", { appJwt: true })` in the Authorization header of
a request to `https://api.github.com` (the secret pinned there) becomes a ten-minute RS256 JWT, for
example to `POST /app/installations/<id>/access_tokens`. In any other header or host it is refused.

## What waits for a member's yes

A rule makes an act wait until a member approves it with a passkey, on
`https://iterate.<domain>/secrets/approvals`. A mind has no rule until someone sets one.

- A rule on a secret names methods and hosts: an `itx.fetch` with that secret that matches waits.
  A member sets it on the page. After five minutes the call answers 403 and says it still waits;
  once approved, the same request sent again goes.
- `itx.approvals` holds the rules for acts: `email.send` (a mail, or with `to` a mail to some
  recipients alone), a verb such as `itx.whatsapp.sendMessage`, or every verb under a name,
  `itx.whatsapp.*`. `rules()` reads them, `setRules([...])` replaces them while the gate is open,
  and `propose(rule)` asks a member to sign one once a member has locked it. A held call waits
  five minutes, then throws; a member can still approve it for a day, and it is done then.
  A rule for a request with a secret is never set by code: propose it, with
  `propose({ secret: "/secrets/<name>", methods, hosts, jsonStrings?, freePaths? })`, and tell
  the member that it waits for them at the `signAt` that the call answers. The member sees it
  there beside the mail and calls that wait, and approves it with a key or rejects it. This is
  the one way: no link carries a rule's words.
- To have a member vouch for one event, call
  `itx.approvals.proposeStatement({ path, type, payload })` and give the member the `signAt` link
  it answers. The page needs no sign-in and shows the exact event; one passkey press signs it,
  within a day. The event then lands on `path` with `event.source.signer` naming the member. Code
  that trusts such an event reads `event.source.signer`, never a field of the payload.
- What a rule does not promise: a mail is held whatever sends it, but a verb is held only when the
  mind's agents or loaded code call it, not from a mind Worker changed to skip the rule.

## Services of the account

When the stack's config names `services` (core/alchemy/README.md), `itx.services.<name>` is a
Worker of the mind's own Cloudflare account, and `itx.services.<name>.<method>(...args)` calls
that Worker's method with the platform's word of who calls first: the mind, the calling
context's path and the person behind the call. `(await itx.rewriteRules.list())` at `/` shows
the root with each service's line. Every context that reaches the root reaches every method. A
jailed context reaches one method alone by a rule there that a member writes (loaded code names no
`itx.builtins` in a row):
`{ match: "itx.install", target: 'itx.builtins.cd("/").services.cloud.installBegin' }`, as the
payload of an `events.iterate.com/itx/rewrite-rule-configured` event on that context.
