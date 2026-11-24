// cloudflare.ts — THE MIND'S CLOUDFLARE CONNECTION (cloudflare.md): a member's consent at
// Cloudflare's own MCP server (https://mcp.cloudflare.com), kept as the grant `/secrets/cloudflare`,
// with which the mind's agents read the account that the mind runs in: what is deployed, its
// settings, its logs and its errors. It reads and changes nothing: the grant holds read scopes
// alone (iterate/api `CLOUDFLARE_READ_SCOPES`), so Cloudflare itself refuses a write.
//
//   cloudflareConnect          the one link a member opens to connect (`itx.config.cloudflareConnect`)
//   cloudflareClientDocument   the mind's client at the MCP server: a document on the zone's apex
//   cloudflareForAgent         Cloudflare's REST API with the grant (`itx.config.cloudflare`)
//   cloudflareMcpForAgent      Cloudflare's own MCP server with the grant (`itx.config.cloudflareMcp`)
//   cloudflareLastHour         the mind's own Workers in the last hour (`itx.config.cloudflareLastHour`)
//   cloudflareBillingToken,    a second credential, for the cost of the account alone
//   cloudflareBilling
//   cloudflareConnectionEvent  what every-event.ts calls for every event: the check of a new grant,
//                              and the connection's card on the Dash's Integrations page
//
// THE MIND IS ITS OWN CLIENT. No OAuth client is made in the account and nobody pastes a token.
// The client id is the URL of a document that the mind serves on its zone's apex
// (`https://<zone>/cloudflare-mcp-client.json`, a client-id metadata document): the MCP server
// fetches it and shows its name on its page. The client is public, with PKCE.
//
// THE TOKEN IS THE MCP SERVER'S OWN. The server keeps Cloudflare's own grant and gives the mind a
// token that opens https://mcp.cloudflare.com/mcp alone; the vault's pin sends it nowhere else.
// So every REST request goes through the server's `execute` tool, as code that the server runs
// with `cloudflare.request()` (`cloudflareRequest`).
//
// THE VAULT IS THE GUARD. The server's page lets the member choose more than was asked ("Full
// access", or the editable list). Before the vault keeps a grant, it checks two things and keeps
// nothing when one fails: every scope that the token answer names is within the vault's own
// ceiling for Cloudflare, reads alone, which no caller can leave out or widen (core/secrets-worker
// `ownCeilingOf`; `grantedWithin` here narrows it to the list), and the grant reaches exactly one
// account, the one that holds the mind's first zone (`expectAccount`, the code of
// `accountCheckCode` through `execute`). Each refresh is held to the same scopes, and one whose
// answer names none is refused. A refused grant goes back to the server. This file then reads
// the grant and says what it found, on the card and to the agent that asked.
import {
  CLOUDFLARE_READ_SCOPES,
  type CollectSecretInput,
  type SecretOAuthOptions,
} from "iterate/api";
import { errorCode, jsonEqual } from "iterate/lib";
import { z } from "zod";
import { dashLinks } from "./apps/dash/links.ts";

const CLOUDFLARE_GRANT = "/secrets/cloudflare";
const CLOUDFLARE_API = "https://api.cloudflare.com";
const CLOUDFLARE_REST = `${CLOUDFLARE_API}/client/v4`;
/** Cloudflare's MCP server: its authorization server, and its one resource. */
const MCP_ORIGIN = "https://mcp.cloudflare.com";
const CLOUDFLARE_MCP = `${MCP_ORIGIN}/mcp`;
/** What the MCP server adds to every grant, whatever is asked: reads, and the refresh. */
const SERVER_ADDS = ["user:read", "account:read", "offline_access"];
/** The path of the mind's client document on the zone's apex: its URL is the client id. */
export const CLIENT_DOCUMENT_PATH = "/cloudflare-mcp-client.json";
/** The grant's token, as a placeholder that the vault fills in on the way out. */
const BEARER = `Bearer getSecret("${CLOUDFLARE_GRANT}", { field: "accessToken" })`;
/** A path of Cloudflare's API: it starts with one slash and has no `.` or `..` part. */
const REST_PATH = /^\/(?!\/)[^\s#\\]*$/;
const DOTS = /(^|\/)(\.|%2e){1,2}(\/|\?|$)/i;
/** The longest answer that goes back whole, in characters (about 6,000 tokens). */
const ANSWER_MOST = 24_000;
/** The longest wait for Cloudflare at a check: a publish's hooks wait for it. */
const CHECK_MS = 20_000;
/** Where `cloudflareConnect` keeps, in the mind's KV, the agents to tell of a consent: a list of
 *  `{ nonce, agent, at }`, one for each connect attempt that an agent asked for. */
const TELL_KEY = "cloudflare/connect-tell";
/** An attempt lasts an hour in the vault: a note for an older one can never be delivered. */
const ATTEMPT_MS = 60 * 60_000;
const AGENT_PATH = /^\/agents\/[A-Za-z0-9/_-]{1,200}$/;

/** `itx.config.cloudflareConnect({ tell? })`: the ONE link to give a member, the MCP server's
 *  consent page for this mind, and `nonce`, which names the attempt
 *  (`itx.secrets.oauthResult(CLOUDFLARE_GRANT, { nonce })`). `tell` is the path of the agent that
 *  asks (`/agents/main`): once the consent has landed and is checked, that agent gets a note
 *  that starts its turn, and the member's browser comes back to its chat. */
export async function cloudflareConnect(
  itx: Pick<CloudflareItx, "secrets" | "kv" | "url">,
  options: { tell?: string; next?: string } = {},
) {
  if (options.tell && !AGENT_PATH.test(options.tell))
    throw new Error('cloudflareConnect: tell is the path of an agent, like "/agents/main"');
  const apex = new URL(await itx.url());
  const zone = apex.hostname;
  const dash = dashLinks(zone);
  // after the consent: `next` (the page whose button began it), else back to the chat that
  // asked, else to the page with the card
  const next = options.next || (options.tell ? dash.agent(options.tell) : dash.integrations());
  const { authorizationUrl, nonce } = await itx.secrets.beginOAuth(CLOUDFLARE_GRANT, {
    authorizationEndpoint: `${MCP_ORIGIN}/authorize`,
    tokenEndpoint: `${MCP_ORIGIN}/token`,
    clientId: `${apex.origin}${CLIENT_DOCUMENT_PATH}`,
    // a public client, as its document says (`token_endpoint_auth_method: "none"`)
    clientAuth: "none",
    // `offline_access` brings the refresh token: the server's token ends after an hour
    scope: [...CLOUDFLARE_READ_SCOPES, "offline_access"].join(" "),
    // the vault keeps no grant that names a scope beyond these, at the consent or at a refresh
    grantedWithin: [...new Set([...CLOUDFLARE_READ_SCOPES, ...SERVER_ADDS])],
    // and none that reaches another account, or more than one
    account: {
      url: CLOUDFLARE_MCP,
      method: "POST",
      body: executeCall(accountCheckCode(zone)),
      id: "result.content.0.text@json.id",
      name: "result.content.0.text@json.name",
    },
    expectAccount: zone,
    // the token goes to the MCP server alone
    urls: [MCP_ORIGIN],
    // RFC 7009: a grant that the vault refuses goes back to the server (its metadata's
    // `revocation_endpoint` is its token endpoint)
    revocationEndpoint: `${MCP_ORIGIN}/token`,
    // RFC 8707: the token is for the server's one resource
    extra: { resource: CLOUDFLARE_MCP },
    // the server's page is the one page the member confirms on
    straightToProvider: true,
    next,
  });
  await keepTell(itx, nonce, options.tell);
  return { link: authorizationUrl, nonce };
}

/** THE ACCOUNT CHECK, as code for the MCP server's `execute`, which the vault runs with the new
 *  token before it keeps it: `{ id: <zone>, name: <account> }` only when the grant reaches
 *  exactly one account and that account holds `zone`; else `{ accounts: <how many> }`, which
 *  names no zone, and the vault refuses. */
export function accountCheckCode(zone: string) {
  return `async () => {
  const accounts = (await cloudflare.request({ method: "GET", path: "/accounts?per_page=50" })).result || [];
  if (accounts.length !== 1) return { accounts: accounts.length };
  const zones = (await cloudflare.request({ method: "GET", path: ${JSON.stringify(`/zones?name=${zone}&per_page=1`)} })).result || [];
  const held = zones.find((each) => each.name === ${JSON.stringify(zone)});
  if (!held || held.account.id !== accounts[0].id) return { accounts: 1 };
  return { id: held.name, name: accounts[0].name };
}`;
}

/** One stateless call of the MCP server's `execute` tool, as JSON-RPC: the whole answer, which
 *  the server would cut at about 6,000 tokens. */
function executeCall(code: string) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "execute", arguments: { code, truncate: false } },
  };
}

/** THE MIND'S CLIENT AT THE MCP SERVER: the client-id metadata document that the server fetches
 *  at a connect (draft-ietf-oauth-client-id-metadata-document). Public: no secret is in it. Its
 *  `client_id` is its own URL, and the vault's callback is its one redirect URI. */
export async function cloudflareClientDocument(
  itx: Pick<CloudflareItx, "secrets">,
  origin: string,
): Promise<Response> {
  return Response.json(
    {
      client_id: `${origin}${CLIENT_DOCUMENT_PATH}`,
      client_name: `iterate mind ${new URL(origin).hostname}`,
      client_uri: origin,
      redirect_uris: [await itx.secrets.oauthCallbackUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

const Tells = z.array(z.object({ nonce: z.string(), agent: z.string(), at: z.number() }));

/** The notes waiting for their attempt: none older than an attempt lives. */
async function tellsOf(itx: Pick<CloudflareItx, "kv">) {
  const text = (await itx.kv.get(TELL_KEY)) || "[]";
  // an older mind kept one agent's path here, which is no list: it is dropped
  const kept = Tells.safeParse(text.startsWith("[") ? JSON.parse(text) : []).data || [];
  return kept.filter(({ at, agent }) => at > Date.now() - ATTEMPT_MS && AGENT_PATH.test(agent));
}

/** Keeps the agent to tell for the attempt `nonce`, beside the others: a connect that a second
 *  one overlaps keeps its own note. A connect from the Dash tells nobody. */
async function keepTell(itx: Pick<CloudflareItx, "kv">, nonce: string, agent?: string) {
  if (!agent) return;
  const tells = (await tellsOf(itx)).filter((tell) => tell.nonce !== nonce);
  await itx.kv.put(TELL_KEY, JSON.stringify([...tells, { nonce, agent, at: Date.now() }]));
}

/** Drops the note of the attempt `nonce`, once it was delivered or can never be. */
async function dropTell(itx: Pick<CloudflareItx, "kv">, nonce: string) {
  const tells = await tellsOf(itx);
  await itx.kv.put(TELL_KEY, JSON.stringify(tells.filter((tell) => tell.nonce !== nonce)));
}

/** One request to Cloudflare's REST API with the grant, through the MCP server's `execute`: the
 *  server runs `cloudflare.request()` with its own grant at Cloudflare, and answers what Cloudflare
 *  answered. `cloudflare.request()` throws for an answer that is no success, and its words name
 *  Cloudflare's status, which comes back as `status` with the words as `text`. A status of the
 *  MCP server itself (a refused token: 401) comes back as it is. */
async function cloudflareRequest(
  itx: Pick<CloudflareItx, "fetch">,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const request = { method, path, ...(body !== undefined && method !== "GET" && { body }) };
  const code = `async () => {
  try {
    return { status: 200, body: await cloudflare.request(${JSON.stringify(request)}) };
  } catch (error) {
    const said = String((error && error.message) || error);
    return { status: Number((said.match(/returned HTTP (\\d{3})/) || [])[1] || 502), body: said.slice(0, 2000) };
  }
}`;
  const answer = await itx.fetch(
    new Request(CLOUDFLARE_MCP, {
      method: "POST",
      headers: {
        authorization: BEARER,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(executeCall(code)),
      // the grant goes to the MCP server alone
      redirect: "manual",
    }),
  );
  const text = await answer.text();
  if (answer.status !== 200) return { status: answer.status, text };
  const called = ExecuteAnswer.safeParse(bodyOf(text)).data;
  const said = called?.result?.content.find((part) => part.type === "text")?.text;
  const done = Executed.safeParse(said && !called?.result?.isError && bodyOf(said));
  if (!done.success)
    return {
      status: 502,
      text: `Cloudflare's MCP server did not run the request: ${(said || text).slice(0, 600)}`,
    };
  return {
    status: done.data.status,
    text: typeof done.data.body === "string" ? done.data.body : JSON.stringify(done.data.body),
  };
}

/** The MCP server's answer to a `tools/call`, and what the code in it returned. */
const ExecuteAnswer = z.object({
  result: z
    .object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    })
    .optional(),
});
const Executed = z.object({ status: z.number(), body: z.unknown() });

/** Throws the words for a mind with no grant. */
async function grantHeld(itx: Pick<CloudflareItx, "secrets">): Promise<void> {
  if ((await itx.secrets.describe(CLOUDFLARE_GRANT)).set) return;
  throw new Error(
    `This mind is not connected to Cloudflare: ${CLOUDFLARE_GRANT} is not set. Call itx.config.cloudflareConnect() and give a member its link.`,
  );
}

/** What `execute` takes. */
const Execute = z.object({
  method: z.string().default("GET"),
  path: z.string(),
  body: z.unknown().optional(),
});

/** `itx.config.cloudflare(tool, args)`: `"execute"` is one request to Cloudflare's REST API,
 *  `{ method?, path, body? }`, and answers `{ status, body }`. `"whoami"` asks Cloudflare who the
 *  grant is for and which account holds this mind: `{ status, user, account, zone, workers }`,
 *  where `workers` is the start of the names of the mind's own Workers. When Cloudflare answers
 *  another status than 200, `body` is its answer. */
export async function cloudflareForAgent(
  itx: Pick<CloudflareItx, "fetch" | "secrets" | "url">,
  tool: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  await grantHeld(itx);
  if (tool === "search" || tool === "docs")
    throw new Error(
      `itx.config.cloudflare has no "${tool}": it calls Cloudflare's REST API itself. Cloudflare's MCP server has it: itx.config.cloudflareMcp("${tool}", …).`,
    );
  if (tool !== "execute" && tool !== "whoami")
    throw new Error(
      'itx.config.cloudflare: the tool is "execute" ({ method?, path, body? }) or "whoami"',
    );
  if (tool === "whoami") {
    const checked = await checkGrant(itx);
    if ("account" in checked) return { status: 200, ...checked };
    return { status: checked.status, body: checked.refused || checked.error };
  }
  if (args && "code" in args)
    throw new Error(
      "itx.config.cloudflare: execute takes { method, path, body }, one request to Cloudflare's REST API. Code for Cloudflare's MCP server goes to itx.config.cloudflareMcp(\"execute\", { code }).",
    );
  const asked = Execute.parse(args || {});
  const method = asked.method.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
    throw new Error("itx.config.cloudflare: the method is GET, POST, PUT, PATCH or DELETE");
  if (!REST_PATH.test(asked.path) || DOTS.test(asked.path))
    throw new Error(
      'itx.config.cloudflare: the path is under /client/v4 and starts with a slash, like "/accounts/<account id>/workers/observability/telemetry/query"',
    );
  const { status, text } = await cloudflareRequest(itx, method, asked.path, asked.body);
  if (text.length > ANSWER_MOST)
    return {
      status,
      cut: true,
      text: `${text.slice(0, ANSWER_MOST)}…(cut: ask for less, with per_page, a filter or a limit)`,
    };
  return { status, body: bodyOf(text) };
}

/** `itx.config.cloudflareMcp(tool, args)`: one tool of Cloudflare's own MCP server, called with
 *  the grant: `"search"` finds the API call for a task in Cloudflare's OpenAPI spec, `"execute"`
 *  runs code against the API, `"docs"` searches Cloudflare's documentation, `"whoami"` names who
 *  the server sees. `search` and `execute` take `{ code }`, an async arrow function as text. The
 *  server reaches what the grant reaches and no more. */
export async function cloudflareMcpForAgent(
  itx: Pick<CloudflareItx, "connectToMcp" | "secrets">,
  tool: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  await grantHeld(itx);
  const server = await itx.connectToMcp(CLOUDFLARE_MCP, { headers: { authorization: BEARER } });
  try {
    return await server.callTool(tool, args);
  } finally {
    await server.close().catch(() => {});
  }
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
// WHO THE GRANT IS FOR, AND WHETHER IT IS OF THE MIND'S OWN ACCOUNT.

/** Cloudflare's answers, as far as the check reads them. */
const Zones = z.object({
  result: z.array(
    z.object({
      id: z.string().min(1),
      account: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    }),
  ),
});
const User = z.object({ result: z.object({ email: z.string().min(1) }) });
// `script` is null on a route that turns Workers off
const Routes = z.object({
  result: z.array(z.object({ pattern: z.string(), script: z.string().nullish() })),
});

type GrantCheck =
  | {
      /** The person who consented, when Cloudflare names them. */
      user?: string;
      /** The account that holds the mind's first zone: the mind's own. */
      account: { id: string; name: string };
      zone: string;
      /** The start of the names of the mind's own Workers (`iterate-example-com-`), read off
       *  the zone's route: the Worker on it is the mind's boundary. Absent when the zone has no
       *  such route. */
      workers?: string;
      refused?: never;
      error?: never;
    }
  | { status: number; refused: string; error?: never }
  | { status: number; error: string; refused?: never };

/** THE CHECK OF THE GRANT: Cloudflare is asked, with the grant, for the mind's first zone. A
 *  grant of the mind's own account lists it, with the account that holds it. `refused`: Cloudflare
 *  answered, and the grant does not list the zone, so it is of another account. `error`:
 *  Cloudflare gave no usable answer, which says nothing of the grant. */
async function checkGrant(itx: Pick<CloudflareItx, "fetch" | "url">): Promise<GrantCheck> {
  const zone = new URL(await itx.url()).hostname;
  const listed = await cloudflareRequest(itx, "GET", `/zones?name=${zone}&per_page=1`);
  const zones = Zones.safeParse(listed.status === 200 && bodyOf(listed.text));
  if (!zones.success)
    return {
      status: listed.status,
      error: `Cloudflare answered ${listed.status} to the grant: ${listed.text.slice(0, 300)}`,
    };
  const [held] = zones.data.result;
  if (!held)
    return {
      status: 200,
      refused: `The consent does not reach the Cloudflare account that holds ${zone}: it is for another account. Connect again, and approve as a member of the account that holds ${zone}.`,
    };
  const [who, routes] = await Promise.all([
    cloudflareRequest(itx, "GET", "/user"),
    cloudflareRequest(itx, "GET", `/zones/${held.id}/workers/routes`),
  ]);
  const user = User.safeParse(who.status === 200 && bodyOf(who.text)).data?.result.email;
  const boundary = Routes.safeParse(routes.status === 200 && bodyOf(routes.text))
    .data?.result.find(({ pattern }) => pattern === `${zone}/*`)
    ?.script?.match(/^(.+-)boundary$/)?.[1];
  return { user, account: held.account, zone, workers: boundary };
}

/** `itx.config.cloudflareLastHour()`: who the mind is connected as, and the last hour of the
 *  mind's own Workers: how many requests each took, by how they ended, and the newest errors.
 *  What an agent shows a member right after a connect. */
export async function cloudflareLastHour(itx: Pick<CloudflareItx, "fetch" | "secrets" | "url">) {
  await grantHeld(itx);
  const checked = await checkGrant(itx);
  if (!("account" in checked)) throw new Error(checked.refused || checked.error);
  return await lastHourOf(itx, checked);
}

/** The last hour of the mind's own Workers, for a grant that the check found to be the mind's. */
async function lastHourOf(
  itx: Pick<CloudflareItx, "fetch">,
  checked: Extract<GrantCheck, { account: object }>,
) {
  if (!checked.workers)
    throw new Error(
      `No Worker is on the route ${checked.zone}/* of the account ${checked.account.name}: the mind's own Workers cannot be named.`,
    );
  const now = Date.now();
  const query = (body: Record<string, unknown>) =>
    cloudflareRequest(
      itx,
      "POST",
      `/accounts/${checked.account.id}/workers/observability/telemetry/query`,
      { timeframe: { from: now - 3_600_000, to: now }, ...body },
    );
  // The stack's Workers, without the one that holds the deploy's state: it serves a deploy, and
  // no request of the mind.
  const ofTheMind = [
    { key: "$metadata.service", operation: "includes", type: "string", value: checked.workers },
    {
      key: "$metadata.service",
      operation: "neq",
      type: "string",
      value: `${checked.workers}state`,
    },
  ];
  const [counted, failed] = await Promise.all([
    query({
      queryId: "iterate-last-hour-requests",
      view: "calculations",
      parameters: {
        datasets: ["cloudflare-workers"],
        filters: [
          ...ofTheMind,
          { key: "$metadata.type", operation: "eq", type: "string", value: "cf-worker-event" },
        ],
        calculations: [{ operator: "count" }],
        groupBys: [
          { type: "string", value: "$metadata.service" },
          { type: "string", value: "$workers.outcome" },
        ],
      },
    }),
    query({
      queryId: "iterate-last-hour-errors",
      view: "events",
      limit: 5,
      parameters: {
        datasets: ["cloudflare-workers"],
        filters: [
          ...ofTheMind,
          { key: "$metadata.level", operation: "eq", type: "string", value: "error" },
        ],
      },
    }),
  ]);
  const requests = Counted.safeParse(counted.status === 200 && bodyOf(counted.text));
  const errors = Failed.safeParse(failed.status === 200 && bodyOf(failed.text));
  if (!requests.success || !errors.success)
    throw new Error(
      `Cloudflare did not answer the log query (${counted.status}, ${failed.status}): ${(requests.success ? failed : counted).text.slice(0, 300)}`,
    );
  return {
    connectedAs: checked.user,
    account: checked.account.name,
    workers: `${checked.workers}*`,
    requests: (requests.data.result.calculations[0]?.aggregates || []).map((row) => {
      const group = (key: string) =>
        String(row.groups.find((each) => each.key === key)?.value ?? "");
      return {
        worker: group("$metadata.service"),
        outcome: group("$workers.outcome"),
        count: row.value,
      };
    }),
    errors: (errors.data.result.events?.events || []).map((line) => ({
      at: new Date(line.timestamp).toISOString(),
      worker: line.$metadata.service,
      said: (line.$metadata.message || line.$metadata.error || "").slice(0, 300),
    })),
  };
}

/** The answers of Cloudflare's telemetry query, as far as `cloudflareLastHour` reads them. */
const Counted = z.object({
  result: z.object({
    calculations: z.array(
      z.object({
        aggregates: z.array(
          z.object({
            value: z.number(),
            groups: z.array(z.object({ key: z.string(), value: z.unknown() })).default([]),
          }),
        ),
      }),
    ),
  }),
});
const Failed = z.object({
  result: z.object({
    events: z
      .object({
        events: z.array(
          z.object({
            timestamp: z.number(),
            $metadata: z.object({
              service: z.string().optional(),
              message: z.string().optional(),
              error: z.string().optional(),
            }),
          }),
        ),
      })
      .optional(),
  }),
});

// ---------------------------------------------------------------------------------------------
// THE BILLING TOKEN: a second Cloudflare credential, for the cost of the account alone
// (cloudflare.md, "Billing has a token of its own"). The grant cannot read billing: Cloudflare
// has no billing permission for a consent. So a member makes an API token with "Billing Read" in
// Cloudflare's dashboard, from a link that fills the form in, and pastes it into a page of this
// mind. The mind stores it and makes no token itself: the right to make tokens would be the right
// to make one that deploys.

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
// THE CHECK OF A NEW GRANT, AND THE CARD.

/** The card's name in the registry, and its one row's. */
const CARD = "cloudflare";
const ROW = "account";

/** Cloudflare ends a mind's earlier grant when the same client is granted again: a refused new
 *  grant can leave the mind with none that works. Said when the earlier one no longer answers. */
const EARLIER_ENDED =
  "The connection before it does not answer either: Cloudflare ends it when it grants a new one, so the mind is not connected now.";

const DESCRIPTION =
  "Your mind reads the Cloudflare account it runs in: what is deployed, its logs and its errors. It can change nothing there. Agents call it with itx.config.cloudflare(tool, args) and itx.config.cloudflareMcp(tool, args).";

/** The registry's state, as far as this file reads it (iterate/integrations). */
const Registry = z.object({
  integrations: z.record(z.string(), z.unknown()).default({}),
  connections: z.record(z.string(), z.unknown()).default({}),
});

export type CloudflareConnectionEvent = {
  type: string;
  path: string;
  offset?: number;
  payload?: unknown;
};

/** The vault's `secret/grant-refused` fact: the attempt it ended, and its words. */
const Refusal = z.object({ nonce: z.string(), reason: z.string() });

/** A publish of this repo (on the root), or the fact that `/secrets/cloudflare` was set, deleted
 *  or refused a grant (on the secret's own log), makes the card true; any other event does
 *  nothing. After a set, a refusal or a publish, each agent that asked for a connect whose
 *  attempt has ended is told how it went. */
export async function cloudflareConnectionEvent(
  itx: CloudflareItx,
  event: CloudflareConnectionEvent,
): Promise<void> {
  const published = event.path === "/" && event.type === "events.iterate.com/mind/worker-updated";
  const set = event.path === CLOUDFLARE_GRANT && event.type === "events.iterate.com/secret/set";
  const deleted =
    event.path === CLOUDFLARE_GRANT && event.type === "events.iterate.com/secret/deleted";
  const refused =
    event.path === CLOUDFLARE_GRANT && event.type === "events.iterate.com/secret/grant-refused";
  if (!published && !set && !deleted && !refused) return;
  const held = (await itx.secrets.describe(CLOUDFLARE_GRANT)).set;
  const check = held ? await checkedInTime(itx) : null;
  await keepCard(itx, check, refused);
  // a refused attempt that a newer one replaced is no longer the vault's to answer: the fact is
  const refusal = refused ? Refusal.safeParse(event.payload).data : undefined;
  if (!deleted) await tellTheAgents(itx, check, held && !(check && "account" in check), refusal);
}

/** Each agent that asked for a connect gets a note that starts its turn once its attempt has
 *  ended: the member, whom Cloudflare's page has just brought back to the chat, need not say that
 *  they approved. The note is bound to its attempt (`nonce`): its idempotency key is the
 *  attempt's, so a replay adds nothing, and it is dropped only after the append, so a failed
 *  append leaves it for the next event. */
async function tellTheAgents(
  itx: CloudflareItx,
  check: (GrantCheck & { at: string }) | null,
  earlierEnded: boolean,
  refusal?: z.infer<typeof Refusal>,
): Promise<void> {
  for (const { nonce, agent } of await tellsOf(itx)) {
    const result =
      refusal?.nonce === nonce
        ? { status: "failed" as const, error: refusal.reason }
        : await itx.secrets.oauthResult(CLOUDFLARE_GRANT, { nonce });
    if (result.status === "pending") continue;
    const content =
      result.status === "complete" && check
        ? await connectedNote(itx, check, agent)
        : result.status === "failed" || result.status === "declined"
          ? `The Cloudflare consent was not kept: ${result.error.slice(0, 400)}${earlierEnded ? ` ${EARLIER_ENDED}` : ""} Say so in one sentence and give the link again: await itx.config.cloudflareConnect({ tell: "${agent}" }).`
          : null;
    if (content)
      await itx
        .cd(agent)
        .append({
          type: "events.iterate.com/agent/context-added",
          idempotencyKey: `cloudflare-connected:${nonce}`,
          payload: { role: "developer", content },
        })
        .catch((error: unknown) => {
          if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
        });
    await dropTell(itx, nonce);
  }
}

/** The note for a consent that the vault kept: who it is connected as, when Cloudflare says, and
 *  the first look at the last hour, so that the agent shows it with no call of its own: counts
 *  alone. A log line's words are whatever a request made a Worker say, and are no part of a note. */
async function connectedNote(
  itx: CloudflareItx,
  check: GrantCheck & { at: string },
  agent: string,
): Promise<string> {
  if (!("account" in check))
    return check.refused
      ? `The Cloudflare consent was kept, but it is not for the account that holds this mind. ${check.refused} Say so in one sentence and give the link again: await itx.config.cloudflareConnect({ tell: "${agent}" }).`
      : `Cloudflare's consent landed, and Cloudflare did not answer the check of it (${check.error}). Say so, and try await itx.config.cloudflare("whoami") in a minute.`;
  const hour = await lastHourOf(itx, check).catch(() => null);
  const seen = hour
    ? `In the last hour its own Workers (${hour.workers}) took these requests, by Worker and by how they ended: ${
        hour.requests
          .map((row) => `${row.worker.slice(0, 80)} ${row.outcome.slice(0, 40)} ${row.count}`)
          .join("; ") || "none yet"
      }. Error lines: ${hour.errors.length}${hour.errors.length === 5 ? " or more" : ""}.`
    : "Cloudflare's log query gave no answer yet: say that the last hour is not there yet, and ask again with await itx.config.cloudflareLastHour().";
  return `Cloudflare is connected: the consent${check.user ? ` of ${check.user}` : ""} reads the account "${check.account.name}", which holds this mind, and Cloudflare's page has brought the member back to this chat. ${seen} Say in the same message, in plain words, who it is connected as${check.user ? "" : " (Cloudflare did not say: say so)"} and what the last hour shows, and that the mind can read the account and change nothing in it. For the error lines themselves: await itx.config.cloudflareLastHour() (cloudflare.md).`;
}

/** The card and its row, made true. Only what differs from the registry is appended. `refused`:
 *  the vault has just refused a new grant, and the card says so. */
async function keepCard(
  itx: CloudflareItx,
  check: (GrantCheck & { at: string }) | null,
  refused = false,
): Promise<void> {
  const registry = itx.cd("/integrations");
  const { state } = await registry.facets
    .get<{ snapshot(): Promise<{ state: unknown }> }>("integration")
    .snapshot();
  const { integrations, connections } = Registry.parse(state);
  // the Dash on the mind's first zone (`itx.url()` is that zone's apex)
  const dash = dashLinks(new URL(await itx.url()).hostname);
  const icon = `${dash.origin}/brands/cloudflare.svg`;
  let card: Record<string, unknown>;
  let row: Record<string, unknown> | null = null;
  if (!check) {
    card = {
      title: "Cloudflare",
      description: DESCRIPTION,
      icon,
      status: refused
        ? {
            kind: "error",
            text: "The last consent was refused, and nothing was kept. Connect again.",
          }
        : { kind: "attention", text: "Not connected." },
      // the press calls `cloudflareConnect` as the member who pressed it, and the page goes on to
      // the one link it answers
      actions: [{ label: "Connect", call: { name: "cloudflareConnect" } }],
    };
  } else {
    const connected = "account" in check;
    card = {
      title: "Cloudflare",
      description: DESCRIPTION,
      icon,
      status:
        refused && connected
          ? {
              kind: "attention",
              text: "The last consent was refused, and nothing was kept. The connection before it still works.",
            }
          : refused
            ? {
                kind: "error",
                text: "The last consent was refused, and nothing was kept. The connection before it does not answer: Cloudflare ends it when it grants a new one. Connect again.",
              }
            : connected
              ? { kind: "ok", text: "Connected" }
              : check.refused
                ? { kind: "error", text: "The grant is for another account. Connect again." }
                : { kind: "error", text: "Cloudflare did not answer the last check" },
      actions: [
        { label: "Connect again", call: { name: "cloudflareConnect" } },
        { label: "Manage", url: dash.secrets() },
      ],
    };
    row = {
      account: (connected ? check.account.name : "Cloudflare account").slice(0, 200),
      status: connected
        ? { kind: "ok" }
        : { kind: "error", text: (check.error || check.refused || "").slice(0, 200) },
      details: {
        ...(connected && { "Account id": check.account.id.slice(0, 200) }),
        ...(connected && check.user && { "Connected as": check.user.slice(0, 200) }),
        API: `${CLOUDFLARE_REST}, through the MCP server's execute`,
        "MCP server": CLOUDFLARE_MCP,
        Use: 'itx.config.cloudflare("execute", { method, path, body }), "whoami"; itx.config.cloudflareMcp("search" or "execute", { code })',
        Checked: `${check.at}: ${connected ? "Cloudflare answered" : "failed"}`,
        Secret: CLOUDFLARE_GRANT,
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

/** One check of the grant, with the time it was made, and no longer than CHECK_MS. */
async function checkedInTime(
  itx: Pick<CloudflareItx, "fetch" | "url">,
): Promise<GrantCheck & { at: string }> {
  const at = new Date().toISOString();
  let fail: (error: Error) => void = () => {};
  const late = new Promise<never>((_, reject) => (fail = reject));
  const timer = setTimeout(() => fail(new Error(`no answer in ${CHECK_MS / 1000} s`)), CHECK_MS);
  try {
    return { at, ...(await Promise.race([checkGrant(itx), late])) };
  } catch (error) {
    return {
      at,
      status: 0,
      error: z.object({ message: z.string() }).safeParse(error).data?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** What this file needs of the mind's root. */
export type CloudflareItx = {
  url(): Promise<string>;
  secrets: {
    describe(path: string): Promise<{ set: boolean; public?: Record<string, string> }>;
    oauthCallbackUrl(): Promise<string>;
    beginOAuth(
      path: string,
      options: SecretOAuthOptions,
    ): Promise<{ authorizationUrl: string; nonce: string }>;
    oauthResult(
      path: string,
      input: { nonce: string },
    ): Promise<
      | { status: "pending" | "complete" | "unavailable" }
      | { status: "declined" | "failed"; error: string }
    >;
    collectFromUser(input: CollectSecretInput): Promise<{ url: string }>;
  };
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
  fetch(request: Request): Promise<Response>;
  connectToMcp(
    url: string,
    options: { headers: Record<string, string> },
  ): Promise<{
    callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
  }>;
  cd(path: string): {
    append(event: {
      type: string;
      idempotencyKey?: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
    facets: { get<T>(name: string): T };
  };
};
