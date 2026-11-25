// recover.ts — `iterate recover`: AN OWNER WITH NO PASSKEY LEFT GETS BACK INTO THE MIND. Whoever
// holds the mind's Cloudflare account runs it: that holding is the proof, as it is for a deploy.
// The mind itself offers no way back, since whoever holds an owner's mailbox must not hold the
// mind (core/auth-worker `enrolment.ts`).
//
// The command signs in to Cloudflare (./cloudflare-access.ts), finds the mind by its zone, and
// writes to the auth Worker's database through Cloudflare's D1 API:
//
//   1. every passkey of the owner is revoked: a link opens nothing while one is live;
//   2. one row of `member_tickets` holds the hash of a new random ticket, with
//      `made_by = 'recovery-command'`, which the auth Worker takes for an owner;
//   3. the link `https://<control plane>/keys/first#<ticket>` is printed. It signs the owner in
//      once, within 24 hours, to add a new passkey.
//
// The owner's signed-in apps and terminals are grants in the auth Worker's KV namespace, and they
// stay: the owner ends them on the mind's own pages.
import { createHash, randomBytes } from "node:crypto";
import * as p from "@clack/prompts";
import { z } from "zod";
import { isOwnerEmail } from "../mind-config.ts";
import { isCodingAgent } from "./coding-agent.ts";
import {
  type Cloudflare,
  cloudflare,
  cloudflareAccess,
  endAccess,
  RECOVER_SCOPES,
  resultOf,
} from "./cloudflare-access.ts";
import { deployedMind } from "./deploy.ts";

/** A NEW TICKET: 32 random bytes as base64url, and its SHA-256 in hex. The ticket goes into the
 *  link's fragment and nowhere else; the database gets the hash alone, as the auth Worker reads
 *  it (`sha256Hex` of the ticket's text). */
export function newTicket() {
  const ticket = randomBytes(32).toString("base64url");
  return { ticket, hash: createHash("sha256").update(ticket).digest("hex") };
}

/** THE TWO STATEMENTS, for the auth Worker's database (core/auth-worker/migrations: `keys`,
 *  `users`, `member_tickets`). `owner` is the lower-cased address, `at` the time in epoch ms. The
 *  link lasts a day, which is as long as the auth Worker's own links do. */
export const recoveryStatements = (recovery: { owner: string; ticketHash: string; at: number }) => [
  {
    sql: `update keys set revoked_at = ?1
          where format = 'webauthn' and revoked_at is null
            and user_id = (select id from users where email = ?2)`,
    params: [recovery.at, recovery.owner],
  },
  {
    sql: `insert into member_tickets (hash, email, made_by, expires_at)
          values (?1, ?2, 'recovery-command', ?3)`,
    params: [recovery.ticketHash, recovery.owner, recovery.at + 24 * 3600_000],
  },
];

/** THE ONE ZONE OF THE MIND, by its domain, narrowed to `account` (an account id) when given. */
export async function zoneForRecovery(cf: Cloudflare, domain: string, account?: string) {
  const query = new URLSearchParams({ name: domain });
  if (account) query.set("account.id", account);
  const zones =
    resultOf(
      z.array(z.object({ id: z.string(), account: z.object({ id: z.string() }) })),
      await cf("GET", `/zones?${query}`),
    ) || [];
  if (zones.length > 1)
    throw new Error(
      `This access to Cloudflare reaches ${zones.length} domains named ${domain} (accounts ${zones.map((candidate) => candidate.account.id).join(", ")}): pass --account <id> to choose one.`,
    );
  if (zones.length === 0)
    throw new Error(
      account
        ? `This access to Cloudflare reaches no domain named ${domain} in account ${account}.`
        : `This access to Cloudflare reaches 0 domains named ${domain}: a mind is found by its one domain.`,
    );
  return zones[0]!;
}

export async function recoverOwner(input: {
  domain: string;
  account?: string;
  owner: string;
  yes?: boolean;
}) {
  p.intro("𝑖  iterate recover: a way back in for an owner with no passkey");
  try {
    const domain = input.domain.toLowerCase();
    const owner = input.owner.toLowerCase();
    const access = await cloudflareAccess(RECOVER_SCOPES, ({ url, code, minutes }) =>
      p.log.step(
        `Sign in at Cloudflare and approve the access. Check that the page shows the code ${code}. Select the account of the mind. The code works for ${minutes} minutes.\n${url.href}`,
      ),
    );
    const cf = cloudflare(access.token);

    // the mind is found by its zone: the zone's account, and the boundary Worker in its routes
    const zone = await zoneForRecovery(cf, domain, input.account?.trim());
    const { account } = zone;
    const routes =
      resultOf(
        z.array(z.object({ script: z.string().nullish() })),
        await cf("GET", `/zones/${zone.id}/workers/routes`),
      ) || [];
    const stageName = routes
      .map((route) => /^iterate-(.+)-boundary$/.exec(route.script || "")?.[1])
      .find(Boolean);
    const mind = stageName && (await deployedMind(cf, account.id, stageName));
    if (!mind) throw new Error(`No mind is at ${domain}: no route there names a mind's boundary.`);
    if (!isOwnerEmail(mind, owner))
      throw new Error(
        `${owner} is no owner of the mind at ${mind.controlPlaneHostname}. Its owners: ${[...mind.ownerEmails, ...(mind.ownerEmailPatterns || [])].join(", ")}. The command is for an owner alone: an owner makes a link for another member on the mind's page /members.`,
      );
    const databaseName = `iterate-${mind.stageName}-auth-db`;
    const database = resultOf(
      z.array(z.object({ uuid: z.string(), name: z.string() })),
      await cf("GET", `/accounts/${account.id}/d1/database?name=${databaseName}`),
    )?.find((candidate) => candidate.name === databaseName);
    if (!database)
      throw new Error(`The account has no database ${databaseName}: the mind's sign-in is there.`);

    if (!input.yes) {
      if (!process.stdin.isTTY || !process.stdout.isTTY || isCodingAgent(process.env))
        throw new Error("Nobody is at this terminal to answer: pass --yes.");
      const yes = await p.confirm({
        message: `Revoke every passkey of ${owner} at ${mind.controlPlaneHostname}, and make a link that signs ${owner} in once, within 24 hours, to add a new one? What ${owner} is signed in to (apps, terminals) stays.`,
      });
      if (yes !== true) throw new Error("Nothing was changed.");
    }

    const { ticket, hash } = newTicket();
    for (const statement of recoveryStatements({ owner, ticketHash: hash, at: Date.now() })) {
      const ran = await cf(
        "POST",
        `/accounts/${account.id}/d1/database/${database.uuid}/query`,
        statement,
      );
      if (ran.status !== 200)
        throw new Error(
          `Cloudflare did not run a statement on ${databaseName} (${ran.status}: ${ran.error}). Run the command again: it revokes and makes a new link.`,
        );
    }
    await endAccess(access);
    p.log.success(`Every passkey of ${owner} at ${mind.controlPlaneHostname} is revoked.`);
    // on a line of its own, so that a narrow terminal's wrap puts nothing into the link
    console.log(
      `\nThe link for ${owner}. It works once, within 24 hours, and whoever opens it adds the passkey:\n\n  https://${mind.controlPlaneHostname}/keys/first#${ticket}\n`,
    );
    p.outro(
      `What ${owner} was signed in to stays: end it at https://${mind.controlPlaneHostname}/sessions.`,
    );
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro("Stopped.");
    process.exit(1);
  }
}
