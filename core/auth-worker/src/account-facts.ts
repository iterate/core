import { type Facts, withFacts } from "iterate/facts";
import type { Envelope } from "iterate/signed";
import { z } from "zod";

const SignedIn = z.union([
  z.object({ method: z.literal("email"), at: z.number() }),
  z.object({ method: z.literal("passkey"), key: z.string().min(1), at: z.number() }),
  z.object({ method: z.literal("first-owner-ticket"), at: z.number() }),
]);
const ConsentApproved = z.object({
  clientId: z.string().min(1),
  clientName: z.string(),
  minds: z.null(),
  scopes: z.array(z.string()),
});
const GrantEnded = z.object({ grantId: z.string().min(1) });
/** The key that signed a change which lets more act (./signed-change.ts), and what it signed. */
const SignedBy = z.object({
  signer: z.object({
    principal: z.object({ actor: z.string(), email: z.string() }),
    key: z.string(),
    label: z.string(),
  }),
  signed: z.custom<Envelope>(),
});
const KeyAdded = z.union([
  // `signer` and `signed`: on each passkey but a person's first, and one the owner's ticket adds
  SignedBy.partial().extend({
    key: z.string().min(1),
    label: z.string(),
    format: z.literal("webauthn"),
    at: z.number(),
  }),
  z.object({
    key: z.string().min(1),
    label: z.string(),
    format: z.literal("p256"),
    at: z.number(),
    actor: z.string(),
    paths: z.array(z.string()),
    /** The capability the key's token may lend, `itx.<provide>`, when it has one. */
    provide: z.string().optional(),
    addedBy: z.string(),
  }),
]);
const KeyRemoved = z.object({
  key: z.string().min(1),
  label: z.string(),
  actor: z.string().optional(),
  at: z.number(),
  /** The owner's user id, when an owner removed a member's key on /members. */
  removedBy: z.string().optional(),
});
const MemberRemoved = z.object({ email: z.string().min(1) });
const MemberAdded = SignedBy.extend({ email: z.string().min(1) });
const LetInApproved = z.object({
  grantId: z.string().min(1),
  clientId: z.string().min(1),
  clientName: z.string(),
  reason: z.string(),
  until: z.number().int().positive(), // epoch ms
  signer: z.object({ actor: z.string(), key: z.string() }).optional(),
});

export type AccountFact = (
  | { type: "events.iterate.com/account/signed-in"; payload: z.infer<typeof SignedIn> }
  | {
      type: "events.iterate.com/account/consent-approved";
      payload: z.infer<typeof ConsentApproved>;
    }
  | { type: "events.iterate.com/account/grant-ended"; payload: z.infer<typeof GrantEnded> }
  | { type: "events.iterate.com/account/member-added"; payload: z.infer<typeof MemberAdded> }
  | { type: "events.iterate.com/account/member-removed"; payload: z.infer<typeof MemberRemoved> }
  | { type: "events.iterate.com/account/let-in-approved"; payload: z.infer<typeof LetInApproved> }
  | { type: "events.iterate.com/account/key-added"; payload: z.infer<typeof KeyAdded> }
  | { type: "events.iterate.com/account/key-removed"; payload: z.infer<typeof KeyRemoved> }
) & { idempotencyKey?: string };

// A record for the mind, never the authority: members and live grants are this Worker's D1 and KV.
export class AccountFacts {
  readonly #facts: Facts = [];

  add(userId: string, fact: AccountFact) {
    this.#facts.push({ path: `/users/${userId}`, events: [fact] });
  }

  addToMind(fact: AccountFact) {
    this.#facts.push({ path: "/", events: [fact] });
  }

  on(response: Response): Response {
    return withFacts(response, this.#facts);
  }
}
