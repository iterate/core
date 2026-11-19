import assert from "node:assert/strict";
import { test } from "node:test";
import { Forbidden, InternalServerError, Unauthorized } from "@distilled.cloud/cloudflare/Errors";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { asksAgain, oauthClientCalls, oauthClientMadeOrKept } from "./cloudflare-oauth-client.ts";

const wanted = {
  clientName: "iterate-example-com-cloudflare",
  redirectUris: ["https://iterate.example.com/secrets/oauth/callback"],
  scopes: ["zone.read", "workers-observability.read"],
};
/** What Cloudflare answers to a token without "OAuth Client Write", as the SDK gives it. */
const mayNot = new Unauthorized({ message: "Authentication error" });

void test("a first deploy makes the client, and the answer keeps its id and its secret", async () => {
  const { cloudflare, calls } = cloudflareWith({});
  const made = await Effect.runPromise(oauthClientMadeOrKept(wanted, undefined, cloudflare));
  assert.equal(made.clientId, "made-client");
  assert.equal(asksAgain(made), false);
  assert.equal(made.clientSecret && Redacted.value(made.clientSecret), "made-secret");
  assert.equal(made.refusal, undefined);
  assert.deepEqual(calls, ["make"]);
  // the secret prints as no text
  assert.doesNotMatch(JSON.stringify(made), /made-secret/);
});

void test("a credential that may not make OAuth clients: no client, Cloudflare's words, no failure", async () => {
  const { cloudflare, calls } = cloudflareWith({ make: Effect.fail(mayNot) });
  assert.deepEqual(await Effect.runPromise(oauthClientMadeOrKept(wanted, undefined, cloudflare)), {
    clientId: undefined,
    clientSecret: undefined,
    refusal: "Authentication error",
    unapplied: undefined,
  });
  assert.deepEqual(calls, ["credential works"]);
  assert.equal(asksAgain({ clientId: undefined }), true);
});

void test("any other failure of the create fails the deploy", async () => {
  const { cloudflare } = cloudflareWith({
    make: Effect.fail(new InternalServerError({ message: "internal error" })),
  });
  const exit = await Effect.runPromiseExit(oauthClientMadeOrKept(wanted, undefined, cloudflare));
  assert.equal(exit._tag, "Failure");
  assert.match(JSON.stringify(exit), /InternalServerError/);
});

void test("a stack that was refused asks again, and the first credential that may makes the client", async () => {
  const refused = { clientId: undefined, clientSecret: undefined, refusal: "Authentication error" };
  const { cloudflare, calls } = cloudflareWith({});
  const made = await Effect.runPromise(oauthClientMadeOrKept(wanted, refused, cloudflare));
  assert.equal(made.clientId, "made-client");
  assert.deepEqual(calls, ["make"]);
});

void test("a second run changes nothing: the client is read, and kept with its secret", async () => {
  const { cloudflare, calls } = cloudflareWith({
    // Cloudflare adds `offline_access` to a client with the refresh grant, and orders as it likes
    observed: { ...wanted, scopes: ["offline_access", ...wanted.scopes.toReversed()] },
  });
  const stays = await Effect.runPromise(oauthClientMadeOrKept(wanted, kept(), cloudflare));
  assert.deepEqual(stays, { ...kept(), unapplied: undefined });
  assert.equal(asksAgain(stays), false);
  assert.deepEqual(calls, ["read kept-client"]);
});

void test("changed scopes, or a changed address, update the client in place", async () => {
  for (const observed of [
    { ...wanted, scopes: ["zone.read", "workers-observability.write"] },
    { ...wanted, redirectUris: ["https://old.example.com/secrets/oauth/callback"] },
  ]) {
    const { cloudflare, calls } = cloudflareWith({ observed });
    assert.deepEqual(await Effect.runPromise(oauthClientMadeOrKept(wanted, kept(), cloudflare)), {
      ...kept(),
      unapplied: undefined,
    });
    assert.deepEqual(calls, ["read kept-client", "patch kept-client"]);
  }
});

void test("a client that somebody deleted is made again", async () => {
  const { cloudflare, calls } = cloudflareWith({ observed: undefined });
  const made = await Effect.runPromise(oauthClientMadeOrKept(wanted, kept(), cloudflare));
  assert.equal(made.clientId, "made-client");
  assert.deepEqual(calls, ["read kept-client", "make"]);
});

void test("a credential that may not read OAuth clients leaves the kept client as it is, and the next deploy asks again", async () => {
  const { cloudflare, calls } = cloudflareWith({ read: Effect.fail(mayNot) });
  const stays = await Effect.runPromise(oauthClientMadeOrKept(wanted, kept(), cloudflare));
  assert.deepEqual(stays, { ...kept(), unapplied: "Authentication error" });
  assert.equal(asksAgain(stays), true);
  assert.deepEqual(calls, ["credential works"]);
});

void test("a refused update is not recorded as done: the next deploy tries it again", async () => {
  const { cloudflare, calls } = cloudflareWith({
    observed: { ...wanted, scopes: ["zone.read"] },
    patch: Effect.fail(new Forbidden({ message: "Method not allowed for token" })),
  });
  const stays = await Effect.runPromise(oauthClientMadeOrKept(wanted, kept(), cloudflare));
  assert.equal(stays.clientId, "kept-client");
  assert.equal(stays.unapplied, "Method not allowed for token");
  assert.equal(asksAgain(stays), true);
  assert.deepEqual(calls, ["read kept-client", "credential works"]);

  // the next deploy, with a credential that may: patched, and no longer asks again
  const next = cloudflareWith({ observed: { ...wanted, scopes: ["zone.read"] } });
  const done = await Effect.runPromise(oauthClientMadeOrKept(wanted, stays, next.cloudflare));
  assert.equal(done.unapplied, undefined);
  assert.equal(asksAgain(done), false);
  assert.deepEqual(next.calls, ["read kept-client", "patch kept-client"]);
});

void test("the words of a refusal from a credential that is not valid fail the deploy", async () => {
  // Cloudflare answers 401 code 10000 "Authentication error" to a token that does not exist: the
  // same words as for a missing permission, so the read that every deploy makes tells them apart
  const { cloudflare } = cloudflareWith({
    make: Effect.fail(mayNot),
    credentialWorks: Effect.fail(new Unauthorized({ message: "Authentication error" })),
  });
  const exit = await Effect.runPromiseExit(oauthClientMadeOrKept(wanted, undefined, cloudflare));
  assert.equal(exit._tag, "Failure");
  assert.match(JSON.stringify(exit), /Unauthorized/);
});

void test("Unauthorized or Forbidden with other words is no refusal, and fails the deploy", async () => {
  for (const error of [
    new Unauthorized({ message: "Authentication failed (status: 400)" }),
    new Forbidden({ message: "internal error" }),
  ]) {
    const { cloudflare, calls } = cloudflareWith({ make: Effect.fail(error) });
    const exit = await Effect.runPromiseExit(oauthClientMadeOrKept(wanted, undefined, cloudflare));
    assert.equal(exit._tag, "Failure");
    assert.deepEqual(calls, []);
  }
});

void test("a client that somebody deleted, and a credential that may not make another: no client", async () => {
  const { cloudflare } = cloudflareWith({ observed: undefined, make: Effect.fail(mayNot) });
  assert.deepEqual(await Effect.runPromise(oauthClientMadeOrKept(wanted, kept(), cloudflare)), {
    clientId: undefined,
    clientSecret: undefined,
    refusal: "Authentication error",
    unapplied: undefined,
  });
});

void test("a client that Cloudflare made with no secret fails the deploy, by its name", async () => {
  const { cloudflare } = cloudflareWith({ make: Effect.succeed({ clientId: "made-client" }) });
  const exit = await Effect.runPromiseExit(oauthClientMadeOrKept(wanted, undefined, cloudflare));
  assert.match(
    JSON.stringify(exit),
    /iterate-example-com-cloudflare \(made-client\) and gave no secret/,
  );
});

void test("a given API token makes each of the provider's calls, and the deploy's credential none", async () => {
  for (const [token, expected] of [
    ["the-client-token", "Bearer the-client-token"],
    [undefined, "Bearer the-deploy-token"],
  ] as const) {
    const sent: string[] = [];
    // Cloudflare as a client that records each request: a client that is not there (404)
    const cloudflare = HttpClient.make((request) =>
      Effect.sync(() => {
        sent.push(`${request.method} ${request.url} ${request.headers.authorization}`);
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { success: false, errors: [{ code: 70700, message: "oauth client not found" }] },
            { status: 404 },
          ),
        );
      }),
    );
    const calls = oauthClientCalls("account-1", wanted, token);
    const read = await Effect.runPromise(
      calls
        .read("client-1")
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(HttpClient.HttpClient, cloudflare),
              fromApiToken({ apiToken: Redacted.make("the-deploy-token") }),
            ),
          ),
        ),
    );
    assert.equal(read, undefined);
    assert.deepEqual(sent, [
      `GET https://api.cloudflare.com/client/v4/accounts/account-1/oauth_clients/client-1 ${expected}`,
    ]);
  }
});

void test("permission refusal on oauth client create fails fast in one request instead of retrying for 24 s", async () => {
  let attempts = 0;
  const cloudflare = HttpClient.make((request) =>
    Effect.sync(() => {
      attempts += 1;
      return HttpClientResponse.fromWeb(
        request,
        Response.json(
          { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
          { status: 403 },
        ),
      );
    }),
  );
  const exit = await Effect.runPromiseExit(
    oauthClientCalls("account-1", wanted).make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, cloudflare),
          fromApiToken({ apiToken: Redacted.make("the-deploy-token") }),
        ),
      ),
    ),
  );
  assert.equal(exit._tag, "Failure");
  assert.equal(attempts, 1);
});

const keptClient = {
  clientId: "kept-client",
  clientSecret: Redacted.make("kept-secret"),
  refusal: undefined,
};
/** The client of an earlier deploy, as the stack's state keeps it: the same object each time. */
function kept() {
  return keptClient;
}

/** Cloudflare as the provider's three calls see it, and the calls that reached it. `observed` is
 *  the kept client as Cloudflare reads it back; `read` and `make` stand in for a call that fails. */
function cloudflareWith(has: {
  observed?: { clientName: string; redirectUris: string[]; scopes: string[] };
  read?: Effect.Effect<never, Unauthorized>;
  make?: Effect.Effect<
    { clientId: string; clientSecret?: string },
    Unauthorized | Forbidden | InternalServerError
  >;
  patch?: Effect.Effect<never, Forbidden>;
  credentialWorks?: Effect.Effect<never, Unauthorized>;
}) {
  const calls: string[] = [];
  return {
    calls,
    cloudflare: {
      read: (clientId: string) =>
        has.read ||
        Effect.sync(() => {
          calls.push(`read ${clientId}`);
          return has.observed;
        }),
      make:
        has.make ||
        Effect.sync(() => {
          calls.push("make");
          return { clientId: "made-client", clientSecret: "made-secret" };
        }),
      patch: (clientId: string) =>
        has.patch || Effect.sync(() => void calls.push(`patch ${clientId}`)),
      credentialWorks:
        has.credentialWorks || Effect.sync(() => void calls.push("credential works")),
    },
  };
}
