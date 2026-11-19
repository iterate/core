// principal.ts — WHO user code is acting for, as the platform tells it: the verified `Principal`
// (`itx.whoami()`, `source.principal` on an event), the header ingress stamps it in on a Request it
// forwards to a mind, with the grant beside it, and the `Person` ingress stamps for anyone
// signed in on a mind's hostname (core/boundary-worker/src/stamp.ts; sdk/auth.ts reads both), and the
// one reader of each stamp, `stampedCallerOf` and `stampedPersonOf`. How the platform admits and carries a
// caller, and signs its own tokens, stays in the platform.
import { z } from "zod";
import { codedError } from "./lib.ts";
import { isMindControlPlaneHostname } from "./signed.ts";

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
  /** "mind": another mind, with `actor` its 64-hex id and `hostname` beside it. Two places name
   *  one: a signer's principal (`source.signer`, core/auth-worker/src/minds.ts; an event in the
   *  hostname form has the hostname as `actor` and no `hostname`), and a request that the
   *  mind signed, which the boundary stamps in `ITX_MIND_HEADER` (`principalStampOf`). A mind is no member: who asks is not what they
   *  may do, so the kernel carries it apart from every member (core/itx `Caller.mind`). "guest": a
   *  person who typed a name and proved nothing (`Person.method` "guest"), named as who asked or
   *  who holds, like `name`: a verified principal is never one. Absent: a person or a service. */
  kind?: "mind" | "guest";
  /** A mind's control-plane hostname, beside its id in a mind's stamp: text to show, never a key.
   *  A hostname can move to another mind, the id cannot: decide by `actor`. */
  hostname?: string;
};

/** The header ingress sets on a Request it forwards on a member's behalf, after the bearer or the
 *  session cookie checks out, and strips from every inbound Request. It names a member alone:
 *  another mind has `ITX_MIND_HEADER`. Read both through `principalStampOf`. */
export const ITX_PRINCIPAL_HEADER = "x-itx-principal";

/** The header ingress sets, as the JSON of a mind's `Principal` (`{ actor: <mind id>, kind:
 *  "mind", hostname }`), on a Request that another mind signed and ingress checked, and strips
 *  from every inbound Request. A header of its own, beside `ITX_PRINCIPAL_HEADER` as
 *  `ITX_PERSON_HEADER` is: a reader that knows only `ITX_PRINCIPAL_HEADER` (one of a Worker or an
 *  SDK from before this header) sees nobody, and refuses as for nobody, so no order of deploys is
 *  needed for a mind's request to stay no member's. Never beside a member, a grant or a person. */
export const ITX_MIND_HEADER = "x-itx-mind";

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
 *  person typed a name (core/auth-worker/src/guest-sign-in.ts). "mind": the person's own mind
 *  signed that they are one of its members (core/auth-worker/src/mind-sign-in.ts). An app names the ones it takes
 *  for its people, in its order (`AppDescription.signIn`, ./app-description.ts); a passkey's
 *  session counts at every app. */
export const SignInMethod = z.enum(["passkey", "email", "guest", "mind"]);
export type SignInMethod = z.infer<typeof SignInMethod>;

/** A signed-in person as a mind's host knows them, member or not: the auth Worker's user id
 *  and their email, `method`, how they signed in, and `impersonatedBy` the platform admin signed
 *  in as them, as on `Principal`. An app that hands out something personal refuses, or records, a
 *  person an admin is signed in as. `name` is what to call them on a page: the part of their
 *  email before the "@", or for a guest the name they typed. It is text to show
 *  (`displayNameOf`), never a key and never a reason to let someone in: `userId` is who they are.
 *  Three kinds, told apart by `method`: a person who proved an address (`AddressedPerson`), a
 *  guest, who proved nothing and has no address (`Guest`, whose `email` is ""), and a member of
 *  another mind, which vouched for them (`MindPerson`, whose `email` is "" too). */
export type Person = AddressedPerson | Guest | MindPerson;

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

/** A MEMBER OF ANOTHER MIND, which signed that they are (core/auth-worker/src/mind-sign-in.ts): no
 *  member here, and no address, since that mind sends none. `mind.id` is that mind's id, which
 *  decides; `mind.hostname` its control-plane hostname, a label; `mind.userId` the person's user id
 *  there. `userId` is this mind's own id for them, stable for that pair. `name` is the hostname,
 *  as a name to show. */
export type MindPerson = {
  userId: string;
  email: "";
  name: string;
  method: "mind";
  mind: { id: string; hostname: string; userId: string };
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
  z.object({
    userId: z.string().min(1),
    email: z.literal(""),
    method: z.literal("mind"),
    name: z.string(),
    mind: z.strictObject({
      id: z.string().regex(/^[0-9a-f]{64}$/),
      hostname: z.string().refine(isMindControlPlaneHostname),
      userId: z.string().min(1),
    }),
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

/** A MEMBER'S STAMP: a person or the operator. It never has a mind's fields, `kind` or
 *  `hostname`: so a mind's stamp that lost its `kind` is a defect, never a member. */
export const MemberPrincipal = z.object({
  actor: z.string().min(1),
  email: z.string().optional(),
  impersonatedBy: z.object({ actor: z.string(), email: z.string() }).optional(),
  kind: z.never().optional(),
  hostname: z.never().optional(),
});
/** A member as the platform stamps one: what `Caller.principal` holds (core/itx). Its `kind` and
 *  `hostname` are `never`, so a mind's stamp does not compile in its place. */
export type MemberPrincipal = z.infer<typeof MemberPrincipal>;

/** A PRINCIPAL THAT THE PLATFORM VOUCHES IS A MEMBER, read as one where it enters the kernel (the
 *  API's session, core/mind-worker rpc.ts). Throws for one with a mind's or a guest's fields: a
 *  defect, because only a member's is passed here. */
export const memberPrincipalOf = (principal: Principal): MemberPrincipal =>
  MemberPrincipal.parse(principal);

/** ANOTHER MIND'S STAMP: its id, which decides, and its control-plane hostname, a label. Nothing
 *  else rides it. */
const MindPrincipal = z.strictObject({
  actor: z.string().regex(/^[0-9a-f]{64}$/, "a mind's id: 64 lower-case hex"),
  kind: z.literal("mind"),
  hostname: z.string().refine(isMindControlPlaneHostname, "a mind's control-plane hostname"),
});
/** Another mind as the platform stamps one: what `Caller.mind` holds (core/itx). */
export type MindPrincipal = z.infer<typeof MindPrincipal>;

/** WHO IS STAMPED AS A PRINCIPAL: the member in `ITX_PRINCIPAL_HEADER`, read with the member's
 *  schema, and another mind in `ITX_MIND_HEADER`, read with the mind's. The two schemas cannot be
 *  crossed, so a mind is never `principal`. This is the one reader of both headers
 *  (`stampedCallerOf`, and the kernel's own read of a Request it stamped). Ingress strips every
 *  `x-itx-*` a caller sends, so a stamp is trusted as it stands: a malformed one, a header that is
 *  present and empty, or a member and a mind on one request, is a defect, and throws. An absent
 *  header is nobody. */
export function principalStampOf(headers: Headers): {
  principal: MemberPrincipal | null;
  mind: MindPrincipal | undefined;
} {
  const principal = stampIn(headers, ITX_PRINCIPAL_HEADER, MemberPrincipal) || null;
  const mind = stampIn(headers, ITX_MIND_HEADER, MindPrincipal);
  if (principal && mind)
    throw new Error(`a member and a mind are stamped on one request: a defect`);
  return { principal, mind };
}

/** The stamp in the header `name`, parsed with `schema`, or undefined when the header is absent. */
function stampIn<T>(headers: Headers, name: string, schema: z.ZodType<T>): T | undefined {
  const stamped = headers.get(name);
  // oxlint-disable-next-line iterate/simple-truthiness-check -- absent (null) is nobody, present and empty is a defect: the two must not collapse
  if (stamped === null) return undefined;
  if (!stamped) throw new Error(`${name} is present and empty: a defect`);
  return schema.parse(JSON.parse(stamped));
}

/** When the credential stamped on `request` ends, in epoch milliseconds, or null when none is
 *  stamped (`ITX_EXPIRES_HEADER`). */
export function stampedExpiryOf(request: Request): number | null {
  const seconds = Number(request.headers.get(ITX_EXPIRES_HEADER));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** THE CALLER INGRESS STAMPED on `request`: the principal, a member, and the grant they came
 *  through, which every event they append then carries; or `mind`, another mind whose signed
 *  request ingress checked, which is never a principal and comes with no grant; and the signed-in
 *  person of a visitor to a mind's host (`stampedPersonOf`). Null, and no person, when nobody is
 *  stamped. Ingress strips every `x-itx-*` a caller sends and stamps its own, and only ingress
 *  reaches a mind, so the stamp is trusted as it stands: a malformed one is a defect, and throws,
 *  as does a grant or a person beside a mind: a mind's request is no person's, so it never opens a
 *  person's view. This is the one read of who asks: the kernel carries the answer with the call,
 *  and stamps each Request that it hands to the mind's code from it (core/itx
 *  `stampCallerHeaders`), and reads it back with this where such a Request arrives. */
export function stampedCallerOf(request: Request): {
  principal: MemberPrincipal | null;
  mind: MindPrincipal | undefined;
  grant: string | undefined;
  person: Person | undefined;
} {
  const { principal, mind } = principalStampOf(request.headers);
  const grant = request.headers.get(ITX_GRANT_HEADER) || undefined;
  const person = stampedPersonOf(request) || undefined;
  if (mind && grant)
    throw new Error(`a grant is stamped beside a mind (${ITX_MIND_HEADER}): a defect`);
  if (mind && person)
    throw new Error(`a person is stamped beside a mind (${ITX_MIND_HEADER}): a defect`);
  return { principal, mind, grant, person };
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
  // a member's: a call carries `Caller.principal`, which is never a mind
  principal: MemberPrincipal.optional(),
  grant: z.string().optional(),
  onBehalfOf: z
    .object({
      // who asked, with the name to show them by and whether they are a guest (`Principal.name`,
      // `kind`), which the caller's own verified `principal` above never has
      principal: MemberPrincipal.extend({
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
