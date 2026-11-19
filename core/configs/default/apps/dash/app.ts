// app.ts — THE DASH, as worker.ts mounts it: the host of one page. It answers the member's `itx`
// socket, what the UI kit's shell asks of its host, and the app's files. What the page shows is
// said in public/app.js. The Integrations page's buttons need no path here: "Connect", "Add
// account", "Connect again" and "Remove" call the mind's config over the page's own socket
// (`itx.config.cloudflareConnect`, `connectCloudAccount`, `removeCloudAccount`), the same
// functions an agent calls.
import { type AppDescription, serveFiles, type IterateConfigEntrypoint } from "iterate/sdk";
import theme from "../theme.css";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import liveReload from "../live-reload/";
import { openFile } from "../open-files.ts";
import index from "./index.html";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";

/** WHAT THE DASH SAYS OF ITSELF: the mind's sign-in pages show its name and its icon, and
 *  open on the passkey, since it is for members (../open-files.ts answers it to anyone). */
const DASH: AppDescription = { name: "Dash", icon: "/icon.svg", for: "members" };

export function dashApp() {
  return {
    /** The app's description and icon, for anyone: worker.ts asks this before its guard
     *  (../open-files.ts). */
    open: (request: Request) => openFile(request, DASH, files),
    /** Every request on the app's host. worker.ts guards it, so a member alone gets here. */
    fetch(request: Request, host: Pick<IterateConfigEntrypoint, "auth">) {
      // The page's own socket (public/app.js opens it), and what @iterate-com/ui's shell asks of
      // its host: which platform this page talks to, the one mind this app serves, its "Sign out".
      const page = host.auth.memberPage(request);
      if (page) return page;
      // the app's own files, and the two files that every app of this mind shares
      return serveFiles(request, {
        index,
        files: { ...files, ...liveReload, "theme.css": theme },
      });
    },
  };
}
