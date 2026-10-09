// cloudflare-access.ts — THE ACCESS APPLICATION `login.methods.cloudflareAccess` signs in through
// (src/cloudflare-access-sign-in.ts), made by `pnpm run deploy` with no dashboard step: the
// account's Zero Trust organization (made if the account has none and Cloudflare allows it), a
// one-time PIN identity provider (Access mails the PIN itself, so no mail domain is needed), and a
// self-hosted application on `<host>/.auth/identity/cloudflare-access` alone, whose policy is the
// config's `login.allow` and `login.deny`, rule for rule. The Worker needs back the team's origin
// and the application's audience tag.
import { z } from "zod";
import type { EmailRule } from "../src/allowed-emails.ts";
import type { IterateConfig } from "../src/iterate-config.ts";
import { resourceNamesOf } from "../src/iterate-config.ts";

/** `cf` with `args`, its JSON answer; a failure throws. The deploy's own `cf`, credentials set. */
export type Cf = (args: string[]) => unknown;

/** `login.allow` and `login.deny` as the Access policy's `include` and `exclude`, one rule for
 *  one rule, as Cloudflare's API names them. */
export function accessPolicyOf(login: Pick<IterateConfig["login"], "allow" | "deny">) {
  const accessRule = (rule: EmailRule) =>
    "everyone" in rule
      ? { everyone: {} }
      : "email" in rule
        ? { email: { email: rule.email } }
        : { email_domain: { domain: rule.emailDomain } };
  return { include: login.allow.map(accessRule), exclude: (login.deny || []).map(accessRule) };
}

/** The Access application, as `cf` creates or updates it: the sign-in path on `host` alone,
 *  one-time PIN only, straight to it, its cookie on that path alone. */
export function accessApplicationOf(input: {
  worker: string;
  host: string;
  identityProviderId: string;
  policy: ReturnType<typeof accessPolicyOf>;
}) {
  const uri = `${input.host}/.auth/identity/cloudflare-access`;
  return {
    name: `iterate ${input.worker} sign-in`,
    type: "self_hosted",
    domain: uri,
    destinations: [{ type: "public", uri }],
    allowed_idps: [input.identityProviderId],
    auto_redirect_to_identity: true,
    // the CF_Authorization cookie goes to the sign-in path alone, never to a project's pages
    path_cookie_attribute: true,
    app_launcher_visible: false,
    session_duration: "24h",
    policies: [{ name: "iterate sign-in", decision: "allow", ...input.policy }],
  };
}

const Organization = z.object({ auth_domain: z.string().min(1) });
const Worker = z.object({
  name: z.string(),
  subdomain: z.object({ url: z.string() }).partial().optional(),
});

/** `worker`'s host on the account's workers.dev subdomain. `cf` has no command for the subdomain
 *  itself, so it is read off a Worker the account already serves there (`<name>.<subdomain>.workers.dev`). */
function workersDevHostOf(worker: string, cf: Cf, accountId: string) {
  for (const { name, subdomain } of z.array(Worker).parse(cf(["workers", "list"]))) {
    const host = subdomain?.url ? new URL(subdomain.url).host : "";
    if (host.startsWith(`${name}.`)) return `${worker}.${host.slice(name.length + 1)}`;
  }
  throw new Error(
    `login.methods.cloudflareAccess: the account has no Worker on its workers.dev subdomain yet, so the sign-in's host is unknown. Pick the subdomain at https://dash.cloudflare.com/${accountId}/workers-and-pages (create any Worker there, such as Hello World), or set urls.os, and deploy again.`,
  );
}
const IdentityProvider = z.object({ id: z.string(), type: z.string() });
const Application = z.object({ id: z.string(), name: z.string(), aud: z.string() });

/** Make or update the Access application, and answer what the Worker checks tokens against. A
 *  check changes nothing and answers placeholders. */
export function ensureCloudflareAccess(
  config: IterateConfig,
  cf: Cf,
  { check }: { check: boolean },
): { teamDomain: string; aud: string } {
  if (check) return { teamDomain: "https://unset.cloudflareaccess.com", aud: "unset" };
  const cloudflare = config.cloudflare!;
  const worker = resourceNamesOf(cloudflare).worker;
  let organization: z.infer<typeof Organization>;
  try {
    organization = Organization.parse(cf(["zero-trust", "organization", "get"]));
  } catch {
    // an account that never used Zero Trust: make its organization, as the dashboard does on its
    // first visit; Cloudflare may refuse until the free plan is chosen there once
    const team = `${cloudflare.resourcePrefix}-${crypto.randomUUID().slice(0, 6)}`;
    const body = JSON.stringify({ name: team, auth_domain: `${team}.cloudflareaccess.com` });
    try {
      organization = Organization.parse(
        cf(["zero-trust", "organization", "create", "--body", body]),
      );
    } catch (error) {
      throw new Error(
        `login.methods.cloudflareAccess: Cloudflare refused to make the account's Zero Trust organization. Turn Zero Trust on once (the free plan) at https://one.dash.cloudflare.com/${cloudflare.accountId}/ and deploy again.`,
        { cause: error },
      );
    }
  }
  const pin =
    z
      .array(IdentityProvider)
      .parse(cf(["zero-trust", "identity-providers", "list"]))
      .find((provider) => provider.type === "onetimepin") ||
    IdentityProvider.parse(
      cf([
        "zero-trust",
        "identity-providers",
        "create",
        "--body",
        JSON.stringify({ name: "One-time PIN", type: "onetimepin", config: {} }),
      ]),
    );
  const body = accessApplicationOf({
    worker,
    // urls.os's host, else the Worker's on the account's workers.dev subdomain
    host: config.urls.os
      ? new URL(config.urls.os).host
      : workersDevHostOf(worker, cf, cloudflare.accountId),
    identityProviderId: pin.id,
    policy: accessPolicyOf(config.login),
  });
  const existing = z
    .array(Application)
    .parse(cf(["zero-trust", "access", "applications", "list"]))
    .find((application) => application.name === body.name);
  const application = Application.parse(
    cf([
      "zero-trust",
      "access",
      "applications",
      ...(existing ? ["update", existing.id] : ["create"]),
      "--body",
      JSON.stringify(body),
    ]),
  );
  return { teamDomain: `https://${organization.auth_domain}`, aud: application.aud };
}
