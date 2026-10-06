// Best-effort heuristics for proposing human-friendly names during
// onboarding. They only need to produce a plausible first draft that the user
// can edit — improve freely.

import { TEST_EMAIL_DOMAIN } from "./test-email-domain.ts";

/** Email domains that say nothing about the user's team: the providers anyone has an address at,
 *  then our own. */
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "hey.com",
  "fastmail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "yandex.com",
  "zoho.com",
  // Most sign-ins in dev and on a preview come from these two. A project's slug follows the
  // suggestion and is one project across the deployment, so a name they all share is one only the
  // first of them can take.
  "nustom.com",
  TEST_EMAIL_DOMAIN,
]);

/**
 * Proposes an organization name for first-run onboarding: the OAuth display
 * name as the provider gave it ("Jonas Templestein"), or the email-only
 * heuristic when there is none.
 */
export function suggestOrganizationName(input: { name?: string | null; email?: string | null }) {
  return input.name?.trim() || suggestOrganizationNameFromEmail(input.email || "");
}

/**
 * Proposes an organization name from an email address: the company domain's
 * first label when the domain looks like a company ("ada@acme.com" →
 * "Acme"), otherwise the local part ("jane.doe+work@gmail.com" → "Jane
 * Doe"). Returns "" when nothing sensible can be derived.
 */
export function suggestOrganizationNameFromEmail(email: string): string {
  const [rawLocalPart, rawDomain] = email.trim().toLowerCase().split("@");
  if (!rawLocalPart || !rawDomain) return "";

  if (!GENERIC_EMAIL_DOMAINS.has(rawDomain)) {
    return titleCaseWords(rawDomain.split(".")[0] || "");
  }

  return titleCaseWords(rawLocalPart.split("+")[0] || "");
}

function titleCaseWords(value: string): string {
  return value
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}
