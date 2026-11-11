// app.ts — THE ONBOARDING APP, as worker.ts mounts it: one page with one agent thread, the chat
// with /agents/onboarding, where a new owner starts. What that agent is told is onboarding.md, which
// apps/agents/backend.ts names as its standing instructions. It reads the file fresh before each
// request, so a commit that changes the file changes the next answer.
import {
  serveFiles,
  type IterateConfigEntrypoint,
  type IterateConfigProcessEventArgs,
} from "iterate/sdk";
import index from "./index.html";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";

/** The one onboarding agent of the mind: every member who opens the app talks in its chat. */
const ONBOARDING_AGENT = "/agents/onboarding";

export function onboardingApp() {
  return {
    /** The init hook's part (worker.ts, `mind/worker-updated`), after the Agents app's install:
     *  the agent, if it does not exist yet. Creating it starts no model turn. Idempotent. */
    async install(itx: IterateConfigProcessEventArgs<"agents">["itx"]) {
      await itx.agents.create(ONBOARDING_AGENT);
    },

    /** Every request on the app's host. worker.ts guards it, so a member alone gets here. */
    fetch(request: Request, host: Pick<IterateConfigEntrypoint, "auth">) {
      const url = new URL(request.url);
      // The page's own socket (public/app.js opens it): the member's itx.
      if (url.pathname === "/itx") return host.auth.itx(request);
      // What @iterate-com/ui's shell asks of its host, as apps/agents/app.ts answers it: which
      // platform this page talks to, and its "Sign out".
      if (url.pathname === "/.auth/session.json") {
        const platform = `https://iterate.${url.hostname.split(".").slice(1).join(".")}`;
        return Response.json({ issuer: platform, defaultIssuer: platform });
      }
      if (url.pathname === "/.auth/logout")
        return new Response(null, { status: 307, headers: { location: "/.iterate/sign-out" } });
      return serveFiles(request, { index, files });
    },
  };
}
