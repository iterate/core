// principal.ts — WHO user code is acting for, as the platform tells it: the verified `Principal`
// (`itx.whoami()`, `source.principal` on an event), the header ingress stamps it in on a Request it
// forwards to a mind, with the grant beside it, and the `Person` ingress stamps for anyone
// signed in on a mind's hostname (core/boundary-worker/src/stamp.ts; sdk/auth.ts reads both), and the
// one reader of each stamp, `stampedCallerOf` and `stampedPersonOf`. How the platform admits and carries a
// caller, and signs its own tokens, stays in the platform.
import { z } from "zod";
import { codedError } from "./lib.ts";

/** Who is acting: a stable actor id (the auth Worker's user id) and, when known, an email. A
 *  platform admin signed in as someone else is two people (RFC 8693's subject and actor): the
 *  principal is the person, whose access every check reads, and `impersonatedBy` the admin doing
 *  it, stamped beside them on every event. */
export type Principal = {
  actor: string;
  email?: string;
  /** A person's `Person.name`, where a person who may be no member is named as who asked or who
   *  holds (`source.onBehalfOf`, a subscription's `heldBy`: core/itx/src/person-context.ts). Text
   *  to show, which the person may have chosen: it proves nothing and decides nothing. A verified
   *  principal (`x-itx-principal`, `source.principal`) never has it. */
  name?: string;
  impersonatedBy?: { actor: string; email: string };
  /** "mind": another mind, which signed with the key it publishes; `actor` is its domain. Only a
   *  signer's principal has it (`source.signer`, core/auth-worker/src/minds.ts). "guest": a person
   *  who typed a name and proved nothing (`Person.method` "guest"), named as who asked or who
   *  holds, like `name`: a verified principal is never one. Absent: a person or a service. */
  kind?: "mind" | "guest";
};

/** The header ingress sets on a Request it forwards on a member's behalf, after the bearer or the
 *  session cookie checks out, and strips from every inbound Request. */
export const ITX_PRINCIPAL_HEADER = "x-itx-principal";

/** The header the edge sets beside `ITX_PRINCIPAL_HEADER`: the OAuth grant the principal acts
 *  through, one per connected client. Stripped from every inbound Request. */
export const ITX_GRANT_HEADER = "x-itx-grant";

/** The header the edge sets beside `ITX_GRANT_HEADER`, and beside `ITX_PERSON_HEADER` on a mind
 *  host: when the credential that stamped the principal or the person ends, in Unix seconds. A
 *  session that outlives its request (the API's WebSocket, a page's socket) ends then. Stripped
 *  from every inbound Request. */
export const ITX_EXPIRES_HEADER = "x-itx-expires";

/** A KEY'S TOKEN (core/auth-worker/src/key-tokens.ts): the service the key speaks for, the key as
 *  the grant it acts through (`key:<id>`), and the one capability it may lend, `itx.<provide>`.
 *  Such a caller is no principal: its session of the API reaches its one lend and nothing else of
 *  the mind. The boundary names it in the call that makes the mind's part of the session
 *  (./workers.ts `ApiCaller`), and in no header. */
export type Lender = { actor: string; key: string; provide: string };

/** HOW A PERSON SIGNED IN at the mind's issuer (core/auth-worker): what opened the session that
 *  a token or a hostname's session came from. "passkey": a passkey, which a member alone has.
 *  "email": a code that the mind mailed to the person's address. "guest": nothing proven, the
 *  person typed a name (core/auth-worker/src/guest-sign-in.ts). An app names the ones it takes
 *  for its people, in its order (`AppDescription.signIn`, ./app-description.ts); a passkey's
 *  session counts at every app. */
export const SignInMethod = z.enum(["passkey", "email", "guest"]);
export type SignInMethod = z.infer<typeof SignInMethod>;

/** A signed-in person as a mind's host knows them, member or not: the auth Worker's user id
 *  and their email, `method`, how they signed in, and `impersonatedBy` the platform admin signed
 *  in as them, as on `Principal`. An app that hands out something personal refuses, or records, a
 *  person an admin is signed in as. `name` is what to call them on a page: the part of their
 *  email before the "@", or for a guest the name they typed. It is text to show
 *  (`displayNameOf`), never a key and never a reason to let someone in: `userId` is who they are.
 *  Two kinds, told apart by `method`: a person who proved an address (`AddressedPerson`), and a
 *  guest, who proved nothing and has no address (`Guest`, whose `email` is ""). */
export type Person = AddressedPerson | Guest;

/** A person whom a passkey or a mailed code signed in: `email` is the address they proved. */
export type AddressedPerson = {
  userId: string;
  email: string;
  name: string;
  method: "passkey" | "email";
  impersonatedBy?: { actor: string; email: string };
};

/** A person who typed a name and proved nothing (core/auth-worker/src/guest-sign-in.ts). No
 *  address: `email` is "", so no reader can take two guests for one person by it. */
export type Guest = {
  userId: string;
  email: "";
  name: string;
  method: "guest";
  impersonatedBy?: undefined;
};

/** The header ingress sets, as the JSON of a `Person`, on a mind host's Request from anyone
 *  signed in (core/boundary-worker/src/mind-host-sign-in.ts), and strips from every inbound Request. A
 *  member gets `x-itx-principal` beside it. */
export const ITX_PERSON_HEADER = "x-itx-person";

/** The longest name a person is shown by. */
export const DISPLAY_NAME_MAX_CHARACTERS = 40;

/** TEXT AS A PERSON'S NAME ON A PAGE: one line of at most `DISPLAY_NAME_MAX_CHARACTERS`, with no
 *  control character, no Unicode line or paragraph separator and no format character (a direction
 *  override, a zero-width mark), in compatibility form. So a name starts no line of its own and
 *  is drawn in the order it is written. It may still hold any letters, an address or a bracket:
 *  whoever puts it in HTML or in a label escapes it there. Empty when nothing is left. */
export const displayNameOf = (text: string) =>
  [
    ...text
      .normalize("NFKC")
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ")
      .trim(),
  ]
    .slice(0, DISPLAY_NAME_MAX_CHARACTERS)
    .join("")
    .trim();

/** A STAMP'S JSON AS A HEADER'S VALUE. A header holds bytes, and a name may hold any letter: so
 *  every character past ASCII is written as its JSON escape, which any reader of the stamp parses
 *  back to the same text. */
export const stampJsonOf = (stamp: unknown) =>
  JSON.stringify(stamp).replace(
    /[^\x20-\x7e]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const StampedPerson = z.discriminatedUnion("method", [
  z.object({
    userId: z.string().min(1),
    email: z.string(),
    method: z.enum(["passkey", "email"]),
    name: z.string(),
    impersonatedBy: z.object({ actor: z.string().min(1), email: z.string() }).optional(),
  }),
  z.object({
    userId: z.string().min(1),
    email: z.literal(""),
    method: z.literal("guest"),
    name: z.string(),
  }),
]);

/** THE PERSON INGRESS STAMPED on `request`, or null when nobody signed in. Trusted as it stands,
 *  as `stampedCallerOf`: a malformed stamp is a defect, and throws. */
export function stampedPersonOf(request: Request): Person | null {
  const stamped = request.headers.get(ITX_PERSON_HEADER);
  if (!stamped) return null;
  const person = StampedPerson.parse(JSON.parse(stamped));
  // cleaned here too, so that no app shows a name as some other stamp wrote it
  return { ...person, name: displayNameOf(person.name) };
}

/** What a person with an address is called for now: the part of it before the "@". */
export const nameInEmail = (email: string) => displayNameOf(email.split("@")[0] || "");

const StampedPrincipal = z.object({
  actor: z.string(),
  email: z.string().optional(),
  impersonatedBy: z.object({ actor: z.string(), email: z.string() }).optional(),
});

/** When the credential stamped on `request` ends, in epoch milliseconds, or null when none is
 *  stamped (`ITX_EXPIRES_HEADER`). */
export function stampedExpiryOf(request: Request): number | null {
  const seconds = Number(request.headers.get(ITX_EXPIRES_HEADER));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** THE CALLER INGRESS STAMPED on `request`: the principal, the grant they came through, which
 *  every event they append then carries, and the signed-in person of a visitor to a mind's host
 *  (`stampedPersonOf`). Null, and no person, when nobody is stamped. Ingress strips every
 *  `x-itx-*` a caller sends and stamps its own, and only ingress reaches a mind, so the stamp is
 *  trusted as it stands: a malformed one is a defect, and throws. This is the one read of who
 *  asks: the kernel carries the answer with the call, and stamps each Request that it hands to
 *  the mind's code from it (core/itx `stampCallerHeaders`). */
export function stampedCallerOf(request: Request): {
  principal: Principal | null;
  grant: string | undefined;
  person: Person | undefined;
} {
  const principal = request.headers.get(ITX_PRINCIPAL_HEADER);
  return {
    principal: principal ? StampedPrincipal.parse(JSON.parse(principal)) : null,
    grant: request.headers.get(ITX_GRANT_HEADER) || undefined,
    person: stampedPersonOf(request) || undefined,
  };
}

/** WHO CALLS A SERVICE, a Worker of the stack's own Cloudflare account that its config names
 *  (core/alchemy `services`). The mind Worker puts it first in each call: `itx.services.<name>.
 *  <method>(...args)` arrives at the bound entrypoint as `<method>(caller, ...args)`. The platform
 *  writes it, never the calling code. A service trusts it because only a Worker of its own account
 *  can bind it: any such Worker could also send one. `mind` is the stack's domain, `path` the
 *  context that called, `onBehalfOf` the person a run acts for. */
export const ServiceCaller = z.object({
  mind: z.string(),
  path: z.string(),
  call: z.string(),
  principal: StampedPrincipal.optional(),
  grant: z.string().optional(),
  onBehalfOf: z
    .object({
      // who asked, with the name to show them by and whether they are a guest (`Principal.name`,
      // `kind`), which the caller's own verified `principal` above never has
      principal: StampedPrincipal.extend({
        name: z.string().optional(),
        kind: z.enum(["mind", "guest"]).optional().catch(undefined),
      }),
      grant: z.string().optional(),
      run: z.string().optional(),
      call: z.string().optional(),
    })
    .optional(),
});
export type ServiceCaller = z.infer<typeof ServiceCaller>;

/** A service's read of its first argument: a call that did not come through a mind's
 *  `itx.services` is refused. */
export function serviceCallerOf(value: unknown): ServiceCaller {
  const parsed = ServiceCaller.safeParse(value);
  if (parsed.success) return parsed.data;
  throw codedError(
    "INVALID_INPUT",
    `not a mind's call: the first argument is no ServiceCaller (${parsed.error.message})`,
  );
}
