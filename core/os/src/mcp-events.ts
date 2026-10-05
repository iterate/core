// mcp-events.ts — MCP EVENTS ON OUR MCP SERVER: the webhook mode of the draft MCP Events extension
// (github.com/modelcontextprotocol/experimental-ext-triggers-events), as ChatGPT speaks it. One
// event, `event.appended`: an event appended to a context the caller's grant reaches, delivered as
// it is in the log. Its arguments are the filter: the project, the context's path, and the event
// types (none: every event). A subscription is a fan-out row on that context, named by the
// subscription's id, whose target is `itx.webhooks` in its MCP form (context/built-ins.ts): the
// client's secret is a project secret pinned to the callback's origin, and a schedule on the context
// removes the row at the granted `refreshBefore`, which a refresh moves. Nothing else is stored.

import { ProtocolError, type McpServer } from "@modelcontextprotocol/server";
import { errorCode } from "iterate/lib";
import { Webhook } from "standardwebhooks";
import { z } from "zod";
import type { ItxExpression, ItxExpressionStep } from "iterate/expression";
import { sha256Hex, type Caller } from "./caller.ts";
import type { contextStub } from "./context-stub.ts";

/** How long a subscription lives unless renewed: a day, the draft's recommended ceiling, so a
 *  revoked grant stops its deliveries within a day. */
const SUBSCRIPTION_TTL_MS = 24 * 60 * 60 * 1000;

/** `event.appended` as `events/list` describes it. */
const EVENT_APPENDED = {
  name: "event.appended",
  description:
    "An event was appended to a context in an iterate project. The event's data is the raw event: its type, payload, path, offset, createdAt and source.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The project: its slug or its id." },
      path: {
        type: "string",
        description: "The context to watch, e.g. /agents/research. Default: the project's root, /.",
      },
      types: {
        type: "array",
        items: { type: "string" },
        description:
          "Only events of these types, e.g. events.iterate.com/agent/web-message-sent for an agent's replies. Omit for every event.",
      },
    },
    required: ["project"],
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      type: { type: "string" },
      payload: { type: "object" },
      path: { type: "string" },
      offset: { type: "integer" },
      createdAt: { type: "string", format: "date-time" },
      source: { type: "object" },
    },
    required: ["type", "path", "offset", "createdAt"],
  },
};

/** What names a subscription besides its caller: the event, its arguments and the callback URL. */
const SubscriptionKey = z.object({
  name: z.string(),
  arguments: z.strictObject({
    project: z.string().trim().min(1),
    path: z.string().startsWith("/").default("/"),
    types: z.array(z.string().min(1)).min(1).optional(),
  }),
  delivery: z.object({ url: z.url({ protocol: /^https$/ }) }),
});
const SubscribeParams = SubscriptionKey.extend({
  delivery: SubscriptionKey.shape.delivery.extend({
    mode: z.literal("webhook"),
    // Standard Webhooks: base64 of 24 to 64 bytes
    secret: z.string().regex(/^whsec_[A-Za-z0-9+/]{32,86}={0,2}$/),
  }),
  ttlMs: z.number().nullish(),
});

/** Serve `events/list`, `events/subscribe` and `events/unsubscribe` on `mcpServer` for `caller`.
 *  `projectOf` resolves a requested project within the caller's grant (or throws), and `rootOf`
 *  reaches its root. */
export function registerMcpEvents(
  mcpServer: McpServer,
  deps: {
    caller: Caller;
    projectOf: (requested: string) => Promise<string>;
    rootOf: (projectId: string) => Pick<ReturnType<typeof contextStub>, "invoke">;
  },
) {
  /** The subscription a key names: its id, deterministic over the caller, the callback URL and
   *  the filter (types sorted), so subscribing again refreshes it and no one else can name it; the
   *  context it watches (`at`, a step from the root); the secret it signs with; and `invoke`, one
   *  call from the project's root as the caller. */
  const subscriptionOf = async (key: z.output<typeof SubscriptionKey>) => {
    if (key.name !== EVENT_APPENDED.name)
      throw new ProtocolError(-32011, "NotFound", { kind: "event" });
    const projectId = await deps.projectOf(key.arguments.project).catch((error: unknown) => {
      // a project outside the caller's grant: the draft's Forbidden, which a client reads as such
      if (errorCode(error) !== "FORBIDDEN") throw error;
      throw new ProtocolError(-32012, "Forbidden", {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    const { path } = key.arguments;
    const types = key.arguments.types && [...new Set(key.arguments.types)].sort();
    const digest = await sha256Hex(
      JSON.stringify([deps.caller.principal, key.delivery.url, projectId, path, types || null]),
    );
    const id = `sub_${digest.slice(0, 32)}`;
    const root = deps.rootOf(projectId);
    return {
      id,
      types,
      at: ["cd", path] satisfies ItxExpressionStep,
      secretPath: `/secrets/mcp-events-${id}`,
      invoke: (steps: ItxExpression, args: unknown[] = []) =>
        root.invoke(["itx", "builtins", ...steps], args, deps.caller),
    };
  };

  mcpServer.server.setRequestHandler("events/list", { params: z.object({}) }, () => ({
    events: [EVENT_APPENDED],
  }));

  mcpServer.server.setRequestHandler(
    "events/subscribe",
    { params: SubscribeParams },
    async (key) => {
      const { id, types, at, secretPath, invoke } = await subscriptionOf(key);
      const existing = await invoke([at, "subscriptions", ["get", id]]);
      // the callback answers a signed challenge before its first event (a refresh is no new
      // callback), sent the way its events will be: through the watched context's own `itx.fetch`
      if (!existing)
        await verifyCallback(
          id,
          key.delivery,
          // `itx.fetch` answers a Response (BuiltInScope `fetch`); `invoke` types every answer unknown
          (request) => invoke([at, "fetch"], [request]) as Promise<Response>,
        );
      await invoke([
        "secrets",
        ["set", secretPath, key.delivery.secret, { urls: [new URL(key.delivery.url).origin] }],
      ]);
      // the client's suggested lifetime, within a minute and a day; none, or no expiry (null): a day
      const ttlMs = Math.min(
        Math.max(key.ttlMs ?? SUBSCRIPTION_TTL_MS, 60_000),
        SUBSCRIPTION_TTL_MS,
      );
      const refreshBefore = new Date(Date.now() + ttlMs).toISOString();
      // One append: the lapse, the row's removal scheduled under the subscription's id, so a refresh
      // moves it; then the row, unless it stands. The row begins after both, so it never delivers
      // its own lapse.
      await invoke([
        at,
        [
          "append",
          {
            type: "events.iterate.com/itx/schedule-set",
            payload: {
              key: id,
              when: { at: refreshBefore },
              events: [
                {
                  type: "events.iterate.com/itx/subscription-configured",
                  payload: { name: id, target: null },
                },
              ],
            },
          },
          ...(existing
            ? []
            : [
                {
                  type: "events.iterate.com/itx/subscription-configured",
                  payload: {
                    name: id,
                    target: [
                      "itx",
                      "builtins",
                      "webhooks",
                      [
                        "get",
                        { url: key.delivery.url, signingSecret: secretPath, mcpSubscription: id },
                      ],
                      "deliverEvent",
                    ],
                    consumes: types,
                    ordered: false,
                  },
                },
              ]),
        ],
      ]);
      return { id, refreshBefore, cursor: null, truncated: false };
    },
  );

  mcpServer.server.setRequestHandler(
    "events/unsubscribe",
    { params: SubscriptionKey },
    async (key) => {
      const { id, at, secretPath, invoke } = await subscriptionOf(key);
      if (await invoke([at, "subscriptions", ["get", id]]))
        await invoke([
          at,
          [
            "append",
            {
              type: "events.iterate.com/itx/subscription-configured",
              payload: { name: id, target: null },
            },
            { type: "events.iterate.com/itx/schedule-cancelled", payload: { key: id } },
          ],
        ]);
      // a lapsed subscription keeps its secret until this; one never set has none to delete
      await invoke(["secrets", ["delete", secretPath]]).catch((error: unknown) => {
        if (errorCode(error) !== "SECRET_NOT_SET") throw error;
      });
      return {};
    },
  );
}

/** POST the callback a signed `verification` challenge through `fetch` and require it echoed in a
 *  2xx answer within 10 s (the draft's endpoint verification), else `CallbackEndpointError`. A
 *  redirect is an answer, never followed. The wait is ours: a signal does not cross to the context. */
async function verifyCallback(
  id: string,
  { url, secret }: { url: string; secret: string },
  fetch: (request: Request) => Promise<Response>,
) {
  const challenge = crypto.randomUUID();
  const body = JSON.stringify({ type: "verification", challenge });
  const webhookId = `msg_verification_${challenge}`;
  const now = new Date();
  const request = new Request(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
      "webhook-signature": new Webhook(secret).sign(webhookId, now, body),
      "x-mcp-subscription-id": id,
    },
    body,
  });
  const answer = await Promise.race([
    fetch(request).then(async (response) => {
      const echoed: unknown = await response.json().catch(() => null);
      return response.ok && echoed;
    }),
    new Promise((resolve) => setTimeout(resolve, 10_000, null)),
  ]).catch(() => null);
  if (z.object({ challenge: z.literal(challenge) }).safeParse(answer).error)
    throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "challenge_failed" });
}
