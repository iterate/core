// app.ts — THE ONBOARDING APP, as worker.ts mounts it: a centered, no-AI setup wizard for members.
// The page's files (index.html, public/app.js) and the guides are the repo `/repos/onboarding`
// (`ONBOARDING_REPO`); this file keeps the routes that act on the mind. Endpoints:
//   GET  /steps.json             onboarding step cards, checked first (steps.ts `onboardingCards`)
//   POST /steps/<step>/<action>  one step press (steps.ts `runStep`), same as itx.config.onboardingStep
//   GET  /ai-status.json         configured AI credentials and mind address (verify-ai.ts `aiStatus`)
//   POST /collect-openai-key     mind secret-collection link for /secrets/openai
//   POST /verify-ai              real server-side test LLM inference request (verify-ai.ts `verifyAi`)
//   GET  /open-cloud             303 to this mind's /sign-in/open, on to its page on iterate Cloud (open-cloud.ts)
//   GET  /theme.css, /live-reload.js  the two files that every app of this mind shares
//   anything else                the worker of `/repos/onboarding` at its newest commit: the page
// worker.ts guards the host before this file runs: only a member gets here, and nothing of the
// mind is read or written for anyone else.
import type { IterateContextApiWith } from "iterate/api";
import { type AppDescription, serveFiles, type IterateConfigEntrypoint } from "iterate/sdk";
import theme from "../theme.css";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import liveReload from "../live-reload/";
import { openFile } from "../open-files.ts";
import { launchOnboardingAgent } from "./launch.ts";
import { openCloud } from "./open-cloud.ts";
import { onboardingCards, runStep, stepContext } from "./steps.ts";
import { aiStatus, collectOpenAiKey, verifyAi } from "./verify-ai.ts";

/** WHAT THE ONBOARDING APP SAYS OF ITSELF: the mind's sign-in pages show its name and its icon,
 *  and open on the passkey alone, since it is for members (../open-files.ts answers it to anyone). */
const ONBOARDING: AppDescription = { name: "Onboarding", icon: "/icon.svg", for: "members" };

const PRESS = /^\/steps\/([a-z0-9-]{1,60})\/([a-z-]{1,40})$/;

/** The repo whose worker serves the onboarding page, and whose files are the guides and the cards
 *  that the onboarding agent reads (launch.ts). `iterate deploy` seeds it on a new mind. */
export const ONBOARDING_REPO = "/repos/onboarding";

/** The files that every app of this mind shares, answered from this repo. */
const SHARED_FILES = { ...liveReload, "theme.css": theme };

/** The onboarding app. `repo` is the repo whose worker serves the page. */
export function onboardingApp({ repo = ONBOARDING_REPO }: { repo?: string } = {}) {
  return {
    /** The app's description and icon, for anyone: worker.ts asks this before its guard
     *  (../open-files.ts). */
    open: (request: Request) => openFile(request, ONBOARDING),
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
        using itx = host.getItx() as IterateContextApiWith<"agents"> & Disposable;
        return await answer(async () => {
          const result = await verifyAi(itx);
          // The moment AI is proven working, create /agents/onboarding with its bespoke
          // instructions, generated tasks & dependencies overview, opener, and background subagents.
          if (result.ok) await launchOnboardingAgent(itx);
          return result;
        });
      }
      if (pathname === "/open-cloud" && request.method === "GET") {
        using itx = host.getItx();
        return openCloud((await itx.whoami()).mindSlug);
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
      if (pathname === "/theme.css" || pathname === "/live-reload.js")
        return serveFiles(request, { files: SHARED_FILES });
      return await pageFromRepo(request, host, repo);
    },
  };
}

/** The request, answered by the worker of `repo` at its newest commit. A mind with no such repo,
 *  or a repo with no commit, gets a 404 that says so. */
async function pageFromRepo(
  request: Request,
  host: Pick<IterateConfigEntrypoint, "getItx">,
  repo: string,
): Promise<Response> {
  using itx = host.getItx();
  const tip = await itx.repos
    .get(repo)
    .tip()
    .catch(() => null);
  if (!tip)
    return new Response(`This mind has no onboarding page: the repo ${repo} is not there.\n`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  // `as`: `workers.get` answers a handle that forwards every call to the loaded worker, whose
  // default export (worker.ts of the repo) has a `fetch`; the handle's type does not name it.
  const worker = itx.workers.get({
    source: ["itx", "repos", ["get", repo], ["files", { commitOid: tip }]],
    cacheKey: `onboarding-page:${repo}:${tip}`,
  }) as unknown as { fetch(request: Request): Promise<Response> };
  const answer = await worker.fetch(request);
  // The body is read before `using itx` releases the mind's handle at the end of this block.
  const body =
    request.method === "HEAD" || answer.status === 304 ? null : await answer.arrayBuffer();
  return new Response(body, { status: answer.status, headers: answer.headers });
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
