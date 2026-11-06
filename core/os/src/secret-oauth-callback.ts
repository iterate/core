// secret-oauth-callback.ts — the host half of a secret's OAuth (secret-oauth.ts is the pure half):
// the provider redirected the human to the platform's callback with a code and the platform-signed
// `state` naming the secret's context; this admits the human by the secret's owner and hands the code
// to the secret's facet, which runs the exchange. On an integration's callback
// (`/api/integrations/<provider>/callback`) the owner's facet then finishes the connection
// (src/integrations/verbs.ts). The human goes on to the attempt's `next` when it named one — with
// the offer to move the account here when another project holds it (Slack). Called by worker.ts.

import { contextStub } from "./context-stub.ts";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "./context/paths.ts";
import type { ControlPlane, Reach } from "./control-plane/edge.ts";
import type { Env } from "./env.ts";
import type { PlatformAddresses } from "./iterate-config.ts";
import { moveOfferLanding } from "./integrations/connections.ts";
import type { FinishConnectAnswer, FinishConnectInput } from "./integrations/verbs.ts";
import { OAUTH_INTEGRATION_PROVIDERS } from "./integrations/contract.ts";
import { isSecretOAuthState, secretOwnerOf } from "./secret-oauth.ts";
import { callbackPage } from "./callback-page.ts";
import { withStartCleared } from "./secret-oauth-start.ts";
import {
  admitCallback,
  callbackStateOf,
  notIssuedHere,
  reaching,
  refused,
  type Admission,
} from "./connect-callback.ts";

/** WHO may complete a secret's OAuth: a session that reaches the secret's owner — for a project's
 *  secret, a session reaching that project; for a user's own, that user; for an organization's, a
 *  member; the admin reaches every one. A project-bound bearer reaches no user's or organization's
 *  own secrets; nothing but the admin reaches the global root's. */
async function reachesSecretOwner(
  controlPlane: ControlPlane,
  reach: Reach,
  owner: ReturnType<typeof secretOwnerOf>,
): Promise<boolean> {
  if (reach === "every") return true;
  if (owner.kind === "project") return controlPlane.reachesProject(reach, owner.id);
  // a grant bound to projects reaches those projects and nothing of the person's own (session.user)
  if (!("userId" in reach) || "projectIds" in reach) return false;
  if (owner.kind === "users") return reach.userId === owner.id;
  return controlPlane.reachesOrg(reach, owner.id);
}

/** WHO completes an attempt begun for one person (iterate/api
 *  `SecretOAuthOptions.completedByUserId`): a session of that person's own, whether or not it
 *  reaches the secret's owner, and no one else's, a member of the owner included. The project's
 *  code named them, and the platform says who a browser is. An impersonation is another person's
 *  hands, so it is refused; the operator's bearer is no person. */
const onlyPerson = (userId: string): Admission => ({
  admits: async (_controlPlane, { principal }) =>
    principal.actor === userId && !principal.impersonatedBy,
  signedOut:
    "Sign in to iterate in this browser first, then open this link again — it was started for one person, and only they can finish it.",
  refused: "This connect was started for someone else. Sign in as them, or start it again.",
});

/** A secret's OAuth callback: the provider redirected the human here with `code` and the
 *  platform-signed `state` (secret-oauth.ts) naming the secret's context and the nonce. The shared
 *  admission (connect-callback.ts) admits the browser that started it, signed in, reaching the
 *  secret's owner (`reachesSecretOwner`), or signed in as the one person the attempt was begun for
 *  (`onlyPerson`); the secret's facet then exchanges the code. A failure is a 4xx page that says
 *  why (callback-page.ts), never a credential. */
export async function secretOAuthCallback(
  request: Request,
  env: Env,
  addresses: PlatformAddresses,
): Promise<Response> {
  const url = new URL(request.url);
  const claims = await callbackStateOf(url, env, isSecretOAuthState);
  if (!claims) return notIssuedHere();
  let owner: ReturnType<typeof secretOwnerOf>;
  try {
    owner = secretOwnerOf(claims.context);
  } catch (error) {
    return callbackPage(400, error instanceof Error ? error.message : String(error));
  }
  // connect-callback.ts: the start cookie, the session (or the sign-in detour), then who it is
  const admitted = await admitCallback(request, env, addresses, {
    start: claims.start,
    admission:
      claims.completedByUserId && owner.kind === "project"
        ? onlyPerson(claims.completedByUserId)
        : reaching(`the secrets of ${owner.kind} ${owner.id}`, (controlPlane, reach) =>
            reachesSecretOwner(controlPlane, reach, owner),
          ),
  });
  if (refused(admitted)) return admitted;
  const { authorization, start } = admitted;
  const code = url.searchParams.get("code");
  if (!code) return callbackPage(400, "The provider sent no authorization code.");
  const provider = OAUTH_INTEGRATION_PROVIDERS.find(
    (name) => url.pathname === `/api/integrations/${name}/callback`,
  );
  // On the secret's own context — `itx.secrets.completeOAuth` (built-ins.ts) runs the exchange in
  // the secret's facet and lands the facts, in the order every other write to that path takes: the
  // same `{ code, state }` a page of the project's hands it, under the platform's own mark.
  let move: FinishConnectAnswer["move"];
  try {
    // the built-in's own answer (context/built-ins.ts `completeOAuth`)
    const { scopes, held } = (await contextStub(
      env.ITERATE_CONTEXT,
      DurableObjectNameCodec.parse(claims.context),
      "secret-oauth",
    ).invoke(
      [
        "itx",
        "builtins",
        "secrets",
        ["completeOAuth", owner.path, { code, state: url.searchParams.get("state") ?? "" }],
      ],
      [],
      { principal: null, platform: true },
    )) as { scopes: string[]; held?: FinishConnectInput["held"] };
    if (provider && owner.kind !== "organizations") {
      // The platform's own call on the owner's root: its facet (a project's `project`, a person's
      // `account`) finishes the attempt this callback completed (integrations/verbs.ts), told what
      // the provider granted and whether the human who consented is the owner themselves, with the
      // `account` scope — what connecting a person's account to a project needs.
      const { principal, grant } = authorization;
      const finish: FinishConnectInput = {
        provider,
        connection: owner.path.slice(`/secrets/${provider}-`.length),
        nonce: claims.nonce,
        grantedScopes: scopes,
        held,
        consentedBy: {
          person:
            owner.kind === "users" &&
            principal.actor === owner.id &&
            !principal.impersonatedBy &&
            Boolean(grant?.scope.includes("account")),
          email: principal.email,
        },
      };
      // the built-in's own answer (context/built-ins.ts `finishConnect`)
      ({ move } = (await contextStub(
        env.ITERATE_CONTEXT,
        DurableObjectNameCodec.address(
          owner.kind === "project"
            ? { projectId: owner.id, path: "/" }
            : { projectId: GLOBAL_PROJECT_ID, path: `/users/${owner.id}` },
        ),
        "secret-oauth",
      ).invoke(["itx", "builtins", "integrations", ["finishConnect", finish]], [], {
        principal: null,
        platform: true,
      })) as FinishConnectAnswer);
    }
  } catch (error) {
    return callbackPage(
      400,
      `${provider ? `Connecting ${provider}` : `Storing the tokens for ${owner.path}`} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Held by another project: the human's landing offers the move (`next` or nowhere).
  if (move)
    return withStartCleared(
      await moveOfferLanding(env, authorization.reach, move, claims.next || null),
      start,
    );
  // `next` was checked against the platform's and the Dash's origins before it was signed.
  if (claims.next)
    return withStartCleared(
      new Response(null, {
        status: 303,
        headers: { location: claims.next, "cache-control": "no-store" },
      }),
      start,
    );
  return withStartCleared(
    callbackPage(
      200,
      `Done: the secret ${owner.path} of ${owner.kind} ${owner.id} holds the tokens. You can close this tab.`,
    ),
    start,
  );
}
