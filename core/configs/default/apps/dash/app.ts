// app.ts — THE DASH, as worker.ts mounts it: the mind seen from above, in a browser. One page
// (public/app.js) shows an overview with the way to every app, and any context of the mind,
// live. Its larger part is a component of @iterate-com/ui, the one iterate's hosted Dash draws.
// It works through the member's own `itx`: what a member may do there, a member may do here,
// and nobody else gets in (worker.ts guards the host).
import { serveFiles, type IterateConfigEntrypoint } from "iterate/sdk";
import theme from "../theme.css";
import index from "./index.html";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";

export function dashApp() {
  return {
    /** Every request on the app's host. worker.ts guards it, so a member alone gets here. */
    fetch(request: Request, host: Pick<IterateConfigEntrypoint, "auth">) {
      const url = new URL(request.url);
      // The page's own socket (public/app.js opens it): the member's itx.
      if (url.pathname === "/itx") return host.auth.itx(request);
      // What @iterate-com/ui's shell asks of its host, as apps/agents/app.ts answers it: which
      // platform this page talks to, the one mind this app serves, and its "Sign out".
      const mind = url.hostname.split(".").slice(1).join(".");
      if (url.pathname === "/.auth/session.json") {
        const platform = `https://iterate.${mind}`;
        return Response.json({ issuer: platform, defaultIssuer: platform });
      }
      if (url.pathname === "/.auth/minds.json")
        return Response.json({
          minds: [{ address: mind, lastUsedAt: Date.now() }],
          lastUsed: mind,
        });
      if (url.pathname === "/.auth/logout")
        return new Response(null, { status: 307, headers: { location: "/.iterate/sign-out" } });
      // the app's own files, and the one theme file that every app of this mind shares
      return serveFiles(request, { index, files: { ...files, "theme.css": theme } });
    },
  };
}
