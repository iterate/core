import { IterateConfigEntrypoint, type IterateConfigProcessEventArgs } from "iterate/sdk";

export default class extends IterateConfigEntrypoint {
  // Every durable event of the mind, and the init case: AGENTS.md.
  async processEvent(_args: IterateConfigProcessEventArgs) {}

  // Every host of the mind, routed on `x-iterate-routing-slug`: AGENTS.md.
  async fetch(request: Request) {
    const routingSlug = request.headers.get("x-iterate-routing-slug");
    if (!routingSlug) {
      using itx = this.getItx();
      const { mindSlug } = await itx.whoami();
      return new Response("Homepage of mind " + mindSlug + "\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Not found\n", { status: 404 });
  }
}
