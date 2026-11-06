// login.server.test.ts — what the sign-in page does for a signed-out browser, as a function of the
// config: with one way in that is a link, it sends the browser straight there.
import { expect, test } from "vitest";
import type { Env } from "./env.ts";
import { loginSearchOf } from "./login-search.ts";
import { loginState } from "./login.server.ts";

const PR123 = "https://pr123-os.iterate-dev-preview.workers.dev";

test.for([
  {
    name: "log in with iterate as the only way in: straight to its deep link",
    methods: { ITERATE__LOGIN__METHODS__ITERATE__ISSUER: "https://os.iterate.com" },
    search: { next: "/projects" },
    straightTo: "/.auth/sign-in/iterate?next=%2Fprojects",
  },
  {
    name: "beside the password: the page, offering both",
    methods: {
      ITERATE__LOGIN__METHODS__ITERATE__ISSUER: "https://os.iterate.com",
      ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD: "password",
    },
    search: { next: "/projects" },
    straightTo: null,
  },
  {
    name: "alone, but back after a refusal: the page, saying why",
    methods: { ITERATE__LOGIN__METHODS__ITERATE__ISSUER: "https://os.iterate.com" },
    search: { next: "/projects", error: "eve@elsewhere.test may not sign in here." },
    straightTo: null,
  },
  {
    name: "alone, naming this very origin (a blank urls.os learns it per request): the page",
    methods: { ITERATE__LOGIN__METHODS__ITERATE__ISSUER: PR123, ITERATE__URLS__OS: "" },
    search: { next: "/projects" },
    straightTo: null,
  },
])("$name", async ({ methods, search, straightTo }) => {
  const env = {
    ITERATE__SECRETS_ENCRYPTION__KEY: "secrets-key",
    ITERATE__LOGIN__ALLOW: '[{"everyone":{}}]',
    ITERATE__URLS__OS: PR123,
    ...methods,
  } as unknown as Env;
  const state = await loginState(new Request(`${PR123}/login`), env, loginSearchOf(search));
  expect(state).toMatchObject({ signedInAs: null, straightTo });
});
