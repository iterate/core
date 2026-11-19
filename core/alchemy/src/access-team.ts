// access-team.ts — THE ACCOUNT'S ZERO TRUST TEAM AND ITS ONE-TIME PIN LOGIN, AS THE STACK FINDS
// THEM. Cloudflare Access proves an owner's address (./stack.ts), and Access needs two things
// that belong to the whole account, not to a mind: the Zero Trust organization (the "team", whose
// domain signs the tokens) and the login that mails a six-digit code (Cloudflare's "one-time
// PIN"). An account has one of each at most, and other things in the account may use them. So
// this resource reads them, makes one only where the account has none, changes nothing that
// exists, and deletes nothing.
//
// Alchemy's own resources (2.0.0-beta.85 and beta.87) do not fit an account that is shared:
// `Cloudflare.Access.Organization` writes the whole organization on every deploy, with its
// default for every setting the stack does not declare, and `Cloudflare.Access.IdentityProvider`
// takes an existing PIN login as its own (it finds it by its type) and deletes it at a destroy.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

export type AccessTeam = Resource<
  "Iterate.AccessTeam",
  {},
  {
    /** `<team name>.cloudflareaccess.com`: the issuer of the team's tokens, where its keys are. */
    teamDomain: string;
    /** The id of the team's one-time PIN login: an identity provider of the type `onetimepin`. */
    pinLoginId: string;
  },
  never,
  Cloudflare.Providers
>;
export const AccessTeam = Resource<AccessTeam>("Iterate.AccessTeam");

export const AccessTeamProvider = () =>
  Provider.succeed(AccessTeam, {
    stables: ["teamDomain", "pinLoginId"],
    reconcile: Effect.fn(function* () {
      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
      return yield* accessTeamFoundOrMade({
        // an account that never used Zero Trust answers 404, or an organization with no domain
        organization: zeroTrust
          .listOrganizationsForAccount({ accountId })
          .pipe(Effect.catchTag("OrganizationNotFound", () => Effect.undefined)),
        // With no name given, Cloudflare picks the team's name (`adjective-noun-hex4`): a name is
        // unique among all accounts and stays taken for good, so the stack proposes none. Another
        // deploy in the account may make the organization between the two calls: that one is used.
        makeOrganization: zeroTrust
          .createOrganizationForAccount({ accountId })
          .pipe(Effect.catchTag("OrganizationAlreadyExists", () => Effect.void)),
        pinLogin: zeroTrust.listIdentityProvidersForAccount.items({ accountId }).pipe(
          Stream.filter(({ type }) => type === "onetimepin"),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        ),
        makePinLogin: zeroTrust.createIdentityProviderForAccount({
          accountId,
          name: "One-time PIN",
          type: "onetimepin",
          config: {},
        }),
      });
    }),
    // the team and its login are the account's: other applications in it may sign people in
    delete: () => Effect.void,
  });

/** THE PROVIDER'S DECISIONS, over the four calls of Cloudflare's API that it makes: what exists
 *  is used as it is, and only what the account lacks is made. The organization is read again
 *  after it is made: the answer to the create need not name its domain. */
export const accessTeamFoundOrMade = <E, R>(account: {
  organization: Effect.Effect<{ authDomain?: string | null } | undefined, E, R>;
  makeOrganization: Effect.Effect<unknown, E, R>;
  pinLogin: Effect.Effect<{ id?: string | null } | undefined, E, R>;
  makePinLogin: Effect.Effect<{ id?: string | null }, E, R>;
}) =>
  Effect.gen(function* () {
    const teamDomain =
      (yield* account.organization)?.authDomain ||
      (yield* account.makeOrganization.pipe(Effect.andThen(account.organization)))?.authDomain;
    if (!teamDomain)
      return yield* Effect.die(
        "Cloudflare made no Zero Trust organization for the account: set one up at https://one.dash.cloudflare.com, then deploy again.",
      );
    const pinLoginId = ((yield* account.pinLogin) || (yield* account.makePinLogin)).id;
    if (!pinLoginId)
      return yield* Effect.die(
        "Cloudflare answered a one-time PIN login with no id: deploy again, or add the login at https://one.dash.cloudflare.com (Integrations, Identity providers).",
      );
    return { teamDomain, pinLoginId };
  });
