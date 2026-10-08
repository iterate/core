// X connections use PKCE and rotating OAuth 2.0 tokens in the existing secret infrastructure,
// through the deployment's X client. Account identity comes from /users/me.
import { codedError } from "iterate/lib";
import { z } from "zod";
import { iterateConfigOf, DEFAULT_X_SCOPES } from "../iterate-config.ts";
import { SECRET_OAUTH_TTL_MS } from "../secret-oauth.ts";
import type { IntegrationConnectionRow } from "./contract.ts";
import {
  appendConnected,
  connectionPathOf,
  connectionRowOf,
  consentAttemptKeyOf,
  deleteTokenSecret,
  ownerEgress,
  routedWhile,
  tokenSecretPathOf,
  type ConnectionAttempt,
  type IntegrationScope,
} from "./connections.ts";

/** X has no ID token: account identity comes from the authorized /2/users/me response.
 * https://docs.x.com/x-api/users/get-my-user */
const XUserResponse = z.object({
  data: z.object({ id: z.string().regex(/^\d+$/), username: z.string().min(1) }),
});

/** A test provider serves both endpoints on one origin; live X splits consent and API hosts. */
export function xEndpointsOf(origin?: string | null) {
  const apiOrigin = origin || "https://api.x.com";
  return {
    authorizationEndpoint: `${origin || "https://x.com"}/i/oauth2/authorize`,
    tokenEndpoint: `${apiOrigin}/2/oauth2/token`,
    userEndpoint: `${apiOrigin}/2/users/me`,
    urls: [apiOrigin],
  };
}

/** Begin consent through the deployment's X client, retaining already granted scopes on a reconnect. */
export async function connectX(
  scope: IntegrationScope,
  input: {
    connection: string;
    next?: string;
    scopes?: readonly string[];
    existing?: IntegrationConnectionRow;
    connectToProject?: ConnectionAttempt["connectToProject"];
  },
) {
  const app = iterateConfigOf(scope.env).integrations.x;
  if (!app) throw codedError("INVALID_INPUT", "This deployment has no X OAuth client.");
  using itx = scope.getItx();
  const endpoints = xEndpointsOf(app.xOrigin);
  const scopes = [
    ...new Set([
      ...DEFAULT_X_SCOPES,
      ...app.scopes,
      ...(input.existing?.scopes || []),
      ...(input.scopes || []),
    ]),
  ];
  const { authorizationUrl, nonce } = await itx.secrets.beginOAuth(
    tokenSecretPathOf("x", input.connection),
    {
      ...endpoints,
      client: { platform: "x" },
      clientAuth: "client_secret_basic",
      scope: scopes.join(" "),
      next: input.next,
      expectAccount: input.existing?.externalId,
    },
  );
  await scope.storage.put<ConnectionAttempt>(consentAttemptKeyOf("x", input.connection, nonce), {
    origin: app.xOrigin || "",
    until: Date.now() + SECRET_OAUTH_TTL_MS,
    connectToProject: input.connectToProject,
  });
  return { authorizationUrl };
}

/** Record the stable account ID from the token's own profile. */
export async function finishXConnect(
  scope: IntegrationScope,
  connection: string,
  attempt: ConnectionAttempt,
  { grantedScopes }: { grantedScopes: string[] },
) {
  const response = await ownerEgress(
    scope.env,
    scope,
    new Request(xEndpointsOf(attempt.origin).userEndpoint, {
      headers: {
        authorization: `Bearer getSecret("${tokenSecretPathOf("x", connection)}", { field: "accessToken" })`,
      },
    }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`X account lookup answered ${response.status}`);
  }
  const { data } = XUserResponse.parse(await response.json());
  const connected = () =>
    appendConnected(scope, {
      provider: "x",
      connection,
      account: `@${data.username}`,
      externalId: data.id,
      scopes: grantedScopes,
    });
  // Iterate's app routes an X account to ONE project connection, as for Slack and GitHub: a second
  // connection of the same account, here or in another project, is refused, and the token the
  // callback stored for it goes. A person's own account is not routed.
  if (scope.rootPath !== "/") return { row: await connected() };
  const path = connectionPathOf("x", connection);
  // a reconnect's callback replaced the live token already: only a connection with no row is new
  const isNew = !(await connectionRowOf(scope.env, scope.projectId, path));
  try {
    return {
      row: await routedWhile(
        scope.env,
        {
          provider: "x",
          externalId: data.id,
          projectId: scope.projectId,
          path,
        },
        connected,
      ),
    };
  } catch (error) {
    if (isNew) await deleteTokenSecret(scope, "x", connection);
    throw error;
  }
}
