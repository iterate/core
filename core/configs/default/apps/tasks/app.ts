// app.ts — THE TASKS APP, as worker.ts mounts it on tasks.<domain>: a board over the markdown
// files under tasks/ in the repo that worker.ts points it at (`tasksApp({ repo })`; /repos/config
// while the mind has no such repo), or in the repo of the mind that `?repo=` names. public/app.js says what the page does, and
// public/tasks-model.js how a file is read as a card. This file only serves the page: the board
// reads and commits through the member's own itx, so there is no backend class and no state here.
// The task sheet edits a file as the Docs app does, through the Docs app's processors
// (../docs/processors/): /processors.json says where they are, in the Docs app's own words.
import { type AppDescription, serveFiles, type IterateConfigEntrypoint } from "iterate/sdk";
import theme from "../theme.css";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import liveReload from "../live-reload/";
import { processorsAnswer } from "../docs/app.ts";
import { openFile } from "../open-files.ts";
import index from "./index.html";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";

/** What Tasks says of itself to anyone: the mind's sign-in pages show its name and icon. */
const TASKS: AppDescription = { name: "Tasks", icon: "/icon.svg", for: "members" };

/** The repo the board points at when worker.ts names none. A commit to a repo other than
 *  `/repos/config` publishes nothing, so a card that moves does not load the mind's code again. */
const TASKS_REPO = "/repos/tasks";

/** `repo`: THE REPO THE BOARD POINTS AT, a path of this mind (`/repos/<name>`). The page shows
 *  the markdown files under `tasks/` of it. While the mind has no such repo, the page shows the
 *  config repo's `tasks/`; `?repo=<name>` shows any other repo for one visit.
 *  `retiredAgents`: the paths of agents that the mind retired. "Needs a person" marks an ask of
 *  one as maybe outdated, and asks the task's agent about it in its place. */
export function tasksApp({
  repo = TASKS_REPO,
  retiredAgents = [],
}: { repo?: string; retiredAgents?: string[] } = {}) {
  return {
    /** The app's description and icon, for anyone: worker.ts asks this before its guard
     *  (../open-files.ts). */
    open: (request: Request) => openFile(request, TASKS),
    /** Every request on the app's host. worker.ts guards it, so a member alone gets here. */
    async fetch(request: Request, host: Pick<IterateConfigEntrypoint, "auth">) {
      const url = new URL(request.url);
      // Where the Docs processors' classes are and which version of them this commit holds: the
      // answer apps/docs/app.ts gives, so the task sheet and Docs start one doc's processors
      // under one name and never as two copies.
      if (url.pathname === "/processors.json") return Response.json(await processorsAnswer());
      // the repo worker.ts points the board at: the page asks once, when it loads
      if (url.pathname === "/board.json")
        return Response.json({ repo, retiredAgents }, { headers: { "cache-control": "no-store" } });
      // The page's own socket (/itx) and what @iterate-com/ui's shell asks of its host
      // (/.auth/session.json, /.auth/minds.json, /.auth/logout).
      const page = host.auth.memberPage(request);
      if (page) return page;
      // the app's own files, and the one theme file that every app of this mind shares
      return serveFiles(request, {
        index,
        files: { ...files, ...liveReload, "theme.css": theme },
      });
    },
  };
}
