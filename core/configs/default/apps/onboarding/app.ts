// app.ts — THE ONBOARDING APP, as worker.ts mounts it: a centered, no-AI setup wizard for members
// (public/app.js). Endpoints:
//   GET  /steps.json             onboarding step cards, checked first (steps.ts `onboardingCards`)
//   POST /steps/<step>/<action>  one step press (steps.ts `runStep`), same as itx.config.onboardingStep
//   GET  /ai-status.json         configured AI credentials and mind address (verify-ai.ts `aiStatus`)
//   POST /collect-openai-key     mind secret-collection link for /secrets/openai
//   POST /verify-ai              real server-side test LLM inference request (verify-ai.ts `verifyAi`)
// worker.ts guards the host before this file runs: only a member gets here, and nothing of the
// mind is read or written for anyone else.
import { type AppDescription, serveFiles, type IterateConfigEntrypoint } from "iterate/sdk";
import theme from "../theme.css";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import liveReload from "../live-reload/";
import { openFile } from "../open-files.ts";
import index from "./index.html";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";
import { onboardingCards, runStep, stepContext } from "./steps.ts";
import { aiStatus, collectOpenAiKey, verifyAi } from "./verify-ai.ts";

/** WHAT THE ONBOARDING APP SAYS OF ITSELF: the mind's sign-in pages show its name and its icon,
 *  and open on the passkey alone, since it is for members (../open-files.ts answers it to anyone). */
const ONBOARDING: AppDescription = { name: "Onboarding", icon: "/icon.svg", for: "members" };

const PRESS = /^\/steps\/([a-z0-9-]{1,60})\/([a-z-]{1,40})$/;

export function onboardingApp() {
  return {
    /** The app's description and icon, for anyone: worker.ts asks this before its guard
     *  (../open-files.ts). */
    open: (request: Request) => openFile(request, ONBOARDING, files),
    /** Every request on the app's host. worker.ts guards it, so a member alone gets here. */
    async fetch(request: Request, host: Pick<IterateConfigEntrypoint, "auth" | "getItx">) {
      const { pathname } = new URL(request.url);
      // `return await`, never `return <promise>`, inside a `using` block: the block releases the
      // mind's handle at the return, so the steps must be done by then.
      if (pathname === "/steps.json" && request.method === "GET") {
        using itx = host.getItx();
        return await answer(async () => onboardingCards(await stepContext(itx)));
      }
      if (pathname === "/ai-status.json" && request.method === "GET") {
        using itx = host.getItx();
        return await answer(async () => aiStatus(itx));
      }
      if (pathname === "/collect-openai-key" && request.method === "POST") {
        using itx = host.getItx();
        return await answer(async () => collectOpenAiKey(itx));
      }
      if (pathname === "/verify-ai" && request.method === "POST") {
        using itx = host.getItx();
        return await answer(async () => verifyAi(itx));
      }
      const press = PRESS.exec(pathname);
      if (press && request.method === "POST") {
        using itx = host.getItx();
        return await answer(async () => runStep(await stepContext(itx), press[1]!, press[2]!));
      }
      // The page's own socket (public/app.js opens it), and what @iterate-com/ui's shell asks of
      // its host: the mind's issuer, the one mind this app serves, and its "Sign out".
      const page = host.auth.memberPage(request);
      if (page) return page;
      // the app's own files, and the two files that every app of this mind shares
      return serveFiles(request, { index, files: { ...files, ...liveReload, "theme.css": theme } });
    },
  };
}

/** The call's answer as JSON; a throw as `{ error }`, with its words, for the card to show. */
async function answer(run: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await run(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
}
