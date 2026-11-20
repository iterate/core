// app.ts — THE DOCS APP, as worker.ts mounts it: public/app.js says what the page does. This file
// serves the page and answers which version of the processors (processors/classes.ts) this
// commit holds. One more path, /notes/<name>.html, answers a stored HTML note inline (notes.ts).
import { type AppDescription, serveFiles, type IterateConfigEntrypoint } from "iterate/sdk";
import theme from "../theme.css";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import liveReload from "../live-reload/";
import { openFile } from "../open-files.ts";
import index from "./index.html";
import { isNotePath, noteResponse } from "./notes.ts";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import processors from "./processors/";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";

/** The module that exports the processors' classes, as a path in this repo. */
const PROCESSORS_MODULE = "apps/docs/processors/classes.ts";

/** WHAT THE DOCS APP SAYS OF ITSELF: the mind's sign-in pages show its name and its icon, and
 *  open on the passkey, since it is for members (../open-files.ts answers it to anyone). */
const DOCS: AppDescription = { name: "Docs", icon: "/icon.svg", for: "members" };

export function docsApp() {
  // The processors' source as TEXT (a folder import hands files over, it does not load them), for
  // one thing: a name for this version of it. The page starts a doc's processor from this repo's
  // files under that name, so a commit that changes the processors starts them anew, and a commit
  // that changes anything else (every autosave is one) leaves them running.
  let version: Promise<string> | undefined;
  return {
    /** The app's description and icon, for anyone: worker.ts asks this before its guard
     *  (../open-files.ts). */
    open: (request: Request) => openFile(request, DOCS),
    /** Every request on the app's host. worker.ts guards it, so a member alone gets here. */
    async fetch(request: Request, host: Pick<IterateConfigEntrypoint, "auth" | "getItx">) {
      const { pathname } = new URL(request.url);
      // A stored HTML note, read in the browser: /notes/<name>.html is the mind's file of that
      // path, fenced so that it cannot act as the member (notes.ts).
      if (isNotePath(pathname)) {
        using itx = host.getItx();
        return await noteResponse(request, (path) => itx.files.get(path).bytes());
      }
      // Where the processors' classes are and which version of them this commit holds.
      if (pathname === "/processors.json")
        return Response.json({
          mainModule: PROCESSORS_MODULE,
          version: await (version ||= versionOf(processors)),
        });
      // The page's own socket (public/app.js opens it), and what @iterate-com/ui's shell asks of
      // its host: the mind's issuer, the one mind this app serves, and its "Sign out".
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

/** A short name for the processors' source: a hash of every file's path and content. */
async function versionOf(source: Record<string, string | Uint8Array>): Promise<string> {
  const encoder = new TextEncoder();
  const parts = Object.keys(source)
    .sort()
    .flatMap((path) => {
      const content = source[path]!;
      return [
        encoder.encode(`\0${path}\0`),
        typeof content === "string" ? encoder.encode(content) : content,
      ];
    });
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
