// app.ts — THE DASH, as worker.ts mounts it: the host of one page. It answers the member's `itx`
// socket, what the UI kit's shell asks of its host, and the app's files. What the page shows is
// said in public/app.js. Three more paths still answer, though no card of this template links to
// them now: its cards' buttons call the mind's config at the press (`connectCloudAccount`,
// `cloudflareConnect`, `removeCloudAccount`). They stay for a card that an older config wrote, and
// go once the minds' own cards call too. `/connect/<app>` begins a connect through that app of
// iterate Cloud's (../../cloud-accounts.ts `connectCloudAccount`) and sends the member on to it.
// `/connect/cloudflare` begins the Cloudflare connect (../../cloudflare.ts). `POST /remove/<app>`
// is an older row's "Remove": the mind forgets the account (../../cloud-accounts.ts
// `removeCloudAccount`, which an agent calls the same).
import { type AppDescription, serveFiles, type IterateConfigEntrypoint } from "iterate/sdk";
import theme from "../theme.css";
import { cloudflareConnect } from "../../cloudflare.ts";
import { connectCloudAccount, removeCloudAccount } from "../../cloud-accounts.ts";
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
    fetch(request: Request, host: Pick<IterateConfigEntrypoint, "auth" | "getItx">) {
      const url = new URL(request.url);
      const app = /^\/connect\/([a-z0-9-]{1,40})$/.exec(url.pathname)?.[1];
      if (app === "cloudflare" && request.method === "GET") return connectCloudflare(host, url);
      if (app && request.method === "GET") return connectThroughCloud(host, app, url);
      const removed = /^\/remove\/([a-z0-9-]{1,40})$/.exec(url.pathname)?.[1];
      if (removed && request.method === "POST") return removeThroughPage(host, removed, request);
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

/** THE CONNECT TO THE MIND'S OWN CLOUDFLARE ACCOUNT, begun for the member who pressed the card's
 *  button: the answer sends their browser to the one link of `cloudflareConnect`, Cloudflare's
 *  consent page or the form for a client that a member made. `tell`: the agent that asked, when
 *  that form leads back here. */
async function connectCloudflare(
  host: Pick<IterateConfigEntrypoint, "getItx">,
  url: URL,
): Promise<Response> {
  using itx = host.getItx();
  try {
    const { link } = await cloudflareConnect(itx, {
      tell: url.searchParams.get("tell") || undefined,
    });
    return new Response(null, { status: 303, headers: { location: link } });
  } catch (error) {
    return new Response(
      `Could not begin the connect: ${error instanceof Error ? error.message : String(error)}`,
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
}

/** A CONNECT THROUGH ONE OF iterate Cloud's APPS, from an older card's link: the answer sends the
 *  member's browser on to the link of `connectCloudAccount` (../../cloud-accounts.ts), which the
 *  cards' buttons now call themselves. `?secret=` names a secret to connect again in place. */
async function connectThroughCloud(
  host: Pick<IterateConfigEntrypoint, "getItx">,
  app: string,
  url: URL,
): Promise<Response> {
  using itx = host.getItx();
  try {
    const { link } = await connectCloudAccount(
      itx,
      app,
      url.searchParams.get("secret") || undefined,
    );
    return new Response(null, { status: 303, headers: { location: link } });
  } catch (error) {
    // the Cloud gave no answer, or it has no such app: the vault's own words say which
    return new Response(
      `Could not begin the connect: ${error instanceof Error ? error.message : String(error)}`,
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
}

/** A ROW'S "REMOVE", sent by the Integrations page after the member said yes: the secret
 *  `?secret=<name>` of the app `app`, and no other secret. Only this page sends it: a POST that
 *  another site's form makes in the member's browser names that site as its `origin`, and is
 *  refused. The answer is what `removeCloudAccount` did, or its words when it refused. */
async function removeThroughPage(
  host: Pick<IterateConfigEntrypoint, "getItx">,
  app: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin)
    return new Response("Remove an account from the Integrations page.", { status: 403 });
  const name = url.searchParams.get("secret") || "";
  if (name !== app && !name.startsWith(`${app}-`))
    return new Response(`${name || "No secret"} is no account of ${app}.`, { status: 400 });
  using itx = host.getItx();
  try {
    return Response.json(await removeCloudAccount(itx, `/secrets/${name}`));
  } catch (error) {
    return new Response(
      `Could not remove the account: ${error instanceof Error ? error.message : String(error)}`,
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
}
