// artifacts-namespace.ts — THE MIND'S ARTIFACTS NAMESPACE AS A RESOURCE. Alchemy's own
// `Cloudflare.Artifacts.Namespace` is a binding's marker and makes nothing: Cloudflare makes a
// namespace at the first repo created under its name. That holds through the REST API, but a repo
// created through a Worker's binding makes no namespace (18 Nov 2026). So the stack makes it, and
// a destroy deletes it, with the repos in it.
import * as Cloudflare from "@alchemy.run/cloudflare";
import { formatHeaders } from "@distilled.cloud/cloudflare/Credentials";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { z } from "zod";

export type ArtifactsNamespace = Resource<
  "Iterate.ArtifactsNamespace",
  { namespace: string },
  { namespace: string },
  never,
  Cloudflare.Providers
>;
export const ArtifactsNamespace = Resource<ArtifactsNamespace>("Iterate.ArtifactsNamespace");

const Repos = z.object({ result: z.array(z.object({ name: z.string() })) });

export const ArtifactsNamespaceProvider = () =>
  Provider.succeed(ArtifactsNamespace, {
    stables: ["namespace"],
    reconcile: Effect.fn(function* ({ news: { namespace } }) {
      // looked up by its own path: its list of repos answers 200 for any name
      const found = yield* namespacesApi("GET", `/${namespace}`);
      if (found.status === 200) return { namespace };
      // only a 404 says that it is not there: no other answer leads to a create
      if (found.status !== 404)
        return yield* Effect.die(
          `Cloudflare did not say whether the Artifacts namespace ${namespace} exists (${found.status}): ${found.text.slice(0, 300)}`,
        );
      const made = yield* namespacesApi("POST", "", { namespace });
      // 10201: it exists, made between the two calls
      if (made.status >= 300 && !/"code":\s*10201\b/.test(made.text))
        return yield* Effect.die(
          `Cloudflare did not make the Artifacts namespace ${namespace} (${made.status}): ${made.text.slice(0, 300)}`,
        );
      return { namespace };
    }),
    // A destroy erases the mind: its repos go first, because Cloudflare refuses to delete a
    // namespace that holds one (409 "Namespace is not empty").
    delete: Effect.fn(function* ({ output: { namespace } }) {
      // a page of repos at a time, until a page is empty: 200 pages of 50 at most
      for (let page = 1; page <= 200; page += 1) {
        const listed = yield* namespacesApi("GET", `/${namespace}/repos`);
        if (listed.status === 404) return;
        const repos = Repos.safeParse(listed.status === 200 && JSON.parse(listed.text));
        if (!repos.success)
          return yield* Effect.die(
            `Cloudflare did not list the repos of the Artifacts namespace ${namespace} (${listed.status}): ${listed.text.slice(0, 300)}`,
          );
        if (repos.data.result.length === 0) break;
        for (const { name } of repos.data.result) {
          const gone = yield* namespacesApi(
            "DELETE",
            `/${namespace}/repos/${encodeURIComponent(name)}`,
          );
          if (gone.status >= 300 && gone.status !== 404)
            return yield* Effect.die(
              `Cloudflare did not delete the repo ${name} of the Artifacts namespace ${namespace} (${gone.status}): ${gone.text.slice(0, 300)}`,
            );
        }
        // Cloudflare takes a repo's delete (202) before the repo is gone
        yield* Effect.sleep("1 second");
      }
      const gone = yield* namespacesApi("DELETE", `/${namespace}`);
      // a refused delete fails, so the stack's state keeps the namespace; a 404 is gone already
      if (gone.status >= 300 && gone.status !== 404)
        return yield* Effect.die(
          `Cloudflare did not delete the Artifacts namespace ${namespace} (${gone.status}): ${gone.text.slice(0, 300)}`,
        );
    }),
  });

/** One call of Cloudflare's namespaces API, for which the SDK under Alchemy has no call
 *  (1.0.0-rc.18): in the deploy's account, with Alchemy's own credentials and HTTP client.
 *  Answers the status and the body's text. */
const namespacesApi = (method: "GET" | "POST" | "DELETE", path: string, json?: unknown) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const credentials = yield* yield* Cloudflare.Credentials;
    const request = HttpClientRequest.make(method)(
      `${credentials.apiBaseUrl}/accounts/${accountId}/artifacts/namespaces${path}`,
      { headers: formatHeaders(credentials) },
    );
    const answer = yield* (yield* HttpClient.HttpClient).execute(
      json === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, json),
    );
    return { status: answer.status, text: yield* answer.text };
  });
