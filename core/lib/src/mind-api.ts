// mind-api.ts — WHERE A MIND ANSWERS (`iterate/mind-api`). A mind is named by its control-plane
// hostname (iterate/mind-config `controlPlaneHostname`): its sign-in, its API and its MCP server answer
// there, and a client's address of a mind is that hostname. Nothing here computes it from a zone.
import { Hostname } from "./mind-config.ts";

/** WHAT A SANDBOX'S PROCESSES ARE TOLD (core/mind-worker/src/sandbox/container.ts): the mind's
 *  address and the sandbox's context path. A hint for the `iterate` CLI, and no credential: who a
 *  sandbox is comes from its egress alone, which the container cannot reach. */
export const sandboxVariablesOf = (address: string, sandboxPath: string) => ({
  ITERATE_MIND: address,
  ITERATE_SANDBOX: sandboxPath,
});

/** THE SANDBOX WHOSE OWN SESSION A CONNECTION TO `address` TAKES, or null: this process runs in a
 *  sandbox of that mind and names no token. The client then sends no bearer, and the sandbox's
 *  egress serves the mind's API as the sandbox's own context (core/mind-worker/src/sandbox/egress.ts).
 *  On any other computer the variables are unset. Set by hand there, they give the boundary's 401. */
export function ownSandboxOf(
  env: Record<string, string | undefined>,
  address: string,
): string | null {
  const sandbox = env.ITERATE_SANDBOX?.trim();
  if (!sandbox || env.ITERATE_MIND_TOKEN?.trim()) return null;
  return env.ITERATE_MIND?.trim().toLowerCase() === address ? sandbox : null;
}

/** On the 401 a sandbox gets for its own session when the mind filters what it sends: why. Set
 *  by the sandbox's egress alone, and read by the `iterate` CLI. */
export const SANDBOX_SESSION_REFUSED_HEADER = "x-iterate-sandbox-session-refused";

/** WHY A SANDBOX GOT NO SESSION OF ITS OWN, in words for whoever ran the command. `why` is the
 *  egress's own reason, on a 401 it marked (`SANDBOX_SESSION_REFUSED_HEADER`). Without it, nothing
 *  on the way served a session: a stack older than this CLI, or variables set outside a sandbox. */
export function sandboxSessionRefusal(input: {
  sandbox: string;
  address: string;
  status: number | undefined;
  why: string | string[] | undefined;
}): string {
  const why = Array.isArray(input.why) ? input.why[0] : input.why;
  const way = `To act as a member instead, set ITERATE_MIND_TOKEN.`;
  return why
    ? `The sandbox ${input.sandbox} gets no session of its own with ${input.address}: ${why}. Its owner removes that rule to give it one. ${way}`
    : `${input.address} answered ${input.status} and served no session for the sandbox ${input.sandbox}: its stack may be older than this CLI, or this is no sandbox of that mind. ${way}`;
}

/** A MIND'S ADDRESS AS A PERSON TYPED IT: the control-plane hostname, lowercased, with a scheme, a path
 *  and a trailing dot dropped. A hostname is taken as typed. The one shorthand is for a BARE
 *  `something.tld`: exactly two labels and nothing else typed (no scheme, port or path), which
 *  means `iterate.something.tld`. A URL keeps its hostname: `https://example.com/` names
 *  `example.com`.
 *
 *  THIS IS FOR WHAT A PERSON TYPES, ONCE: an input box, a command's argument. Its answer is the
 *  mind's address, and every function after it takes that address as it is. A second pass over
 *  an answer would put `iterate.` before a control plane at a zone's apex, and send that mind's
 *  token to a hostname that its own code answers. What code hands on (a link's parameter, a
 *  stored profile) is read with `mindAddressGiven`. */
export function mindAddressOf(input: string): { address: string } | { error: string } {
  const typed = input.trim().toLowerCase();
  if (!typed) return { error: "Enter the mind's address, like iterate.example.com." };
  let hostname: string;
  try {
    hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(typed) ? typed : `https://${typed}`).hostname;
  } catch {
    return { error: "Enter the mind's address, like iterate.example.com." };
  }
  hostname = hostname.replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return { address: hostname };
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("["))
    return { error: "A mind's address is a hostname, not an IP address." };
  if (!hostname.includes("."))
    return { error: "Enter the mind's whole address, like iterate.example.com." };
  const bare = /^[a-z0-9-]+\.[a-z0-9-]+\.?$/.test(typed);
  const address = mindAddressGiven(bare ? `iterate.${hostname}` : hostname);
  if (!address)
    return { error: "That is no hostname. Enter the mind's address, like iterate.example.com." };
  return { address };
}

/** AN ADDRESS AS TEXT FOR A FIELD THAT `mindAddressOf` READS (a connect page that the gate fills
 *  in): the address, and a two-label one as a URL, which the shorthand leaves as it is. */
export const mindAddressAsTyped = (address: string) =>
  /^[a-z0-9-]+\.[a-z0-9-]+$/.test(address) ? `https://${address}` : address;

/** A MIND'S ADDRESS THAT CODE HANDS ON, as it is: lowercased, and null when it is no hostname.
 *  No shorthand: `example.com` here is the mind whose control plane is at `example.com`. */
export function mindAddressGiven(given: string): string | null {
  const address = given.toLowerCase();
  // a mind in local development
  if (address === "localhost" || address.endsWith(".localhost")) return address;
  return Hostname.safeParse(address).data ?? null;
}

/** Also the API's OAuth resource identifier (RFC 8707). The boundary serves it before the mind's
 *  own code, so it stays the way in when the mind's config is broken. */
export const mindApiUrlOf = (controlPlaneHostname: string) => `https://${controlPlaneHostname}/api`;

/** Also the MCP server's OAuth resource identifier. */
export const mindMcpUrlOf = (controlPlaneHostname: string) => `https://${controlPlaneHostname}/mcp`;

/** The name a coding agent's CLI keeps the mind's MCP server under (`claude mcp add … <name>`,
 *  `codex mcp add <name>`): the control-plane hostname with a hyphen for each dot. A person with two
 *  minds then has two servers, and Claude Code refuses a name with a dot in it. */
export const mindMcpNameOf = (controlPlaneHostname: string) =>
  controlPlaneHostname.replace(/[^a-zA-Z0-9_-]/g, "-");

/** THE OAUTH RESOURCE IDENTIFIER (RFC 8707) OF THE RIGHT TO HAND IN THE MIND: the audience of the
 *  token that a mind which runs elsewhere (core/home-lab) authenticates with at the API, where it
 *  gets `provideExternalMind` and nothing else (iterate/workers `ControlPlaneSession`). It is no
 *  address of its own. A token for the API is not live for it, so no member's API token hands in
 *  a mind; a token for it reaches nothing of the mind. */
export const mindProvideConnectResourceOf = (controlPlaneHostname: string) =>
  `${mindApiUrlOf(controlPlaneHostname)}/provide-connect`;

/** THE HEADER BY WHICH A DIAL OF THE API SAYS THAT IT HANDS IN A MIND, with any value. It decides
 *  WHERE THE SESSION ENDS, and nothing about who the dial is: every session authenticates the
 *  same way. A mind's link lasts for days and every request of the mind uses it, so its socket
 *  ends in the boundary's Durable Object (core/boundary-worker `ProvidedMind`), which every
 *  invocation reaches, and not in the one invocation that answers an ordinary dial. */
export const MIND_PROVIDE_EXTERNAL_MIND_HEADER = "x-iterate-provide-external-mind";

/** RFC 9728 §3.1. */
export function protectedResourceMetadataUrlOf(resource: string) {
  const { origin, pathname } = new URL(resource);
  return `${origin}/.well-known/oauth-protected-resource${pathname === "/" ? "" : pathname}`;
}

export type ControlPlaneRoute = "auth" | "secrets" | "api" | "mcp";

/** WHICH PART OF THE CONTROL PLANE A REQUEST ON THE CONTROL-PLANE HOSTNAME IS FOR, by its path alone.
 *  The boundary and the mind Worker both route by it; each decides first that the hostname is the
 *  control-plane hostname. */
export function controlPlaneRouteOf(url: URL): ControlPlaneRoute {
  const under = (prefix: string) =>
    url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
  for (const route of ["api", "mcp"] as const)
    if (
      under(`/${route}`) ||
      url.pathname === new URL(protectedResourceMetadataUrlOf(`${url.origin}/${route}`)).pathname
    )
      return route;
  return under("/secrets") ? "secrets" : "auth";
}

/** The boundary serves it, never the mind, so a mind cannot name another issuer. The first issuer
 *  is the one to use. */
export type MindResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
};
