// ── who may sign in ── `login.allow` and `login.deny` (iterate-config.ts), rules that mirror
// Cloudflare Access's policy rules: an address, a domain (exactly, not its subdomains), or
// everyone. Checked at each sign-in, one through Cloudflare Access too
// (cloudflare-access-sign-in.ts), and at every grant's admission and refresh (oauth.ts).
import { dnsName } from "iterate/app-config";
import { z } from "zod";

/** One rule, as Cloudflare Access names it but in camelCase; values lowercased. */
export const EmailRule = z.union(
  [
    z.strictObject({
      email: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[^@\s]+@[^@\s]+$/, "expected an email address"),
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

/** Whether `rules` admit `email`: some `allow` rule matches and no `deny` rule does, as an Access
 *  policy's `include` and `exclude` decide. */
export function emailAllowed(
  rules: { allow: readonly EmailRule[]; deny?: readonly EmailRule[] },
  email: string,
): boolean {
  const address = email.trim().toLowerCase();
  const matches = (rule: EmailRule) =>
    "everyone" in rule ||
    ("email" in rule ? rule.email === address : address.split("@")[1] === rule.emailDomain);
  return rules.allow.some(matches) && !(rules.deny || []).some(matches);
}

/** What a refused person reads on the sign-in page. */
export const EMAIL_NOT_ALLOWED_MESSAGE = "That email can't sign in here.";
