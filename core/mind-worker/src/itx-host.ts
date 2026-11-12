// itx-host.ts — THE MIND'S ITX HOST: what the kernel of core/itx is told about this Worker. Its
// first-party facets, each context's birth events, the way out for a context's requests, the vault's
// gate for acts, and the roots that the mind adds to every `itx`. ./worker.ts imports this module for
// its effect: `defineItxHost` runs once, when the Worker's code is evaluated.
import { env } from "cloudflare:workers";
import { contextAt, defineItxHost, type ItxHostRoot } from "core-itx";
import { EmailContract } from "iterate/email";
import { INTEGRATIONS_PATH, IntegrationRegistryContract } from "iterate/integrations";
import { tracedModelCall } from "./agent-spans.ts";
import { APPROVALS_ROOT_DESCRIPTION, approvalsRoot } from "./context/approvals.ts";
import { BROWSER_ROOT_DESCRIPTION, cfBrowser } from "./context/browser.ts";
import { mindScopedArtifacts } from "./context/cf-artifacts.ts";
import { gateOf } from "./context/held-verb-rules.ts";
import { IMAGES_ROOT_DESCRIPTION, mindImages } from "./context/images.ts";
import { r2Root } from "./context/r2.ts";
import {
  SECRETS_ROOT_DESCRIPTION,
  secretsRoot,
  sendRecordingSecretFacts,
} from "./context/secrets.ts";
import { platformWakeEvents, telemetryRoots } from "./context/telemetry.ts";
import { URL_ROOT_DESCRIPTION, urlRoot } from "./context/url.ts";
import { WEBHOOKS_ROOT_DESCRIPTION, webhooksRoot } from "./context/webhooks.ts";
import { prepareConfinedWorker } from "./context/worker-loader.ts";
import { EmailFacet } from "./email/durable-object.ts";
import { EMAIL_PATH, emailRoot } from "./integrations/email.ts";
import {
  INTEGRATIONS_ROOT_DESCRIPTION,
  IntegrationFacet,
  integrationBirthEvents,
  integrationsRoot,
} from "./integrations/registry.ts";
import { ItxAi } from "./itx-ai.ts";
import { libraryRoots } from "./library.ts";
import { MIND_CONTEXT_BIRTH_EVENTS, rootBirthEvents } from "./mind/context-birth-events.ts";
import { MindContract } from "./mind/contract.ts";
import { MindFacet } from "./mind/durable-object.ts";
import { RepoFacet } from "./repo/durable-object.ts";
import { SandboxFacet } from "./sandbox/durable-object.ts";
import { WorkspaceFacet } from "./workspace/durable-object.ts";

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
    ...(path === "/" ? rootBirthEvents(env.MIND_TEMPLATE) : integrationBirthEvents(path)),
  ],
  wakeEvents: () => platformWakeEvents(Boolean(env.TELEMETRY_METRICS)),
  get metrics() {
    return env.TELEMETRY_METRICS;
  },
  egress: (request, { path }) =>
    tracedModelCall(request, path, () =>
      sendRecordingSecretFacts(request, env.DOOR, (secretPath) => contextAt(secretPath)),
    ),
  // The vault's gate for acts. The kernel asks for the verb rules on each call a context resolves
  // by its own table: kept a few seconds, so a new rule holds within that time.
  acts: gateOf(() => env.DOOR),
  loader: { prepareConfinedWorker },
  // A getter: the bindings are read when the kernel first reads the roots, never during module
  // evaluation.
  get roots(): Record<string, ItxHostRoot> {
    return {
      ...(env.TELEMETRY_METRICS && telemetryRoots(() => env.DOOR)),
      ...libraryRoots,
      members: {
        description:
          "who is a member of the mind now, as its sign-in knows it: `members.has(email)` answers true or false",
        build: () => ({ has: (email: string) => env.DOOR.isMember(String(email)) }),
      },
      kv: {
        description:
          "key-value strings, the mind's own: `kv.get(k)` · `kv.put(k, v)` · `kv.list(prefix)` · `kv.delete(k)`",
        build: () => kvRoot(env.MIND_KV),
      },
      ai: {
        description:
          'Workers AI, verbatim: `ai.run(model, inputs, options?)` · `ai.models({ search?, task? })`; files as Markdown: `ai.toMarkdown({ name, blob } | [ … ], { conversionOptions? })` → { name, mimeType, format, tokens, data } (or `format: "error"`) for PDF, Office (docx, xlsx), ODF, CSV, HTML, XML and pictures (described), `blob` the bytes or a text, or `{ name, data }` with base64, at most 10 MiB a call; `ai.toMarkdown().supported()` lists the formats; web search through AI Gateway, billed to its credits: `ai.websearch({ gatewayId: "default", query, provider?: "ceramic" | "exa" | "linkup", limit? })` → { items: [{ url, title, description? }] }; AI Gateway: `ai.gateway(id).run(request)` · `getLog(logId)` · `patchLog(logId, { score?, feedback? })` · `getUrl(provider?)`',
        // each call through an AI Gateway names the mind and the calling context to it
        build: (scope) => new ItxAi(env.AI, { mindSlug: env.MIND_NAME, path: scope.path }),
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
