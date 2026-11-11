export function honouredNext(
  next: string | null,
  issuer: string,
  trustedClients: readonly string[] = [],
): string | null {
  if (!next) return null;
  let url: URL;
  try {
    url = new URL(next, issuer);
  } catch {
    return null;
  }
  // resolved first, so `//evil.example` and `/\evil.example` are judged by where they really go
  if (url.origin === issuer) return `${url.pathname}${url.search}${url.hash}`;
  // A hostname of the mind (its domain, or a label under it) is the owner's own site: the
  // onboarding app, the Agents app. The issuer is `iterate.<domain>`.
  const domain = new URL(issuer).hostname.split(".").slice(1).join(".");
  if (url.protocol === "https:" && (url.hostname === domain || url.hostname.endsWith(`.${domain}`)))
    return url.href;
  return trustedClients.includes(url.origin) ? url.href : null;
}

// The mind resolves dot segments, so `/integrations/../secrets/x` would land at `/secrets/x`
// while its text starts with `/integrations/`.
export const canonicalPath = (path: string) =>
  path.startsWith("/") &&
  (path === "/" ||
    path
      .split("/")
      .slice(1)
      .every((segment) => segment && segment !== "." && segment !== ".."));

// By whole segments, so `/smoke` never reaches `/smokey`.
export const underPaths = (path: string, paths: readonly string[] | undefined) =>
  !paths ||
  paths.some((prefix) => {
    const root = prefix.replace(/\/+$/, "");
    return path === root || path.startsWith(`${root}/`);
  });

const SERVICE_PATHS_ROOT = "/integrations/";

export type ServiceKeyRequest = {
  actor: string;
  label: string;
  publicKey: string;
  paths: string[];
};

// `actor` allows no `_`, so it is never a user's id, `user_…`.
export function serviceKeyRequestOf(
  fields: URLSearchParams | FormData,
): ServiceKeyRequest | { refused: string } {
  const field = (name: string) => String(fields.get(name) || "").trim();
  const actor = field("actor");
  const label = field("label");
  const publicKey = field("publicKey");
  const paths = field("paths")
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(Boolean);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(actor))
    return { refused: "The service's name must be lowercase letters, digits and hyphens." };
  if (!label || label.length > 100) return { refused: "The service must give a short name." };
  if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) return { refused: "The service sent no public key." };
  // A key a member allows on a page reaches integrations alone: a link someone was tricked into
  // opening cannot ask for an agent's context or the mind's root. A wider key is the config's.
  if (
    !paths.length ||
    !paths.every(
      (prefix) =>
        prefix.startsWith(SERVICE_PATHS_ROOT) && canonicalPath(prefix.replace(/\/+$/, "")),
    )
  )
    return {
      refused: `The service may add events under ${SERVICE_PATHS_ROOT} alone, and must name where.`,
    };
  return { actor, label, publicKey, paths };
}
