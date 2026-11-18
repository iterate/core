import { expect, test } from "vitest";
import { defineItxHost } from "../host.ts";
import { buildIdentityRoots } from "./built-ins.ts";

const MIND_ID = "a".repeat(64);
defineItxHost({ firstPartyFacets: {}, mindSlug: "iterate.example.com", mindId: MIND_ID });

test("whoami answers the mind's id, which stays when the hostname changes, beside the hostname that people read", async () => {
  const loadedCode = buildIdentityRoots({
    path: "/agents/ada",
    caller: () => ({ principal: null }),
  });
  // `toEqual`: no field more, and no principal for code that calls as itself
  expect(await loadedCode.whoami()).toEqual({
    path: "/agents/ada",
    mindId: MIND_ID,
    mindSlug: "iterate.example.com",
  });
  const member = buildIdentityRoots({
    path: "/",
    caller: () => ({ principal: { actor: "user_ada", email: "ada@example.org" } }),
  });
  expect(await member.whoami()).toEqual({
    path: "/",
    mindId: MIND_ID,
    mindSlug: "iterate.example.com",
    principal: { actor: "user_ada", email: "ada@example.org" },
  });
});
