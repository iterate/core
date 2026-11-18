/** The mind keeps every hostname of its domain but this one. */
export const PLATFORM_HOSTNAME_LABEL = "iterate";

export const platformOriginOf = (address: string) =>
  `https://${PLATFORM_HOSTNAME_LABEL}.${address}`;

/** Also the API's OAuth resource identifier (RFC 8707). Platform code serves it before the
 *  mind's own, so it stays the way in when the mind's config is broken. */
export const mindApiUrlOf = (address: string) => `${platformOriginOf(address)}/api`;

/** Also the MCP server's OAuth resource identifier. */
export const mindMcpUrlOf = (address: string) => `${platformOriginOf(address)}/mcp`;

/** The name a coding agent's CLI keeps the mind's MCP server under (`claude mcp add … <name>`,
 *  `codex mcp add <name>`): the address with a hyphen for each dot. A person with two minds then
 *  has two servers, and Claude Code refuses a name with a dot in it. */
export const mindMcpNameOf = (address: string) => address.replace(/[^a-zA-Z0-9_-]/g, "-");

/** Also the OAuth resource identifier of the credential a home lab presents there. */
export const mindProvideUrlOf = (address: string) => `${platformOriginOf(address)}/provide`;

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

/** RFC 9728 §3.1. */
export function protectedResourceMetadataUrlOf(resource: string) {
  const { origin, pathname } = new URL(resource);
  return `${origin}/.well-known/oauth-protected-resource${pathname === "/" ? "" : pathname}`;
}

export type PlatformRoute = "auth" | "secrets" | "api" | "mcp" | "provide";

/** The one definition ingress, egress and the mind route by. Null: the mind's own. */
export function platformRouteOf(url: URL, address: string): PlatformRoute | null {
  if (url.hostname !== `${PLATFORM_HOSTNAME_LABEL}.${address}`) return null;
  const under = (prefix: string) =>
    url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
  for (const route of ["api", "mcp"] as const)
    if (
      under(`/${route}`) ||
      url.pathname === new URL(protectedResourceMetadataUrlOf(`${url.origin}/${route}`)).pathname
    )
      return route;
  if (under("/secrets")) return "secrets";
  return under("/provide") ? "provide" : "auth";
}

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
    return { error: "A mind's address is a domain name, not an IP address." };
  if (!hostname.includes("."))
    return { error: "Enter the mind's whole address, like iterate.example.com." };
  return { address: hostname };
}

/** The addresses a typed host may name, in the order to ask: the host as the platform's own
 *  hostname (`iterate.example.com` names `example.com`), then the host as the domain. Only discovery
 *  decides which one is the mind. */
export function mindAddressCandidatesOf(host: string): string[] {
  const prefix = `${PLATFORM_HOSTNAME_LABEL}.`;
  const under = host.startsWith(prefix) ? host.slice(prefix.length) : "";
  return under.includes(".") ? [under, host] : [host];
}

/** Ingress serves it, never the mind, so a mind cannot name another issuer. The first issuer
 *  is the one to use. */
export type MindResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
};
