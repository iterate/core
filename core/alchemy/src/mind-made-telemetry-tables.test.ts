import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudflareError, Forbidden, NotFound } from "@distilled.cloud/cloudflare/Errors";
import { noCatalogThere } from "./mind-made-telemetry-tables.ts";

void test("a destroy passes a bucket that never had a catalog, and no other refusal", () => {
  // what Cloudflare answers for a bucket whose tables were never turned on, as the SDK gives it
  assert.equal(noCatalogThere(new NotFound({ message: "Warehouse not found" })), true);
  for (const code of [7003, 10006, 40406])
    assert.equal(
      noCatalogThere(new CloudflareError({ status: 400, errors: [{ code, message: "no" }] })),
      true,
    );
  assert.equal(noCatalogThere(new CloudflareError({ status: 404, errors: [] })), true);
  assert.equal(
    noCatalogThere(new CloudflareError({ status: 500, errors: [{ code: 1, message: "x" }] })),
    false,
  );
  assert.equal(noCatalogThere(new Forbidden({ message: "Authentication error" })), false);
});
