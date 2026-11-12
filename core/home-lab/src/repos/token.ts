// A REPO'S OWN TOKEN at home: `v1.<grant>.<mac>`. The grant says one repo, read or write, and when
// it ends; the mac is its HMAC-SHA-256 under the store's token. The store's token itself opens
// every repo and the store's admin paths: it stays with the launcher and the platform's own calls.
export type RepoGrant = { repo: string; scope: "read" | "write"; expires: number };

const encoder = new TextEncoder();
const keyOf = (storeToken: string) =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(storeToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

export async function repoToken(storeToken: string, grant: RepoGrant): Promise<string> {
  const text = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const mac = await crypto.subtle.sign("HMAC", await keyOf(storeToken), encoder.encode(text));
  return `v1.${text}.${Buffer.from(mac).toString("base64url")}`;
}

/** The grant that `token` carries, or null: not signed by this store, or over. */
export async function repoGrantOf(
  storeToken: string,
  token: string,
  now = Date.now(),
): Promise<RepoGrant | null> {
  const [version, text = "", mac = ""] = token.split(".");
  if (version !== "v1") return null;
  const signed = await crypto.subtle.verify(
    "HMAC",
    await keyOf(storeToken),
    Buffer.from(mac, "base64url"),
    encoder.encode(text),
  );
  if (!signed) return null;
  // the cast: the mac says that `repoToken` wrote this text
  const grant = JSON.parse(Buffer.from(text, "base64url").toString()) as RepoGrant;
  return grant.expires > now ? grant : null;
}
