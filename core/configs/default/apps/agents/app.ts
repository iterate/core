// app.ts — THE AGENTS APP, as worker.ts mounts it. An app is a folder: its page (index.html), the
// files the page loads (public/), its Durable Object classes (backend.ts), and this file, whose
// function makes the object worker.ts calls. It is a convention, not a framework: copy the folder
// to start an app of your own.
import { installAgents } from "iterate/agents/install";
import { serveFiles, type IterateConfigEntrypoint } from "iterate/sdk";
import index from "./index.html";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";

export function agentsApp() {
  return {
    /** The init hook's part (worker.ts, `project/worker-updated`): the catalog on /agents and the
     *  `itx.agents` rule, from the classes backend.ts exports. Idempotent. */
    install: (itx: Parameters<typeof installAgents>[0]) =>
      installAgents(itx, { module: "apps/agents/backend.ts" }),

    /** Every request on the app's host. worker.ts guards it, so a member alone gets here. */
    fetch(request: Request, host: Pick<IterateConfigEntrypoint, "auth">) {
      const url = new URL(request.url);
      // The page's own socket (public/app.js opens it): the member's itx, which the platform
      // serves for whoever it signed in on this host.
      if (url.pathname === "/itx") return host.auth.itx(request);
      // What @iterate-com/ui's shell asks of the host it runs on, for the foot of its sidebar. It
      // was written for an app with a sign-in gate of its own under /.auth/. Here the platform
      // signs people in, so these two answers stand in for that gate. Nobody signed out gets this
      // far: worker.ts's guard answers them first.
      if (url.pathname === "/.auth/session.json") {
        // which platform this page talks to: the project's own, one label beside this host
        const platform = `https://iterate.${url.hostname.split(".").slice(1).join(".")}`;
        return Response.json({ issuer: platform, defaultIssuer: platform });
      }
      // its "Sign out": the platform's own sign-out takes the POST
      if (url.pathname === "/.auth/logout")
        return new Response(null, { status: 307, headers: { location: "/.iterate/sign-out" } });
      // A file of public/ by its path; any other page load is index.html.
      return serveFiles(request, { index, files });
    },
  };
}
