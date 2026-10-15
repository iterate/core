# Tear down a self-hosted iterate

A recipe for a coding agent: remove what [`setup-prompt.md`](setup-prompt.md) made, so the user
can start over or stop. Work in the folder the setup ran in, `<folder>`; its `iterate/core/os` holds
`.secrets` (the deploy token) and `.alchemy/` (what the deploy made). Run every command from
`iterate/core/os`.

What stays unless the user says otherwise: the Cloudflare account, its Workers Paid and R2 plans,
and a domain's registration and its zone.

## 1. List it, then ask

Find what exists of the list below, and send one message: each resource by name, what stays, and,
if you ran the setup, its papercuts: everything in `setup-prompt.md` that didn't work as written,
and every point where you or the user had to work around it. Delete nothing until the user says
yes.

- The deployment: `pnpm alchemy destroy --dry-run` lists what Alchemy's state names: the Worker
  `<resourcePrefix>`, its D1, KV namespaces, R2 bucket, container application and routes.
- The Artifacts namespace, `<resourcePrefix>-repos`, which Alchemy did not make.
- With a domain: the zone's DNS records the setup made (`<domain>`, `*.<domain>` and the mail
  ones), Email Routing and its catch-all rule, and the Email Sending domains `<domain>` and
  `mail.<domain>`.
- The deploy token, `iterate-<folder>`, and a `cf` sign-in of that name if one is left
  (`pnpm exec cf auth list`).
- The deployment's MCP server in the clients the user added it to.
- The folder itself: the clone, `.secrets` and Alchemy's state.

## 2. Credentials

The deploy token in `.secrets` can remove the deployment, the Artifacts namespace and the DNS
records. For the mail and the token itself, sign in as the setup's step 2 does, with these scopes
alone:

```bash
pnpm exec cf auth create iterate-<folder> --browser=false --scopes \
  account:read user:read offline account_api_tokens:create zone:read zone.read \
  email_routing:write email-routing-rule.write email_sending:write email-sending.write
```

`open` the link it prints yourself and give the user the link and the code.

## 3. Remove it, in this order

1. **The deployment**: `pnpm alchemy destroy --yes`. With `cloudflare.protectData` on, it forgets
   the resources instead of deleting them (`SELF-HOSTING.md`, "Destroy").
2. **The Artifacts namespace**: `pnpm exec cf artifacts namespaces delete <resourcePrefix>-repos`
   with the deploy token. Don't list its repositories first: that can stall. "Deletion already in
   progress" counts as done; check it is gone.
3. **Mail**, each command with `CLOUDFLARE_ACCOUNT_ID=<account id> pnpm exec cf --profile
iterate-<folder> -z <domain>` in front:
   - `email-sending subdomains list`, then `email-sending subdomains delete <id>` for each.
     Cloudflare removes their records but leaves the DMARC ones, `_dmarc.<domain>` and
     `_dmarc.mail.<domain>`: they go with the DNS records below.
   - `email-routing disable`, with no `--name`: a name means a subdomain, and the domain's own is
     refused with "Subdomain not found".
   - The catch-all rule can't be deleted ("Invalid rule operation"). Turn it off instead:
     `email-routing rules catch-all update --enabled=false --matchers '[{"type":"all"}]'
--actions '[{"type":"drop"}]'`. Its row stays.
4. **DNS**: delete the records the setup made, with the deploy token. Show the user anything else
   on the zone, and ask before you delete it.
5. **MCP**: in each client, sign out of the server first, then remove it (e.g.
   `codex mcp logout <name>` then `codex mcp remove <name>`; `claude mcp remove <name>`).
6. **Check** that everything from section 1 is gone, before the credentials that could fix it go.
7. **The credentials**: revoke the deploy token (`cf accounts tokens delete <id>` with the
   sign-in; if Cloudflare refuses, send the user https://dash.cloudflare.com/?to=/:account/api-tokens),
   then delete the sign-in: `pnpm exec cf auth delete iterate-<folder>`.
8. **The folder**, last: once `.secrets` and Alchemy's state are gone, nothing can find what is
   left.

## 4. Hand over

Tell the user what is gone, what stays (the residual catch-all row among it), and to delete the
deployment's password from their password manager: a new setup generates another.
