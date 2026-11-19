// cloudflare-oauth-client.ts — THE STACK'S OWN OAUTH CLIENT AT CLOUDFLARE, AS A RESOURCE. One
// private OAuth client in the mind's own account: only a member of that account can approve it.
// Through it a member connects the mind to the account it runs in (./stack.ts gives the client
// to the secrets Worker alone; iterate/api `StackClientName` says how a connect names it).
// Cloudflare gives a client's secret once, in the answer to the create: the stack's state keeps
// it, as it keeps the generated keys.
//
// A CREDENTIAL THAT MAY NOT MAKE OAUTH CLIENTS IS AN EXPECTED OUTCOME, and no failure: an API
// token needs the permission "OAuth Client Write", and Cloudflare lists no OAuth scope for it, so
// a person's sign-in has none. Cloudflare then answers 403 code 10000 "Authentication error"
// (Cloudflare's API on 18 Nov 2026). The resource answers `refusal`, Cloudflare's words, and no
// client, and the stack goes on without one. Each later deploy asks again, so the first
// credential that may make the client makes it. Any other failure fails the deploy: see `refusedForPermission` for
// how a refusal is told from an invalid credential.
//
// AN API TOKEN FOR THE CLIENT ALONE. A sign-in at Cloudflare cannot grant "OAuth Client Write" (no
// OAuth scope names it), and a token that a sign-in makes may not hold it either. So
// `iterate deploy` takes one API token with that one permission from the person, and gives it to
// the script as `CLOUDFLARE_OAUTH_CLIENT_API_TOKEN` (`OAUTH_CLIENT_TOKEN`). When it is set, every
// call of this resource uses it, and the deploy's own credential makes no call here; otherwise
// the deploy's credential makes them, as for every other resource.
//
// Alchemy has no resource for an account's OAuth clients (2.0.0-beta.85 and beta.87); the SDK under it has
// the calls. When Alchemy has one that keeps the secret and takes a refusal as an outcome, this
// file goes.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as iam from "@distilled.cloud/cloudflare/iam";
import * as user from "@distilled.cloud/cloudflare/user";
import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import { z } from "zod";

export type CloudflareOAuthClient = Resource<
  "Iterate.CloudflareOAuthClient",
  {
    name: string;
    /** The one address that Cloudflare sends a member back to after a consent. */
    redirectUri: string;
    /** The scopes that a consent through the client may ask for. */
    scopes: readonly string[];
  },
  {
    /** The client's id and its secret. Absent: Cloudflare refused to make a client. */
    clientId: string | undefined;
    clientSecret: Redacted.Redacted<string> | undefined;
    /** Cloudflare's own words, when the deploy's credential may not make OAuth clients. */
    refusal: string | undefined;
    /** Cloudflare's words, when the credential could not read or change the kept client: the
     *  client may still differ from the props, and the next deploy tries again. */
    unapplied?: string | undefined;
  },
  never,
  Cloudflare.Providers
>;
export const CloudflareOAuthClient = Resource<CloudflareOAuthClient>(
  "Iterate.CloudflareOAuthClient",
);

/** The environment variable of the API token for the client alone (see the top of the file). */
export const OAUTH_CLIENT_TOKEN = "CLOUDFLARE_OAUTH_CLIENT_API_TOKEN";

/** The provider. `token`: the API token for the client alone, when the deploy was given one. */
export const CloudflareOAuthClientProvider = (token?: string) =>
  Provider.succeed(CloudflareOAuthClient, {
    // A stack with no client, or with a change that was refused, asks again at every deploy: this
    // deploy's credential may be one that may. Otherwise only a change of the name, the address
    // or the scopes is an update (Alchemy's own comparison of the props).
    diff: ({ output }) =>
      Effect.succeed(output && asksAgain(output) ? ({ action: "update" } as const) : undefined),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
      const wanted = {
        clientName: news.name,
        redirectUris: [news.redirectUri],
        scopes: [...news.scopes],
      };
      return yield* oauthClientMadeOrKept(
        wanted,
        output,
        oauthClientCalls(accountId, wanted, token),
      );
    }),
    delete: Effect.fn(function* ({ output, olds }) {
      if (!output.clientId) return;
      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
      yield* withToken(token)(
        iam.deleteOauthClient({ accountId, oauthClientId: output.clientId }),
      ).pipe(
        Effect.catchIf(notThere, () => Effect.void),
        // A destroy by a credential that may not delete OAuth clients still erases the mind. The
        // client stays in the account, and nothing holds its secret once the state is gone.
        Effect.catchIf(refusedForPermissionShape, (refused) =>
          Effect.logWarning(
            `The OAuth client ${olds.name} stays in the account: this credential may not delete OAuth clients (Cloudflare: ${wordsOf(refused)}). Delete it in Cloudflare's dashboard, under Manage Account, OAuth clients.`,
          ),
        ),
      );
    }),
  });

/** An effect of Cloudflare's SDK that runs with `token`, when there is one, in place of the
 *  deploy's credential. */
const withToken =
  (token: string | undefined) =>
  <A, E, R>(call: Effect.Effect<A, E, R>) =>
    token
      ? Effect.provideService(
          call,
          Credentials,
          Effect.succeed(apiTokenCredentials({ apiToken: Redacted.make(token) })),
        )
      : call;

/** THE CALLS OF CLOUDFLARE'S API THAT THE PROVIDER MAKES for the account `accountId`: with
 *  `token` when it is given, else with the deploy's credential. */
export const oauthClientCalls = (
  accountId: string,
  wanted: { clientName: string; redirectUris: string[]; scopes: string[] },
  token?: string,
) => {
  const using = withToken(token);
  return {
    read: (oauthClientId: string) =>
      using(iam.getOauthClient({ accountId, oauthClientId })).pipe(
        Effect.catchIf(notThere, () => Effect.undefined),
      ),
    make: using(
      iam.createOauthClient({
        ...wanted,
        accountId,
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        // the secret goes in the token request's form: the secrets Worker sends it so
        tokenEndpointAuthMethod: "client_secret_post",
      }),
    ),
    patch: (oauthClientId: string) =>
      using(iam.patchOauthClient({ ...wanted, accountId, oauthClientId })),
    // a read that the credential surely may make: it fails for one that is not valid, and so
    // tells that from one that lacks a permission. The deploy's own may read zones ("zone.read");
    // a given token holds one permission, and verifies itself (an account's token, or a person's).
    credentialWorks: token
      ? using(
          accounts.verifyToken({ accountId }).pipe(Effect.catchCause(() => user.verifyToken({}))),
        )
      : zones.listZones({ account: { id: accountId }, perPage: 1 }),
  };
};

/** Whether a deploy must ask Cloudflare again, with unchanged props: the stack has no client,
 *  or a change to it was refused. */
export const asksAgain = (
  output: Pick<CloudflareOAuthClient["Attributes"], "clientId" | "unapplied">,
) => !output.clientId || Boolean(output.unapplied);

/** A client as Cloudflare reads it back. `offline_access` and `openid` are in its scopes when
 *  its grant types call for them: Cloudflare adds and removes those two itself. */
type ObservedClient = {
  clientName?: string | null;
  redirectUris?: readonly string[] | null;
  scopes?: readonly string[] | null;
};

/** THE PROVIDER'S DECISIONS, over the calls of Cloudflare's API that it makes. The client of an
 *  earlier deploy is kept, with its secret, and changed in place where it differs from `wanted`;
 *  one that somebody deleted is made again. A credential that may not read or change OAuth
 *  clients leaves a kept client as it is, marked `unapplied`, so the next deploy tries again.
 *  With no client, one is made, and a refusal for permission is the answer `refusal`.
 *
 *  A client that somebody deleted, and a credential that may not make another: the answer is no
 *  client, with the refusal. The kept id and secret name a client that Cloudflare no longer has:
 *  a link through them fails at Cloudflare, and a grant through them can no longer refresh. So
 *  the stack holds none, the vault says the mind has no client, and a later deploy makes one. */
export const oauthClientMadeOrKept = <E, R>(
  wanted: { clientName: string; redirectUris: string[]; scopes: string[] },
  kept: CloudflareOAuthClient["Attributes"] | undefined,
  cloudflare: {
    /** The client of that id, or undefined when the account has none. */
    read: (clientId: string) => Effect.Effect<ObservedClient | undefined, E, R>;
    make: Effect.Effect<{ clientId: string; clientSecret?: string | null }, E, R>;
    patch: (clientId: string) => Effect.Effect<unknown, E, R>;
    /** Any read that the deploy's credential surely may make: it succeeds for a valid one. */
    credentialWorks: Effect.Effect<unknown, E, R>;
  },
) =>
  Effect.gen(function* () {
    const refusedForPermission = <A, E2, R2>(call: Effect.Effect<A, E2, R2>) =>
      call.pipe(
        Effect.map((value) => ({ value })),
        Effect.catchIf(refusedForPermissionShape, (refused) =>
          // the same words come for a credential that is not valid: only one that works for the
          // read that every deploy makes lacks a permission. Otherwise the refusal is the failure.
          cloudflare.credentialWorks.pipe(
            Effect.flatMap(() => Effect.succeed({ refusal: wordsOf(refused) })),
            Effect.catchCause(() => Effect.fail(refused)),
          ),
        ),
      );
    if (kept?.clientId) {
      const { clientId } = kept;
      const read = yield* refusedForPermission(cloudflare.read(clientId));
      const patched =
        "value" in read && read.value && differs(read.value, wanted)
          ? yield* refusedForPermission(cloudflare.patch(clientId))
          : undefined;
      const refused =
        "refusal" in read ? read : patched && "refusal" in patched ? patched : undefined;
      if (refused) {
        yield* Effect.logWarning(
          `The OAuth client ${wanted.clientName} stays as an earlier deploy left it: this credential may not read or change OAuth clients (Cloudflare: ${refused.refusal}). The next deploy tries again.`,
        );
        return { ...kept, unapplied: refused.refusal };
      }
      if ("value" in read && read.value) return { ...kept, unapplied: undefined };
    }
    const asked = yield* refusedForPermission(cloudflare.make);
    const made = "value" in asked ? asked.value : asked;
    if ("refusal" in made) {
      yield* Effect.logWarning(
        `No OAuth client ${wanted.clientName} was made: this credential may not make OAuth clients (Cloudflare: ${made.refusal}). The mind runs without it, and a deploy with an API token that has "OAuth Client Write" makes it.`,
      );
      return {
        clientId: undefined,
        clientSecret: undefined,
        refusal: made.refusal,
        unapplied: undefined,
      };
    }
    if (!made.clientSecret)
      return yield* Effect.die(
        `Cloudflare made the OAuth client ${wanted.clientName} (${made.clientId}) and gave no secret for it. Delete it in Cloudflare's dashboard, under Manage Account, OAuth clients, then deploy again.`,
      );
    return {
      clientId: made.clientId,
      clientSecret: Redacted.make(made.clientSecret),
      refusal: undefined,
      unapplied: undefined,
    };
  });

/** WHETHER AN ERROR HAS THE SHAPE OF A REFUSAL FOR PERMISSION. Cloudflare's API on 18 Nov
 *  2026: a valid token without "OAuth Client Read/Write" gets 403 code 10000 "Authentication error"; a token that does not exist gets 401
 *  with the same code and words; a malformed one 400 code 9106. The SDK maps code 10000 to
 *  `Unauthorized` and keeps only the words, not the status, and it tries the call again for
 *  about 24 s first, because Cloudflare answers the same words to a valid token under load. Code
 *  10001 "Method not allowed for token" (`Forbidden`) is a refusal too; its other words
 *  ("internal error", "Unable to authenticate request") are Cloudflare's own failures. So the
 *  shape is those words alone, and `oauthClientMadeOrKept` then proves the credential valid.
 *  What stays ambiguous: a valid token that Cloudflare refuses under load for all of the 24 s
 *  counts as a refusal, and the next deploy asks again. */
const refusedForPermissionShape = (error: unknown) =>
  (Predicate.isTagged(error, "Unauthorized") && /^Authentication error$/i.test(wordsOf(error))) ||
  (Predicate.isTagged(error, "Forbidden") && /method not allowed for token/i.test(wordsOf(error)));

/** Cloudflare's answer for a client that the account does not have (404 "oauth client not
 *  found"). The SDK gives it as `NotFound`, which its types for these calls do not list
 *  (1.0.0-rc.18): so a predicate, and no `catchTag`. */
const notThere = Predicate.isTagged("NotFound");

const wordsOf = (refused: unknown) =>
  z.object({ message: z.string() }).safeParse(refused).data?.message || "no reason given";

/** The two scopes that Cloudflare adds to a client by its grant types. */
const PROTOCOL_SCOPES = ["offline_access", "openid"];

const differs = (
  observed: ObservedClient,
  wanted: { clientName: string; redirectUris: string[]; scopes: string[] },
) =>
  observed.clientName !== wanted.clientName ||
  (observed.redirectUris || []).join() !== wanted.redirectUris.join() ||
  (observed.scopes || [])
    .filter((scope) => !PROTOCOL_SCOPES.includes(scope))
    .toSorted()
    .join() !== wanted.scopes.toSorted().join();
