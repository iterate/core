/** The project keeps every hostname of its domain but this one. */
export const PLATFORM_HOSTNAME_LABEL = "iterate";

export const platformOriginOf = (address: string) =>
  `https://${PLATFORM_HOSTNAME_LABEL}.${address}`;

/** Also the API's OAuth resource identifier (RFC 8707). Platform code serves it before the
 *  project's own, so it stays the way in when the project's config is broken. */
export const projectApiUrlOf = (address: string) => `${platformOriginOf(address)}/api`;

/** Also the MCP server's OAuth resource identifier. */
export const projectMcpUrlOf = (address: string) => `${platformOriginOf(address)}/mcp`;

/** Also the OAuth resource identifier of the credential a home lab presents there. */
export const projectProvideUrlOf = (address: string) => `${platformOriginOf(address)}/provide`;

/** RFC 9728 §3.1. */
export function protectedResourceMetadataUrlOf(resource: string) {
  const { origin, pathname } = new URL(resource);
  return `${origin}/.well-known/oauth-protected-resource${pathname === "/" ? "" : pathname}`;
}

export type PlatformRoute = "auth" | "secrets" | "api" | "mcp" | "provide";

/** The one definition ingress, egress and the project route by. Null: the project's own. */
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

export function projectAddressOf(input: string): { address: string } | { error: string } {
  const typed = input.trim().toLowerCase();
  if (!typed) return { error: "Enter the project's address, like iterate.example.com." };
  let hostname: string;
  try {
    hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(typed) ? typed : `https://${typed}`).hostname;
  } catch {
    return { error: "Enter the project's address, like iterate.example.com." };
  }
  hostname = hostname.replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return { address: hostname };
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("["))
    return { error: "A project's address is a domain name, not an IP address." };
  if (!hostname.includes("."))
    return { error: "Enter the project's whole address, like iterate.example.com." };
  return { address: hostname };
}

/** The addresses a typed host may name, in the order to ask: the host as the platform's own
 *  hostname (`iterate.example.com` names `example.com`), then the host as the domain. Only discovery
 *  decides which one is the project. */
export function projectAddressCandidatesOf(host: string): string[] {
  const prefix = `${PLATFORM_HOSTNAME_LABEL}.`;
  const under = host.startsWith(prefix) ? host.slice(prefix.length) : "";
  return under.includes(".") ? [under, host] : [host];
}

/** Ingress serves it, never the project, so a project cannot name another issuer. The first issuer
 *  is the one to use. */
export type ProjectResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
};
