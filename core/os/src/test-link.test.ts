// test-link.test.ts — a PR deployment's one-click link (test-link.ts) as a table of what the
// redeeming deployment decides: the token's refusals, then where a `next` may and may not go. That
// iterate-config.ts refuses the config off a preview, and prd has no route, is worker.test.ts's.

import { expect, test } from "vitest";
import { redeemTestLink, testLinkToken } from "./test-link.ts";

const KEY = "preview-secrets-key";
const PR123 = "https://pr123-aaaaaaa-os.iterate-dev-preview.workers.dev";
const AGENTS = "https://pr123-aaaaaaa-agents.iterate-dev-preview.workers.dev";

test("a deployment's own token is good, and with no next lands on the issuer's /login", async () => {
  expect(await redeem(await testLinkToken(PR123, KEY))).toEqual({ next: `${PR123}/login` });
});

test.for<[string, () => Promise<string | null>]>([
  ["no token", async () => null],
  ["an empty token", async () => ""],
  ["not a token", async () => "a+b.c/d"],
  [
    "a flipped byte",
    async () => {
      const token = await testLinkToken(PR123, KEY);
      return `${token.slice(0, -2)}${token.at(-2) === "A" ? "B" : "A"}${token.at(-1)}`;
    },
  ],
  ["another key's", () => testLinkToken(PR123, "prd-secrets-key")],
  [
    "another deployment's: every preview shares the key, not the origin",
    () => testLinkToken("https://pr124-aaaaaaa-os.iterate-dev-preview.workers.dev", KEY),
  ],
  [
    "this PR's previous deployment's: a token ends with its deployment",
    () => testLinkToken("https://pr123-bbbbbbb-os.iterate-dev-preview.workers.dev", KEY),
  ],
])("%s is refused", async ([, token]) => {
  expect(await redeem(await token())).toEqual({
    refused: "This sign-in link is not for this deployment.",
  });
});

test.for<[string, string, string]>([
  ["a path on the platform", "/projects/pr123/notes", `${PR123}/projects/pr123/notes`],
  ["a page of the platform", `${PR123}/login`, `${PR123}/login`],
  ["an app's sign-in", `${AGENTS}/.auth/login?next=%2F`, `${AGENTS}/.auth/login?next=%2F`],
  [
    "a deep link to one agent, its query kept",
    `${AGENTS}/projects/pr123?agent=/agents/showcase`,
    `${AGENTS}/projects/pr123?agent=/agents/showcase`,
  ],
])("next: %s is followed", async ([, next, lands]) => {
  expect(await redeem(await testLinkToken(PR123, KEY), next)).toEqual({ next: lands });
});

// The token does not sign `next`, so a link anyone edits must still never leave the deployment's
// parent host. That includes a foreign Worker on workers.dev itself.
test.for<[string, string]>([
  ["a foreign site", "https://evil.example/"],
  ["a foreign Worker on workers.dev", "https://evil.attacker.workers.dev/"],
  ["protocol-relative", "//evil.example/x"],
  ["backslashes the URL parser reads as slashes", "/\\evil.example/x"],
  ["the deployment's parent host as a prefix", `${AGENTS}.evil.example/`],
  ["a host under an app's", `https://evil.pr123-aaaaaaa-agents.iterate-dev-preview.workers.dev/`],
  ["http to an app", AGENTS.replace("https:", "http:")],
  ["a javascript: URL", "javascript:alert(1)"],
  ["a blob: URL made on the platform", `blob:${PR123}/0f3c`],
  ["not a URL", "https://"],
])("next: %s is refused", async ([, next]) => {
  expect(await redeem(await testLinkToken(PR123, KEY), next)).toEqual({
    refused: "This sign-in link leads somewhere this deployment does not send people.",
  });
});

test("a good next does not rescue a bad token", async () => {
  expect(await redeem("wrong", `${AGENTS}/`)).toEqual({
    refused: "This sign-in link is not for this deployment.",
  });
});

/** What the deployment at `PR123` decides for a link's `t` and `next`. */
function redeem(token: string | null, next: string | null = null) {
  return redeemTestLink({ token, next, platformOrigin: PR123, key: KEY });
}
