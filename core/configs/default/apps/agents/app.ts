// app.ts — THE AGENTS APP, as worker.ts mounts it. An app is a folder: its page (index.html), the
// files the page loads (public/), its Durable Object classes (backend.ts), and this file, whose
// function makes the object worker.ts calls. It is a convention, not a framework: copy the folder
// to start an app of your own.
import { installAgents } from "iterate/agents/install";
import { serveFiles, type IterateConfigEntrypoint } from "iterate/sdk";
import theme from "../theme.css";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import liveReload from "../live-reload/";
import { openFile } from "../open-files.ts";
import index from "./index.html";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";

export function agentsApp() {
  return {
    /** The app's manifest and icon, for anyone: worker.ts asks this before its guard
     *  (../open-files.ts). */
    open: (request: Request) => openFile(request, files),
    /** The init hook's part (worker.ts, `mind/worker-updated`): the catalog on /agents and the
     *  `itx.agents` rule, from the classes backend.ts exports. Idempotent. */
    install: (itx: Parameters<typeof installAgents>[0]) =>
      installAgents(itx, { module: "apps/agents/backend.ts" }),

    /** Every request on the app's host. worker.ts guards it, so a member alone gets here. */
    fetch(request: Request, host: Pick<IterateConfigEntrypoint, "auth">) {
      // The page's own socket (public/app.js opens it): the member's itx, which the platform
      // serves for whoever it signed in on this host. And what @iterate-com/ui's shell asks of the
      // host it runs on, for the head and the foot of its sidebar: the platform signs people in,
      // so its three answers stand in for a sign-in gate of the app's own. Nobody signed out
      // gets this far: worker.ts's guard answers them first.
      const page = host.auth.memberPage(request);
      if (page) return page;
      // A file of public/ by its path; any other page load is index.html.
      // the app's own files, and the one theme file that every app of this mind shares
      return serveFiles(request, {
        index,
        files: { ...files, ...liveReload, "theme.css": theme },
      });
    },
  };
}
