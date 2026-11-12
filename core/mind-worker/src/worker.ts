// worker.ts — THE MIND'S WORKER. It composes the itx host (./itx-host.ts, imported for its
// effect), the entrypoint that the boundary calls (./rpc.ts, which answers requests through
// ./http.ts) and the classes that Cloudflare makes by name.
import "./itx-host.ts";
import type { Env } from "./env.ts";

// `ctx.exports` mints a loopback or a first-party facet's class only for an export of the main module.
export { IterateContextDurableObject, ItxEntrypoint } from "core-itx";
export { EmailFacet } from "./email/durable-object.ts";
export { IntegrationFacet } from "./integrations/registry.ts";
export { MindFacet } from "./mind/durable-object.ts";
export { RepoFacet } from "./repo/durable-object.ts";
export { Mind } from "./rpc.ts";
export { SandboxContainer } from "./sandbox/container.ts";
export { SandboxFacet } from "./sandbox/durable-object.ts";
export { SandboxEgress } from "./sandbox/egress.ts";
export { WorkspaceFacet } from "./workspace/durable-object.ts";

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<Env>;
