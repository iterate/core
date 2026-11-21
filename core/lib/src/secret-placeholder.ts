// secret-placeholder.ts — THE PLACEHOLDER GRAMMAR (tasks/mind-stack.md): how a request spells a
// secret, `getSecret("/secrets/<name>")`, defined once for the Workers that read it. Egress finds
// which secret a request names and sends it to the secrets Worker with the secret named in
// `SECRET_USE_HEADER`; the secrets Worker substitutes the material. Pure, moved unchanged out of
// the earlier platform (core/os, removed). And the path of the secrets Worker's OAuth callback,
// which the mind answers as `itx.secrets.oauthCallbackUrl()`. The facts a secret's answer carries
// ride the one carrier of iterate/facts.
import { cookieTrimmed } from "./lib.ts";

/** A secret's name: `[a-zA-Z0-9._-]+`, but never `.` or `..` — the two segments
 *  `resolveContextPath` resolves away, so `/secrets/..` would name its owner's ROOT (and
 *  `/secrets/.` the `/secrets` context), never a secret's own context. The stored path and the
 *  placeholder share this grammar. */
const SECRET_NAME = String.raw`(?!\.\.?(?![a-zA-Z0-9._-]))[a-zA-Z0-9._-]+`;

/** The secrets Worker's redirect URI for a secret's OAuth, on the platform's origin, under its pages:
 *  registered once per provider app. */
export const SECRET_OAUTH_CALLBACK_PATH = "/secrets/oauth/callback";

/** A secret IS its path, and the path is what the placeholder spells: `/secrets/<name>`. */
export const SECRET_PATH = new RegExp(`^/secrets/${SECRET_NAME}$`);

export function assertSecretPath(path: string): string {
  if (!SECRET_PATH.test(path))
    throw new Error(
      `secrets: a secret's path is /secrets/<name>, the name [a-zA-Z0-9._-]+ and never "." or ".." (what getSecret("/secrets/<name>") can spell), got ${JSON.stringify(path)}`,
    );
  return path;
}

// ── the placeholder grammar ── for a URL, a header or a JSON body:
// `getSecret("/secrets/NAME")` is the whole stored value; `getSecret("/secrets/NAME", { field: "a.b" })`
// is one dotted field of a JSON-valued secret; `getSecret("/secrets/NAME", { appJwt: true })` is a
// GitHub App's JWT made from the secret (api.ts `SecretMaterial`). Double quotes, whitespace free
// inside the parentheses; `/secrets/NAME` is the PATH `itx.secrets.set("/secrets/NAME", …)` stored. Matched as written in a
// header, and as the URL parser percent-encodes it in a URL (`"` → %22, a space → %20, `{` → %7B, `}`
// → %7D) — the path and the query alike; the value is spliced back into the URL as ONE component,
// `:` kept (Telegram's `bot123:abc` path). A `Basic base64(user:getSecret(…))` credential is peeled:
// the placeholder is substituted inside the decoded `user:password` and the credential encoded
// again — the Authorization a git remote's userinfo becomes (`https://x:getSecret(…)@host/repo.git`,
// as git and curl send it). In a JSON body it is filled only as the whole value of a field that the
// secret names, in the request that it names (core/secrets-worker/src/body-placement.ts). Egress
// reads no body: a request names its secret in a header or its URL.
//
// NO TWO RUNS OF WHITESPACE STAND SIDE BY SIDE in the pattern: the run before the closing
// parenthesis is inside the optional `{ … }` part. Two neighbours would share a long run of spaces
// in every way it splits, and the time to refuse `getSecret("/secrets/x"` with n spaces after it
// would grow with n squared. A header from outside is matched before anything else reads it.
const QUOTE = '(?:"|%22)';
const SPACE = "(?:\\s|%20)*";
export const SECRET_PLACEHOLDER = new RegExp(
  `getSecret\\(${SPACE}${QUOTE}(/secrets/${SECRET_NAME})${QUOTE}${SPACE}` +
    `(?:,${SPACE}(?:\\{|%7B)${SPACE}(?:field${SPACE}:${SPACE}${QUOTE}([^"%\\s]+)${QUOTE}|(appJwt)${SPACE}:${SPACE}true)${SPACE}(?:\\}|%7D)${SPACE})?\\)`,
  "g",
);

/** The placeholder as a caller wrote it, for a refusal that names it. */
export const placeholderOf = (path: string, field: string | undefined, appJwt?: string): string =>
  appJwt
    ? `getSecret("${path}", { appJwt: true })`
    : !field
      ? `getSecret("${path}")`
      : `getSecret("${path}", { field: "${field}" })`;

/** The DISTINCT secret paths a request's URL and headers reference — how egress knows which
 *  secret's context a request belongs to (one request, one secret). */
export function secretPathsReferenced(request: Request): string[] {
  const paths = new Set(secretPathsIn(request.url));
  for (const [, value] of request.headers)
    for (const path of headerSecretPaths(value)) paths.add(path);
  return [...paths];
}

/** THE SECRET PATHS A HEADER'S VALUE NAMES, as egress reads a header: a `Basic` credential
 *  decoded, any other value as it is. Empty: the header names no secret. */
export const headerSecretPaths = (value: string): string[] =>
  secretPathsIn(basicCredentialOf(value) ?? value);

/** Whether a header's value names a secret, as egress reads it (`headerSecretPaths`). */
export const headerNamesASecret = (value: string): boolean => headerSecretPaths(value).length > 0;

/** The decoded `user:password` of a `Basic` header value, or null when the value is no Basic
 *  credential (or not base64 of UTF-8). */
export function basicCredentialOf(value: string): string | null {
  const encoded = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(value)?.[1];
  if (!encoded) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

/** The secret paths one string's placeholders name. */
export function secretPathsIn(value: string): string[] {
  if (!value.includes("getSecret(")) return [];
  return [...new Set([...value.matchAll(SECRET_PLACEHOLDER)].map(([, path = ""]) => path))];
}

/** THE SECRET A REQUEST USES, as egress names it on the request it hands the secrets Worker: the
 *  path its placeholder spells. Egress deletes any copy a caller sent and sets its own, and only
 *  egress binds the entrypoint that reads it (core/secrets-worker rpc.ts `SecretUse`). */
export const SECRET_USE_HEADER = "x-itx-secret-use";

/** On an answer the vault gave itself, its `VaultAnswerKind`. The secrets Worker strips it from
 *  every upstream answer, so its presence means the vault answered and nothing was sent. */
export const VAULT_ANSWER_HEADER = "x-iterate-vault-answer";

export type VaultAnswerKind = "refused" | "held" | "waiting" | "rejected" | "sent-before";

/** The digest of a held request to wait on: once approved, the stored request is sent, whatever
 *  this call carries. */
export const SECRET_HELD_HEADER = "x-itx-secret-held";

/** NO PLACEHOLDER FROM OUTSIDE REACHES A MIND'S CODE IN A HEADER: egress would fill it for an
 *  app that passed the header on. Every entrance from outside runs it: the boundary's ingress
 *  and the home lab's local port. A header that names a secret as egress reads it goes; of
 *  `cookie`, only such pairs (`cookiesNamingNoSecret`). No URL is refused. */
export function withoutOutsidePlaceholders(request: Request): Request {
  const named = [...request.headers].filter(([, value]) => headerNamesASecret(value));
  if (!named.length) return request;
  const headers = new Headers(request.headers);
  for (const [name, value] of named) {
    const kept = name === "cookie" ? cookiesNamingNoSecret(value) : "";
    if (kept) headers.set(name, kept);
    else headers.delete(name);
  }
  return new Request(request, { headers });
}

/** A cookie header without the pairs that name a secret, read again as egress reads it. When the
 *  rest still names one (a placeholder split over pairs, a Basic credential), only the `__Host-`
 *  pairs stay: no other hostname can plant one for this host, and every cookie the platform sets
 *  has the prefix, so a planted page never signs a member out. By design, it can make a member's APP cookies drop for a request
 *  while the planted pairs last; the member stays signed in. "" when nothing is left. */
function cookiesNamingNoSecret(value: string): string {
  const pairs = value.split(";").filter((pair) => !secretPathsIn(pair).length);
  for (const kept of [pairs, pairs.filter(isHostOnlyCookiePair)]) {
    const text = cookieTrimmed(kept.join(";"));
    if (!headerNamesASecret(text)) return text;
  }
  return "";
}

/** A pair `__Host-<name>=value`: host-only by the browser's own rule, so no other hostname can
 *  set it for this one. */
export const isHostOnlyCookiePair = (pair: string) => {
  const at = pair.indexOf("=");
  return at > 0 && cookieTrimmed(pair.slice(0, at)).startsWith("__Host-");
};
