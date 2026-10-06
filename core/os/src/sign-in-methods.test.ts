// sign-in-methods.test.ts — the sign-in page as a function of `login.methods`: the methods in the
// order they were written, the password and the mailed code as one form, the links in place.
import { expect, test, vi } from "vitest";
import { parseIterateConfigInput, type IterateConfigInput } from "./iterate-config.ts";
import { signInMethodsOf } from "./sign-in-methods.ts";

test("the methods show in the order they were written; the password and the code share one form, where the first of them is", () => {
  expect(
    methodsOf({
      github: {},
      emailCode: { from: "iterate <login@acme.test>" },
      google: {},
      password: { password: "p" },
    }).map((method) => (method.kind === "link" ? method.key : method)),
  ).toEqual(["github", { kind: "email", password: true, code: true }, "google"]);
});

test("Cloudflare Access alone is one link, which /login goes straight to", () => {
  expect(
    methodsOf({
      cloudflareAccess: { teamDomain: "https://acme.cloudflareaccess.com", aud: "aud-1" },
    }),
  ).toEqual([
    {
      kind: "link",
      key: "cloudflare-access",
      name: "email (Cloudflare Access)",
      href: "/.auth/identity/cloudflare-access?next=%2Fprojects",
      logo: "/cloudflare-logo.svg",
    },
  ]);
});

const methodsOf = (methods: IterateConfigInput["login"]["methods"]) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const config = parseIterateConfigInput({
    secretsEncryption: { key: "k" },
    integrations: {
      google: { oauthClientId: "g", oauthClientSecret: "g-secret" },
      github: {
        appId: "1",
        appSlug: "app",
        oauthClientId: "gh",
        oauthClientSecret: "gh-secret",
        privateKey: "key",
        webhookSecret: "hook",
      },
    },
    login: { methods, allow: [{ everyone: {} }] },
  });
  return signInMethodsOf(config, { next: "/projects", mail: true });
};
