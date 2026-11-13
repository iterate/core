// config.ts — WHAT THE AUTH WORKER IS TOLD (tasks/mind-stack.md): who may sign in, how, which
// clients need no consent page, and the resources it issues tokens for. The stack's config takes
// `AuthSettings` under `auth` (core/alchemy/src/config.ts), and the stack binds them as the Worker's
// `AUTH_SETTINGS` variable beside `DOMAIN` (`authConfigOf`). No Worker code here: the stack imports it.
import { dnsName } from "iterate/app-config";
import { mindApiUrlOf, mindMcpUrlOf, mindProvideUrlOf } from "iterate/mind-api";
import { z } from "zod";

/** An origin, `https://host[:port]`, spelled exactly as `new URL(…).origin` spells it. */
const Origin = z
  .string()
  .trim()
  .refine((value) => URL.canParse(value) && new URL(value).origin === value, {
    error: "expected an origin, like https://example.com, with no path and no trailing slash",
  });

/** One rule of `login.allow`, as Cloudflare Access names its rules, values lowercased (copied
 *  from the earlier platform, core/os, removed). Only `{ email }` with no `subaddresses` names one
 *  person. Each other rule admits addresses nobody named: such an address is a member with no
 *  passkey until it adds one, so whoever reads its mail gets a passkey that approves requests and
 *  adds members. */
export const EmailRule = z.union(
  [
    z.strictObject({
      email: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[^@\s]+@[^@\s]+$/, "expected an email address"),
      /** Also the address's subaddresses: `jo+anything@b.com` for `jo@b.com`. */
      subaddresses: z.literal(true).optional(),
    }),
    z.strictObject({ emailDomain: dnsName }),
    z.strictObject({ everyone: z.strictObject({}) }),
  ],
  {
    error:
      'expected a rule: { "email": "a@b.com" }, { "emailDomain": "b.com" } or { "everyone": {} }',
  },
);
export type EmailRule = z.infer<typeof EmailRule>;

/** The auth part of a mind's config: how a person signs in, who may, and which clients are
 *  approved without a consent page. */
export const AuthSettings = z.strictObject({
  login: z.strictObject({
    /** The ways to prove an address beside a passkey. A method here signs in a member who holds no
     *  passkey, to add the first one, and anyone who is no member. None is valid: a member signs
     *  in with a passkey (./passkey-sign-in.ts), and the one way to a first passkey is a deploy's
     *  ticket (./first-owner.ts), which is an owner's alone. So with no method, a member who is no
     *  owner (one an owner added, or one an `emailDomain` rule names) cannot get in: name each
     *  person by address in `allow`, or give the mind a method. */
    methods: z
      .strictObject({
        /** A MAILED CODE (./email-sign-in.ts): six digits sent from `sign-in@<domain>` through the
         *  stack's own boundary, so the stack depends on nobody. The stack must handle mail
         *  (its `email` part). A code goes to an address an `email` or `emailDomain` rule of
         *  `allow` names. `anyone: true` also mails any other address that asks, so that people who
         *  are not members can sign in to the mind's own pages: at most 20 such codes an hour
         *  for the whole stack, so its domain is never a way to mail the world. */
        email: z.strictObject({ anyone: z.literal(true).optional() }).optional(),
        /** SIGN IN WITH GOOGLE (./google-sign-in.ts, which says whom this trusts), through the
         *  Google client of the iterate Cloud the stack's config names (`cloud.origin`). It proves
         *  an address as a mailed code does: a member who holds no passkey adds the first one, and
         *  a member who holds one signs in with the passkey. `signsInAlone: true` is the other
         *  policy: Google alone signs a member in, passkey or not, and the Cloud is then trusted
         *  as much as Google for who a member is. */
        google: z.strictObject({ signsInAlone: z.literal(true).optional() }).optional(),
        /** SIGN IN WITH CLOUDFLARE (./cloudflare-sign-in.ts): a Cloudflare OAuth client's id. It
         *  makes the way exist, and an app of the mind chooses it in its own code (iterate/sdk
         *  `auth.requirePerson(request, { methods: ["cloudflare"] })`): no app gets it otherwise.
         *  The client's secret is never in these settings: the deploy takes it from its environment
         *  (core/alchemy/src/config.ts) and binds it as CLOUDFLARE_SIGN_IN_CLIENT_SECRET. */
        cloudflare: z.strictObject({ clientId: z.string().trim().min(1) }).optional(),
      })
      .default({}),
    /** WHO IS A MEMBER, for now: a person is when one rule matches. Anyone a method vouches for
     *  (a mailed code) may sign in, and signing in grants nothing: a token for the
     *  API, the MCP server or `/provide` is issued to a member alone, and answered only while they are one (checked at
     *  consent, at every token refresh and at every `whoIs`). Everyone, on purpose:
     *  `[{ "everyone": {} }]`. */
    allow: z.array(EmailRule).min(1, "lists no rule, so nobody could sign in"),
  }),
  /** Origins whose clients are approved with no consent page: a client whose id (its metadata
   *  document's URL) and redirect are both on one of them (./authorize.ts). */
  trustedClients: z.array(Origin).optional(),
  /** A DEVICE'S APPROVAL (./device/page.ts). "Sign in a device" and "Let … in" give a device, or
   *  an agent somewhere else, a token for the whole mind as the member who continues. With
   *  `passkey: true`, Continue on that page is a statement that one of the member's passkeys
   *  signs, with the member checked (a PIN, a fingerprint or a face), as allowing a key is
   *  (./keys-pages.ts). A stolen session then signs in no device. Without it, the session alone
   *  continues: a member who holds no passkey on this browser can still continue. */
  devices: z.strictObject({ passkey: z.literal(true).optional() }).optional(),
  /** Root keys: their statements count with no row here. A key with an `email` is a person's, a
   *  member while `login.allow` admits it: it approves, and adds members and keys, at no path at
   *  all. `paths` confines what a service's key may add through `POST /statements`; without it,
   *  any path. So a key has an `email` or `paths`, never both: `paths` would read as a limit on
   *  what the person's key may do, and it is none. */
  keys: z
    .array(
      z
        .strictObject({
          actor: z.string().min(1),
          email: z.string().optional(),
          /** SubjectPublicKeyInfo DER, base64url. */
          publicKey: z
            .string()
            .regex(/^[A-Za-z0-9_-]+$/, "expected SubjectPublicKeyInfo DER, base64url"),
          label: z.string().min(1),
          paths: z.array(z.string().startsWith("/")).min(1).optional(),
        })
        .refine(({ email, paths }) => !(email && paths), {
          path: ["paths"],
          error:
            "a key with an email is a person's: it approves and adds members whatever paths say, so it takes no paths. Give a service's key paths and no email",
        }),
    )
    .optional(),
});
export type AuthSettings = z.infer<typeof AuthSettings>;

/** The Worker's config. The stack parses it at deploy (`authConfigOf`), so two things
 *  under the mind's own domain refuse the deploy, because every hostname and every mailbox there
 *  is the mind's, whose code may be hostile: a trusted client, which would be approved with no
 *  consent page; and a member's address, an `email` rule at the domain or a subdomain of it or an
 *  `emailDomain` rule of one, whose mailed sign-in code the mind receives. */
export const AuthConfig = AuthSettings.extend({
  /** The mind's domain: this Worker answers on `iterate.<domain>`, its issuer's origin. */
  domain: z.string(),
  /** The resources (RFC 8707) this Worker issues tokens for to members, each a canonical URI.
   *  Besides them, any hostname of the mind is a resource for anyone signed in (./oauth.ts
   *  `mindHostResourceOf`). A request for any other is refused. */
  resources: z.array(z.string()).min(1),
})
  .refine(
    ({ domain, trustedClients = [] }) =>
      trustedClients.every((origin) => {
        const { hostname } = new URL(origin);
        return hostname !== domain && !hostname.endsWith(`.${domain}`);
      }),
    {
      path: ["trustedClients"],
      error:
        "a trusted client may not be under the mind's own domain: those hostnames are the mind's",
    },
  )
  .refine(
    ({ domain, login }) =>
      login.allow.every((rule) => {
        const host =
          "email" in rule
            ? rule.email.split("@")[1]
            : "emailDomain" in rule
              ? rule.emailDomain
              : null;
        return !host || (host !== domain && !host.endsWith(`.${domain}`));
      }),
    {
      path: ["login", "allow"],
      error:
        "a member's address may not be at the mind's own domain: the mind receives that address's mail, so the mind could sign in as that member",
    },
  );
export type AuthConfig = z.infer<typeof AuthConfig>;

/** Whether `email` is at the mind's own domain or under it. Every mailbox there is the mind's,
 *  whose code may be hostile: the mind receives the sign-in code mailed to that address. */
export function atMindsDomain(domain: string, email: string): boolean {
  const host = email.trim().toLowerCase().split("@")[1] || "";
  return host === domain || host.endsWith(`.${domain}`);
}

/** WHETHER THE CONFIG MAKES `email` A MEMBER: a rule of `login.allow` admits it, and it is no
 *  address of the mind's own. A deploy refuses a rule that names such an address (`AuthConfig`).
 *  `everyone` names none, so it is refused here: with it, the mind's code could mail itself a
 *  code and be a member. */
export const memberByConfig = (
  config: { domain: string; login: { allow: readonly EmailRule[] } },
  email: string,
) => !atMindsDomain(config.domain, email) && emailAllowed(config.login.allow, email);

/** Whether `rules` admit `email`: one of them matches (no `deny` rule). */
export function emailAllowed(rules: readonly EmailRule[], email: string): boolean {
  const address = email.trim().toLowerCase();
  // the address with its subaddress (`+tag` before the `@`) removed, for a rule that admits them
  const bare = address.replace(/\+[^@]*@/, "@");
  return rules.some(
    (rule) =>
      "everyone" in rule ||
      ("email" in rule
        ? rule.email === address || (rule.subaddresses === true && rule.email === bare)
        : address.split("@")[1] === rule.emailDomain),
  );
}

/** An owner is a member an `email` rule of `login.allow` names, by the exact address: the people a
 *  deploy lets in, so the only ones who let another member in again. */
export const isOwner = (login: Pick<AuthSettings["login"], "allow">, email: string) =>
  login.allow.some((rule) => "email" in rule && rule.email === email);

/** THE FIRST OWNER'S TICKET (./first-owner.ts), the Worker's `FIRST_OWNER_TICKET` variable: a deploy
 *  run makes a random ticket for the owner it deploys for and binds its hash alone. It signs that
 *  owner in once, to add a passkey: the first one, or a new one when every passkey is lost. */
export const FirstOwnerTicket = z.strictObject({
  email: z.string().trim().toLowerCase(),
  /** The SHA-256 of the ticket's text, in lowercase hex. */
  hash: z.string().regex(/^[0-9a-f]{64}$/, "expected a SHA-256 in lowercase hex"),
  /** Epoch ms. */
  expires: z.number().int().positive(),
});
export type FirstOwnerTicket = z.infer<typeof FirstOwnerTicket>;

export const FIRST_OWNER_TICKET_MS = 24 * 3600_000;
/** The page a ticket opens: the first owner's (./first-owner.ts), and a member's link from an owner
 *  (./members.ts `memberLink`). */
export const FIRST_OWNER_PATH = "/keys/first";

/** The ticket in `text`, or why auth refuses it: its address must be one an `email` rule of
 *  `login.allow` names, and it ends at most 24 hours from `now`. */
export function firstOwnerTicketOf(
  text: string,
  settings: Pick<AuthSettings, "login">,
  now = Date.now(),
): FirstOwnerTicket | { refused: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { refused: "the first owner's ticket is not JSON" };
  }
  const parsed = FirstOwnerTicket.safeParse(value);
  if (!parsed.success)
    return { refused: "the first owner's ticket is not { email, hash, expires }" };
  const ticket = parsed.data;
  if (!isOwner(settings.login, ticket.email))
    return { refused: "the first owner's ticket is for an address login.allow does not name" };
  if (ticket.expires > now + FIRST_OWNER_TICKET_MS)
    return { refused: "the first owner's ticket ends more than 24 hours from now" };
  return ticket;
}

/** The Worker's `AUTH_SETTINGS` variable: the config's `auth`, and `provide` when the mind is
 *  provided, so that `/provide` is a resource. */
const AuthVariable = AuthSettings.extend({ provide: z.literal(true).optional() });

/** The config of the Worker on `domain` with `settings` (`AUTH_SETTINGS`), or a throw that names
 *  what auth refuses. */
export function authConfigOf(domain: string, settings: unknown): AuthConfig {
  const { provide, ...rest } = AuthVariable.parse(settings);
  return AuthConfig.parse({
    ...rest,
    domain,
    resources: [
      mindApiUrlOf(domain),
      mindMcpUrlOf(domain),
      ...(provide ? [mindProvideUrlOf(domain)] : []),
    ],
  });
}
