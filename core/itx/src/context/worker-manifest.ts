import { z } from "zod";

// `identity` is the hash of what the loader loads with the module as main, npm dependencies
// included (worker-loader.ts `moduleIdentityOf`). `generation` only grows.
export const WorkerManifest = z.object({
  generation: z.number().int().positive(),
  modules: z.record(
    z.string(),
    z.object({ identity: z.string().min(1), classes: z.array(z.string()) }),
  ),
});
export type WorkerManifest = z.infer<typeof WorkerManifest>;
