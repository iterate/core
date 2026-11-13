// The default config's "Cloudflare" card (core/configs/default/cloudflare.ts): a mind with the
// stack's token shows the connection right after a publish, as Cloudflare's MCP server answered;
// a mind without it says how to get one. The fake registry takes only what the real one takes
// (the contract's own schemas).
import { expect, test } from "vitest";
import { cloudflareConnectionEvent } from "../../configs/default/cloudflare.ts";
import { IntegrationRegistryContract } from "./integrations.ts";

const CLOUD = "https://cloud.example.com";
const PUBLISHED = { type: "events.iterate.com/mind/worker-updated", path: "/" };
const ACCOUNT = "aaaaabbbbbccccc111112222233333aa";

test("right after a publish, a mind with the token shows the connection: what the MCP server named, and when it asked", async () => {
  const mind = cloudflareMind({ token: true });

  await cloudflareConnectionEvent(mind.itx, PUBLISHED);

  const { card, row } = mind.registry();
  expect(card).toMatchObject({
    title: "Cloudflare",
    icon: { routingSlug: "dash", path: "/brands/cloudflare.svg" },
    status: { kind: "ok", text: "Connected" },
  });
  expect(card?.description).toMatch(/itx\.config\.cloudflare\(tool, args\)/);
  expect(row).toMatchObject({
    account: "Ada's account",
    status: { kind: "ok" },
    details: {
      "Account id": ACCOUNT,
      Server: "https://mcp.cloudflare.com/mcp",
      Secret: "/secrets/cloudflare",
    },
  });
  expect(row?.details?.Checked).toMatch(/^\d{4}-\d\d-\d\dT.*: whoami answered$/);
  // the server was asked with the secret's placeholder, never the token, and the session closed
  expect(mind).toMatchObject({
    asked: [
      {
        url: "https://mcp.cloudflare.com/mcp",
        authorization: 'Bearer getSecret("/secrets/cloudflare", { field: "token" })',
        tool: "whoami",
        closed: true,
      },
    ],
  });

  // another event, or a secret's fact for another path, asks nothing
  await cloudflareConnectionEvent(mind.itx, { type: "events.iterate.com/itx/woken", path: "/" });
  await cloudflareConnectionEvent(mind.itx, {
    type: "events.iterate.com/secret/set",
    path: "/",
    payload: { path: "/secrets/google" },
  });
  expect(mind.asked.length).toBe(1);
});

test("a server that refuses the token, or does not answer, makes the card say so", async () => {
  const mind = cloudflareMind({ token: true, refuses: "401 invalid_token" });
  await cloudflareConnectionEvent(mind.itx, PUBLISHED);
  const { card, row } = mind.registry();
  expect(card).toMatchObject({ status: { kind: "error" } });
  expect(row).toMatchObject({
    account: "Cloudflare account",
    status: { kind: "error", text: "401 invalid_token" },
  });
  expect(row?.details).not.toHaveProperty("Account id");
  expect(row?.details?.Checked).toMatch(/: failed$/);
});

test("without the token the card says how to get one, and a token set later connects it", async () => {
  const mind = cloudflareMind({ token: false });
  await cloudflareConnectionEvent(mind.itx, PUBLISHED);
  expect(mind.registry()).toEqual({
    card: expect.objectContaining({
      status: {
        kind: "attention",
        text: "Not connected. Run “Update iterate” on this deployment in iterate Cloud.",
      },
      actions: [{ label: "Open iterate Cloud", url: `${CLOUD}/deployments` }],
    }),
    row: undefined,
  });
  expect(mind).toMatchObject({ asked: [] });

  // the root stores the stack's token at its next wake
  mind.token = true;
  await cloudflareConnectionEvent(mind.itx, {
    type: "events.iterate.com/secret/set",
    path: "/",
    payload: { path: "/secrets/cloudflare" },
  });
  expect(mind.registry().card).toMatchObject({ status: { kind: "ok" } });
  expect(mind.registry().row).toMatchObject({ account: "Ada's account" });

  // and a deleted token takes the row away
  mind.token = false;
  await cloudflareConnectionEvent(mind.itx, {
    type: "events.iterate.com/secret/deleted",
    path: "/",
    payload: { path: "/secrets/cloudflare" },
  });
  expect(mind.registry().row).toBeUndefined();
  expect(mind.registry().card).toMatchObject({ status: { kind: "attention" } });
});

test("a mind whose stack names no Cloud is told to deploy with the field, with no link", async () => {
  const mind = cloudflareMind({ token: false, cloud: false });
  await cloudflareConnectionEvent(mind.itx, PUBLISHED);
  expect(mind.registry().card).toMatchObject({
    status: { kind: "attention", text: expect.stringMatching(/cloudflareToken: true/) },
    actions: [],
  });
});

type Row = { details?: Record<string, string> } & Record<string, unknown>;

/** A mind with or without the stack's Cloudflare token, whose MCP server names ACCOUNT or
 *  refuses with `refuses`. */
function cloudflareMind(given: { token: boolean; cloud?: boolean; refuses?: string }) {
  const state = {
    integrations: {} as Record<string, unknown>,
    connections: {} as Record<string, unknown>,
  };
  const events = IntegrationRegistryContract.events;
  const mind = {
    token: given.token,
    asked: [] as { url: string; authorization?: string; tool: string; closed: boolean }[],
    registry: () =>
      structuredClone({
        card: state.integrations.cloudflare as Record<string, unknown> | undefined,
        row: state.connections["cloudflare/account"] as Row | undefined,
      }),
    itx: {
      secrets: {
        describe: async (path: string) => ({ set: path === "/secrets/cloudflare" && mind.token }),
        cloud: async () => (given.cloud === false ? null : { origin: CLOUD }),
      },
      connectToMcp: async (url: string, options: { headers: Record<string, string> }) => {
        if (given.refuses) throw new Error(given.refuses);
        const call = { url, authorization: options.headers.authorization, tool: "", closed: false };
        mind.asked.push(call);
        return {
          callTool: async (tool: string) => {
            call.tool = tool;
            return { id: `account:${ACCOUNT}`, name: "Ada's account" };
          },
          close: async () => void (call.closed = true),
        };
      },
      cd: (path: string) => ({
        append: async (event: { type: string; payload: Record<string, unknown> }) => {
          expect(path).toBe("/integrations");
          if (event.type === "events.iterate.com/integration/configured") {
            const { integration, card } = events[
              "events.iterate.com/integration/configured"
            ].payloadSchema.parse(event.payload);
            if (card) state.integrations[integration] = card;
            else delete state.integrations[integration];
          } else {
            const { integration, connection, row } = events[
              "events.iterate.com/integration/connection-configured"
            ].payloadSchema.parse(event.payload);
            expect(state.integrations).toHaveProperty(integration);
            if (row) state.connections[`${integration}/${connection}`] = row;
            else delete state.connections[`${integration}/${connection}`];
          }
        },
        facets: {
          get: <T>() => ({ snapshot: async () => ({ state: structuredClone(state) }) }) as T,
        },
      }),
    },
  };
  return mind;
}
