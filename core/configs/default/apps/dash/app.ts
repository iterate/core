// app.ts — THE DASH, as worker.ts mounts it: the host of one page. It answers the member's `itx`
// socket, what the UI kit's shell asks of its host, and the app's files. What the page shows is
// said in public/app.js. One more path, `/connect/<app>`, is where the Integrations page's
// "Connect", "Add account" and "Connect again" buttons lead (../../cloud-accounts.ts): it begins a
// connect through that app of iterate Cloud's, with the scopes ../../cloud-scopes.ts names, and
// sends the member on to it.
import { serveFiles, type IterateConfigEntrypoint } from "iterate/sdk";
import theme from "../theme.css";
import { CLOUD_SCOPES } from "../../cloud-scopes.ts";
import { openFile } from "../open-files.ts";
import index from "./index.html";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";

export function dashApp() {
  return {
    /** The app's manifest and icon, for anyone: worker.ts asks this before its guard
     *  (../open-files.ts). */
    open: (request: Request) => openFile(request, files),
    /** Every request on the app's host. worker.ts guards it, so a member alone gets here. */
    fetch(request: Request, host: Pick<IterateConfigEntrypoint, "auth" | "getItx">) {
      const url = new URL(request.url);
      const app = /^\/connect\/([a-z0-9-]{1,40})$/.exec(url.pathname)?.[1];
      if (app && request.method === "GET") return connectThroughCloud(host, app, url);
      // The page's own socket (public/app.js opens it), and what @iterate-com/ui's shell asks of
      // its host: which platform this page talks to, the one mind this app serves, its "Sign out".
      const page = host.auth.memberPage(request);
      if (page) return page;
      // the app's own files, and the one theme file that every app of this mind shares
      return serveFiles(request, { index, files: { ...files, "theme.css": theme } });
    },
  };
}

/** A CONNECT THROUGH ONE OF iterate Cloud's APPS, begun for the member who pressed the button: the
 *  answer sends their browser to the secrets Worker's start page, which shows the secret and the
 *  hosts its tokens go to before anything leaves for the service. Nothing is stored until they
 *  approve there. `again` names a secret to connect again in place (its row's "Connect again");
 *  with none, the account gets the first free name: `/secrets/google`, then `/secrets/google-2`.
 *  For GitHub the member chooses the installation on the App's own install page. */
async function connectThroughCloud(
  host: Pick<IterateConfigEntrypoint, "getItx">,
  app: string,
  url: URL,
): Promise<Response> {
  const again = url.searchParams.get("secret");
  using itx = host.getItx();
  try {
    const taken = new Set((await itx.secrets.list()).map((secret) => secret.path));
    let path = `/secrets/${app}`;
    for (let n = 2; taken.has(path); n += 1) path = `/secrets/${app}-${n}`;
    // a secret of this app alone is connected again: no other secret is written over from a link
    if (again && (again === app || again.startsWith(`${app}-`)) && taken.has(`/secrets/${again}`))
      path = `/secrets/${again}`;
    const { authorizationUrl } = await itx.secrets.beginOAuth(path, {
      client: { cloud: app },
      install: app === "github",
      // the mind's own choice for this app, else the Cloud's defaults (../../cloud-scopes.ts)
      ...(Object.hasOwn(CLOUD_SCOPES, app) && CLOUD_SCOPES[app] && { scope: CLOUD_SCOPES[app] }),
      // back to this page, on the Dash's own host: the vault takes an absolute URL of the mind's
      next: `${url.origin}/?page=integrations`,
    });
    return new Response(null, { status: 303, headers: { location: authorizationUrl } });
  } catch (error) {
    // no Cloud, or no such app at it: the vault's own words say which
    return new Response(
      `Could not begin the connect: ${error instanceof Error ? error.message : String(error)}`,
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
}
