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
  type SecretBodyField,
  type SecretMaterial,
  type SecretOperation,
  type SecretProxy,
  type SecretRefresh,
} from "iterate/api";
import { codedError } from "iterate/lib";
import { isMindControlPlaneHostname, isMindId } from "iterate/signed";
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

/** A secret by proxy as its object writes it: no value, no refresh, a header placeholder. */
export type ProxiedSecretRecord = { proxy: SecretProxy; urls: string[]; refresh: null } & SecretUse;

/** The record of a `set` with `proxy`; a field given as undefined counts as not given. */
export function proxiedSecretRecordOf(input: Record<string, unknown>): ProxiedSecretRecord {
  const parsed = ProxiedSetInput.safeParse(
    Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
  );
  if (!parsed.success)
    throw codedError(
      "INVALID_INPUT",
      'secrets.set with proxy: pass { material: null, urls, proxy, placement?: "header" } and nothing else, with one origin in urls at least: the secret proxy holds the value, keeps it fresh and uses it',
    );
  return {
    proxy: secretProxyOf(parsed.data.proxy),
    urls: originsOf(parsed.data.urls),
    refresh: null,
    placement: "header",
    operations: [],
    lendTo: [],
  };
}

const ProxiedSetInput = z.strictObject({
  material: z.null(),
  urls: z.array(z.string()).min(1),
  proxy: z.unknown(),
  placement: z.literal("header").optional(),
});

/** A SECRET PROXY ON EVERY WAY IN: a `set`, and a cell marked `byProxy` at each opening. */
export function secretProxyOf(value: unknown): SecretProxy {
  const refuse = (sentence: string) =>
    codedError("INVALID_INPUT", `secrets: a secret by proxy: ${sentence}`);
  const parsed = z.strictObject({ mind: z.string(), url: z.string() }).safeParse(value);
  if (!parsed.success) throw refuse("proxy is { mind, url }, two strings and nothing else");
  const { mind, url } = parsed.data;
  if (!isMindId(mind) && !isMindControlPlaneHostname(mind))
    throw refuse("proxy.mind is the id of a mind, or its control-plane hostname, lowercase");
  const parsedUrl = URL.parse(url);
  const asWritten =
    parsedUrl?.href === url || (parsedUrl?.pathname === "/" && parsedUrl.href === `${url}/`);
  if (
    parsedUrl?.protocol !== "https:" ||
    !asWritten ||
    parsedUrl.username ||
    parsedUrl.password ||
    url.includes("?") ||
    url.includes("#") ||
    url.endsWith("/")
  )
    throw refuse(
      "proxy.url is an https URL, with a path or none, and no query, fragment, trailing slash or credentials",
    );
  return { mind, url };
}

// `lendTo` null is every path: a secret's only when its maker says `lendTo: null` outright.
export type SecretUse = {
  placement: "header" | "url";
  operations: SecretOperation[];
  lendTo: string[] | null;
  /** Absent: a statement it signs may name any path. */
  statementPaths?: string[];
  /** Absent: its value goes into no body (./body-placement.ts). */
  bodyFields?: SecretBodyField[];
};

/** `urls`: the origins of the secret's pin, at one of which each body field is. */
export function secretUseOf(
  options:
    | {
        placement?: unknown;
        operations?: unknown;
        lendTo?: unknown;
        statementPaths?: unknown;
        bodyFields?: unknown;
      }
    | undefined,
  urls: readonly string[],
): SecretUse {
  const given = options?.statementPaths;
  if (
    given !== undefined &&
    (!Array.isArray(given) ||
      !given.every((path) => typeof path === "string" && path.startsWith("/")))
  )
    throw new Error("secrets: statementPaths lists paths, each starting with /");
  const statementPaths = given && { statementPaths: [...new Set<string>(given)] };
  const bodyFields = bodyFieldsOf(options?.bodyFields, urls);
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
    return {
      placement,
      operations: [...new Set(operations)],
      lendTo: null,
      bodyFields,
      ...statementPaths,
    };
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
    bodyFields,
    ...statementPaths,
  };
}

/** A SECRET'S BODY FIELDS AS ITS MAKER NAMED THEM (iterate/api `SecretBodyField`), each written
 *  one way, or undefined for none. The URL is taken only as a URL writes itself, with a path of
 *  plain parts and no query: the request's own URL is compared with it letter by letter, and a
 *  `%` or a `..` that a host may read as another path matches nothing (./approval.ts `pathIsFree`
 *  holds a free path to the same). The field is a path of object keys: no index of a list. */
function bodyFieldsOf(given: unknown, urls: readonly string[]): SecretBodyField[] | undefined {
  if (given === undefined) return undefined;
  const parsed = BodyFields.safeParse(given);
  if (!parsed.success)
    throw new Error(
      `secrets: bodyFields lists at most 10 of { method, url, field }: ${parsed.error.issues[0]?.message}`,
    );
  const fields = new Map<string, SecretBodyField>();
  for (const { method, url, field } of parsed.data) {
    const written = URL.parse(url);
    if (written?.href !== url)
      throw new Error(`secrets: bodyFields: ${JSON.stringify(url)} is not as a URL writes itself`);
    if (!urls.includes(written.origin))
      throw new Error(
        `secrets: bodyFields: ${url} is outside the pin ${urls.join(", ")}: a secret goes into a body only at a pinned host`,
      );
    fields.set(JSON.stringify([method.toUpperCase(), url, field]), {
      method: method.toUpperCase(),
      url,
      field,
    });
  }
  return fields.size ? [...fields.values()] : undefined;
}

// Each string has a length: the entries are sealed with the value and read at every use.
const BodyFields = z
  .array(
    z.strictObject({
      method: z.string().regex(/^[A-Za-z]{1,20}$/, "method is one word, such as POST"),
      url: z
        .string()
        .max(2000, "url has at most 2,000 characters")
        .regex(
          /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~-]+)+\/?$/,
          "url is an https URL with a path of plain parts and no query, such as https://api.example.com/v1/sinks",
        ),
      field: z
        .string()
        .max(200, "field has at most 200 characters")
        .regex(
          /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/,
          "field is the dotted name of a field of the body's JSON object, such as config.token",
        ),
    }),
  )
  .max(10);

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

/** A CLOUD'S ADDRESS, AS A CALLER NAMED IT: an exact `https:` origin, as `new URL(…).origin`
 *  spells it, with no path, query or trailing slash. Anything else is refused, in words that
 *  name `what` was asked. */
export function cloudOriginOf(origin: unknown, what: string): string {
  const url = typeof origin === "string" ? URL.parse(origin) : null;
  if (!url || url.protocol !== "https:" || url.origin !== origin)
    throw codedError(
      "INVALID_INPUT",
      `${what}: a Cloud is named by its origin, an https address with no path (https://cloud.iterate.com), got ${JSON.stringify(origin)}`,
    );
  return url.origin;
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
        bodyFields?: unknown;
      }
    | undefined,
): SecretRecord {
  if (typeof material !== "string" && !isRecord(material))
    throw new Error("secrets: material is a string or a JSON object");
  const urls = options?.urls === undefined ? [] : originsOf(options.urls);
  if (urls.length === 0)
    throw new Error(
      "secrets: urls is required — the origins this secret may be sent to; a secret is never sent anywhere else",
    );
  const use = secretUseOf(options, urls);
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
    // a refresh sends a refresh token, a client secret or an App's signature there
    if (endpoint.protocol !== "https:")
      throw new Error(`secrets: refresh.${endpointKey} must be an https URL`);
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
      // iterate Cloud's App key stays at the Cloud, whose origin the secret keeps from here on
      const cloud = typeof client?.cloud === "string" ? client.cloud : "";
      if (!cloud && client?.mind !== "github")
        throw new Error(
          'secrets: refresh.client is { mind: "github" }, or { cloud: "<name>", origin: "<the Cloud\'s origin>" } for iterate Cloud\'s App',
        );
      refresh = {
        kind,
        apiOrigin: endpoint.origin,
        installationId,
        client: cloud
          ? { cloud, origin: cloudOriginOf(client?.origin, "secrets: refresh.client.origin") }
          : { mind: "github" },
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

/** WHAT EACH KIND OF REFRESH READS OF ITS SECRET'S MATERIAL to make a new access token, as the
 *  schema that the refresh itself reads the material with. Those fields are the refresh's alone:
 *  of a secret that has the refresh, no placeholder and no lend gives one out
 *  (`refreshOnlyFieldRefusal`). So a refresh token, one that iterate Cloud sealed too, goes to
 *  its token endpoint and nowhere else, and a client secret or an App's key goes only where the
 *  refresh sends it. A new kind has the rule once it has its entry, which the type requires.
 *  `worker`: the exchange code is the secret's maker's own and is handed the material whole. The
 *  platform reads no field for it, so it can name none. */
export const REFRESH_READS = {
  "oauth-refresh-token": z.object({
    refreshToken: z.string().min(1),
    clientId: z.string().min(1),
    clientSecret: z.string().optional(),
  }),
  "github-app-installation": z.object({ appId: z.string(), privateKey: z.string() }),
  worker: z.object({}),
} satisfies Record<SecretRefresh["kind"], z.ZodObject>;

/** Why `field` of the secret at `path` is given to its refresh alone, or null: a field that the
 *  secret's kind of refresh reads (`REFRESH_READS`), or one under it. Asked before a placeholder
 *  is put into a request and before a secret is lent, so nothing is sent. */
export function refreshOnlyFieldRefusal(
  refresh: SecretRefresh | null,
  path: string,
  field: string | undefined,
): string | null {
  const name = field?.split(".")[0];
  if (!refresh || !name || !Object.hasOwn(REFRESH_READS[refresh.kind].shape, name)) return null;
  return `${JSON.stringify(name)} of ${path} is what the secret's ${refresh.kind} refresh reads to make a new access token: it is given to that refresh alone`;
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

/** How a placeholder's secret is read. `field`: the one the placeholder names. A resolver refuses
 *  a field that is not given out. Null: no secret is stored. */
export type SecretResolver = (
  path: string,
  field: string | undefined,
) => Promise<SecretMaterial | null> | SecretMaterial | null;

/** THE VALUE THAT ONE PLACEHOLDER STANDS FOR, wherever it sits in a request: the whole stored
 *  string, one field of a JSON secret, or a GitHub App's JWT. `match` is a match of
 *  `SECRET_PLACEHOLDER`, `where` names its place for a refusal, and `url` is the request's. A
 *  placeholder with no stored secret throws to the caller, never the destination. */
export async function secretValueOf(
  match: RegExpMatchArray,
  where: string,
  url: string,
  resolve: SecretResolver,
): Promise<string> {
  const [, path = "", field, appJwt] = match;
  const placeholder = placeholderOf(path, field, appJwt);
  const stored = await resolve(path, field);
  // oxlint-disable-next-line iterate/simple-truthiness-check -- null means no secret is stored; a stored empty-string value is a real secret and must be substituted, not refused
  if (stored == null)
    throw new SecretRefused(
      `itx.fetch: no stored mind secret for ${placeholder} in ${where}`,
      true,
    );
  if (appJwt) return githubAppJwtOf(stored, placeholder, where, url);
  if (field) return secretFieldOf(stored, field, placeholder, where);
  if (typeof stored === "string") return stored;
  throw new SecretRefused(
    `itx.fetch: ${placeholder} in ${where} names no field, but the secret is a JSON object — pick one with { field: "…" }`,
  );
}

// The URL and the headers. In the URL the value is one component, so it can never add a query or
// a fragment. The body is not read here: ./body-placement.ts fills it, at a field that the secret
// names.
export async function substituteMindSecrets(
  request: Request,
  resolve: SecretResolver,
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
      const secret = await secretValueOf(m, where, request.url, resolve);
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
  const app = REFRESH_READS["github-app-installation"].safeParse(material);
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

/** The material's field that says when its access token ends, as an ISO time: what the token
 *  endpoint's `expires_in` gave. The secret's object refreshes a token that has ended before it
 *  sends a request (./secret/durable-object.ts), because not every provider answers an ended
 *  token with 401: Cloudflare answers 403. */
const ACCESS_TOKEN_EXPIRES_AT = "accessTokenExpiresAt";

/** Whether `material` says that its access token has ended, or ends within `marginMs`. Material
 *  that names no end is never ended here: a 401 is then what starts its refresh. */
export function accessTokenEnded(material: unknown, now = Date.now(), marginMs = 60_000): boolean {
  if (!isRecord(material)) return false;
  const at = material[ACCESS_TOKEN_EXPIRES_AT];
  return typeof at === "string" && Date.parse(at) - marginMs <= now;
}

export async function oauthTokensOf(
  response: Response,
  grant: string,
): Promise<{ accessToken: string; refreshToken?: string; accessTokenExpiresAt?: string }> {
  if (!response.ok) throw new Error(`${grant}: the token endpoint answered ${response.status}`);
  const data = await jsonRecordOf(response);
  if (typeof data.access_token !== "string")
    throw new Error(`${grant}: the token endpoint returned no access_token`);
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === "string" && { refreshToken: data.refresh_token }),
    ...(typeof data.expires_in === "number" &&
      data.expires_in > 0 && {
        [ACCESS_TOKEN_EXPIRES_AT]: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      }),
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

// RFC 6749 §6. `ceiling`: the scopes that the grant is held to (./secret-oauth.ts `grantCeilingOf`).
export async function refreshSecretMaterial(
  refresh: Extract<SecretRefresh, { kind: "oauth-refresh-token" }>,
  material: SecretMaterial | null,
  fetchFn: (request: Request) => Promise<Response>,
  clientSecretOf: ClientSecretOf,
  ceiling: readonly string[] | undefined = refresh.grantedWithin,
): Promise<Record<string, unknown>> {
  const record = typeof material === "object" && material ? material : {};
  const reads = REFRESH_READS[refresh.kind].safeParse(record);
  if (!reads.success)
    throw new Error(
      `${refresh.kind}: the secret's material has no "${String(reads.error.issues[0]?.path[0])}"`,
    );
  const { refreshToken, clientId, clientSecret = "" } = reads.data;
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
  // THE CEILING HOLDS AT EACH REFRESH, closed on what the answer does not say: an answer that
  // names a scope outside it, or names none, is refused, and its tokens are not kept.
  if (ceiling && response.ok) {
    const answer: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    const scopes =
      isRecord(answer) && typeof answer.scope === "string"
        ? answer.scope.split(/[\s,]+/).filter(Boolean)
        : [];
    if (!scopes.length)
      throw new Error(
        `${refresh.kind}: the token endpoint did not say which scopes the refreshed grant holds, and this grant is kept only while they can be checked: the new tokens were not kept. Connect again.`,
      );
    const outside = scopes.filter((scope) => !ceiling.includes(scope));
    if (outside.length)
      throw new Error(
        `${refresh.kind}: the token endpoint answered scopes beyond the grant's ceiling (${outside.join(", ")}): the new tokens were not kept`,
      );
  }
  // The client secret stays as held: a placeholder, never the value it resolved to. The end of
  // the old access token goes: the new answer names the new token's end, or none.
  const { [ACCESS_TOKEN_EXPIRES_AT]: _ended, ...kept } = record;
  return { ...kept, ...(await oauthTokensOf(response, refresh.kind)) };
}
