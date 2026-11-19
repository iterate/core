import { expect, test } from "vitest";
import { CLOUDFLARE_READ_SCOPES, CLOUDFLARE_READS_LEFT_OUT } from "./api.ts";

// THE RULE of a mind's Cloudflare connection, the owner's own (19 Nov 2026, 10:31 UTC): "we
// basically want the cloudflare connection to be able to read ANYTHING EXCEPT THE SECRET
// ENCRYPTION KEY". So: every read, and no write; and no read by which a holder could come to act
// as the mind or as a member (CLOUDFLARE_READS_LEFT_OUT, each with its reason).
const READ = /\.(read|metadata_read|monitoring|report)$/;

test("the Cloudflare scopes are reads alone, each named once", () => {
  for (const scope of CLOUDFLARE_READ_SCOPES) expect(scope).toMatch(READ);
  expect([...new Set(CLOUDFLARE_READ_SCOPES)]).toHaveLength(CLOUDFLARE_READ_SCOPES.length);
  // no write or edit by another name
  for (const scope of CLOUDFLARE_READ_SCOPES) expect(scope).not.toMatch(/write|edit|admin/);
});

test("the reads left out: a closed list, each with its reason, and none of them asked for", () => {
  const scopes: readonly string[] = CLOUDFLARE_READ_SCOPES;
  expect(Object.keys(CLOUDFLARE_READS_LEFT_OUT).toSorted()).toEqual([
    "d1.read",
    "logs.read",
    "workers-tail.read",
  ]);
  for (const [scope, reason] of Object.entries(CLOUDFLARE_READS_LEFT_OUT)) {
    expect(scopes).not.toContain(scope);
    expect(reason.length).toBeGreaterThan(40);
  }
});

test("the list is the server's 'Read only' template, less the reads left out", () => {
  // the template of github.com/cloudflare/mcp at 19f7601: 199 reads, beside the three scopes the
  // server adds to every grant
  const template = CLOUDFLARE_READ_SCOPES.length + Object.keys(CLOUDFLARE_READS_LEFT_OUT).length;
  expect(template).toBe(199);
  expect(CLOUDFLARE_READ_SCOPES.toSorted()).toEqual([...CLOUDFLARE_READ_SCOPES]);
  // what the mind's own guides read is in it
  expect(CLOUDFLARE_READ_SCOPES).toEqual(
    expect.arrayContaining([
      "user-details.read",
      "workers-scripts.read",
      "workers-observability.read",
      "workers-routes.read",
      "zone.read",
      "dns.read",
      "d1.metadata_read",
      "workers-kv-storage.read",
      "workers-r2.read",
      "secrets-store.read",
    ]),
  );
});
