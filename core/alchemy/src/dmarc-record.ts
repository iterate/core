// dmarc-record.ts — THE ONE DNS RECORD OF A STACK THAT A DESTROY LEAVES IN ITS ZONE, and how it
// goes (scripts/remove-dmarc-record.ts runs this after a destroy).
//
// A deploy turns on Email Sending for the stack's domain (src/stack.ts `EmailSending`), and
// Cloudflare then writes the TXT record `_dmarc.<domain>` itself. Turning Email Sending off
// removes the bounce and DKIM records and leaves that one, so a destroyed stack's zone is not
// empty.
import { type Call, stillDeployed } from "./cloudflare-call.ts";

/** What Cloudflare's Email Sending writes. A record with any other content is a person's own. */
const WRITTEN_BY_EMAIL_SENDING = "v=DMARC1; p=reject;";

/** The stack's domain for the step: the one given with `--domain`, else the config's. `destroy`
 *  gives it, read before Alchemy's destroy: a stack deployed with no config file keeps its config
 *  in its state, and the destroy clears that, so the config cannot be read afterwards. An empty
 *  `--domain` is a stack with no domain yet. */
export async function domainFor(
  argv: readonly string[],
  configDomain: () => Promise<string | undefined>,
) {
  const at = argv.indexOf("--domain");
  return at >= 0 ? argv[at + 1] || undefined : configDomain();
}

/** Removes `_dmarc.<domain>` when it is as Email Sending wrote it, after a destroy: nothing goes
 *  while a Worker of the stack is deployed. Answers one line for each thing it did or left. */
export async function removeDmarcRecord(input: {
  accountId: string;
  name: string;
  domain: string;
  call: Call;
}) {
  const { domain, call } = input;
  const live = await stillDeployed(input);
  if (live.worker)
    return {
      failed: false,
      lines: [
        `The stack ${input.name} is still deployed (the Worker ${live.worker} is there): its DMARC record stays.`,
      ],
    };
  if (live.unread) return { failed: true, lines: [`${live.unread}: no DNS record is removed.`] };

  const api = "https://api.cloudflare.com/client/v4/zones";
  const record = `_dmarc.${domain}`;
  const zones = await call("GET", `${api}?name=${domain}&account.id=${input.accountId}`);
  // The cast: Cloudflare's documented answer, a list of zones; one that is not there reads as none.
  const zone = (zones.body as { result?: { id?: string }[] } | null)?.result?.[0]?.id;
  if (zones.status !== 200)
    return {
      failed: true,
      lines: [
        `Cloudflare answered ${zones.status} to GET the zone ${domain}: the TXT record ${record} may be left`,
      ],
    };
  if (!zone) return { failed: false, lines: [`The account has no zone ${domain}: no DNS record`] };

  const found = await call("GET", `${api}/${zone}/dns_records?type=TXT&name=${record}`);
  if (found.status !== 200)
    return {
      failed: true,
      lines: [
        `Cloudflare answered ${found.status} to GET the TXT records of ${record}: one may be left`,
      ],
    };
  // The cast: Cloudflare's documented answer, a list of DNS records with their content.
  const records = (found.body as { result?: { id: string; content: string }[] } | null)?.result;
  const lines: string[] = [];
  let failed = false;
  for (const each of records || []) {
    // Cloudflare answers a TXT record's content with its quotes
    if (each.content.replace(/^"|"$/g, "") !== WRITTEN_BY_EMAIL_SENDING) {
      lines.push(`Left: a TXT record ${record} that Email Sending did not write`);
      continue;
    }
    const gone = await call("DELETE", `${api}/${zone}/dns_records/${each.id}`);
    if (gone.status >= 200 && gone.status < 300) lines.push(`Removed: the TXT record ${record}`);
    else {
      failed = true;
      lines.push(`NOT removed: the TXT record ${record} (Cloudflare answered ${gone.status})`);
    }
  }
  return { failed, lines };
}
