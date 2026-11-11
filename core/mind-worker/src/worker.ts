import { env, WorkerEntrypoint } from "cloudflare:workers";
import {
  contextAt,
  defineItxHost,
  IterateContextDurableObject,
  ItxEntrypoint,
  serveHostRequest,
  type Caller,
  type ItxHostRoot,
} from "core-itx";
import { ITERATE_ROUTING_SLUG_HEADER } from "iterate/mind-ingress";
import { stampedCallerOf } from "iterate/principal";
import { platformOriginOf, platformRouteOf } from "iterate/mind-api";
import { EmailContract } from "iterate/email";
import { INTEGRATIONS_PATH, IntegrationRegistryContract } from "iterate/integrations";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import type { MindTarget } from "iterate/workers";
import { serveApi } from "./api.ts";
import { prepareConfinedWorker } from "./context/worker-loader.ts";
import type { Env } from "./env.ts";
import { ItxAi } from "./itx-ai.ts";
import { libraryRoots } from "./library.ts";
import { serveMcp } from "./mcp.ts";
import { mindScopedArtifacts } from "./context/cf-artifacts.ts";
import { FILES_PATH, serveMindFileRequest } from "./context/file-urls.ts";
import { r2Root } from "./context/r2.ts";
import {
  SECRETS_ROOT_DESCRIPTION,
  secretsRoot,
  sendRecordingSecretFacts,
} from "./context/secrets.ts";
import { MIND_CONTEXT_BIRTH_EVENTS, rootBirthEvents } from "./mind/context-birth-events.ts";
import { MindContract } from "./mind/contract.ts";
import { MindFacet } from "./mind/durable-object.ts";
import { RepoFacet } from "./repo/durable-object.ts";
import { WorkspaceFacet } from "./workspace/durable-object.ts";
import { SandboxFacet } from "./sandbox/durable-object.ts";
import { SandboxContainer } from "./sandbox/container.ts";
import { SandboxEgress } from "./sandbox/egress.ts";
import { APPROVALS_ROOT_DESCRIPTION, approvalsRoot } from "./context/approvals.ts";
import { BROWSER_ROOT_DESCRIPTION, cfBrowser } from "./context/browser.ts";
import { IMAGES_ROOT_DESCRIPTION, mindImages } from "./context/images.ts";
import { EmailFacet } from "./email/durable-object.ts";
import { runApprovedAct } from "./approved-acts.ts";
import { heldVerbRules } from "./context/held-verb-rules.ts";
import { EMAIL_PATH, emailRoot, receiveEmail } from "./integrations/email.ts";
import {
  INTEGRATIONS_ROOT_DESCRIPTION,
  IntegrationFacet,
  integrationBirthEvents,
  integrationsRoot,
} from "./integrations/registry.ts";
import { MCP_WEBHOOK_PATH, serveMcpWebhook } from "./integrations/mcp.ts";
import { serveWebhook, WEBHOOKS_PATH } from "./integrations/webhooks.ts";
import { PLATFORM_BIRTH_EVENTS, telemetryRoots } from "./context/telemetry.ts";
import { tracedModelCall } from "./agent-spans.ts";
import { URL_ROOT_DESCRIPTION, urlRoot } from "./context/url.ts";
import { WEBHOOKS_ROOT_DESCRIPTION, webhooksRoot } from "./context/webhooks.ts";

// The functions that need a binding read the Worker's env through `cloudflare:workers` when called.
defineItxHost({
  get mindSlug() {
    return env.MIND_NAME;
  },
  // The repo's row is unfiltered: its at-head pass retries a failed teardown.
  firstPartyFacets: {
    mind: {
      className: "MindFacet",
      publicMethods: MindFacet.publicMethods,
      placement: { where: 'the root, "/"', mayBeHostedOn: (path) => path === "/" },
      consumes: MindContract.consumes,
    },
    repo: { className: "RepoFacet", publicMethods: RepoFacet.publicMethods },
    workspace: { className: "WorkspaceFacet", publicMethods: WorkspaceFacet.publicMethods },
    sandbox: { className: "SandboxFacet", publicMethods: SandboxFacet.publicMethods },
    email: {
      className: "EmailFacet",
      publicMethods: EmailFacet.publicMethods,
      placement: {
        where: `the mind's ${EMAIL_PATH}`,
        mayBeHostedOn: (path) => path === EMAIL_PATH,
      },
      consumes: EmailContract.consumes,
    },
    integration: {
      className: "IntegrationFacet",
      publicMethods: IntegrationFacet.publicMethods,
      placement: {
        where: `the mind's ${INTEGRATIONS_PATH}`,
        mayBeHostedOn: (path) => path === INTEGRATIONS_PATH,
      },
      consumes: IntegrationRegistryContract.consumes,
    },
  },
  birthEvents: (path) => [
    ...MIND_CONTEXT_BIRTH_EVENTS,
    ...(env.TELEMETRY_METRICS ? PLATFORM_BIRTH_EVENTS : []),
    ...(path === "/" ? rootBirthEvents(env.MIND_TEMPLATE) : integrationBirthEvents(path)),
  ],
  get metrics() {
    return env.TELEMETRY_METRICS;
  },
  egress: (request, { path }) =>
    tracedModelCall(request, path, () =>
      sendRecordingSecretFacts(request, env.DOOR, (secretPath) => contextAt(secretPath)),
    ),
  // The vault's gate for acts. The kernel asks for the verb rules on each call a context resolves
  // by its own table: kept a few seconds, so a new rule holds within that time.
  acts: {
    verbRules: heldVerbRules(() => env.DOOR.actRules()),
    ask: (input) => env.DOOR.act(input),
  },
  loader: { prepareConfinedWorker },
  // A getter: the bindings are read when the kernel first reads the roots, never during module
  // evaluation.
  get roots(): Record<string, ItxHostRoot> {
    return {
      ...(env.TELEMETRY_METRICS && telemetryRoots(() => env.DOOR)),
      ...libraryRoots,
      kv: {
        description:
          "key-value strings, the mind's own: `kv.get(k)` · `kv.put(k, v)` · `kv.list(prefix)` · `kv.delete(k)`",
        build: () => kvRoot(env.MIND_KV),
      },
      ai: {
        description:
          'Workers AI, verbatim: `ai.run(model, inputs, options?)` · `ai.models({ search?, task? })`; files as Markdown: `ai.toMarkdown({ name, blob } | [ … ], { conversionOptions? })` → { name, mimeType, format, tokens, data } (or `format: "error"`) for PDF, Office (docx, xlsx), ODF, CSV, HTML, XML and pictures (described), `blob` the bytes or a text, or `{ name, data }` with base64, at most 10 MiB a call; `ai.toMarkdown().supported()` lists the formats; web search through AI Gateway, billed to its credits: `ai.websearch({ gatewayId: "default", query, provider?: "ceramic" | "exa" | "linkup", limit? })` → { items: [{ url, title, description? }] }; AI Gateway: `ai.gateway(id).run(request)` · `getLog(logId)` · `patchLog(logId, { score?, feedback? })` · `getUrl(provider?)`',
        build: () => new ItxAi(env.AI),
      },
      cfArtifacts: {
        description: "the Artifacts binding, mind-scoped (`repos` is the friendlier surface)",
        build: () => mindScopedArtifacts({ namespace: env.ARTIFACTS }),
      },
      r2: {
        description: "the object store, verbatim (`files` is the friendlier surface)",
        build: (scope) => mindR2(scope),
      },
      secrets: {
        description: SECRETS_ROOT_DESCRIPTION,
        build: (scope) => secretsRoot(scope, env.DOOR),
      },
      approvals: {
        description: APPROVALS_ROOT_DESCRIPTION,
        build: (scope) => approvalsRoot(scope, env.DOOR, env.DOMAIN),
      },
      browser: { description: BROWSER_ROOT_DESCRIPTION, build: () => cfBrowser(env.BROWSER) },
      // over a second `itx.r2` of the context's: what a write lands is the same
      images: {
        description: IMAGES_ROOT_DESCRIPTION,
        build: (scope) => mindImages(env.IMAGES, scope, mindR2(scope)),
      },
      email: {
        description:
          "the mind's mail, on /integrations/email: `email.send({ to, subject, text | html, cc?, from?, attachments?: [{ path }], inReplyToOffset? })` from <mind>@<domain> or any address @<domain>",
        build: (scope) =>
          emailRoot(scope, {
            files: env.FILES,
            egress: () => env.DOOR,
            name: env.MIND_NAME,
            domain: env.DOMAIN,
          }),
      },
      integrations: { description: INTEGRATIONS_ROOT_DESCRIPTION, build: integrationsRoot },
      // At every context: one with no parent link, such as `/integrations/webhooks/<name>`, finds them too.
      url: {
        description: URL_ROOT_DESCRIPTION,
        build: () => urlRoot(env.DOMAIN),
        everyContext: true,
      },
      webhooks: {
        description: WEBHOOKS_ROOT_DESCRIPTION,
        build: (scope) => webhooksRoot(scope, env.DOMAIN),
        everyContext: true,
      },
    };
  },
  signingSecret: async () => env.MIND_SIGNING_KEY,
});

// `ctx.exports` mints a loopback or a first-party facet's class only for an export of the main module.
export {
  EmailFacet,
  IntegrationFacet,
  IterateContextDurableObject,
  ItxEntrypoint,
  MindFacet,
  RepoFacet,
  SandboxContainer,
  SandboxEgress,
  SandboxFacet,
  WorkspaceFacet,
};

export class Mind extends WorkerEntrypoint<Env> implements MindTarget {
  async fetch(request: Parameters<MindTarget["fetch"]>[0]) {
    const domain = this.env.DOMAIN;
    const url = new URL(request.url);
    // The API and MCP first: platform code, before anything of the mind's own.
    const route = platformRouteOf(url, domain);
    // The signature is the permission, so a signed file URL is answered before any bearer check.
    if (route === "api" && url.pathname.startsWith(FILES_PATH))
      return serveMindFileRequest({
        bucket: this.env.FILES,
        secret: this.env.MIND_SIGNING_KEY,
        recordUpload: (payload) =>
          contextAt("/").invoke(
            ["itx", "builtins", ["append", { type: "events.iterate.com/itx/file-set", payload }]],
            [],
            { principal: null, platform: true },
          ),
        request,
      });
    // a webhook's signature is the permission
    if (route === "api" && url.pathname.startsWith(WEBHOOKS_PATH)) return serveWebhook(request);
    if (route === "api" && url.pathname === MCP_WEBHOOK_PATH)
      return serveMcpWebhook(request, this.env.MIND_SIGNING_KEY);
    if (route === "api") {
      if (request.method === "GET" && url.pathname === "/api/_skeleton") {
        // a member alone: each run writes a fact and sends requests out
        if (!stampedCallerOf(request).principal)
          return new Response("Sign in\n", {
            status: 401,
            headers: { "WWW-Authenticate": 'Bearer realm="iterate"' },
          });
        return Response.json(await this.#skeletonChecks(request, domain));
      }
      return serveApi(request, this.ctx);
    }
    if (route === "mcp") return serveMcp(request);
    return serveMindHost(request, this.ctx, domain);
  }

  /** Only the boundary reaches this entrypoint, so what it appends is the platform's, which the
   *  kernel refuses from any other caller. A signed statement is its signer's: only the auth
   *  Worker's answer names one, and each is appended under its own signer. */
  async append(...[path, events, fromAuth]: Parameters<MindTarget["append"]>) {
    const signed = fromAuth ? events.filter((event) => event.source?.signer) : [];
    const own = events.filter((event) => !signed.includes(event));
    if (own.length) await appendAsPlatform(path, own);
    for (const event of signed) await appendAsPlatform(path, [event], event.source?.signer);
  }

  async receiveEmail(mail: Parameters<MindTarget["receiveEmail"]>[0]) {
    await receiveEmail(this.env.FILES, contextAt(EMAIL_PATH), mail);
  }

  async runAct(held: Parameters<MindTarget["runAct"]>[0]) {
    await runApprovedAct(
      { files: this.env.FILES, egress: this.env.DOOR, contextAt, appendAsPlatform },
      held,
    );
  }

  /** No secret material: core/alchemy/scripts/smoke.ts reads these. */
  async #skeletonChecks(request: Request, domain: string) {
    const door = this.env.DOOR;
    return {
      principal: stampedCallerOf(request).principal,
      /** The boundary removes a cookie on the platform's hostname. */
      cookieReached: request.headers.has("cookie"),
      egressFetchStatus: (await door.fetch(new Request("https://example.com/"))).status,
      authThroughEgressStatus: (await door.fetch(new Request(`${platformOriginOf(domain)}/`)))
        .status,
      secretsEventCount:
        (await door.secret("/secrets/skeleton", "describe", undefined)).path === "/secrets/skeleton"
          ? 1
          : 0,
      emailEventCount: (await contextAt("/integrations/email").read()).events.length,
      /** Of a type only the platform may append, which the default config's cases pass over. */
      platformFactOffset: (
        await appendAsPlatform("/skeleton/platform-fact", [
          { type: "events.iterate.com/mcp/webhook-received", payload: { skeleton: true } },
        ])
      )[0]?.offset,
    };
  }
}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<Env>;

const appendAsPlatform = async (
  path: string,
  events: StreamEventInput[],
  signer?: Caller["signer"],
) =>
  (await contextAt(path).invoke(["itx", "builtins", ["append", ...events]], [], {
    principal: null,
    platform: true,
    signer,
  })) as StreamEvent[];

/** The routing slug header is unset on the apex, so a visitor's copy never survives. */
function serveMindHost(request: Request, ctx: ExecutionContext, domain: string) {
  const { hostname } = new URL(request.url);
  const routingSlug = hostname.endsWith(`.${domain}`)
    ? hostname.slice(0, -`.${domain}`.length)
    : null;
  const headers = new Headers(request.headers);
  if (routingSlug) headers.set(ITERATE_ROUTING_SLUG_HEADER, routingSlug);
  else headers.delete(ITERATE_ROUTING_SLUG_HEADER);
  return serveHostRequest({
    ctx,
    request: new Request(request, { headers }),
    caller: stampedCallerOf(request),
    itxSessions: true,
  });
}

const mindR2 = (scope: Parameters<typeof r2Root>[0]) =>
  r2Root(scope, env.FILES, {
    domain: env.DOMAIN,
    secret: async () => env.MIND_SIGNING_KEY,
  });

/** The loader's memos and module locks share MIND_KV under their own prefixes. */
const KV_PREFIX = "itx-kv/";

function kvRoot(kv: KVNamespace) {
  return {
    get: (k: string) => kv.get(KV_PREFIX + k),
    put: async (k: string, v: string) => {
      await kv.put(KV_PREFIX + k, String(v));
      return { ok: true };
    },
    delete: async (k: string) => {
      await kv.delete(KV_PREFIX + k);
      return { ok: true };
    },
    list: async (prefix = "") => {
      // Cloudflare KV caps one list page at 1000 keys
      const out: string[] = [];
      for (let cursor: string | undefined; ;) {
        const page = await kv.list({ prefix: KV_PREFIX + prefix, cursor });
        for (const k of page.keys) out.push(k.name.slice(KV_PREFIX.length));
        if (page.list_complete) return { keys: out };
        cursor = page.cursor;
      }
    },
  };
}
