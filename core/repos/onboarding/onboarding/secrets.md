# Secrets

The owner should come away with: the mind keeps a key it cannot read, and sends it only where the form said.

## Ready today

- `itx.secrets.collectFromUser({ path, egress: { urls }, description })` answers `{ path, url }`:
  a form on `<control-plane hostname>` that shows the secret's path, the addresses it may go to (its pin),
  what it may be used for, and your description. Only a signed-in member can fill it.
- In a request, `getSecret("/secrets/<name>")` in a header is a placeholder: the vault puts the
  value in on the way out, toward the pinned origins alone. Toward any other origin it is refused,
  with words that say the secret is pinned to its origins and was not sent to that one.
- `await itx.secrets.describe(path)` answers `{ path, set, … }`: whether it holds a value, never
  the value.
- The claim, exactly this and no more: "I never see the value; it leaves only to the address
  shown on the form."

## Not ready

- Never pin a secret to an address in one of the mind's own zones, nor to a service that echoes a
  request back (httpbin and the like): the value would come back where you can read it.
- A secret that goes in a URL (a Telegram bot token) needs `placement: "url"` when it is
  collected. Its uses are fixed then; they cannot be widened later.
- A secret that an API takes as a field of a JSON body needs `bodyFields` when it is collected:
  `[{ method: "POST", url: "https://api.example.com/v1/sinks", field: "config.token" }]`. In
  that request, and in no other, the placeholder as the whole value of that field is filled,
  beside the same placeholder in a header:
  `JSON.stringify({ config: { token: 'getSecret("/secrets/<name>")' } })`. The form shows the
  owner each request and field. The claim above does not hold for such a secret, and the form
  says so: if that service shows the value back, you can read it. Ask for a key with only the
  reach that the owner would give you.
- `redirectUrl` (the form sends them back when saved) is not tried in onboarding, and neither is
  the one-minute demo below, end to end.

## How

```ts
const { url } = await itx.secrets.collectFromUser({
  path: "/secrets/openai",
  egress: { urls: ["https://api.openai.com"] },
  description: "An OpenAI API key, from https://platform.openai.com/api-keys",
});
return url;
```

Give the owner the link and ask them to look at the address the form names. Never ask for a key
in the chat. When they say it is saved, check it:
`await itx.secrets.describe("/secrets/openai")` shows `set: true`, and no value.

The one-minute demo, with the secret they just gave: the same placeholder, once to another host
and once to the pinned one.

```ts
const headers = { authorization: 'Bearer getSecret("/secrets/openai")' };
const elsewhere = await itx.fetch(new Request("https://example.com/", { headers })).then(
  (answer) => `answered ${answer.status}`,
  (error) => String(error),
);
const pinned = await itx.fetch(new Request("https://api.openai.com/v1/models", { headers }));
return { elsewhere, pinned: pinned.status }; // elsewhere: the refusal; pinned: 200
```

Then show the other half: `onboarding/approvals.md`.

## Say

- "Here is your mind's own form for the key. I never see the value; it leaves only to the
  address shown on the form, so look at that address."
- "I just asked your mind to send that key to another site. It refused. To OpenAI it went."
