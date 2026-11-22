// signed-upload.ts — the path of a signed file upload, run in workerd by ../signed-upload.test.ts:
// the Boundary hands the request on to the Mind, and the Mind's file route puts it in R2. Each hop
// passes the body through `requestWithOwnedBody`, as core/boundary-worker/src/worker.ts and
// ../../rpc.ts do.
import { WorkerEntrypoint } from "cloudflare:workers";
import { requestWithOwnedBody } from "core-itx/request-body";
import { serveMindFileRequest } from "../file-urls.ts";

type Env = { MIND: Fetcher; BUCKET: R2Bucket; SECRET: string };

export class Mind extends WorkerEntrypoint<Env> {
  override fetch(request: Request) {
    return serveMindFileRequest({
      bucket: this.env.BUCKET,
      secret: this.env.SECRET,
      recordUpload: async () => {},
      request: requestWithOwnedBody(request, "mind"),
    });
  }
}

export default {
  fetch: (request: Request, env: Env) => env.MIND.fetch(requestWithOwnedBody(request, "boundary")),
} satisfies ExportedHandler<Env>;
