// cloudflare.ts — THE MIND'S CLOUDFLARE CONNECTION (cloudflare.md): Cloudflare's REST API, called
// with the credential of the mind's own account at `/secrets/cloudflare`. With it the mind's
// agents read the account and query its logs and traces, and change nothing in it (core/alchemy
// README, "The mind's Cloudflare token", says what it may do and why).
//
// THE CREDENTIAL IS ONE OF TWO KINDS, and this file reads which. The stack's API token: a stack
// whose config says `cloudflareToken: true` keeps it in the vault, and its field is `token`. Or a
// consent at Cloudflare that the vault refreshes: its field is `accessToken`. Cloudflare's own MCP
// server is not used: it refuses a consent that lacks the right to read the person's own details
// and the account's settings, which this connection does not ask for.
//
// Three things here: the call an agent makes (`cloudflareForAgent`, `itx.config.cloudflare`); the
// billing token, a second credential for the cost of the account alone (`cloudflareBillingToken`,
// `cloudflareBilling`); and the connection's card on the Dash's Integrations page
// (`cloudflareConnectionEvent`, which worker.ts calls for every event). The card is made true at
// each publish of this repo (`mind/worker-updated`) and when the secret is set or deleted: with
// the secret, the mind asks Cloudflare which accounts it reaches, so "Connected" is what
// Cloudflare answered at that time, and the row says when; without it, the card says how to get
// one.
import { jsonEqual } from "iterate/lib";
import { z } from "zod";

const CLOUDFLARE_TOKEN_SECRET = "/secrets/cloudflare";
const CLOUDFLARE_API = "https://api.cloudflare.com";
const CLOUDFLARE_REST = `${CLOUDFLARE_API}/client/v4`;
/** The paths of Cloudflare's API that make a lasting export of the account's data to an address:
 *  an observability destination, a notification webhook, a Logpush job. This call refuses a
 *  request that names one. It reads the request's text, so a path built elsewhere passes: it slows
 *  an agent and stops no one. The credential itself, through `itx.fetch`, is not guarded at all. */
const EXPORTS = /observability\/destinations|alerting\/v3\/destinations|logpush\/jobs/;
/** A path of Cloudflare's API: it starts with one slash and has no `.` or `..` part. */
const REST_PATH = /^\/(?!\/)[^\s#\\]*$/;
const DOTS = /(^|\/)(\.|%2e){1,2}(\/|\?|$)/i;
/** The longest answer that goes back whole, in characters (about 6,000 tokens). */
const ANSWER_MOST = 24_000;

/** What `/secrets/cloudflare` is, as the vault describes it. */
type Held = { set: boolean; refresh?: string };

/** One request to Cloudflare's REST API with the mind's credential, as a placeholder that the
 *  vault fills in on the way out. A consent that the vault refreshes keeps its token as
 *  `accessToken`; the stack's token is the field `token`. */
async function cloudflareRequest(
  itx: Pick<CloudflareItx, "fetch">,
  held: Held,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const field = held.refresh === "oauth-refresh-token" ? "accessToken" : "token";
  const withBody = body !== undefined && method !== "GET";
  const answer = await itx.fetch(
    new Request(`${CLOUDFLARE_REST}${path}`, {
      method,
      headers: {
        authorization: `Bearer getSecret("${CLOUDFLARE_TOKEN_SECRET}", { field: "${field}" })`,
        ...(withBody && { "content-type": "application/json" }),
      },
      body: withBody ? JSON.stringify(body) : undefined,
      // the credential goes to Cloudflare's API alone
      redirect: "manual",
    }),
  );
  return { status: answer.status, text: await answer.text() };
}

/** Cloudflare's list of accounts, as far as this file reads it: one page of at most 50, and how
 *  many there are in all. */
const Accounts = z.object({
  result: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
  result_info: z.object({ total_count: z.number().int() }).optional(),
});
/** How many accounts the credential reaches: Cloudflare's count, or the page's own. */
const countOf = (accounts: z.infer<typeof Accounts>) =>
  Math.max(accounts.result_info?.total_count ?? 0, accounts.result.length);
/** What `execute` takes. */
const Execute = z.object({
  method: z.string().default("GET"),
  path: z.string(),
  body: z.unknown().optional(),
});

/** `itx.config.cloudflare(tool, args)`: `"execute"` is one request to Cloudflare's REST API,
 *  `{ method?, path, body? }`, and answers `{ status, body }`; `"whoami"` names the accounts that
 *  the credential reaches: the first 50, and `total`, how many there are. When Cloudflare answers
 *  another status than 200, `accounts` is empty and `body` is Cloudflare's answer. */
export async function cloudflareForAgent(
  itx: Pick<CloudflareItx, "fetch" | "secrets">,
  tool: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const held = await itx.secrets.describe(CLOUDFLARE_TOKEN_SECRET);
  if (!held.set)
    throw new Error(
      `This mind has no Cloudflare connection: ${CLOUDFLARE_TOKEN_SECRET} is not set. A member connects Cloudflare, or the stack's config says cloudflareToken: true, which an owner turns on in iterate Cloud.`,
    );
  if (tool === "search" || tool === "docs")
    throw new Error(
      `itx.config.cloudflare has no "${tool}": it calls Cloudflare's REST API itself. Read the API's reference at https://developers.cloudflare.com/api/ and Cloudflare's docs at https://developers.cloudflare.com/ on the web.`,
    );
  if (tool !== "execute" && tool !== "whoami")
    throw new Error(
      'itx.config.cloudflare: the tool is "execute" ({ method?, path, body? }) or "whoami"',
    );
  if (EXPORTS.test(JSON.stringify(args || {})))
    throw new Error(
      "This call makes a lasting export of the account's data (an observability destination, a webhook, a Logpush job), which this connection does not make. Ask a member to set it up in Cloudflare's dashboard.",
    );
  if (tool === "whoami") {
    const { status, text } = await cloudflareRequest(itx, held, "GET", "/accounts?per_page=50");
    // Cloudflare's own answer says why: without it a refusal reads as a credential of no account
    if (status !== 200)
      return { status, accounts: [], total: 0, body: bodyOf(text.slice(0, ANSWER_MOST)) };
    const listed = Accounts.parse(JSON.parse(text));
    return {
      status,
      accounts: listed.result.map(({ id, name }) => ({ id, name })),
      total: countOf(listed),
    };
  }
  if (args && "code" in args)
    throw new Error(
      "itx.config.cloudflare: execute takes { method, path, body }, one request to Cloudflare's REST API: see cloudflare.md",
    );
  const asked = Execute.parse(args || {});
  const method = asked.method.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
    throw new Error("itx.config.cloudflare: the method is GET, POST, PUT, PATCH or DELETE");
  if (!REST_PATH.test(asked.path) || DOTS.test(asked.path))
    throw new Error(
      'itx.config.cloudflare: the path is under /client/v4 and starts with a slash, like "/accounts/<account id>/workers/observability/telemetry/query"',
    );
  const { status, text } = await cloudflareRequest(itx, held, method, asked.path, asked.body);
  if (text.length > ANSWER_MOST)
    return {
      status,
      cut: true,
      text: `${text.slice(0, ANSWER_MOST)}…(cut: ask for less, with per_page, a filter or a limit)`,
    };
  return { status, body: bodyOf(text) };
}

/** Cloudflare's answer as JSON, or as its text when it is none. */
function bodyOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------------------------
// THE BILLING TOKEN: a second Cloudflare credential, for the cost of the account alone
// (cloudflare.md, "Billing has a token of its own"). The mind's own credential cannot read
// billing, and no consent at Cloudflare can: Cloudflare has no billing permission for one. So a
// member makes an API token with "Billing Read" in Cloudflare's dashboard, from a link that fills
// the form in, and pastes it into a page of this mind. The mind stores it and makes no token
// itself: the right to make tokens would be the right to make one that deploys.

const BILLING_TOKEN_SECRET = "/secrets/cloudflare-billing";
/** The key of the permission "Billing Read" in a template link for an account token
 *  (https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/). */
const BILLING_READ = [{ key: "billing", type: "read" }];
/** The dashboard's form for a new API token of an account, with "Billing Read" filled in. The
 *  dashboard asks which account when the person has several. The person still presses Create. */
const BILLING_TOKEN_LINK = `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(JSON.stringify(BILLING_READ))}&name=${encodeURIComponent("iterate billing read")}`;
/** What the billing token reads, under `/accounts/<account>/`: billing, subscriptions, and the
 *  usage by product, which Cloudflare serves at `billable-usage`. */
const BILLING_PATH =
  /^(billing|subscriptions|billable-usage|billable)(\/[A-Za-z0-9_-]+)*(\?[A-Za-z0-9_=&.:%-]*)?$/;
/** The billing profile is a person's name and address, which no cost report needs. */
const BILLING_PROFILE = /^billing\/profile/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** `itx.config.cloudflareBillingToken()`: whether the mind has the billing token, and when it has
 *  none, the two links a member needs: Cloudflare's form, and the page of this mind that takes
 *  the token. No agent sees the token. */
export async function cloudflareBillingToken(itx: Pick<CloudflareItx, "secrets">) {
  if ((await itx.secrets.describe(BILLING_TOKEN_SECRET)).set) return { set: true as const };
  const { url } = await itx.secrets.collectFromUser({
    path: BILLING_TOKEN_SECRET,
    egress: { urls: [CLOUDFLARE_API] },
    description: 'A Cloudflare API token with "Billing Read" alone, for the cost report',
  });
  return {
    set: false as const,
    makeTheTokenAt: BILLING_TOKEN_LINK,
    pasteItAt: url,
    say: 'Ask a member, in one message: open the first link, pick the account, keep "Billing Read" as the one permission, press Create and copy the token; then open the second link and paste it there. The token reads the account\'s bills and nothing else.',
  };
}

/** `itx.config.cloudflareBilling(account, path)`: one GET of the account's cost with the billing
 *  token, such as `"billable-usage"` (usage by product, this billing period), `"billing/history"`,
 *  `"billing/credits"`, `"subscriptions"`. Answers `{ status, body }`. Nothing but such a read goes
 *  with this token. */
export async function cloudflareBilling(
  itx: Pick<CloudflareItx, "fetch" | "secrets">,
  account: string,
  path: string,
) {
  if (!ACCOUNT_ID.test(String(account)))
    throw new Error("cloudflareBilling: the account is its 32-character id");
  if (!BILLING_PATH.test(String(path)) || BILLING_PROFILE.test(String(path)))
    throw new Error(
      'cloudflareBilling: the path is under the account, and costs alone: "billable-usage", "billing/history", "billing/credits", "subscriptions". The billing profile (a name and an address) is not read.',
    );
  if (!(await itx.secrets.describe(BILLING_TOKEN_SECRET)).set)
    throw new Error(
      `This mind has no billing token: ${BILLING_TOKEN_SECRET} is not set. Call itx.config.cloudflareBillingToken() and give a member its two links.`,
    );
  const answer = await itx.fetch(
    new Request(`${CLOUDFLARE_REST}/accounts/${account}/${path}`, {
      headers: { authorization: `Bearer getSecret("${BILLING_TOKEN_SECRET}")` },
      // the token goes to Cloudflare's API alone
      redirect: "manual",
    }),
  );
  const text = await answer.text();
  try {
    const body: unknown = JSON.parse(text);
    return { status: answer.status, body };
  } catch {
    return { status: answer.status, body: text.slice(0, 2000) };
  }
}

// ---------------------------------------------------------------------------------------------
// THE CARD.

/** The card's name in the registry, and its one row's. */
const CARD = "cloudflare";
const ROW = "account";
/** The longest wait for Cloudflare at a check: a publish's hooks wait for it. */
const CHECK_MS = 20_000;

const DESCRIPTION =
  "Cloudflare's API, with a credential of this mind's own account: agents see what the account runs and how it is set up, and query logs and traces. The credential changes nothing in the account. An agent calls it with itx.config.cloudflare(tool, args).";

/** The registry's state, as far as this file reads it (iterate/integrations). */
const Registry = z.object({
  integrations: z.record(z.string(), z.unknown()).default({}),
  connections: z.record(z.string(), z.unknown()).default({}),
});

export type CloudflareConnectionEvent = { type: string; path: string; payload?: unknown };

/** A publish of this repo, or the root's fact that `/secrets/cloudflare` was set or deleted, makes
 *  the card true; any other event does nothing. */
export async function cloudflareConnectionEvent(
  itx: CloudflareItx,
  event: CloudflareConnectionEvent,
): Promise<void> {
  if (event.path !== "/") return;
  const published = event.type === "events.iterate.com/mind/worker-updated";
  const secretChanged =
    (event.type === "events.iterate.com/secret/set" ||
      event.type === "events.iterate.com/secret/deleted") &&
    z.object({ path: z.string() }).safeParse(event.payload).data?.path === CLOUDFLARE_TOKEN_SECRET;
  if (published || secretChanged) await keepCard(itx);
}

/** The card and its row, made true. Only what differs from the registry is appended. */
async function keepCard(itx: CloudflareItx): Promise<void> {
  const registry = itx.cd("/integrations");
  const { state } = await registry.facets
    .get<{ snapshot(): Promise<{ state: unknown }> }>("integration")
    .snapshot();
  const { integrations, connections } = Registry.parse(state);
  const held = await itx.secrets.describe(CLOUDFLARE_TOKEN_SECRET);
  const check = held.set ? await checkConnection(itx, held) : null;
  const icon = { routingSlug: "dash", path: "/brands/cloudflare.svg" };
  let card: Record<string, unknown>;
  let row: Record<string, unknown> | null = null;
  if (!check) {
    const cloud = await itx.secrets.cloud().catch(() => null);
    card = {
      title: "Cloudflare",
      description: DESCRIPTION,
      icon,
      status: {
        kind: "attention",
        text: cloud
          ? "Not connected. Run “Update iterate” on this deployment in iterate Cloud."
          : "Not connected. The stack's config must say cloudflareToken: true; deploy it again.",
      },
      actions: cloud ? [{ label: "Open iterate Cloud", url: `${cloud.origin}/deployments` }] : [],
    };
  } else {
    card = {
      title: "Cloudflare",
      description: DESCRIPTION,
      icon,
      status: check.account
        ? { kind: "ok", text: "Connected" }
        : { kind: "error", text: "Cloudflare did not answer the last check" },
      actions: [{ label: "Manage", routingSlug: "dash", path: "/?page=secrets" }],
    };
    row = {
      account: check.account?.name.slice(0, 200) || "Cloudflare account",
      status: check.account ? { kind: "ok" } : { kind: "error", text: check.error.slice(0, 200) },
      details: {
        ...(check.account && { "Account id": check.account.id.slice(0, 200) }),
        ...(check.others && { "Also reaches": `${check.others} more account(s)` }),
        API: CLOUDFLARE_REST,
        Credential:
          held.refresh === "oauth-refresh-token"
            ? "a consent at Cloudflare, which the vault refreshes"
            : "the stack's API token",
        Use: 'itx.config.cloudflare("execute", { method, path, body }) and "whoami"',
        Checked: `${check.at}: ${check.account ? "Cloudflare answered" : "failed"}`,
        Secret: CLOUDFLARE_TOKEN_SECRET,
      },
      actions: [],
    };
  }
  // the card before its row: a row stands under a card that exists
  if (!jsonEqual(integrations[CARD], card))
    await registry.append({
      type: "events.iterate.com/integration/configured",
      payload: { integration: CARD, card },
    });
  const key = `${CARD}/${ROW}`;
  if (row ? !jsonEqual(connections[key], row) : key in connections)
    await registry.append({
      type: "events.iterate.com/integration/connection-configured",
      payload: { integration: CARD, connection: ROW, row },
    });
}

/** One check of the connection: Cloudflare, asked with the credential, names the accounts it
 *  reaches. `others`: how many it reaches beside the first, which a connection of one account
 *  never has. */
async function checkConnection(
  itx: CloudflareItx,
  held: Held,
): Promise<
  | { at: string; account: { id: string; name: string }; others: number; error?: never }
  | { at: string; account?: never; others?: never; error: string }
> {
  const at = new Date().toISOString();
  let fail: (error: Error) => void = () => {};
  const late = new Promise<never>((_, reject) => (fail = reject));
  const timer = setTimeout(() => fail(new Error(`no answer in ${CHECK_MS / 1000} s`)), CHECK_MS);
  const ask = async () => {
    const { status, text } = await cloudflareRequest(itx, held, "GET", "/accounts?per_page=50");
    if (status !== 200) throw new Error(`Cloudflare answered ${status}`);
    const listed = Accounts.parse(JSON.parse(text));
    const [account] = listed.result;
    if (!account) throw new Error("the credential reaches no account");
    return { account, others: countOf(listed) - 1 };
  };
  try {
    return { at, ...(await Promise.race([ask(), late])) };
  } catch (error) {
    return {
      at,
      error: z.object({ message: z.string() }).safeParse(error).data?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** What this file needs of the mind's root. */
export type CloudflareItx = {
  secrets: {
    describe(path: string): Promise<Held>;
    cloud(): Promise<{ origin: string } | null>;
    collectFromUser(input: {
      path: string;
      egress: { urls: string[] };
      description: string;
    }): Promise<{ url: string }>;
  };
  fetch(request: Request): Promise<Response>;
  cd(path: string): {
    append(event: { type: string; payload: Record<string, unknown> }): Promise<unknown>;
    facets: { get<T>(name: string): T };
  };
};
