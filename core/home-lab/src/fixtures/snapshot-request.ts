import { contextReach } from "../../../itx/src/context/stateless-context.ts";
import {
  SNAPSHOT_TTL_MS,
  SNAPSHOT_REREADS,
  type RulesSnapshotAnswer,
} from "../../../itx/src/context/rule-snapshots.ts";
import type { IterateContextNamespace } from "../../../itx/src/iterate-context.ts";

export default {
  async fetch(request: Request, env: { SOURCE: Fetcher }, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    const namespace = {
      getByName: () => ({
        rulesSnapshot: async () => {
          const response = await env.SOURCE.fetch(`http://source${path}`);
          return response.json<RulesSnapshotAnswer>();
        },
      }),
    };
    const reach = contextReach({
      // This fixture supplies only the namespace method snapshotOf calls.
      namespace: namespace as unknown as IterateContextNamespace,
      ctx,
    });
    if (path === "/prime") {
      // End the owner with its read pending, as an interrupted request does.
      void reach.snapshotOf("/fixture").catch(() => {});
      await (await env.SOURCE.fetch("http://source/ready")).arrayBuffer();
      return new Response("primed", {
        headers: { "x-snapshot-read-budget-ms": String(SNAPSHOT_TTL_MS * SNAPSHOT_REREADS) },
      });
    }
    try {
      return Response.json(await reach.snapshotOf("/fixture"));
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
