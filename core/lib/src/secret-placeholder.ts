// secret-placeholder.ts — THE PLACEHOLDER GRAMMAR (tasks/mind-stack.md): how a request spells a
// secret, `getSecret("/secrets/<name>")`, defined once for the Workers that read it. Egress finds
// which secret a request names and sends it to the secrets Worker with the secret named in
// `SECRET_USE_HEADER`; the secrets Worker substitutes the material. Pure, moved unchanged out of
// the earlier platform (core/os, removed). And the path of the secrets Worker's OAuth callback,
// which the mind answers as `itx.secrets.oauthCallbackUrl()`. The facts a secret's answer carries
// ride the one carrier of iterate/facts.

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

// ── the placeholder grammar ── for a URL or a header:
// `getSecret("/secrets/NAME")` is the whole stored value; `getSecret("/secrets/NAME", { field: "a.b" })`
// is one dotted field of a JSON-valued secret. Double quotes, whitespace free inside the
// parentheses; `/secrets/NAME` is the PATH `itx.secrets.set("/secrets/NAME", …)` stored. Matched as written in a
// header, and as the URL parser percent-encodes it in a URL (`"` → %22, a space → %20, `{` → %7B, `}`
// → %7D) — the path and the query alike; the value is spliced back into the URL as ONE component,
// `:` kept (Telegram's `bot123:abc` path). A `Basic base64(user:getSecret(…))` credential is peeled:
// the placeholder is substituted inside the decoded `user:password` and the credential encoded
// again — the Authorization a git remote's userinfo becomes (`https://x:getSecret(…)@host/repo.git`,
// as git and curl send it). No JSON-body template — the body is never scanned.
const QUOTE = '(?:"|%22)';
const SPACE = "(?:\\s|%20)*";
export const SECRET_PLACEHOLDER = new RegExp(
  `getSecret\\(${SPACE}${QUOTE}(/secrets/${SECRET_NAME})${QUOTE}${SPACE}` +
    `(?:,${SPACE}(?:\\{|%7B)${SPACE}field${SPACE}:${SPACE}${QUOTE}([^"%\\s]+)${QUOTE}${SPACE}(?:\\}|%7D))?${SPACE}\\)`,
  "g",
);

/** The placeholder as a caller wrote it, for a refusal that names it. */
export const placeholderOf = (path: string, field: string | undefined): string =>
  !field ? `getSecret("${path}")` : `getSecret("${path}", { field: "${field}" })`;

/** The DISTINCT secret paths a request's URL and headers reference — how egress knows which
 *  secret's context a request belongs to (one request, one secret). */
export function secretPathsReferenced(request: Request): string[] {
  const paths = new Set<string>();
  const scan = (value: string) => {
    if (!value.includes("getSecret(")) return;
    for (const [, path = ""] of value.matchAll(SECRET_PLACEHOLDER)) paths.add(path);
  };
  scan(request.url);
  for (const [, value] of request.headers) scan(basicCredentialOf(value) ?? value);
  return [...paths];
}

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
 *  egress binds the entrypoint that reads it (core/secrets-worker worker.ts `SecretUse`). */
export const SECRET_USE_HEADER = "x-itx-secret-use";

/** On an answer the vault gave itself, its `VaultAnswerKind`. The secrets Worker strips it from
 *  every upstream answer, so its presence means the vault answered and nothing was sent. */
export const VAULT_ANSWER_HEADER = "x-iterate-vault-answer";

export type VaultAnswerKind = "refused" | "held" | "waiting" | "rejected" | "sent-before";

/** The digest of a held request to wait on: once approved, the stored request is sent, whatever
 *  this call carries. */
export const SECRET_HELD_HEADER = "x-itx-secret-held";
