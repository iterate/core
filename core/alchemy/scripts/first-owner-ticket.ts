// A ticket for a stack's first owner, or for an owner whose passkeys are lost
// (core/auth/src/first-owner.ts), for a deploy run:
//   node scripts/first-owner-ticket.ts <the owner's address>
// prints { ticket, variable }. Deploy with ITERATE_FIRST_OWNER_TICKET=<variable>, then send the owner
// to https://iterate.<domain>/keys/first#<ticket> within 24 hours. The ticket is kept nowhere.
import { createHash, randomBytes } from "node:crypto";
import { FIRST_OWNER_TICKET_MS, type FirstOwnerTicket } from "core-auth/config";

const email = process.argv[2]?.trim().toLowerCase();
if (!email || process.argv.length > 3) {
  console.error("usage: first-owner-ticket.ts <the owner's address>");
  process.exit(2);
}
const ticket = randomBytes(32).toString("base64url");
const variable: FirstOwnerTicket = {
  email,
  hash: createHash("sha256").update(ticket).digest("hex"),
  expires: Date.now() + FIRST_OWNER_TICKET_MS,
};
console.log(JSON.stringify({ ticket, variable: JSON.stringify(variable) }));
