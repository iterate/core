/** The mind keeps every hostname of its domain but this one. */
export const PLATFORM_HOSTNAME_LABEL = "iterate";

export const platformOriginOf = (address: string) =>
  `https://${PLATFORM_HOSTNAME_LABEL}.${address}`;

/** Also the API's OAuth resource identifier (RFC 8707). Platform code serves it before the
 *  mind's own, so it stays the way in when the mind's config is broken. */
export const mindApiUrlOf = (address: string) => `${platformOriginOf(address)}/api`;

/** Also the MCP server's OAuth resource identifier. */
export const mindMcpUrlOf = (address: string) => `${platformOriginOf(address)}/mcp`;

/** Also the OAuth resource identifier of the credential a home lab presents there. */
export const mindProvideUrlOf = (address: string) => `${platformOriginOf(address)}/provide`;

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
