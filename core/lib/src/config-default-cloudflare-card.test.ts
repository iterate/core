// The default config's "Cloudflare" card (core/configs/default/cloudflare.ts): a mind with the
// stack's token shows the connection right after a publish, as Cloudflare's API answered;
// a mind without it says how to get one. The fake registry takes only what the real one takes
// (the contract's own schemas).
import { expect, test } from "vitest";
import { cloudflareConnectionEvent } from "../../configs/default/cloudflare.ts";
import { IntegrationRegistryContract } from "./integrations.ts";

const CLOUD = "https://cloud.example.com";
const PUBLISHED = { type: "events.iterate.com/mind/worker-updated", path: "/" };
const ACCOUNT = "aaaaabbbbbccccc111112222233333aa";

test("right after a publish, a mind with the token shows the connection: the account that Cloudflare named, and when it was asked", async () => {
  const mind = cloudflareMind({ token: true });

  await cloudflareConnectionEvent(mind.itx, PUBLISHED);

  const { card, row } = mind.registry();
  expect(card).toMatchObject({
    title: "Cloudflare",
    icon: { routingSlug: "dash", path: "/brands/cloudflare.svg" },
    status: { kind: "ok", text: "Connected" },
  });
  expect(card?.description).toMatch(/itx\.config\.cloudflare\(tool, args\)/);
  // the token reads the account and changes nothing in it: the card says so, and offers no change
  expect(card?.description).toMatch(/query logs and traces\. The credential changes nothing/);
  expect(card?.description).not.toMatch(/DNS|routes|profile/);
  expect(row).toMatchObject({
    account: "Ada's account",
    status: { kind: "ok" },
    details: {
      "Account id": ACCOUNT,
      API: "https://api.cloudflare.com/client/v4",
      Credential: "the stack's API token",
      Secret: "/secrets/cloudflare",
    },
  });
  expect(row?.details).not.toHaveProperty("Also reaches");
  expect(row?.details?.Checked).toMatch(/^\d{4}-\d\d-\d\dT.*: Cloudflare answered$/);
  // Cloudflare was asked with the secret's placeholder, never the token
  expect(mind).toMatchObject({
    asked: [
      {
        url: "https://api.cloudflare.com/client/v4/accounts?per_page=50",
        authorization: 'Bearer getSecret("/secrets/cloudflare", { field: "token" })',
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

test("a consent that the vault refreshes is asked by its own field, and a connection that reaches more than one account says so", async () => {
  const mind = cloudflareMind({ token: true, refresh: "oauth-refresh-token", accounts: 3 });
  await cloudflareConnectionEvent(mind.itx, PUBLISHED);
  expect(mind.registry().row?.details).toMatchObject({
    Credential: "a consent at Cloudflare, which the vault refreshes",
    "Also reaches": "2 more account(s)",
  });
  expect(mind.asked).toMatchObject([
    { authorization: 'Bearer getSecret("/secrets/cloudflare", { field: "accessToken" })' },
  ]);
});

test("a Cloudflare that refuses the credential makes the card say so", async () => {
  const mind = cloudflareMind({ token: true, refuses: 403 });
  await cloudflareConnectionEvent(mind.itx, PUBLISHED);
  const { card, row } = mind.registry();
  expect(card).toMatchObject({ status: { kind: "error" } });
  expect(row).toMatchObject({
    account: "Cloudflare account",
    status: { kind: "error", text: "Cloudflare answered 403" },
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

/** A mind with or without a Cloudflare credential (the stack's token, or with `refresh` a
 *  consent), whose Cloudflare names ACCOUNT first of `accounts`, or refuses with the status
 *  `refuses`. */
function cloudflareMind(given: {
  token: boolean;
  cloud?: boolean;
  refuses?: number;
  refresh?: string;
  accounts?: number;
}) {
  const state = {
    integrations: {} as Record<string, unknown>,
    connections: {} as Record<string, unknown>,
  };
  const events = IntegrationRegistryContract.events;
  const mind = {
    token: given.token,
    asked: [] as { url: string; authorization: string | null }[],
    registry: () =>
      structuredClone({
        card: state.integrations.cloudflare as Record<string, unknown> | undefined,
        row: state.connections["cloudflare/account"] as Row | undefined,
      }),
    itx: {
      secrets: {
        describe: async (path: string) => ({
          set: path === "/secrets/cloudflare" && mind.token,
          refresh: given.refresh,
        }),
        collectFromUser: async () => ({ url: "" }),
        cloud: async () => (given.cloud === false ? null : { origin: CLOUD }),
      },
      fetch: async (request: Request) => {
        if (given.refuses) return new Response("no", { status: given.refuses });
        mind.asked.push({ url: request.url, authorization: request.headers.get("authorization") });
        return Response.json({
          result: Array.from({ length: given.accounts ?? 1 }, (_, index) => ({
            id: index ? `${index}`.repeat(32) : ACCOUNT,
            name: index ? `Another account ${index}` : "Ada's account",
          })),
        });
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
