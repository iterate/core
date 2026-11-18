import { expect, test } from "vitest";
import { CLOUDFLARE_OAUTH, CLOUDFLARE_READ_SCOPES } from "./api.ts";

// THE PROMISE of a mind's Cloudflare connection: the mind can read its own account (logs,
// errors, what is deployed) and can change nothing there. Every scope is a `.read` or a
// `.metadata_read`, and each is in the list for a need of debugging the mind's own stack.
test("the Cloudflare scopes are reads alone, each named once", () => {
  for (const scope of CLOUDFLARE_READ_SCOPES) expect(scope).toMatch(/\.(read|metadata_read)$/);
  expect([...new Set(CLOUDFLARE_READ_SCOPES)]).toHaveLength(CLOUDFLARE_READ_SCOPES.length);
});

test("no scope reads a Worker's code or data, runs a query or a model, sends anything, or shows a secret", () => {
  const scopes: readonly string[] = CLOUDFLARE_READ_SCOPES;
  // of the Workers' scopes, only the one without the source
  expect(scopes.filter((scope) => /^workers-scripts\.|^workers-tail\./.test(scope))).toEqual([
    "workers-scripts.metadata_read",
  ]);
  for (const excluded of [
    // a Worker's code and live requests
    "workers-scripts.read",
    "workers-scripts.content_read",
    "workers-tail.read",
    // data, and secrets
    "d1.read",
    "account-settings.read",
    "workers-kv-storage.read",
    "workers-r2.read",
    "workers-r2-bucket-item.read",
    "logs.read",
    "images.read",
    "stream.read",
    "access.read",
    "access-service-token.read",
    "ssl-and-certificates.read",
    "zaraz.read",
    "secrets-store.read",
    "artifacts.read",
    "r2-catalog.read",
    // the code review's seven: SQL, billed models, feedback, an unsubscribe token, snippets'
    // source; and AI Gateway's custom providers' headers
    "r2-catalog-sql.read",
    "account-analytics.read",
    "ai.read",
    "bot-management.read",
    "bot-management-feedback.read",
    "notifications.read",
    "snippets.read",
    "aig.read",
    // and the second review's: SCIM credentials, a tunnel's token, a queue's messages
    "access-app.read",
    "argotunnel.read",
    "queues.read",
  ])
    expect(scopes).not.toContain(excluded);
});

test("the list is what debugging the mind's own stack needs, and nothing else", () => {
  expect(CLOUDFLARE_READ_SCOPES.toSorted()).toEqual([
    "d1.metadata_read",
    "dns.read",
    "email-routing-rule.read",
    "pipelines.read",
    "queues.metadata_read",
    "user-details.read",
    "workers-kv-storage.metadata_read",
    "workers-observability.read",
    "workers-r2.metadata_read",
    "workers-routes.read",
    "workers-scripts.metadata_read",
    "zone-settings.read",
    "zone.read",
  ]);
});

test("a consent's token goes to Cloudflare's API and its MCP server alone", () => {
  // the token endpoint, where the client's secret goes, is at neither
  expect(CLOUDFLARE_OAUTH).toEqual({
    authorizationEndpoint: "https://dash.cloudflare.com/oauth2/auth",
    tokenEndpoint: "https://dash.cloudflare.com/oauth2/token",
    urls: ["https://api.cloudflare.com", "https://mcp.cloudflare.com"],
  });
});
