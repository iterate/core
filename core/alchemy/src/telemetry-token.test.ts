import assert from "node:assert/strict";
import { test } from "node:test";
import { Forbidden, InternalServerError, Unauthorized } from "@distilled.cloud/cloudflare/Errors";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  deleteLegacyAccountApiToken,
  TELEMETRY_TOKEN,
  telemetryTokenNeedsUpdate,
  telemetryTokenValueOf,
} from "./telemetry-token.ts";

void test("first deploy with a provided token stores it redacted, and missing token dies with guidance", async () => {
  const made = await Effect.runPromise(telemetryTokenValueOf("cf-telemetry-secret", undefined));
  assert.equal(Redacted.value(made.value), "cf-telemetry-secret");
  assert.doesNotMatch(JSON.stringify(made), /cf-telemetry-secret/);

  const missing = await Effect.runPromiseExit(telemetryTokenValueOf(undefined, undefined));
  assert.equal(missing._tag, "Failure");
  assert.match(JSON.stringify(missing), new RegExp(TELEMETRY_TOKEN));
});

void test("later deploys reuse the kept token without prompting and update only on rotation", async () => {
  const kept = { value: Redacted.make("cf-telemetry-v1") };
  assert.equal(telemetryTokenNeedsUpdate(undefined, kept), false);
  assert.equal(telemetryTokenNeedsUpdate("cf-telemetry-v1", kept), false);
  assert.equal(telemetryTokenNeedsUpdate("cf-telemetry-v2", kept), true);

  const reused = await Effect.runPromise(telemetryTokenValueOf(undefined, kept));
  assert.equal(Redacted.value(reused.value), "cf-telemetry-v1");

  const rotated = await Effect.runPromise(telemetryTokenValueOf("cf-telemetry-v2", kept));
  assert.equal(Redacted.value(rotated.value), "cf-telemetry-v2");
});

void test("legacy AccountApiToken delete succeeds when permitted, logs and continues on permission refusal with valid credential, and fails on invalid credential or 5xx", async () => {
  const accountId = "a".repeat(32);
  const token = {
    accountId,
    name: "iterate-ada-telemetry-catalog",
    tokenId: "tok-123",
  };

  // Credential with delete permission removes the token cleanly without warning
  const okLines: string[] = [];
  await Effect.runPromise(
    deleteLegacyAccountApiToken(Effect.void, Effect.void, token, (line) => okLines.push(line)),
  );
  assert.deepEqual(okLines, []);

  // Fresh branch sign-in lacking API-token write (Unauthorized "Authentication error" or Forbidden "Method not allowed for token")
  for (const refusal of [
    new Unauthorized({ message: "Authentication error" }),
    new Forbidden({ message: "Method not allowed for token" }),
  ]) {
    const lines: string[] = [];
    await Effect.runPromise(
      deleteLegacyAccountApiToken(Effect.fail(refusal), Effect.succeed("valid"), token, (line) =>
        lines.push(line),
      ),
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /iterate-ada-telemetry-catalog/);
    assert.match(lines[0]!, new RegExp(`https://dash\\.cloudflare\\.com/${accountId}/api-tokens`));
  }

  // Invalid credential fails even on Unauthorized "Authentication error"
  const invalidExit = await Effect.runPromiseExit(
    deleteLegacyAccountApiToken(
      Effect.fail(new Unauthorized({ message: "Authentication error" })),
      Effect.fail(new Unauthorized({ message: "Authentication error" })),
      token,
      () => {},
    ),
  );
  assert.equal(invalidExit._tag, "Failure");

  // Non-permission errors (500) still fail
  const serverErrorExit = await Effect.runPromiseExit(
    deleteLegacyAccountApiToken(
      Effect.fail(new InternalServerError({ message: "internal error" })),
      Effect.succeed("valid"),
      token,
      () => {},
    ),
  );
  assert.equal(serverErrorExit._tag, "Failure");
});
