import { expect, test } from "vitest";
import { CLOUDFLARE_READ_SCOPES, CLOUDFLARE_READS_LEFT_OUT } from "./api.ts";

// `CLOUDFLARE_READ_SCOPES` matches Cloudflare MCP's full "Read only" template (every read, no
// write) so the Cloudflare consent page presents standard read-only access.
const READ = /\.(read|metadata_read|monitoring|report)$/;

test("the Cloudflare scopes are reads alone, each named once", () => {
  for (const scope of CLOUDFLARE_READ_SCOPES) expect(scope).toMatch(READ);
  expect([...new Set(CLOUDFLARE_READ_SCOPES)]).toHaveLength(CLOUDFLARE_READ_SCOPES.length);
  // no write or edit by another name
  for (const scope of CLOUDFLARE_READ_SCOPES) expect(scope).not.toMatch(/write|edit|admin/);
});

test("the list matches the server's full 199-scope 'Read only' template", () => {
  // the template of github.com/cloudflare/mcp at 19f7601: 199 reads, beside the three scopes the
  // server adds to every grant
  expect(Object.keys(CLOUDFLARE_READS_LEFT_OUT)).toEqual([]);
  expect(CLOUDFLARE_READ_SCOPES).toHaveLength(199);
  expect(CLOUDFLARE_READ_SCOPES.toSorted()).toEqual([...CLOUDFLARE_READ_SCOPES]);
  // what the mind's own guides read is in it, alongside the rest of the Read-only template
  expect(CLOUDFLARE_READ_SCOPES).toEqual(
    expect.arrayContaining([
      "user-details.read",
      "workers-scripts.read",
      "workers-observability.read",
      "workers-routes.read",
      "workers-tail.read",
      "zone.read",
      "dns.read",
      "d1.metadata_read",
      "d1.read",
      "logs.read",
      "workers-kv-storage.read",
      "workers-r2.read",
      "secrets-store.read",
    ]),
  );
});
