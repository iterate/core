import { z } from "zod";

/** The platform's OAuth scopes — what an app may ask for and what a consent grants:
 *   - `iterate`             — reach the minds the person grants (implied: a request that names
 *                             no scope, or any set but `identity` alone, asks for it)
 *   - `identity`            — who the person is, and no mind: an app for people who are not
 *                             its mind's members (core/boundary-worker/src/mind-host-sign-in.ts). Asked for
 *                             alone; beside `iterate` it is dropped, since every grant says who
 *                             the person is
 *   - `account`             — manage the person's sessions and personal access tokens
 *   - `organizations:write` — the person's organizations: list every one they belong to, create new ones
 *   - `admin`               — operate the platform: every mind and person
 *  A mind's auth Worker grants `iterate` or `identity` alone (core/auth-worker/src/oauth.ts
 *  `grantedScopes`).
 *  Consent is task-based (the shape Cloudflare's own OAuth consent took in August 2026: a client
 *  requests a set, the person may deselect the optional ones, the token carries what was granted):
 *  `iterate` is required, every other requested scope is optional on the consent page (`identity`
 *  alone has the identity card instead), and an app reads the granted set from
 *  `session.info().scopes` rather than assuming its request. */
export const OAuthScope = z.enum([
  "iterate",
  "identity",
  "account",
  "organizations:write",
  "admin",
]);
export type OAuthScope = z.infer<typeof OAuthScope>;

/** A requested set as it is granted: `identity` alone stays `identity`, and any other set gets
 *  `iterate` and loses `identity`. `identity` beside another scope but `iterate` would be a power
 *  over no mind, and is refused. */
export const OAuthScopes = z
  .array(OAuthScope)
  .transform((scopes) =>
    scopes.includes("identity") && !scopes.includes("iterate")
      ? [...new Set(scopes)]
      : [...new Set(["iterate", ...scopes])].filter((scope) => scope !== "identity"),
  )
  .refine((scopes) => !scopes.includes("identity") || scopes.length === 1, {
    message: "`identity` is asked for alone, or beside `iterate`.",
  });

/** A requested scope as the consent page shows it: its name, what it means to the person, and
 *  whether they may untick it (`iterate` never). */
export interface ConsentScope {
  name: OAuthScope;
  title: string;
  note: string;
  required: boolean;
}

/** What each scope means to the person — the consent page's copy, sent with `consent.describe` so
 *  the page renders what it is given: a scope added to `OAuthScope` is described here or it does
 *  not compile. */
export const OAuthScopeDescriptions: Record<OAuthScope, Omit<ConsentScope, "name">> = {
  iterate: {
    title: "Read and make changes in the minds you grant it",
    note: "Required — what the app is for.",
    required: true,
  },
  identity: {
    title: "Learn who you are: your email, and nothing else",
    note: "Required — what the app is for.",
    required: true,
  },
  account: {
    title: "See and end your sessions, and mint personal access tokens",
    note: "Optional.",
    required: false,
  },
  "organizations:write": {
    title: "See all your organizations and create new ones",
    note: "Optional.",
    required: false,
  },
  admin: {
    title: "Operate this platform: every mind and every person",
    note: "Optional. For platform admins; ends 12 hours after you allow it.",
    required: false,
  },
};
