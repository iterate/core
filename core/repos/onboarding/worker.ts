// worker.ts — THE ONBOARDING PAGE'S FILES, as a worker of this repo.
//
// The config worker of the mind (`apps/onboarding/` of `/repos/config`) guards
// `onboarding.<zone>`: it answers the app's name and icon to anyone, asks for a member, and answers
// the app's own routes (the steps, the AI check, the page's socket, `/theme.css` and
// `/live-reload.js`). Every other request on that host comes here, to the newest commit of this
// repo, and this worker serves the page's files.
import { IterateConfigEntrypoint, serveFiles } from "iterate/sdk";
import index from "./index.html";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";

/** The onboarding page: `index.html` at `/`, and the files of `public/` by path. */
export default class extends IterateConfigEntrypoint {
  async fetch(request: Request) {
    return serveFiles(request, { index, files });
  }

  async email() {}

  async processEvent() {}
}
