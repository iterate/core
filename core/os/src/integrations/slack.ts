// src/integrations/slack.ts — SLACK: a connection is one workspace (connections.ts), through the
// deployment's own Slack app (ITERATE `integrations.slack`). Its bot token lives in
// `/secrets/slack-<connection>`; outbound calls carry
// `getSecret("/secrets/slack-<connection>", { field: "accessToken" })` through egress. (A project's
// own Slack app is a package the project hosts, iterate/sdk `Integration`: its consent through
// `itx.secrets.beginOAuth` with the client in the clear, its webhook on the project's own host.)
//   connectSlack      → the consent URL (`itx.secrets.beginOAuth`, `client: { platform: "slack" }`)
//   finishSlackConnect → the callback stored the token: `auth.test` names the workspace, iterate's
//                       app routes it here (control-plane/catalog.ts), `slack/connected` lands on `/`;
//                       or, for a workspace another project holds, the secret held the token aside
//                       and the human is offered the move (Slack let them install into it: the proof)
//   connectMovedSlackTeam → the move (verbs.ts `confirmIntegrationMove`): the held token stored here
//   revokeSlack       → a disconnect's `auth.revoke` (verbs.ts `PROVIDERS`), when its release of
//                       the workspace's route wins
//   slackWebhookRoute → Slack's inbound requests, on the URLs the app is registered with:
//     POST /api/integrations/slack/{webhook,interactivity-webhook}
// A signed request lands on `<project>:/integrations/slack/<connection>` as
// `slack/webhook-received`, keyed `slack-webhook:<event_id|trigger_id>` (the codes: rules.ts).
import { codedError, errorCode } from "iterate/lib";
import { z } from "zod";
import { iterateConfigOf } from "../iterate-config.ts";
import { DurableObjectNameCodec } from "../context/paths.ts";
import { ControlPlane } from "../control-plane/edge.ts";
import type { Env } from "../env.ts";
import { SECRET_OAUTH_TTL_MS } from "../secret-oauth.ts";
import { verifySecretHmac } from "../secrets.ts";
import type { IntegrationConnectionRow } from "./contract.ts";
import {
  appendConnected,
  appendPlatformFact,
  attemptKeyOf,
  consentAttemptKeyOf,
  connectionPathOf,
  ignoredWebhook,
  ownerEgress,
  routedWhile,
  tokenSecretPathOf,
  type ConnectionAttempt,
  type HeldToken,
  type IntegrationMove,
  type IntegrationScope,
  type MovableAttempt,
  type MoveOffered,
} from "./connections.ts";
import { slackPayloadOf, slackSignatureValid, slackTeamIdOf } from "./rules.ts";

/** The bot token's Slack Web API call, through egress. */
function slackApi(scope: IntegrationScope, origin: string, method: string, connection: string) {
  return ownerEgress(
    scope.env,
    scope,
    new Request(`${origin}/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer getSecret("${tokenSecretPathOf("slack", connection)}", { field: "accessToken" })`,
      },
    }),
  );
}

export async function connectSlack(
  scope: IntegrationScope,
  input: {
    connection: string;
    next?: string;
    /** More bot scopes than the app's default: a reinstall asks for the union. */
    scopes?: readonly string[];
    /** The connection, when it exists: the reinstall must come back for its team. */
    existing?: IntegrationConnectionRow;
  },
): Promise<{ authorizationUrl: string }> {
  const { connection } = input;
  // iterate's app at Slack (`slackOrigin` is a fake's on a preview)
  const slack = iterateConfigOf(scope.env).integrations.slack;
  if (!slack)
    throw codedError(
      "INVALID_INPUT",
      "This deployment has no Slack app (ITERATE integrations.slack).",
    );
  const { slackOrigin: origin, scopes } = slack;
  using itx = scope.getItx();
  const { authorizationUrl, nonce } = await itx.secrets.beginOAuth(
    tokenSecretPathOf("slack", connection),
    {
      authorizationEndpoint: `${origin}/oauth/v2/authorize`,
      tokenEndpoint: `${origin}/api/oauth.v2.access`,
      client: { platform: "slack" },
      clientAuth: "client_secret_post",
      scope: [...new Set([...scopes, ...(input.scopes || [])])].join(","),
      // files.slack.com serves a shared file's download (url_private)
      urls: origin === "https://slack.com" ? [origin, "https://files.slack.com"] : [origin],
      next: input.next,
      expectAccount: input.existing?.externalId,
    },
  );
  const attempt: ConnectionAttempt = {
    origin,
    until: Date.now() + SECRET_OAUTH_TTL_MS,
  };
  await scope.storage.put(consentAttemptKeyOf("slack", connection, nonce), attempt);
  // a new consent supersedes an offer to move a workspace here (its held token went with `beginOAuth`)
  await scope.storage.delete(attemptKeyOf("slack", connection));
  return { authorizationUrl };
}

/** The callback's finish (verbs.ts `finishIntegrationConnect`). `held`: the secret held the token
 *  aside, because another project's connection held the workspace when Slack answered — Slack let
 *  the human install iterate's app into it, which is all a move asks, so they are offered the move
 *  (answered for the callback to sign), bound to a fresh nonce; a workspace released meanwhile has
 *  its token stored and connects like any other. */
export async function finishSlackConnect(
  scope: IntegrationScope,
  connection: string,
  attempt: ConnectionAttempt,
  { held }: { held?: HeldToken & { nonce: string } },
) {
  const { env, projectId } = scope;
  if (held) {
    const holder = await new ControlPlane(env).integrationRouteOf("slack", held.externalId);
    if (holder && holder.projectId !== projectId) {
      const move: IntegrationMove = {
        externalId: held.externalId,
        account: held.account,
        holder,
        heldTokenNonce: held.nonce,
      };
      const offered: MovableAttempt = {
        origin: attempt.origin,
        until: held.until,
        nonce: crypto.randomUUID(),
        move,
      };
      await scope.storage.put(attemptKeyOf("slack", connection), offered);
      return { move: slackMoveOffered(scope, connection, offered.nonce, offered.until, move) };
    }
    // Released meanwhile: the workspace is routed here first (first owner wins), and only then is
    // the token stored — a project that took it in between refuses the route, the token stays held,
    // and the callback again offers the move.
    const path = connectionPathOf("slack", connection);
    const row = await routedWhile(
      env,
      { provider: "slack", externalId: held.externalId, projectId, path },
      async () => {
        await admitHeldToken(scope, connection, held.nonce);
        const identity = await slackIdentityOf(scope, attempt.origin, connection);
        if (identity.teamId !== held.externalId)
          throw new Error(
            `Slack's auth.test names workspace ${identity.teamId}, not ${held.externalId}`,
          );
        return slackConnected(scope, connection, identity);
      },
    );
    return { row };
  }
  const identity = await slackIdentityOf(scope, attempt.origin, connection);
  // iterate's app routes the team here while `connected` lands; a failure puts the routes back
  const path = connectionPathOf("slack", connection);
  const row = await routedWhile(
    env,
    { provider: "slack", externalId: identity.teamId, projectId, path },
    () => slackConnected(scope, connection, identity),
  );
  return { row };
}

/** The offer this consent's finish made already, while it stands untouched: a replay of its callback
 *  (a refreshed tab, an answer lost on the way) lands on the same offer. */
export async function slackMoveOfferedAgain(
  scope: IntegrationScope,
  connection: string,
  heldTokenNonce: string,
): Promise<MoveOffered | undefined> {
  const offered = await scope.storage.get<MovableAttempt>(attemptKeyOf("slack", connection));
  if (
    !offered?.move ||
    offered.move.heldTokenNonce !== heldTokenNonce ||
    offered.move.stage ||
    offered.until <= Date.now()
  )
    return undefined;
  return slackMoveOffered(scope, connection, offered.nonce, offered.until, offered.move);
}

function slackMoveOffered(
  scope: IntegrationScope,
  connection: string,
  nonce: string,
  until: number,
  move: IntegrationMove,
): MoveOffered {
  return {
    provider: "slack",
    projectId: scope.projectId,
    connection,
    nonce,
    externalId: move.externalId,
    account: move.account,
    holderProjectId: move.holder.projectId,
    exp: until,
  };
}

/** A WORKSPACE MOVED HERE (verbs.ts `confirmIntegrationMove`, its route this connection's already):
 *  the token the consent's exchange held aside stored in the connection's secret, `auth.test` through
 *  egress proving it names that workspace, then `slack/connected`. On a failure the confirm drops
 *  what the consent left (`dropHeldSlackToken`): the connection had no token of its own (one that
 *  holds a workspace is only ever asked for more of the same one). */
export async function connectMovedSlackTeam(
  scope: IntegrationScope,
  connection: string,
  attempt: ConnectionAttempt,
  move: IntegrationMove,
): Promise<void> {
  await admitHeldToken(scope, connection, move.heldTokenNonce || "");
  const identity = await slackIdentityOf(scope, attempt.origin, connection);
  if (identity.teamId !== move.externalId)
    throw new Error(`Slack's auth.test names workspace ${identity.teamId}, not ${move.externalId}`);
  await slackConnected(scope, connection, identity);
}

/** The held token stored in the connection's secret (secret/durable-object.ts `admitHeldToken`): the
 *  platform's own call, which no member's itx reaches. */
async function admitHeldToken(scope: IntegrationScope, connection: string, nonce: string) {
  await scope.env.ITERATE_CONTEXT.getByName(
    DurableObjectNameCodec.stringify({ projectId: scope.projectId, path: "/" }),
  ).invoke(
    [
      "itx",
      "builtins",
      "secrets",
      ["admitHeldToken", tokenSecretPathOf("slack", connection), { nonce }],
    ],
    [],
    { principal: null, platform: true },
  );
}

/** WHAT A FAILED MOVE LEFT OF ITS CONSENT, gone: the held token, or the token its admit stored while
 *  the secret still holds that one; a write since is someone else's (secret/durable-object.ts
 *  `dropHeldToken`). */
export async function dropHeldSlackToken(
  scope: IntegrationScope,
  connection: string,
  nonce: string,
): Promise<void> {
  await scope.env.ITERATE_CONTEXT.getByName(
    DurableObjectNameCodec.stringify({ projectId: scope.projectId, path: "/" }),
  ).invoke(
    [
      "itx",
      "builtins",
      "secrets",
      ["dropHeldToken", tokenSecretPathOf("slack", connection), { nonce }],
    ],
    [],
    { principal: null, platform: true },
  );
}

/** The workspace the connection's token is for: Slack's `auth.test` through egress. */
async function slackIdentityOf(
  scope: IntegrationScope,
  origin: string,
  connection: string,
): Promise<{ teamId: string; team: string }> {
  const response = await slackApi(scope, origin, "auth.test", connection);
  const identity = SlackAuthTest.safeParse(await response.json().catch(() => null));
  if (!identity.success)
    throw new Error(`Slack's auth.test answered ${response.status}, naming no workspace`);
  return { teamId: identity.data.team_id, team: identity.data.team || identity.data.team_id };
}
const SlackAuthTest = z.object({
  ok: z.literal(true),
  team_id: z.string().min(1),
  team: z.string().optional(),
});

function slackConnected(
  scope: IntegrationScope,
  connection: string,
  identity: { teamId: string; team: string },
) {
  return appendConnected(scope, {
    provider: "slack",
    connection,
    account: identity.team,
    externalId: identity.teamId,
  });
}

/** A disconnect's revoke, before verbs.ts `disconnectIntegration` releases the connection's routes.
 *  Slack keeps one bot token per app and workspace, so revoking iterate's app's ends it for every
 *  connection of the workspace: only the connection that still held the route may, which its own
 *  release answers (one statement: a move of the route and this release never both win), and only
 *  while no project routed the workspace since — read again, fresh, right before the revoke. A
 *  token already dead is the goal, so the revoke is best-effort. */
export async function revokeSlack(
  scope: IntegrationScope,
  connection: string,
  row: IntegrationConnectionRow | undefined,
) {
  if (!row) return;
  const controlPlane = new ControlPlane(scope.env);
  const path = connectionPathOf("slack", connection);
  const revokes =
    (await controlPlane.releaseIntegrationRoute("slack", row.externalId, scope.projectId, path)) &&
    !(await controlPlane.integrationRouteOf("slack", row.externalId));
  // a deployment that dropped its Slack app leaves nothing to revoke with: the disconnect completes
  const origin = iterateConfigOf(scope.env).integrations.slack?.slackOrigin;
  if (!revokes || !origin) return;
  try {
    const response = await slackApi(scope, origin, "auth.revoke", connection);
    await response.body?.cancel();
  } catch {
    // best effort: a token already dead is the goal
  }
}

const SLACK_WEBHOOK_PATH = /^\/api\/integrations\/slack\/(webhook|interactivity-webhook)$/;

/** A Slack request's response (rules.ts), or null when the path is not Slack's. */
export async function slackWebhookRoute(request: Request, env: Env): Promise<Response | null> {
  const match = SLACK_WEBHOOK_PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const [, endpoint] = match;
  const slack = iterateConfigOf(env).integrations.slack;
  if (!slack)
    return Response.json({ error: "Slack integration is not configured." }, { status: 503 });
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signed = await slackSignatureValid({
    rawBody,
    timestamp,
    signature: request.headers.get("x-slack-signature"),
    nowSeconds: Math.floor(Date.now() / 1000),
    hmacHexMatches: (payload, signature) =>
      verifySecretHmac(slack.webhookSigningSecret.exposeSecret(), { payload, signature }),
  });
  if (!signed) return Response.json({ error: "Invalid Slack signature." }, { status: 401 });
  const body = slackPayloadOf(rawBody, endpoint === "interactivity-webhook");
  if (body?.type === "url_verification") return Response.json({ challenge: body.challenge });
  if (!body) return ignoredWebhook("unparseable-payload");
  const teamId = slackTeamIdOf(body);
  if (!teamId) return ignoredWebhook("no-team-id");
  const route = await new ControlPlane(env).integrationRouteOf("slack", teamId);
  if (!route) return ignoredWebhook("unrouted-team");
  const eventId = typeof body.event_id === "string" ? body.event_id : null;
  const triggerId = typeof body.trigger_id === "string" ? body.trigger_id : null;
  try {
    await appendPlatformFact(env, route.projectId, route.path, {
      type: "events.iterate.com/slack/webhook-received",
      idempotencyKey: `slack-webhook:${eventId || triggerId || crypto.randomUUID()}`,
      payload: { body, teamId, slackRequestTimestamp: timestamp },
    });
  } catch (error) {
    // A redelivery carries a new timestamp, so its body differs from the one stored under the key:
    // already stored.
    if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
  }
  return Response.json({ ok: true });
}
