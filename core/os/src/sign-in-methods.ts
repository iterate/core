// sign-in-methods.ts — WHAT THE SIGN-IN PAGE SHOWS, a function of the config alone:
// `login.methods` in its key order (iterate-config.ts keeps the order it was written in), and
// `login.adminIssuer`'s link after them. The password and the mailed code share one email form,
// placed where the first of them is written; every other method is a link that starts its
// sign-in. routes/login.tsx renders the list and wires no method of its own.
import { INTEGRATION_PROVIDER_NAMES } from "iterate/api";
import { ADMIN_SIGN_IN_PATH } from "./admin-sign-in.ts";
import { CLOUDFLARE_ACCESS_SIGN_IN_PATH } from "./cloudflare-access-sign-in.ts";
import type { SignInProvider } from "./components/login/providers.ts";
import type { IterateConfig } from "./iterate-config.ts";

/** One thing the page shows: the email form (a password, a mailed code, or both), or a link. */
export type SignInMethodView =
  | { kind: "email"; password: boolean; code: boolean }
  | ({ kind: "link" } & SignInProvider);

/** The page's ways in, in order. `mail` says whether the mailed code can be sent (the `EMAIL`
 *  binding); `next` is where a sign-in lands. A Cloudflare Access method its deploy has not set
 *  up yet is left out: nobody could use it. */
export function signInMethodsOf(
  config: Pick<IterateConfig, "login">,
  { next, mail }: { next: string; mail: boolean },
): SignInMethodView[] {
  const query = new URLSearchParams({ next });
  const views: SignInMethodView[] = [];
  let form: Extract<SignInMethodView, { kind: "email" }> | undefined;
  const link = (key: string, name: string, href: string, logo: string) =>
    views.push({ kind: "link", key, name, href, logo });
  for (const [name, method] of Object.entries(config.login.methods)) {
    if (!method) continue;
    if (name === "password" || (name === "emailCode" && mail)) {
      if (!form) views.push((form = { kind: "email", password: false, code: false }));
      if (name === "password") form.password = true;
      else form.code = true;
    } else if (name === "cloudflareAccess")
      link(
        "cloudflare-access",
        "email (Cloudflare Access)",
        `${CLOUDFLARE_ACCESS_SIGN_IN_PATH}?${query}`,
        "/cloudflare-logo.svg",
      );
    else if (name === "google")
      link(
        "google",
        INTEGRATION_PROVIDER_NAMES.google,
        `/.auth/identity?${query}`,
        "/google-logo.svg",
      );
    else if (name === "github")
      link(
        "github",
        INTEGRATION_PROVIDER_NAMES.github,
        `/.auth/identity/github?${query}`,
        "/github-logo.svg",
      );
    else if (name === "cloudflare")
      link(
        "cloudflare",
        INTEGRATION_PROVIDER_NAMES.cloudflare,
        `/.auth/identity/cloudflare?${query}`,
        "/cloudflare-logo.svg",
      );
  }
  // an admin through another issuer (admin-sign-in.ts): prd, on a preview
  if (config.login.adminIssuer) {
    const host = new URL(config.login.adminIssuer).host;
    link(host, host, `${ADMIN_SIGN_IN_PATH}?${query}`, "/iterate-logo.svg");
  }
  return views;
}
