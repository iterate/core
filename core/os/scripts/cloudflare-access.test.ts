// cloudflare-access.test.ts — the Access application the deploy makes for
// `login.methods.cloudflareAccess`: its policy, `login.allow` and `login.deny` rule for rule; what it
// guards; and the `cf` calls that make or update it.
import { expect, test } from "vitest";
import type { EmailRule } from "../src/allowed-emails.ts";
import { parseIterateConfigInput } from "../src/iterate-config.ts";
import {
  accessApplicationOf,
  accessPolicyOf,
  ensureCloudflareAccess,
} from "./cloudflare-access.ts";

test.for<{ rule: EmailRule; access: object }>([
  { rule: { email: "friend@example.org" }, access: { email: { email: "friend@example.org" } } },
  { rule: { emailDomain: "acme.test" }, access: { email_domain: { domain: "acme.test" } } },
  { rule: { everyone: {} }, access: { everyone: {} } },
])("the rule $rule is Access's $access, in include and in exclude", ({ rule, access }) => {
  expect(accessPolicyOf({ allow: [rule], deny: [rule] })).toEqual({
    include: [access],
    exclude: [access],
  });
});

test("the application guards the sign-in path alone, with the one-time PIN, its cookie on that path", () => {
  expect(
    accessApplicationOf({
      worker: "acme",
      host: "acme.example.workers.dev",
      identityProviderId: "pin-1",
      policy: { include: [{ email: { email: "owner@example.com" } }], exclude: [] },
    }),
  ).toMatchObject({
    name: "iterate acme sign-in",
    type: "self_hosted",
    domain: "acme.example.workers.dev/.auth/identity/cloudflare-access",
    destinations: [
      { type: "public", uri: "acme.example.workers.dev/.auth/identity/cloudflare-access" },
    ],
    allowed_idps: ["pin-1"],
    auto_redirect_to_identity: true,
    path_cookie_attribute: true,
    policies: [
      { decision: "allow", include: [{ email: { email: "owner@example.com" } }], exclude: [] },
    ],
  });
});

test.for<{ name: string; existing: object[]; command: string[] }>([
  { name: "a first deploy creates the application", existing: [], command: ["create"] },
  {
    name: "a later deploy updates the one it made, by name",
    existing: [{ id: "app-1", name: "iterate acme sign-in", aud: "aud-1" }],
    command: ["update", "app-1"],
  },
])("$name on the Worker's workers.dev host", ({ existing, command }) => {
  const calls: string[][] = [];
  const answers: Record<string, unknown> = {
    "zero-trust organization get": { auth_domain: "acme.cloudflareaccess.com" },
    "zero-trust identity-providers list": [{ id: "pin-1", type: "onetimepin" }],
    "workers subdomains get": { subdomain: "acme-sub" },
    "zero-trust access applications list": existing,
    [`zero-trust access applications ${command.join(" ")}`]: {
      id: "app-1",
      name: "iterate acme sign-in",
      aud: "aud-1",
    },
  };
  const cf = (args: string[]) => {
    calls.push(args);
    const key = Object.keys(answers).find((known) => args.join(" ").startsWith(known));
    if (!key) throw new Error(`unexpected cf ${args.join(" ")}`);
    return answers[key];
  };
  expect(ensureCloudflareAccess(CONFIG, cf, { check: false })).toEqual({
    teamDomain: "https://acme.cloudflareaccess.com",
    aud: "aud-1",
  });
  expect(JSON.parse(calls.at(-1)!.at(-1)!)).toMatchObject({
    domain: "acme.acme-sub.workers.dev/.auth/identity/cloudflare-access",
  });
});

test("a check calls no cf and answers placeholders", () => {
  expect(
    ensureCloudflareAccess(
      CONFIG,
      () => {
        throw new Error("a check called cf");
      },
      { check: true },
    ),
  ).toEqual({
    teamDomain: "https://unset.cloudflareaccess.com",
    aud: "unset",
  });
});

/** A self-host's config: workers.dev, projects as paths, who may sign in in login.allow. */
const CONFIG = parseIterateConfigInput({
  cloudflare: { accountId: "account-1", resourcePrefix: "acme" },
  secretsEncryption: { key: "k" },
  login: { methods: { cloudflareAccess: {} }, allow: [{ email: "owner@example.com" }] },
});
