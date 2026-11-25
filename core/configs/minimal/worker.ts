import { IterateConfigEntrypoint, type IterateConfigProcessEventArgs } from "iterate/sdk";

export default class extends IterateConfigEntrypoint {
  // Every durable event of the mind, and the init case: AGENTS.md. A mail to the mind is one:
  // `events.iterate.com/email/received` on /integrations/email.
  async processEvent(_args: IterateConfigProcessEventArgs) {}

  // Every hostname of the mind's zones but its control-plane hostname: AGENTS.md. An app's hostname is
  // `<label>.<zone>`, so the switch is on the first label; any other hostname is the homepage's:
  // GET and HEAD of `/`, and nothing else.
  async fetch(request: Request) {
    const { hostname, pathname } = new URL(request.url);
    switch (hostname.split(".")[0]) {
      // case "blog":
      //   return blog(request);
      default: {
        // anything else is not found: a webhook that nothing serves must not be answered as taken
        if (pathname !== "/" || !["GET", "HEAD"].includes(request.method))
          return new Response("Not found\n", { status: 404 });
        using itx = this.getItx();
        const { mindSlug } = await itx.whoami();
        return new Response("Homepage of mind " + mindSlug + "\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
  }
}
