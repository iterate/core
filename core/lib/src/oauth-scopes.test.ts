import { expect, test } from "vitest";
import { OAuthScopes } from "./oauth-scopes.ts";

// A request's scopes as they are granted: no scope means `iterate` (MCP clients send none), and
// `identity` alone means who the person is and no project.
test.for<{ requested: string[]; granted: string[] | "refused" }>([
  { requested: [], granted: ["iterate"] },
  { requested: ["account"], granted: ["iterate", "account"] },
  { requested: ["identity"], granted: ["identity"] },
  { requested: ["identity", "identity"], granted: ["identity"] },
  { requested: ["identity", "iterate"], granted: ["iterate"] },
  { requested: ["identity", "iterate", "account"], granted: ["iterate", "account"] },
  { requested: ["identity", "account"], granted: "refused" },
  { requested: ["projects"], granted: "refused" },
])("$requested → $granted", ({ requested, granted }) => {
  const parsed = OAuthScopes.safeParse(requested);
  expect(parsed.success ? parsed.data : "refused").toEqual(granted);
});
