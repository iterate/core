import type { SecretDescription } from "iterate/workers";
import { expect, test } from "vitest";
import {
  boundCloudflareTokenOf,
  CLOUDFLARE_TOKEN_EDITION,
  CLOUDFLARE_TOKEN_SECRET,
  keepCloudflareToken,
} from "./cloudflare-token.ts";

const bound = { token: "the token's value", tokenId: "token-2" };

test("a stack with a token and a vault with none: the token is stored, pinned to Cloudflare's two origins, its id public", async () => {
  const vault = vaultWith({ set: false });
  expect(await keepCloudflareToken(vault, bound)).toEqual({
    path: CLOUDFLARE_TOKEN_SECRET,
    outcome: "set",
  });
  expect(vault).toMatchObject({
    wrote: [
      {
        set: "/secrets/cloudflare",
        material: { token: "the token's value", tokenId: "token-2" },
        options: {
          urls: ["https://mcp.cloudflare.com", "https://api.cloudflare.com"],
          public: ["tokenId"],
        },
      },
    ],
  });
});

test("the vault holds this very token: nothing is written", async () => {
  const vault = vaultWith({ set: true, public: { tokenId: "token-2" } });
  expect(await keepCloudflareToken(vault, bound)).toMatchObject({ outcome: "unchanged" });
  expect(vault).toMatchObject({ wrote: [] });
});

test("the vault holds an earlier token of the stack: the stack's token of now takes its place", async () => {
  const vault = vaultWith({ set: true, public: { tokenId: "token-1" } });
  expect(await keepCloudflareToken(vault, bound)).toMatchObject({ outcome: "set" });
  expect(vault).toMatchObject({ wrote: [{ set: "/secrets/cloudflare", material: bound }] });
});

test("a secret that somebody else put at the path has no token id of the stack: it is left as it is", async () => {
  for (const described of [{ set: true }, { set: true, public: { clientId: "theirs" } }]) {
    const vault = vaultWith(described);
    expect(await keepCloudflareToken(vault, bound)).toMatchObject({ outcome: "unchanged" });
    expect(await keepCloudflareToken(vault, undefined)).toMatchObject({ outcome: "unchanged" });
    expect(vault).toMatchObject({ wrote: [] });
  }
});

test("a stack with no token any more: the token that the stack stored is deleted", async () => {
  const vault = vaultWith({ set: true, public: { tokenId: "token-2" } });
  expect(await keepCloudflareToken(vault, undefined)).toEqual({
    path: CLOUDFLARE_TOKEN_SECRET,
    outcome: "deleted",
  });
  expect(vault).toMatchObject({ wrote: [{ delete: "/secrets/cloudflare" }] });
});

test("a stack with no token and a vault with none: nothing is written", async () => {
  const vault = vaultWith({ set: false });
  expect(await keepCloudflareToken(vault, undefined)).toMatchObject({ outcome: "unchanged" });
  expect(vault).toMatchObject({ wrote: [] });
});

test("the stack's token is the bound one only when it is of this release's edition", () => {
  const env = { CLOUDFLARE_TOKEN: "the token's value", CLOUDFLARE_TOKEN_ID: "token-2" };
  const edition = String(CLOUDFLARE_TOKEN_EDITION);
  expect(boundCloudflareTokenOf({ ...env, CLOUDFLARE_TOKEN_EDITION: edition })).toEqual(bound);
  // an older list, which may do more; a stack of an older release, which says no edition
  expect(boundCloudflareTokenOf({ ...env, CLOUDFLARE_TOKEN_EDITION: "2" })).toBeUndefined();
  expect(boundCloudflareTokenOf({ ...env, CLOUDFLARE_TOKEN_EDITION: "1" })).toBeUndefined();
  expect(boundCloudflareTokenOf(env)).toBeUndefined();
  // a stack with no token
  expect(boundCloudflareTokenOf({ CLOUDFLARE_TOKEN_EDITION: edition })).toBeUndefined();
});

test.for([
  { stored: "the same token, which an earlier release stored", tokenId: "token-2" },
  { stored: "an earlier token of the stack", tokenId: "token-1" },
])(
  "a token of an older list that a deploy could not change is not kept, and $stored is deleted from the vault",
  async ({ tokenId }) => {
    const older = boundCloudflareTokenOf({
      CLOUDFLARE_TOKEN: "the wide token's value",
      CLOUDFLARE_TOKEN_ID: "token-2",
      CLOUDFLARE_TOKEN_EDITION: "2",
    });
    const vault = vaultWith({ set: true, public: { tokenId } });
    expect(await keepCloudflareToken(vault, older)).toMatchObject({ outcome: "deleted" });
    expect(vault).toMatchObject({ wrote: [{ delete: "/secrets/cloudflare" }] });
    // and a vault with none gets none
    const empty = vaultWith({ set: false });
    expect(await keepCloudflareToken(empty, older)).toMatchObject({ outcome: "unchanged" });
    expect(empty).toMatchObject({ wrote: [] });
  },
);

/** A vault that holds `/secrets/cloudflare` as described, and records what it is asked to write. */
function vaultWith(described: Omit<SecretDescription, "path">) {
  const wrote: unknown[] = [];
  return {
    wrote,
    describe: async (path: string) => ({ path, ...described }),
    set: async (path: string, material: unknown, options: unknown) =>
      void wrote.push({ set: path, material, options }),
    delete: async (path: string) => void wrote.push({ delete: path }),
  };
}
