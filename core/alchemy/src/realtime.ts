// realtime.ts — THE STACK'S REALTIME SFU APP AND TURN KEY AT CLOUDFLARE, AND A DEPLOY THAT MAY NOT
// MAKE THEM. Every stack makes one SFU app and one TURN key (./stack.ts), with Alchemy's own
// resources, and gives their ids and secrets to the secrets Worker alone, which serves them as
// two secrets that the stack made (core/secrets-worker src/stack-secrets.ts). Neither costs
// anything until a call uses it.
//
// A CREDENTIAL THAT MAY NOT MAKE REALTIME (CALLS) RESOURCES IS AN EXPECTED OUTCOME, and no
// failure. "Calls Write" is not the only permission that allows it: a sub-token without "Calls
// Read" and "Calls Write" still made both when it held "Realtime" or "Realtime Admin" (19 Nov
// 2026). For a credential that may not, Cloudflare answers
// HTTP 403, code 10000, "Authentication error" (asked on 18 Nov 2026), which the SDK gives as the
// Calls service's `Forbidden` with the code. A token that is not valid gets 401 with the same
// words, which the SDK gives as `Unauthorized`: that one still fails the deploy. On the refusal
// the resource is kept as not made (an empty id), the deploy says so in one line and goes on, and
// the secrets Worker gets `{ refusal }` for it. The next deploy asks again. What an earlier
// deploy made stays as the state keeps it. Any other failure fails the deploy, as Alchemy's
// provider would.
//
// The SDK takes "Authentication error" as a passing blip as well, and asks again up to eight
// times before the refusal reaches this file: some seconds of each such deploy.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { z } from "zod";

/** The stack's resource ids of the two (./stack.ts). */
export const REALTIME_SFU = "RealtimeSfu";
export const TURN_KEY = "TurnKey";

/** Cloudflare's words for the refusal, with what they mean: the secrets Worker gives them as the
 *  reason why the stack's two secrets are not set. */
export const CALLS_REFUSAL =
  "Authentication error (HTTP 403, code 10000): the deploy's credential may not make Realtime apps and TURN keys. A deploy whose credential may make Realtime (Calls) resources makes them.";

/** The one line that a deploy says whose credential may not make Realtime (Calls) resources. */
export const NO_CALLS_PERMISSION_LINE =
  "This deploy's Cloudflare credential lacks the permission to make Realtime (Calls) resources: the stack goes on without its Realtime SFU app and TURN key, and /secrets/cloudflare-realtime-sfu and /secrets/cloudflare-turn are not set.";

/** Cloudflare's refusal of a Calls call to a token without the permission: HTTP 403 (the Calls
 *  service's `Forbidden`) with code 10000. */
const CallsRefusal = z.object({ _tag: z.literal("Forbidden"), code: z.literal(10000) });
export const isCallsRefusal = (error: unknown) => CallsRefusal.safeParse(error).success;

type AppService = Provider.ProviderService<Cloudflare.Calls.App>;
type TurnKeyService = Provider.ProviderService<Cloudflare.Calls.TurnKey>;
type Attributes<S extends AppService | TurnKeyService> = Parameters<S["delete"]>[0]["output"];

/** Alchemy's provider `base` of the resource, where Cloudflare's refusal (`isCallsRefusal`) of the
 *  resource with logical id `resource.id` counts as not made:
 *
 *  - `reconcile`: on the refusal, an earlier output with a Cloudflare id stays; with none, the
 *    resource is not made, in the account `accountId` gives, and `say` gets
 *    `NO_CALLS_PERMISSION_LINE`.
 *  - `diff`: a resource that is not made is updated at each deploy, and none of its attributes is
 *    taken as stable, so the secrets Worker's value comes from the new answer.
 *  - `delete`: a resource that is not made has nothing to delete, and one that the credential may
 *    not delete stays in the account, said in a line. */
export function callsWithoutWriteProvider<S extends AppService | TurnKeyService>(
  base: S,
  resource: {
    id: string;
    cloudflareIdOf: (output: Attributes<S>) => string;
    notMade: (accountId: string) => Attributes<S>;
  },
  options: { accountId: Effect.Effect<string>; say: (line: string) => void },
): S {
  // The casts: `base` is one of two providers whose members take and give that provider's own
  // attributes, and `resource` reads and makes the same provider's attributes. TypeScript cannot
  // call a member of a union of two providers, so the wrapper is written for one of them.
  const service = base as AppService;
  const cloudflareIdOf = resource.cloudflareIdOf as (output: Attributes<AppService>) => string;
  const notMade = resource.notMade as (accountId: string) => Attributes<AppService>;
  const ours = (id: string) => id === resource.id;
  const made = (output: Attributes<AppService> | undefined) =>
    Boolean(output && cloudflareIdOf(output));
  const wrapped: AppService = {
    ...service,
    diff: (input) =>
      ours(input.id) && input.output && !made(input.output)
        ? Effect.succeed({ action: "update" as const, stables: [] })
        : service.diff!(input),
    reconcile: (input) =>
      service.reconcile(input).pipe(
        Effect.catchIf(
          (error: unknown) => ours(input.id) && isCallsRefusal(error),
          () =>
            Effect.gen(function* () {
              if (input.output && made(input.output)) return input.output;
              options.say(NO_CALLS_PERMISSION_LINE);
              return notMade(yield* options.accountId);
            }),
        ),
      ),
    delete: (input) =>
      !ours(input.id)
        ? service.delete(input)
        : !made(input.output)
          ? Effect.void
          : service.delete(input).pipe(
              // a destroy by a credential that may not delete it still erases the mind: the
              // thing stays in the account, and nothing holds its secret once the state is gone
              Effect.catchIf(isCallsRefusal, () =>
                Effect.sync(() =>
                  options.say(
                    `${cloudflareIdOf(input.output)} stays in the account: this credential lacks the permission to delete Realtime (Calls) resources. Delete it in Cloudflare's dashboard, under Realtime.`,
                  ),
                ),
              ),
            ),
  };
  return wrapped as S;
}

/** The deploy's account, as Alchemy's Cloudflare providers read it. */
const accountIdOfDeploy = Effect.map(Cloudflare.CloudflareEnvironment, (environment) =>
  Effect.map(environment, ({ accountId }) => accountId),
);

const notMadeAt = (accountId: string) => ({ accountId, name: "", created: "", modified: "" });

/** `write`, with a line that was said already left out. */
export const eachLineOnce = (write: (line: string) => void) => {
  const said = new Set<string>();
  return (line: string) => {
    if (said.has(line)) return;
    said.add(line);
    write(line);
  };
};

/** The stack's providers of the two: put it over `Cloudflare.providers()`, which it overrides for
 *  these two types. It says the line of a deploy that may not make them once, for both; a destroy's
 *  line names one leftover each, so each is said. */
export const CallsWithoutWriteProviders = () => {
  const say = eachLineOnce(console.log);
  const app = Provider.effect(
    Cloudflare.Calls.App,
    Effect.gen(function* () {
      const accountId = yield* accountIdOfDeploy;
      return callsWithoutWriteProvider(
        yield* Cloudflare.Calls.App.Provider,
        {
          id: REALTIME_SFU,
          cloudflareIdOf: (output) => output.appId,
          notMade: (accountId) => ({
            ...notMadeAt(accountId),
            appId: "",
            secret: Redacted.make(""),
          }),
        },
        { accountId, say },
      );
    }),
  ).pipe(Layer.provide(Cloudflare.Calls.AppProvider()));
  const turnKey = Provider.effect(
    Cloudflare.Calls.TurnKey,
    Effect.gen(function* () {
      const accountId = yield* accountIdOfDeploy;
      return callsWithoutWriteProvider(
        yield* Cloudflare.Calls.TurnKey.Provider,
        {
          id: TURN_KEY,
          cloudflareIdOf: (output) => output.keyId,
          notMade: (accountId) => ({ ...notMadeAt(accountId), keyId: "", key: Redacted.make("") }),
        },
        { accountId, say },
      );
    }),
  ).pipe(Layer.provide(Cloudflare.Calls.TurnKeyProvider()));
  return Layer.mergeAll(app, turnKey);
};

/** THE SECRETS WORKER'S VALUE OF THE TWO (core/secrets-worker src/config.ts
 *  `cloudflareRealtime`): each one's id and secret, or `{ refusal }` when it was not made. */
export const realtimeConfigOf = (made: {
  appId: string;
  appSecret: Redacted.Redacted<string>;
  keyId: string;
  key: Redacted.Redacted<string>;
}) => ({
  sfu:
    made.appId && Redacted.value(made.appSecret)
      ? { appId: made.appId, appSecret: Redacted.value(made.appSecret) }
      : { refusal: refusalOf(made.appId) },
  turn:
    made.keyId && Redacted.value(made.key)
      ? { keyId: made.keyId, apiToken: Redacted.value(made.key) }
      : { refusal: refusalOf(made.keyId) },
});

/** Why one of the two has no secret: not made, or made and its secret lost (Cloudflare shows it
 *  once, at the create). */
const refusalOf = (id: string) =>
  id
    ? `Cloudflare made ${id} and the stack holds no secret of it: delete it in Cloudflare's dashboard, under Realtime, then deploy again.`
    : CALLS_REFUSAL;
