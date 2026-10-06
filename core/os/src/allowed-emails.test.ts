// allowed-emails.test.ts — who may sign in: `login.allow` and `login.deny`, rules that mirror
// Cloudflare Access's, with Access's semantics.
import { expect, test } from "vitest";
import { emailAllowed, type EmailRule } from "./allowed-emails.ts";

const ACME: EmailRule = { emailDomain: "acme.test" };

test.for<{ name: string; allow: EmailRule[]; deny?: EmailRule[]; email: string; allowed: boolean }>(
  [
    {
      name: "a domain rule admits its domain",
      allow: [ACME],
      email: "jo@acme.test",
      allowed: true,
    },
    { name: "whatever the case", allow: [ACME], email: " Jo@ACME.test ", allowed: true },
    { name: "but not a subdomain", allow: [ACME], email: "jo@sub.acme.test", allowed: false },
    {
      name: "an address rule admits that address alone",
      allow: [{ email: "friend@example.org" }],
      email: "other@example.org",
      allowed: false,
    },
    { name: "everyone admits anyone", allow: [{ everyone: {} }], email: "x@y.dev", allowed: true },
    {
      name: "a deny rule wins over an allow rule",
      allow: [ACME],
      deny: [{ email: "fired@acme.test" }],
      email: "fired@acme.test",
      allowed: false,
    },
  ],
)("$name", ({ allow, deny, email, allowed }) => {
  expect(emailAllowed({ allow, deny }, email)).toBe(allowed);
});
