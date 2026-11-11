import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import { contextAt, runningCause, type ItxEntrypointScope } from "core-itx";
import { moduleIdentityOf } from "../context/worker-loader.ts";
import { EntityCollectionRpcTarget } from "./collection.ts";
import type { ProjectState } from "./contract.ts";
import type { EntitySlug } from "./entity-lifecycle.ts";
import { ProjectProcessor } from "./processor.ts";
import { configRepoCall, type ProjectPublisher } from "./publication.ts";
import type { TemplateKept } from "./template-update.ts";

export class ProjectFacet extends StreamProcessorDurableObject<
  ProjectState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  static override publicMethods = [...super.publicMethods, "repos", "workspaces", "sandboxes"];

  processor = new ProjectProcessor(
    () => this.getItx(),
    () => this.#publisher(),
    {
      template: () => this.ctx.storage.get<TemplateKept>("config-template"),
      keepTemplate: (kept) => this.ctx.storage.put("config-template", kept),
    },
  );

  #publisher(): ProjectPublisher {
    const root = contextAt("/");
    return {
      head: async () => {
        using itx = this.getItx();
        return (await itx.invoke(configRepoCall("tip"))) as string | null;
      },
      files: async (commitOid) => {
        using itx = this.getItx();
        return (await itx.invoke(configRepoCall("files", { commitOid }))) as Record<
          string,
          string | { base64: string }
        >;
      },
      identityOf: (files, mainModule) =>
        moduleIdentityOf(files, mainModule, `the config repo's ${mainModule}`),
      probe: async (files, mainModule) => {
        using itx = this.getItx();
        return await itx.invoke([
          "itx",
          "builtins",
          "workers",
          ["get", { source: files, mainModule }],
          ["probe"],
        ]);
      },
      // caused by what the follower reacts to, so the init it sets off runs one deeper than the commit
      appendAsPlatform: (...events) =>
        root.invoke(["itx", "builtins", ["append", ...events]], [], {
          principal: null,
          platform: true,
          cause: runningCause(),
        }),
    };
  }

  // Methods, not fields: Workers RPC reaches only what the prototype declares.
  #collections = new Map<string, EntityCollectionRpcTarget>();
  #collection(slug: EntitySlug): EntityCollectionRpcTarget {
    const known = this.#collections.get(slug);
    if (known) return known;
    const collection = new EntityCollectionRpcTarget(
      slug,
      () => this.getItx(),
      async () => (await this.snapshot()).state,
    );
    this.#collections.set(slug, collection);
    return collection;
  }

  repos(): EntityCollectionRpcTarget {
    return this.#collection("repo");
  }
  workspaces(): EntityCollectionRpcTarget {
    return this.#collection("workspace");
  }
  sandboxes(): EntityCollectionRpcTarget {
    return this.#collection("sandbox");
  }
}
