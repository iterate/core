// dash.ts — `/dash`: the hosted Dash for this project, at the trusted client whose hostname names
// it. A config that trusts none has no Dash here.
import { type Env, iterateConfigOf } from "./env.ts";
import { errorPage } from "./pages.ts";

export const DASH_PATH = "/dash";

/** The hosted Dash this config trusts, if it trusts one. */
export const dashOriginOf = (env: Env) =>
  (iterateConfigOf(env).trustedClients || []).find((client) =>
    new URL(client).hostname.split(/[.-]/).includes("dash"),
  );

export function dashResponse(env: Env): Response {
  const { domain } = iterateConfigOf(env);
  const origin = dashOriginOf(env);
  if (!origin)
    return errorPage(`No Dash is set up for ${domain}: its config trusts no Dash app.`, 404);
  return new Response(null, {
    status: 302,
    headers: {
      location: `${origin}/projects/${encodeURIComponent(domain)}`,
      "cache-control": "no-store",
    },
  });
}
