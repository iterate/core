import type { SecretDescription } from "iterate/workers";
import { expect, test } from "vitest";
import { CLOUDFLARE_TOKEN_SECRET, keepCloudflareToken } from "./cloudflare-token.ts";

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
