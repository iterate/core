import type { IterateContextDurableObject } from "core-itx";
import type { Door } from "iterate/workers";
import type { ArtifactsNamespace } from "./context/cf-artifacts.ts";
import type { SandboxContainer } from "./sandbox/container.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      DOMAIN: string;
      MIND_NAME: string;
      MIND_TEMPLATE: string;
      DOOR: Door;
      CONTEXTS: DurableObjectNamespace<IterateContextDurableObject>;
      CF_VERSION_METADATA: WorkerVersionMetadata;
      LOADER: WorkerLoader;
      MIND_KV: KVNamespace;
      AI: Ai;
      ARTIFACTS: ArtifactsNamespace;
      FILES: R2Bucket;
      /** Never returned or logged. */
      MIND_SIGNING_KEY: string;
      TELEMETRY_METRICS?: AnalyticsEngineDataset;
      /** Never read: the binding gives the class `ctx.exports.SandboxContainer` its containers. */
      SANDBOX_CONTAINER: DurableObjectNamespace<SandboxContainer>;
      BROWSER: BrowserRun;
      IMAGES: ImagesBinding;
    }
    // Types `ctx.exports`.
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
    }
  }
}

export type Env = Cloudflare.Env;
