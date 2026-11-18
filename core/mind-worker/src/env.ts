import type { IterateContextDurableObject } from "core-itx";
import type { Door } from "iterate/workers";
import type { ArtifactsNamespace } from "./context/cf-artifacts.ts";
import type { SandboxContainer } from "./sandbox/container.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      /** The config that every Worker of the mind gets, as JSON, and this Worker's own key beside
       *  it (./config.ts reads both). The key is never returned or logged. */
      ITERATE: string;
      ITERATE__SIGNING_KEY: string;
      DOOR: Door;
      CONTEXTS: DurableObjectNamespace<IterateContextDurableObject>;
      CF_VERSION_METADATA: WorkerVersionMetadata;
      LOADER: WorkerLoader;
      MIND_KV: KVNamespace;
      AI: Ai;
      ARTIFACTS: ArtifactsNamespace;
      FILES: R2Bucket;
      /** The dataset of the mind's metrics: the kernel writes each context's to it. */
      TELEMETRY_METRICS: AnalyticsEngineDataset;
      /** Never read: the binding declares the class `ctx.exports.SandboxContainer` and gives it its
       *  containers. */
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
