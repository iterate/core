import { type Facts, withFacts } from "iterate/facts";
import type { Envelope } from "iterate/signed";
import { z } from "zod";

/** `session`: the browser's session it opened (./cookies.ts `sessionCookie`). */
const session = z.string().min(1);
const SignedIn = z.union([
  z.object({ method: z.literal("passkey"), key: z.string().min(1), session, at: z.number() }),
  // a proof that opens the session that may add a first passkey (./enrolment.ts `Proof`)
  z.object({
    method: z.enum(["cloudflare-access", "member-link", "recovery-link"]),
    session,
    at: z.number(),
  }),
  // a mailed code that proved the address of a person who is no member (./email-sign-in.ts)
  z.object({ method: z.literal("email"), session, at: z.number() }),
  // another mind vouched that this person is its member (./mind-sign-in.ts): that mind's id and
  // hostname. No session row: the cookie is the session (./cookies.ts `mindSessionCookie`)
  z.object({
    method: z.literal("mind"),
    mind: z.string().min(1),
    hostname: z.string().min(1),
    at: z.number(),
  }),
]);
/** This mind vouched for its member to another mind (./vouch.ts): that mind's id and hostname. */
const SignInVouched = z.object({
  mind: z.string().min(1),
  hostname: z.string().min(1),
  at: z.number(),
});
/** A new guest (./guest-sign-in.ts): the name they typed, and the host of the app that let them
 *  come. Once for each guest: the sessions a guest earns later write nothing. */
const GuestSignedIn = z.object({
  userId: z.string().min(1),
  name: z.string().min(1),
  app: z.string().min(1),
  at: z.number(),
});
/** A guest was not let in. "rate": the stack's bound on new guests is reached; "session-rate":
 *  its bound on guests' sessions; "blocked": an owner blocked this guest. At most one for each
 *  reason in ten minutes, however many were refused. */
const GuestRefused = z.object({
  reason: z.enum(["rate", "session-rate", "blocked"]),
  app: z.string().min(1),
  at: z.number(),
});
/** A browser's session ended: at sign-out, on /sessions, or with its person's removal. */
const SessionEnded = z.object({ session, at: z.number() });
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
  // `signer` and `signed`: on each passkey but a person's first
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
    /** The iterate Cloud's origin that published the key, for the actor `iterate-cloud`. */
    cloud: z.string().optional(),
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
const PersonBlocked = z.object({ email: z.string().min(1) });
const MemberLinkMade = z.object({ email: z.string().min(1), expires: z.number() });
const MemberAdded = SignedBy.extend({ email: z.string().min(1) });
/** A device's request that a member's passkey signed to continue (./device/page.ts), as the page
 *  showed it. The grant itself is `consent-approved`, and for a let-in `let-in-approved`. */
const DeviceConfirmed = SignedBy.extend({
  userCode: z.string().min(1),
  clientId: z.string().min(1),
  clientName: z.string(),
  resource: z.string(),
  letIn: z.object({ seconds: z.number().int(), reason: z.string() }).optional(),
});
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
  | { type: "events.iterate.com/account/session-ended"; payload: z.infer<typeof SessionEnded> }
  | { type: "events.iterate.com/account/member-added"; payload: z.infer<typeof MemberAdded> }
  | { type: "events.iterate.com/account/member-removed"; payload: z.infer<typeof MemberRemoved> }
  | {
      type: "events.iterate.com/account/member-link-made";
      payload: z.infer<typeof MemberLinkMade>;
    }
  | { type: "events.iterate.com/account/person-blocked"; payload: z.infer<typeof PersonBlocked> }
  | { type: "events.iterate.com/account/person-unblocked"; payload: z.infer<typeof PersonBlocked> }
  | { type: "events.iterate.com/account/let-in-approved"; payload: z.infer<typeof LetInApproved> }
  | {
      type: "events.iterate.com/account/device-confirmed";
      payload: z.infer<typeof DeviceConfirmed>;
    }
  | { type: "events.iterate.com/account/key-added"; payload: z.infer<typeof KeyAdded> }
  | { type: "events.iterate.com/account/key-removed"; payload: z.infer<typeof KeyRemoved> }
  | {
      type: "events.iterate.com/account/guest-signed-in";
      payload: z.infer<typeof GuestSignedIn>;
    }
  | { type: "events.iterate.com/account/guest-refused"; payload: z.infer<typeof GuestRefused> }
  | {
      type: "events.iterate.com/account/sign-in-vouched";
      payload: z.infer<typeof SignInVouched>;
    }
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
