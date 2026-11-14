// Material goes in; nothing comes out except a request to a pinned host. A credential never
// appears in an error message.
import { createPrivateKey } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import {
  SECRET_OPERATIONS,
  type ClientAuth,
  type SecretEqualsVerification,
  type SecretHmacSigning,
  type SecretHmacVerification,
  type SecretMaterial,
  type SecretOperation,
  type SecretRefresh,
} from "iterate/api";
import { codedError } from "iterate/lib";
import {
  basicCredentialOf,
  placeholderOf,
  SECRET_PATH,
  SECRET_PLACEHOLDER,
} from "iterate/secret-placeholder";
import { z } from "zod";
import { SecretRefreshKind } from "./secret/contract.ts";

// `urls` are origins, never empty: a secret is always pinned.
export type SecretRecord = {
  material: SecretMaterial;
  urls: string[];
  refresh: SecretRefresh | null;
} & SecretUse;

// `lendTo` null is every path: an import's (`UNLIMITED_USE`), and a new secret's only when its
// maker says `lendTo: null` outright.
export type SecretUse = {
  placement: "header" | "url";
  operations: SecretOperation[];
  lendTo: string[] | null;
  /** Absent: a statement it signs may name any path. */
  statementPaths?: string[];
};

// A secret made before records said what it may do, or imported: everything the earlier platform
// (core/os, removed) let it do, and no operation added since.
export const UNLIMITED_USE: SecretUse = {
  placement: "url",
  operations: [
    "signHmac",
    "verifyHmac",
    "verifyEquals",
    "deriveSharedSecret",
    "publicKeyOf",
    "signWithKey",
  ],
  lendTo: null,
};

export function secretUseOf(
  options:
    | { placement?: unknown; operations?: unknown; lendTo?: unknown; statementPaths?: unknown }
    | undefined,
): SecretUse {
  const given = options?.statementPaths;
  if (
    given !== undefined &&
    (!Array.isArray(given) ||
      !given.every((path) => typeof path === "string" && path.startsWith("/")))
  )
    throw new Error("secrets: statementPaths lists paths, each starting with /");
  const statementPaths = given && { statementPaths: [...new Set<string>(given)] };
  const placement = options?.placement ?? "header";
  if (placement !== "header" && placement !== "url")
    throw new Error('secrets: placement is "header" or "url"');
  const operations = options?.operations ?? [];
  const known = (operation: unknown): operation is SecretOperation =>
    SECRET_OPERATIONS.some((name) => name === operation);
  if (!Array.isArray(operations) || !operations.every(known))
    throw new Error(`secrets: operations names some of ${SECRET_OPERATIONS.join(", ")}`);
  // Absent is no path, the default. Null is every path, said outright: it is what `describe()`
  // answers for a secret that lends to every path, so a secret set again from its description is
  // not narrowed, and it is the one way to lend to secrets whose paths are not known yet. Any
  // other value that is no list of paths ("", 0, false) is refused below.
  const givenLendTo = options?.lendTo;
  if (givenLendTo === null)
    return { placement, operations: [...new Set(operations)], lendTo: null, ...statementPaths };
  // oxlint-disable-next-line iterate/simple-truthiness-check -- as above: only an absent lendTo is the default
  const lendTo = givenLendTo === undefined ? [] : givenLendTo;
  if (!Array.isArray(lendTo) || !lendTo.every((path) => SECRET_PATH.test(String(path))))
    throw new Error(
      "secrets: lendTo lists secret paths, /secrets/<name>, or is null for every secret of the mind",
    );
  return {
    placement,
    operations: [...new Set(operations)],
    lendTo: [...new Set<string>(lendTo)],
    ...statementPaths,
  };
}

// Exchange code is sealed in the record beside the material; a login is a few requests, not a bundle.
const EXCHANGE_SOURCE_MAX_CHARS = 64 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && !!value && !Array.isArray(value);
}

const CLIENT_AUTHS: readonly ClientAuth[] = ["client_secret_basic", "client_secret_post", "none"];

export function clientAuthOf(value: unknown): ClientAuth {
  if (value === undefined) return "client_secret_basic";
  const known = CLIENT_AUTHS.find((method) => method === value);
  if (!known)
    throw new Error(
      `secrets: clientAuth is one of ${CLIENT_AUTHS.join(", ")} (RFC 8414 token_endpoint_auth_methods_supported), got ${JSON.stringify(value)}`,
    );
  return known;
}

export function originsOf(urls: unknown): string[] {
  if (!Array.isArray(urls)) throw new Error("secrets: urls is a list of URLs");
  return [...new Set(urls.map((url) => new URL(String(url)).origin))];
}

export function normalizeSecretRecord(
  material: unknown,
  options:
    | {
        urls?: unknown;
        refresh?: unknown;
        placement?: unknown;
        operations?: unknown;
        lendTo?: unknown;
        statementPaths?: unknown;
      }
    | undefined,
): SecretRecord {
  const use = secretUseOf(options);
  if (typeof material !== "string" && !isRecord(material))
    throw new Error("secrets: material is a string or a JSON object");
  const urls = options?.urls === undefined ? [] : originsOf(options.urls);
  if (urls.length === 0)
    throw new Error(
      "secrets: urls is required — the origins this secret may be sent to; a secret is never sent anywhere else",
    );
  let refresh: SecretRefresh | null = null;
  if (options?.refresh) {
    // The one place a strategy kind is admitted from untyped input.
    const parsedKind = isRecord(options.refresh)
      ? SecretRefreshKind.safeParse(options.refresh.kind)
      : undefined;
    if (!isRecord(options.refresh) || !parsedKind?.success)
      throw new Error(
        `secrets: refresh.kind is one of ${SecretRefreshKind.options.join(", ")}, got ${JSON.stringify(isRecord(options.refresh) ? options.refresh.kind : options.refresh)}`,
      );
    const kind = parsedKind.data;
    const strategy = options.refresh;
    if (kind === "worker") {
      const { source } = strategy;
      if (typeof source !== "string" || !/\bexchange\b/.test(source))
        throw new Error(
          "secrets: refresh.source is an ES module exporting `async function exchange(material, fetch)`",
        );
      if (source.length > EXCHANGE_SOURCE_MAX_CHARS)
        throw new Error(
          `secrets: refresh.source is ${source.length} chars, over the ${EXCHANGE_SOURCE_MAX_CHARS}-char ceiling`,
        );
      return { material, urls, refresh: { kind, source }, ...use };
    }
    const endpointKey = kind === "oauth-refresh-token" ? "tokenEndpoint" : "apiOrigin";
    const endpoint = new URL(String(strategy[endpointKey]));
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
      throw new Error(`secrets: refresh.${endpointKey} must be an http(s) URL`);
    if (!urls.includes(endpoint.origin))
      throw new Error(
        `secrets: refresh.${endpointKey} ${endpoint.origin} is outside the pin ${urls.join(", ")} — a refresh only ever sends the material toward a pinned host`,
      );
    const client = isRecord(strategy.client) ? strategy.client : undefined;
    if (kind === "oauth-refresh-token") {
      if (client)
        throw new Error(
          "secrets: refresh.client is not offered here — the client is the secret's own clientId and clientSecret",
        );
      refresh = {
        kind,
        tokenEndpoint: endpoint.href,
        clientAuth: clientAuthOf(strategy.clientAuth),
      };
    } else {
      const installationId = String(strategy.installationId ?? "");
      // it lands in a URL path: GitHub's ids are digits, a fake's a slug
      if (!/^[a-zA-Z0-9_-]+$/.test(installationId))
        throw new Error("secrets: refresh.installationId is GitHub's id ([a-zA-Z0-9_-]+)");
      // iterate Cloud's App key stays at the Cloud
      const cloud = typeof client?.cloud === "string" ? client.cloud : "";
      if (!cloud && client?.mind !== "github")
        throw new Error(
          'secrets: refresh.client is { mind: "github" }, or { cloud: "<name>" } for iterate Cloud\'s App',
        );
      refresh = {
        kind,
        apiOrigin: endpoint.origin,
        installationId,
        client: cloud ? { cloud } : { mind: "github" },
      };
    }
  }
  return { material, urls, refresh, ...use };
}

// A public field's value rides the `secret/set` fact: it must be a short identifier.
const PUBLIC_FIELDS_MAX = 10;
const PUBLIC_FIELD_MAX_CHARS = 1024;

export function publicFieldsOf(material: unknown, names: unknown): Record<string, string> {
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string"))
    throw new Error("secrets: public is a list of the material's field names");
  if (names.length > PUBLIC_FIELDS_MAX)
    throw new Error(`secrets: public names at most ${PUBLIC_FIELDS_MAX} fields`);
  if (!isRecord(material))
    throw new Error("secrets: public names fields of an object material — a string has none");
  return Object.fromEntries(
    names.map((name) => {
      const value = material[name];
      if (typeof value !== "string")
        throw new Error(
          `secrets: public field ${JSON.stringify(name)} is not a string field of the material`,
        );
      if (value.length > PUBLIC_FIELD_MAX_CHARS)
        throw new Error(
          `secrets: public field ${JSON.stringify(name)} is ${value.length} chars, over the ${PUBLIC_FIELD_MAX_CHARS}-char ceiling`,
        );
      return [name, value];
    }),
  );
}

function secretPlaceholderOf(value: string): { path: string; field?: string } | null {
  const [match] = [...value.matchAll(SECRET_PLACEHOLDER)];
  if (match?.index !== 0 || match[0].length !== value.length) return null;
  const [, path = "", field] = match;
  return field ? { path, field } : { path };
}

// A placeholder with anything around it is refused: it is neither a value nor a reference.
export function clientSecretReferenceOf(
  clientSecret: string,
): { path: string; field?: string } | null {
  const reference = secretPlaceholderOf(clientSecret);
  if (reference || !clientSecret.includes("getSecret(")) return reference;
  throw codedError(
    "INVALID_INPUT",
    'secrets: a clientSecret that names the secret holding it is one placeholder and nothing else, getSecret("/secrets/<name>") or getSecret("/secrets/<name>", { field: "a.b" })',
  );
}

// Answered to the caller, never the destination. `mintable`: a refresh strategy can fill the miss.
export class SecretRefused extends Error {
  readonly mintable: boolean;
  // Not a parameter property: this module keeps to erasable syntax.
  constructor(message: string, mintable = false) {
    super(message);
    this.mintable = mintable;
  }
}

function secretFieldOf(
  material: SecretMaterial,
  field: string,
  placeholder: string,
  where: string,
): string {
  if (typeof material === "string")
    throw new SecretRefused(
      `itx.fetch: ${placeholder} in ${where} names a field, but the secret is one string, not an object`,
    );
  let value: unknown = material;
  for (const segment of field.split(".")) value = isRecord(value) ? value[segment] : undefined;
  if (typeof value !== "string")
    throw new SecretRefused(
      `itx.fetch: ${placeholder} in ${where}: the secret has no string at field "${field}"`,
      true,
    );
  return value;
}

// A placeholder with no stored secret throws to the caller, never the destination. In the URL the
// value is one component, so it can never add a query or a fragment. The body is not scanned.
export async function substituteMindSecrets(
  request: Request,
  resolve: (path: string) => Promise<SecretMaterial | null> | SecretMaterial | null,
  // every spelling of each value put in: what an answer must not carry back
  substitutedValues?: Set<string>,
): Promise<Request> {
  // null: no placeholder in it
  const substitute = async (value: string, where: string, encode: boolean) => {
    if (!value.includes("getSecret(")) return null;
    let out = "";
    let last = 0;
    let any = false;
    for (const m of value.matchAll(SECRET_PLACEHOLDER)) {
      const [, path = "", field, appJwt] = m;
      const placeholder = placeholderOf(path, field, appJwt);
      const stored = await resolve(path);
      // oxlint-disable-next-line iterate/simple-truthiness-check -- null means no secret is stored; a stored empty-string value is a real secret and must be substituted, not refused
      if (stored == null)
        throw new SecretRefused(
          `itx.fetch: no stored mind secret for ${placeholder} in ${where}`,
          true,
        );
      let secret: string;
      if (appJwt) secret = await githubAppJwtOf(stored, placeholder, where, request.url);
      else if (field) secret = secretFieldOf(stored, field, placeholder, where);
      else if (typeof stored === "string") secret = stored;
      else
        throw new SecretRefused(
          `itx.fetch: ${placeholder} in ${where} names no field, but the secret is a JSON object — pick one with { field: "…" }`,
        );
      // `:` kept: a Telegram bot token sits in a URL path
      const spliced = encode ? encodeURIComponent(secret).replaceAll("%3A", ":") : secret;
      substitutedValues?.add(secret).add(spliced);
      out += value.slice(last, m.index) + spliced;
      last = m.index + m[0].length;
      any = true;
    }
    return any ? out + value.slice(last) : null;
  };

  const url = await substitute(request.url, "the request URL", true);
  const base = url ? new Request(url, request) : request;
  const headers = new Headers(base.headers);
  let changed = false;
  for (const [name, value] of base.headers) {
    const credential = basicCredentialOf(value);
    const inCredential = credential
      ? await substitute(credential, `header "${name}"`, false)
      : null;
    const credentialHeader = inCredential
      ? `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(inCredential)))}`
      : null;
    // a credential goes as base64, the spelling an answer that echoes it would carry back
    if (credentialHeader) substitutedValues?.add(credentialHeader.slice("Basic ".length));
    const substituted = credentialHeader || (await substitute(value, `header "${name}"`, false));
    // oxlint-disable-next-line iterate/simple-truthiness-check -- substitute() returns null for "no placeholder here"; a substituted-to-empty header ("") is a real change and must be written, not skipped
    if (substituted !== null) {
      headers.set(name, substituted);
      changed = true;
    }
  }
  return changed ? new Request(base, { headers }) : base;
}

const GITHUB_API_ORIGIN = "https://api.github.com";
const GithubAppMaterial = z.object({ appId: z.string(), privateKey: z.string() });

// The JWT goes to GitHub's API alone, in the one header GitHub reads it from; the key never leaves.
async function githubAppJwtOf(
  material: SecretMaterial,
  placeholder: string,
  where: string,
  url: string,
): Promise<string> {
  if (where !== 'header "authorization"' || new URL(url).origin !== GITHUB_API_ORIGIN)
    throw new SecretRefused(
      `itx.fetch: ${placeholder} goes in the Authorization header of a request to ${GITHUB_API_ORIGIN} alone, not in ${where} to ${new URL(url).origin}`,
    );
  const app = GithubAppMaterial.safeParse(material);
  if (!app.success)
    throw new SecretRefused(
      `itx.fetch: ${placeholder}: the secret holds no "appId" and "privateKey"`,
    );
  return githubAppJwt(app.data.appId, app.data.privateKey).catch(() => {
    throw new SecretRefused(`itx.fetch: ${placeholder}: "privateKey" is no RSA private key in PEM`);
  });
}

/** A GitHub App's JWT (RS256, ten minutes), what GitHub mints an installation token for. */
export async function githubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  // GitHub hands out PKCS#1 keys; @octokit/auth-app signs with WebCrypto here, which takes PKCS#8
  const privateKey = createPrivateKey(privateKeyPem).export({ type: "pkcs8", format: "pem" });
  const { token } = await createAppAuth({ appId, privateKey: String(privateKey) })({ type: "app" });
  return token;
}

// An object with no field named, a field on a string, or no string at it: no key, nothing verifies.
export function secretMaterialStringOf(material: SecretMaterial, field?: string): string | null {
  if (!field) return typeof material === "string" ? material : null;
  let value: unknown = material;
  for (const segment of field.split(".")) value = isRecord(value) ? value[segment] : undefined;
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Hashed first, so the time depends on neither where they differ nor how long they are.
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const digest = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(left, right);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(
  key: string | Uint8Array,
  payload: string | Uint8Array,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, bytes as BufferSource);
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// `key`: the string at the field, or a derived key (secret/key-ops.ts `hmacKeyOf`); null is none.
export async function verifySecretHmac(
  key: string | Uint8Array | null,
  input: SecretHmacVerification,
): Promise<boolean> {
  if (!key) return false;
  const signature = input.signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  return secretsEqual(await hmacSha256Hex(key, input.payload), signature);
}

export const SecretKeyDerivationInput = z.object({ info: z.string().min(1) });

// It arrives untyped.
export const SecretHmacSigningInput = z.object({
  payload: z.union([z.string(), z.instanceof(Uint8Array)]),
  field: z.string().min(1).optional(),
  encoding: z.enum(["hex", "base64"]).optional(),
  derive: SecretKeyDerivationInput.optional(),
});

export async function signSecretHmac(
  key: string | Uint8Array | null,
  input: SecretHmacSigning,
): Promise<string | null> {
  if (!key) return null;
  const hex = await hmacSha256Hex(key, input.payload);
  if (input.encoding !== "base64") return hex;
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  return btoa(String.fromCharCode(...bytes));
}

export async function verifySecretEquals(
  material: SecretMaterial,
  input: SecretEqualsVerification,
): Promise<boolean> {
  const expected = secretMaterialStringOf(material, input.field);
  if (!expected) return false;
  return secretsEqual(input.value, expected);
}

// So an app that forwards a visitor's headers cannot be made to mail a credential to a stranger.
export function originPinned(url: string, urls: string[]): boolean {
  return urls.includes(new URL(url).origin);
}

export function pinRefusal(path: string, url: string, urls: string[]): SecretRefused {
  return new SecretRefused(
    `itx.fetch: the secret ${path} is pinned to ${urls.join(", ")} — not sent to ${new URL(url).origin}`,
  );
}

function stringField(record: Record<string, unknown>, field: string, kind: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "")
    throw new Error(`${kind}: the secret's material has no "${field}"`);
  return value;
}

async function jsonRecordOf(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  return isRecord(body) ? body : {};
}

// A client with no secret is sent as `none`, whatever it declared.
export function oauthTokenRequest(input: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  clientAuth: ClientAuth;
  params: Record<string, string>;
}): Request {
  const method = input.clientSecret ? input.clientAuth : "none";
  const body = new URLSearchParams(input.params);
  if (method !== "client_secret_basic") body.set("client_id", input.clientId);
  if (method === "client_secret_post") body.set("client_secret", input.clientSecret);
  return new Request(input.tokenEndpoint, {
    method: "POST",
    headers: {
      ...(method === "client_secret_basic" && {
        authorization: `Basic ${btoa(`${input.clientId}:${input.clientSecret}`)}`,
      }),
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });
}

export async function oauthTokensOf(
  response: Response,
  grant: string,
): Promise<{ accessToken: string; refreshToken?: string }> {
  if (!response.ok) throw new Error(`${grant}: the token endpoint answered ${response.status}`);
  const data = await jsonRecordOf(response);
  if (typeof data.access_token !== "string")
    throw new Error(`${grant}: the token endpoint returned no access_token`);
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === "string" && { refreshToken: data.refresh_token }),
  };
}

// Resolves a placeholder (`clientSecretReferenceOf`) for the request alone.
export type ClientSecretOf = (clientSecret: string, tokenEndpoint: string) => Promise<string>;

/** A REFRESH REQUEST THAT GOT NO ANSWER: no decision of the provider came back. The request
 *  failed on its way, or the answer was 408, 429 or 5xx. Where the request left, the provider may
 *  have issued the new tokens, and a refresh token that works once is then spent: only a later
 *  try with the same token tells. A refusal is an answer, and is never this.
 *  `notAtOnce`: one more request at once would do harm, and the caller's next run asks again.
 *  A 429 says that the far side gets too many requests. A 504 says that the Cloud's call to
 *  the provider still goes on: the Cloud keeps its late answer for the same token, and a second
 *  call now would show the provider a token that is in use. */
export class RefreshUnanswered extends Error {
  readonly notAtOnce: boolean;
  // Not a parameter property: erasable syntax only.
  constructor(message: string, notAtOnce = false) {
    super(message);
    this.notAtOnce = notAtOnce;
  }
}

// RFC 6749 §6.
export async function refreshSecretMaterial(
  refresh: Extract<SecretRefresh, { kind: "oauth-refresh-token" }>,
  material: SecretMaterial | null,
  fetchFn: (request: Request) => Promise<Response>,
  clientSecretOf: ClientSecretOf,
): Promise<Record<string, unknown>> {
  const record = typeof material === "object" && material ? material : {};
  const refreshToken = stringField(record, "refreshToken", refresh.kind);
  const clientId = stringField(record, "clientId", refresh.kind);
  const clientSecret = typeof record.clientSecret === "string" ? record.clientSecret : "";
  const request = oauthTokenRequest({
    tokenEndpoint: refresh.tokenEndpoint,
    clientId,
    clientSecret: await clientSecretOf(clientSecret, refresh.tokenEndpoint),
    clientAuth: refresh.clientAuth || "client_secret_basic",
    params: { grant_type: "refresh_token", refresh_token: refreshToken },
  });
  const response = await fetchFn(request).catch((error: unknown) => {
    throw new RefreshUnanswered(
      `${refresh.kind}: the token endpoint did not answer (${error instanceof Error ? error.message : String(error)})`,
    );
  });
  if (response.status === 408 || response.status === 429 || response.status >= 500)
    throw new RefreshUnanswered(
      `${refresh.kind}: the token endpoint answered ${response.status}`,
      response.status === 429 || response.status === 504,
    );
  // The client secret stays as held: a placeholder, never the value it resolved to.
  return { ...record, ...(await oauthTokensOf(response, refresh.kind)) };
}
