import assert from "node:assert/strict";
import { test } from "node:test";
import { tryFindProviderRegistrationByType } from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import {
  RetiredCloudflareOAuthClientProvider,
  retiredClientDropped,
} from "./retired-cloudflare-oauth-client.ts";

// A DEPLOY OVER A STACK THAT HAS A CLIENT: the program declares none, so Alchemy plans a delete
// of the row `CloudflareClient` with this provider. The delete must succeed with no call, and the
// row (with the client's secret) leaves the state.

/** The delete's outcome, and every line it logged. The effect needs no service: the type says
 *  `Effect<void>`, and it runs here with none, so no credential and no HTTP client exist. */
async function dropped(output: { clientId?: string }, olds: { name?: string }) {
  const lines: string[] = [];
  const logger = Logger.make(({ message }) => void lines.push(String(message)));
  const exit = await Effect.runPromiseExit(
    retiredClientDropped({ output, olds }).pipe(Effect.provide(Logger.layer([logger]))),
  );
  return { ok: exit._tag === "Success", lines };
}

void test("a stack with a client: the row leaves with no call, and the deploy says how to delete the client", async () => {
  const { ok, lines } = await dropped(
    { clientId: "example-client-id" },
    { name: "iterate-example-com-cloudflare" },
  );
  assert.equal(ok, true);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0] || "",
    /client iterate-example-com-cloudflare \(example-client-id\) stays in the account.*Manage Account, OAuth clients/,
  );
});

void test("a stack whose deploy was refused a client: the row leaves with no call and no words", async () => {
  assert.deepEqual(
    await dropped({ clientId: undefined }, { name: "iterate-example-com-cloudflare" }),
    {
      ok: true,
      lines: [],
    },
  );
});

void test("the old row's type has a provider: Alchemy's plan of the orphan delete finds it, and does not die", async () => {
  // alchemy src/Plan.ts dies with `missingProviderError` when this lookup finds nothing
  const found = await Effect.runPromise(
    tryFindProviderRegistrationByType("Iterate.CloudflareOAuthClient").pipe(
      Effect.provide(RetiredCloudflareOAuthClientProvider()),
    ),
  );
  assert.equal(Option.isSome(found), true);
  const missing = await Effect.runPromise(
    tryFindProviderRegistrationByType("Iterate.CloudflareOAuthClient"),
  );
  assert.equal(Option.isNone(missing), true);
});
