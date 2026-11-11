// The authority over one secret. The project's `/secrets/<name>` context is its record, which the
// project's own code can withhold from or forge into, so nothing here reads it.
import { createPrivateKey } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { DurableObject } from "cloudflare:workers";
import type { SecretMaterial, SecretOperation, SecretRefresh } from "iterate/api";
import { codedError, ITERATE_CAUSE_HEADER } from "iterate/lib";
import { type Facts, withFacts } from "iterate/facts";
import { platformOriginOf } from "iterate/project-api";
import {
  assertSecretPath,
  SECRET_OAUTH_CALLBACK_PATH,
  SECRET_HELD_HEADER,
  SECRET_USE_HEADER,
  secretPathsIn,
  VAULT_ANSWER_HEADER,
  type VaultAnswerKind,
} from "iterate/secret-placeholder";
import type {
  SecretAnswer,
  SecretDescription,
  SecretOAuthResult,
  SecretRefusal,
  SecretVerb,
  SecretVerbs,
} from "iterate/workers";
import { z } from "zod";
import type { Envelope } from "iterate/signed";
import type { PageCaller } from "../callback-page.ts";
import { askOf, brokered, cloudClientOf } from "../cloud-client.ts";
import type { Env } from "../env.ts";
import {
  decryptLegacySecretMaterial,
  decryptSecretMaterial,
  encryptSecretMaterial,
} from "../secret-at-rest.ts";
import {
  accountOf,
  beginSecretOAuth,
  completeSecretOAuth,
  normalizeSecretOAuth,
  stateOf,
  type PendingSecretOAuth,
} from "../secret-oauth.ts";
import { startLinkOf } from "../secret-oauth-start.ts";
import {
  clientSecretReferenceOf,
  hmacSha256Hex,
  isRecord,
  normalizeSecretRecord,
  originPinned,
  originsOf,
  pinRefusal,
  publicFieldsOf,
  secretUseOf,
  UNLIMITED_USE,
  type SecretUse,
  SecretRefused,
  refreshSecretMaterial,
  secretMaterialStringOf,
  secretsEqual,
  sha256Hex,
  substituteProjectSecrets,
  SecretHmacSigningInput,
  signSecretHmac,
  verifySecretEquals,
  verifySecretHmac,
  type SecretRecord,
} from "../secrets.ts";
import {
  ApprovalRule,
  HELD_BODY_LIMIT,
  HeldAnswer,
  isTightening,
  requestOfText,
  requestText,
  ruleMatches,
} from "../approval.ts";
import { INDEX } from "../approvals-index.ts";
import { LegacySealedCell, type SealedCell, type SecretFact, type Signer } from "./contract.ts";
import { runExchangeCode } from "./exchange-jail.ts";
import {
  SecretKeyAgreement,
  SecretKeyField,
  SecretKeySignature,
  x25519PublicKey,
  x25519SharedSecret,
  x25519Sign,
} from "./key-ops.ts";

type Current = { cell: SealedCell; public?: Record<string, string> };

// Per fixed minute, in memory: an eviction resets them. `verifyHmac` is not counted.
const OPERATIONS_PER_MINUTE = 300;
const FALSE_VERIFICATIONS_PER_MINUTE = 20;

// A cell sealed before records named `lendTo` lends to every path when it answers every operation,
// as an import does, and else to none.
const useOf = (cell: SealedCell): SecretUse => {
  if (!cell.placement) return UNLIMITED_USE;
  const operations = cell.operations || [];
  const imported = operations.length === UNLIMITED_USE.operations.length;
  return {
    placement: cell.placement,
    operations,
    // oxlint-disable-next-line iterate/simple-truthiness-check -- absent is a cell sealed before `lendTo`; null is every path, an import's
    lendTo: cell.lendTo !== undefined ? cell.lendTo : imported ? null : [],
  };
};

// `from` is the kernel's claim, never checked.
export type HeldRow = {
  digest: string;
  text: string;
  at: number;
  until: number;
  from?: string;
  state: "waiting" | "approved" | "rejected" | "sent";
  signer?: Signer;
  reason?: string;
};

export const HOLD_MS = 5 * 60_000;

export const MAX_WAITING = 50;

// A later approval serves an identical retry for a day.
const HELD_ROW_MS = 24 * 60 * 60_000;

// Each statement type is also the type of the fact it leaves.
export const APPROVED = "events.iterate.com/secret/request-approved";
export const REJECTED = "events.iterate.com/secret/request-rejected";
export const RULE_CONFIGURED = "events.iterate.com/secret/approval-rule-configured";

// `basedOn`: the version the attempt began on; a write since ends it.
type PendingAttempt = PendingSecretOAuth & { basedOn: number; authorizationUrl: string };

type Completed = {
  nonce: string;
  version: number;
  scopes: string[];
  account?: { id: string; name: string | null };
};

type Collecting = {
  nonce: string;
  urls: string[];
  description?: string;
  fields?: CollectField[];
  redirectUrl?: string;
  until: number;
  use: SecretUse;
  anyoneWithLink: boolean;
};

type CollectField = z.infer<typeof CollectField>;

const COLLECT_TTL_MS = 24 * 60 * 60_000;

const CollectField = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  label: z.string().trim().min(1).max(80),
  multiline: z.boolean().optional(),
  public: z.boolean().optional(),
  placeholder: z.string().trim().min(1).max(120).optional(),
  // HTML's pattern attribute, which the browser compiles with the `v` flag
  pattern: z
    .string()
    .min(1)
    .max(500)
    .refine((pattern) => {
      try {
        new RegExp(pattern, "v");
        return true;
      } catch {
        return false;
      }
    }, "pattern is a regular expression, as HTML's pattern attribute takes it")
    .optional(),
});

const CollectInput = z.object({
  egress: z.object({ urls: z.array(z.string()) }),
  description: z.string().optional(),
  fields: z
    .array(CollectField)
    .min(1)
    .max(10)
    .refine(
      (fields) => new Set(fields.map((field) => field.name)).size === fields.length,
      "field names are unique",
    )
    .optional(),
  redirectUrl: z
    .url({ protocol: /^https?$/ })
    .refine((value) => {
      const url = new URL(value);
      return !url.username && !url.password;
    }, "redirectUrl is an http(s) URL without credentials")
    .optional(),
  anyoneWithLink: z.boolean().optional(),
});

// It arrives untyped.
const SecretHmacVerificationInput = z.object({
  payload: z.union([z.string(), z.instanceof(Uint8Array)]),
  signature: z.string(),
  field: z.string().min(1).optional(),
});

class RefreshFailed extends Error {
  readonly facts: SecretFact[];
  readonly lent: Facts;
  // Not parameter properties: erasable syntax only, as in secrets.ts.
  constructor(message: string, facts: SecretFact[], lent: Facts) {
    super(message);
    this.facts = facts;
    this.lent = lent;
  }
}

class LendRefused extends Error {
  readonly facts: Facts;
  constructor(message: string, facts: Facts) {
    super(message);
    this.facts = facts;
  }
}

// The page's `form-action` must name `redirectOrigin`: a browser holds a form's redirect to it.
export type CollectionForm = Pick<
  Collecting,
  "urls" | "description" | "fields" | "use" | "anyoneWithLink"
> & { redirectOrigin?: string };

export class SecretDurableObject extends DurableObject<Env> {
  // Single-flight per cell: callers who 401 together share one mint. A caller holding a newer cell
  // queues behind the running one.
  #refreshing: { nonce: string; promise: Promise<SecretFact[]> } | undefined;

  #minute = { start: 0, operations: 0, falseVerifications: 0 };

  #waiting = new Map<string, Set<() => void>>();

  #pathOf(path: string): string {
    assertSecretPath(path);
    const named = this.ctx.id.name;
    if (named && named !== path) throw new Error(`this object is the secret ${named}, not ${path}`);
    return path;
  }

  #current(): Current | undefined {
    return this.ctx.storage.kv.get<Current>("current");
  }

  // Never goes back.
  #version(): number {
    return this.ctx.storage.kv.get<number>("version") ?? 0;
  }

  #key(): string {
    return this.env.SECRETS_AT_REST_KEY;
  }

  // The pages' own calls and another secret's `clientSecretFor` are this Worker's alone: no door
  // outside it reaches them.
  async secret(path: string, verb: string, input: unknown): Promise<unknown> {
    const verbs: {
      [V in SecretVerb]: (input: SecretVerbs[V]["input"]) => Promise<SecretVerbs[V]["answer"]>;
    } = {
      set: (input) => this.#set(path, input),
      delete: () => this.#delete(path),
      describe: () => this.#describe(path),
      importSealed: (input) => this.#importSealed(path, input.cell, input.proof),
      beginOAuth: (input) => this.#beginOAuth(path, input),
      oauthResult: (input) => this.#oauthResult(path, input),
      collectFromUser: (input) => this.#collectFromUser(path, input),
      signHmac: (input) => this.#signHmac(path, input),
      verifyHmac: (input) => this.#verifyHmac(path, input),
      verifyEquals: (input) => this.#verifyEquals(path, input),
      deriveSharedSecret: (input) => this.#deriveSharedSecret(path, input),
      publicKeyOf: (input) => this.#publicKeyOf(path, input),
      signWithKey: (input) => this.#signWithKey(path, input),
    };
    if (!Object.hasOwn(verbs, verb))
      throw codedError("INVALID_INPUT", `secrets: ${JSON.stringify(verb)} is no verb of a secret`);
    return (verbs[verb as SecretVerb] as (input: unknown) => Promise<unknown>)(input);
  }

  // Material always travels with its complete policy: a value never inherits a pin or a strategy.
  async #set(path: string, input: unknown): Promise<SecretAnswer<{ path: string }>> {
    this.#pathOf(path);
    if (!isRecord(input))
      throw codedError(
        "INVALID_INPUT",
        "secrets.set: pass { material, urls, refresh?, public?, placement?, operations?, lendTo? }",
      );
    const record = normalizeSecretRecord(input.material, {
      urls: input.urls,
      refresh: input.refresh,
      placement: input.placement,
      operations: input.operations,
      lendTo: input.lendTo,
    });
    const publicFields =
      input.public === undefined ? undefined : publicFieldsOf(input.material, input.public);
    return {
      result: { path },
      facts: [{ path, events: [await this.#write(path, record, { public: publicFields })] }],
    };
  }

  async #delete(path: string): Promise<SecretAnswer<{ path: string }>> {
    this.#pathOf(path);
    if (this.#version() === 0)
      throw codedError("SECRET_NOT_SET", `secret ${path}: never set — nothing to delete`);
    const held = this.#current();
    for (const key of ["current", "pending", "completed", "collecting"])
      this.ctx.storage.kv.delete(key);
    const events: SecretFact[] = held
      ? [{ type: "events.iterate.com/secret/deleted", payload: { path } }]
      : [];
    if (held) console.info({ event: "secret.deleted", path, version: held.cell.version });
    return { result: { path }, facts: events.length ? [{ path, events }] : [] };
  }

  async #describe(path: string): Promise<SecretDescription> {
    this.#pathOf(path);
    const current = this.#current();
    if (!current) return { path, set: false };
    const { cell } = current;
    return {
      path,
      set: true,
      urls: cell.urls,
      ...(cell.refresh && { refresh: cell.refresh.kind }),
      public: current.public,
      ...useOf(cell),
    };
  }

  // `proof` is an HMAC under the at-rest key of the path and the cell, checked before anything opens.
  // The import writes over any value held: the old project may have rotated a refresh token since.
  async #importSealed(
    path: string,
    // the JSON text the proof was made over: its bytes, not its keys' order, crossed every hop
    cell: string,
    proof: string,
  ): Promise<SecretAnswer<{ path: string }>> {
    this.#pathOf(path);
    const legacy = LegacySealedCell.parse(JSON.parse(cell));
    // A proof is good for ever, so each cell imports once. Taken before the first await, kept on
    // failure, and kept by `delete`.
    const imported = this.ctx.storage.kv.get<string[]>("imported-nonces") || [];
    if (imported.includes(legacy.nonce))
      throw codedError(
        "FORBIDDEN",
        `secrets.importSealed: this cell of ${path} was imported once already`,
      );
    this.ctx.storage.kv.put("imported-nonces", [...imported, legacy.nonce]);
    if (
      !(await secretsEqual(proof, await hmacSha256Hex(this.#key(), JSON.stringify([path, cell]))))
    )
      throw codedError(
        "FORBIDDEN",
        `secrets.importSealed: no proof under the at-rest key for ${path}`,
      );
    let material: SecretMaterial;
    try {
      material = await decryptLegacySecretMaterial(
        legacy.material,
        { context: legacy.context, urls: legacy.urls, nonce: legacy.nonce },
        this.#key(),
      );
    } catch {
      throw codedError(
        "INVALID_INPUT",
        `secrets.importSealed: the cell for ${path} does not open under this stack's at-rest key`,
      );
    }
    const record: SecretRecord = {
      material,
      urls: legacy.urls,
      refresh: legacy.refresh,
      ...UNLIMITED_USE,
    };
    const fact = await this.#write(path, record, { imported: true });
    return { result: { path }, facts: [{ path, events: [fact] }] };
  }

  async #write(
    path: string,
    record: SecretRecord,
    {
      public: publicFields,
      imported,
      by,
    }: { public?: Record<string, string>; imported?: true; by?: PageCaller },
  ): Promise<SecretFact> {
    // reserved before the seal awaits, so two writes in flight never share a version
    const version = this.#version() + 1;
    this.ctx.storage.kv.put("version", version);
    const cell = await this.#sealCell(path, record, version);
    const current = this.#current();
    if (!current || current.cell.version < version)
      this.ctx.storage.kv.put<Current>("current", { cell, public: publicFields });
    console.info({ event: "secret.set", path, version, urls: record.urls, imported });
    return this.#setFact(path, record, publicFields, imported, by);
  }

  async #setFact(
    path: string,
    record: Omit<SecretRecord, "material">,
    publicFields: Record<string, string> | undefined,
    imported?: true,
    by?: PageCaller,
  ): Promise<SecretFact> {
    return {
      type: "events.iterate.com/secret/set",
      payload: {
        path,
        urls: record.urls,
        refresh: record.refresh?.kind,
        refreshSourceSha256:
          record.refresh?.kind === "worker" ? await sha256Hex(record.refresh.source) : undefined,
        public: publicFields,
        imported,
        placement: record.placement,
        operations: record.operations,
        lendTo: record.lendTo,
        by: by ? { userId: by.userId, email: by.email } : undefined,
      },
    };
  }

  async #sealCell(path: string, record: SecretRecord, version: number): Promise<SealedCell> {
    const nonce = crypto.randomUUID();
    const { material: clear, urls, refresh, ...use } = record;
    const material = await encryptSecretMaterial(
      clear,
      { context: path, urls, refresh, version, nonce, use },
      this.#key(),
    );
    return { context: path, urls, refresh, version, nonce, material, ...use };
  }

  async #open(path: string, current: Current): Promise<SecretRecord> {
    const { cell } = current;
    try {
      if (cell.context !== path || cell.version > this.#version())
        throw new Error("not this secret's current cell");
      const material = await decryptSecretMaterial(
        cell.material,
        {
          context: path,
          urls: cell.urls,
          refresh: cell.refresh,
          version: cell.version,
          nonce: cell.nonce,
          use: cell.placement && {
            placement: cell.placement,
            operations: cell.operations || [],
            lendTo: cell.lendTo,
          },
        },
        this.#key(),
      );
      return { material, urls: cell.urls, refresh: cell.refresh, ...useOf(cell) };
    } catch {
      throw new SecretRefused(
        `itx.fetch: the stored material of ${path} cannot be opened (another key, or another secret's record) — set the secret again`,
      );
    }
  }

  // `verifyHmac` is the public webhook door's: anyone can make it answer false, so it is not counted
  // and only a true answer leaves a fact; else a stranger could shut the secret and fill its log.
  async #operate<T>(
    path: string,
    verb: SecretOperation,
    run: (material: SecretMaterial) => Promise<T>,
  ): Promise<SecretAnswer<T> | SecretRefusal> {
    this.#pathOf(path);
    const current = this.#current();
    if (!current) throw codedError("SECRET_NOT_SET", `${verb}: ${path} holds no material`);
    const record = await this.#open(path, current);
    const now = Date.now();
    if (now - this.#minute.start >= 60_000)
      this.#minute = { start: now, operations: 0, falseVerifications: 0 };
    const counted = verb !== "verifyHmac";
    const refusal = !record.operations.includes(verb)
      ? {
          code: "FORBIDDEN" as const,
          message: `${verb}: ${path} was not made to answer it. A secret answers the operations it was made with — itx.secrets.set(path, material, { urls, operations: ["${verb}"] }), or collectFromUser and beginOAuth with the same option, which the person who gives it sees.`,
        }
      : (counted && this.#minute.operations >= OPERATIONS_PER_MINUTE) ||
          (verb === "verifyEquals" &&
            this.#minute.falseVerifications >= FALSE_VERIFICATIONS_PER_MINUTE)
        ? {
            code: "FORBIDDEN" as const,
            message: `${verb}: ${path} has answered its limit for this minute (${OPERATIONS_PER_MINUTE} operations, ${FALSE_VERIFICATIONS_PER_MINUTE} wrong guesses of its value); try again after ${new Date(this.#minute.start + 60_000).toISOString()}.`,
          }
        : null;
    const factsOf = (outcome: "answered" | "refused") => [
      {
        path,
        events: [
          {
            type: "events.iterate.com/secret/operated",
            payload: { verb, outcome },
          } satisfies SecretFact,
        ],
      },
    ];
    if (refusal) {
      console.info({ event: "secret.operated", path, verb, outcome: "refused" });
      return { refused: refusal, facts: counted ? factsOf("refused") : [] };
    }
    if (counted) this.#minute.operations += 1;
    const result = await run(record.material);
    if (result === false && verb === "verifyEquals") this.#minute.falseVerifications += 1;
    console.info({ event: "secret.operated", path, verb, outcome: "answered" });
    return { result, facts: counted || result !== false ? factsOf("answered") : [] };
  }

  #verifyHmac(path: string, input: unknown) {
    const parsed = SecretHmacVerificationInput.parse(input);
    return this.#operate(path, "verifyHmac", (material) => verifySecretHmac(material, parsed));
  }

  #signHmac(path: string, input: unknown) {
    const parsed = SecretHmacSigningInput.parse(input);
    return this.#operate(path, "signHmac", async (material) => {
      const signature = await signSecretHmac(material, parsed);
      if (!signature)
        throw codedError("SECRET_NOT_SET", "signHmac: this secret holds no key at that field");
      return signature;
    });
  }

  #verifyEquals(path: string, input: unknown) {
    const parsed = z
      .object({ value: z.string(), field: z.string().min(1).optional() })
      .parse(input);
    return this.#operate(path, "verifyEquals", (material) => verifySecretEquals(material, parsed));
  }

  #deriveSharedSecret(path: string, input: unknown) {
    const { field, peerPublicHex } = SecretKeyAgreement.parse(input);
    return this.#operate(path, "deriveSharedSecret", async (material) => {
      const shared = await x25519SharedSecret(
        this.#privateAt(material, field),
        Buffer.from(peerPublicHex, "hex"),
      );
      return Buffer.from(shared).toString("hex");
    });
  }

  #publicKeyOf(path: string, input: unknown) {
    const { field } = SecretKeyField.parse(input);
    return this.#operate(path, "publicKeyOf", async (material) =>
      Buffer.from(await x25519PublicKey(this.#privateAt(material, field))).toString("hex"),
    );
  }

  #signWithKey(path: string, input: unknown) {
    const { field, messageHex } = SecretKeySignature.parse(input);
    return this.#operate(path, "signWithKey", async (material) =>
      Buffer.from(
        x25519Sign(this.#privateAt(material, field), Buffer.from(messageHex, "hex")),
      ).toString("hex"),
    );
  }

  #privateAt(material: SecretMaterial, field: string): Uint8Array {
    let node: unknown = material;
    for (const part of field.split(".")) node = isRecord(node) ? node[part] : undefined;
    if (typeof node !== "string")
      throw codedError("INVALID_INPUT", `key-ops: material has no hex key at "${field}"`);
    return Buffer.from(node, "hex");
  }

  // Only this Worker calls it. The pin binds this use as it binds every other.
  async clientSecretFor(
    path: string,
    input: { borrower: string; origin: string; field?: string },
  ): Promise<SecretAnswer<string> | SecretRefusal> {
    this.#pathOf(path);
    const { borrower, origin } = input;
    const current = this.#current();
    if (!current)
      throw codedError(
        "INVALID_INPUT",
        `secrets: ${path} holds no secret — collect the client secret there first (itx.secrets.collectFromUser)`,
      );
    const { lendTo } = useOf(current.cell);
    const refusal = this.#rule()
      ? // a secret that waits for approval is spent with one alone
        `secrets: ${path} has an approval rule, so it is lent to no other secret's token request`
      : lendTo && !lendTo.includes(borrower)
        ? `secrets: ${path} does not lend to ${borrower} — set it again with lendTo: ["${borrower}"]`
        : !originPinned(origin, current.cell.urls)
          ? `secrets: the secret ${path} is pinned to ${current.cell.urls.join(", ")}, not ${origin} — so it is never sent there as a client secret`
          : null;
    const outcome = refusal ? "refused" : "answered";
    console.info({ event: "secret.operated", path, verb: "clientSecretFor", borrower, outcome });
    if (refusal)
      return {
        refused: { code: "FORBIDDEN", message: refusal },
        facts: [
          {
            path,
            events: [
              {
                type: "events.iterate.com/secret/operated",
                payload: { verb: "clientSecretFor", outcome, borrower },
              } satisfies SecretFact,
            ],
          },
        ],
      };
    let record: SecretRecord;
    try {
      record = await this.#open(path, current);
    } catch (error) {
      if (!(error instanceof SecretRefused)) throw error;
      throw codedError("INVALID_INPUT", error.message.replace(/^itx\.fetch: /, "secrets: "));
    }
    const value = secretMaterialStringOf(record.material, input.field);
    if (value) return { result: value, facts: [] };
    throw codedError(
      "INVALID_INPUT",
      input.field
        ? `secrets: ${path} has no string at field "${input.field}"`
        : typeof record.material === "string"
          ? `secrets: ${path} is empty`
          : `secrets: ${path} is a JSON object: name its field, getSecret("${path}", { field: "…" })`,
    );
  }

  #brokered(name: string, asks: "token" | "installation-token" | "ask") {
    return brokered(
      (input) => this.env.AUTH.sign(input),
      this.env.CLOUD_ORIGIN,
      name,
      `events.iterate.com/integration/${asks}-requested`,
    );
  }

  #clientSecretOf(path: string) {
    return async (clientSecret: string, tokenEndpoint: string): Promise<string> => {
      const reference = clientSecretReferenceOf(clientSecret);
      if (!reference) return clientSecret;
      if (reference.path === path)
        throw codedError(
          "INVALID_INPUT",
          `secrets: the client secret getSecret("${reference.path}") names ${path} itself — collect the client secret into a secret of its own`,
        );
      // RPC's stub types cannot say which answer the object gives
      const answer = (await this.env.SECRET.getByName(reference.path).clientSecretFor(
        reference.path,
        { borrower: path, origin: new URL(tokenEndpoint).origin, field: reference.field },
      )) as SecretAnswer<string> | SecretRefusal;
      if ("refused" in answer) throw new LendRefused(answer.refused.message, answer.facts);
      return answer.result;
    };
  }

  async #beginOAuth(
    path: string,
    options: unknown,
  ): Promise<SecretAnswer<{ authorizationUrl: string; nonce: string }> | SecretRefusal> {
    this.#pathOf(path);
    const domain = this.env.DOMAIN;
    const platformOrigin = platformOriginOf(domain);
    const next = isRecord(options) && typeof options.next === "string" ? options.next : null;
    const nextOrigin = next && URL.canParse(next) ? new URL(next) : null;
    const projectOrigin =
      nextOrigin?.protocol === "https:" &&
      (nextOrigin.hostname === domain || nextOrigin.hostname.endsWith(`.${domain}`))
        ? nextOrigin.origin
        : null;
    const client = isRecord(options) && isRecord(options.client) ? options.client.cloud : null;
    const cloud =
      typeof client === "string" ? await cloudClientOf(this.env.CLOUD_ORIGIN, client) : null;
    const normalized = normalizeSecretOAuth(
      options,
      [platformOrigin, ...(projectOrigin ? [projectOrigin] : [])],
      cloud,
    );
    const nonce = crypto.randomUUID();
    // a placeholder that cannot resolve is refused now, before a human is sent to consent
    try {
      await this.#clientSecretOf(path)(normalized.clientSecret, normalized.tokenEndpoint);
    } catch (error) {
      if (!(error instanceof LendRefused)) throw error;
      return { refused: { code: "FORBIDDEN", message: error.message }, facts: error.facts };
    }
    const { pending, authorizationUrl } = await beginSecretOAuth(normalized, {
      // a Cloud client's one redirect URI is the Cloud's callback, which sends the code on here
      redirectUri: cloud?.redirectUri || `${platformOrigin}${SECRET_OAUTH_CALLBACK_PATH}`,
      state: stateOf({ path, nonce }),
      nonce,
    });
    this.ctx.storage.kv.put<PendingAttempt>("pending", {
      ...pending,
      basedOn: this.#version(),
      authorizationUrl,
    });
    return {
      result: { authorizationUrl: startLinkOf(platformOrigin, path, nonce), nonce },
      facts: [],
    };
  }

  async oauthStartTarget(
    path: string,
    input: { nonce: string },
  ): Promise<{
    authorizationUrl: string;
    urls: string[];
    use: SecretUse;
    anyoneWithLink: boolean;
    returnTo?: string;
    beginAt?: string;
  } | null> {
    this.#pathOf(path);
    const pending = this.ctx.storage.kv.get<PendingAttempt>("pending");
    if (!pending || pending.nonce !== input.nonce || pending.until <= Date.now()) return null;
    const { urls, use, anyoneWithLink, cloud } = pending.options;
    const callback = `${platformOriginOf(this.env.DOMAIN)}${SECRET_OAUTH_CALLBACK_PATH}`;
    return {
      authorizationUrl: pending.authorizationUrl,
      urls,
      use,
      anyoneWithLink,
      // the Cloud's page says which accounts' installations the project asks for
      ...(cloud && {
        returnTo: callback,
        beginAt:
          cloud.beginEndpoint && cloud.accounts?.length
            ? `${cloud.beginEndpoint}?accounts=${cloud.accounts.join(",")}`
            : cloud.beginEndpoint,
      }),
    };
  }

  // Never a token, a cell or the provider's URL.
  async #oauthResult(path: string, input: { nonce: string }): Promise<SecretOAuthResult> {
    this.#pathOf(path);
    const nonce = String(input?.nonce || "");
    const pending = this.ctx.storage.kv.get<PendingAttempt>("pending");
    if (pending?.nonce === nonce && pending.until > Date.now()) return { status: "pending" };
    const completed = this.ctx.storage.kv.get<Completed>("completed");
    if (completed?.nonce !== nonce || completed.version !== this.#version())
      return { status: "unavailable" };
    return {
      status: "complete",
      scopes: completed.scopes,
      account: completed.account,
    };
  }

  // A stale or foreign callback fails without touching the live attempt.
  async completeOAuth(
    path: string,
    input: { code: string; nonce: string; by: PageCaller; cloudProof?: string },
  ): Promise<SecretAnswer<{ next: string | null; scopes: string[] }>> {
    this.#pathOf(path);
    const { by } = input;
    const pending = this.ctx.storage.kv.get<PendingAttempt>("pending");
    if (!pending || pending.nonce !== input.nonce)
      throw new Error("no pending attempt matches this callback — begin again");
    // the page admitted the browser; this holds whatever called
    if (!pending.options.anyoneWithLink && !by?.member)
      throw new Error("only a member of the project, signed in, may complete this attempt");
    if (pending.until <= Date.now()) {
      this.ctx.storage.kv.delete("pending");
      throw new Error("the attempt expired — begin again");
    }
    if (pending.basedOn !== this.#version()) {
      this.ctx.storage.kv.delete("pending");
      throw new Error("the secret was changed since this attempt began — begin again");
    }
    let scopes: string[] = [];
    const record = await completeSecretOAuth(
      pending,
      input.code,
      async (exchange) => {
        const { cloud } = pending.options;
        if (!cloud && !originPinned(exchange.url, pending.options.urls))
          throw new Error(`the token endpoint ${new URL(exchange.url).origin} is outside the pin`);
        const response = await (cloud ? this.#brokered(cloud.name, "token") : dispatch)(exchange);
        const answer: unknown = await response
          .clone()
          .json()
          .catch(() => null);
        scopes =
          isRecord(answer) && typeof answer.scope === "string"
            ? answer.scope.split(/[\s,]+/).filter(Boolean)
            : (pending.options.scope || "").split(/\s+/).filter(Boolean);
        return response;
      },
      this.#clientSecretOf(path),
      input.cloudProof,
    );
    let account: { id: string; name: string | null } | undefined;
    const lookup = pending.options.account;
    if (lookup) {
      const identity = await dispatch(
        new Request(lookup.url, {
          headers: {
            authorization: `Bearer ${secretMaterialStringOf(record.material, "accessToken")}`,
          },
          redirect: "manual",
        }),
      );
      if (!identity.ok) {
        await identity.body?.cancel();
        throw new Error(`the account lookup answered ${identity.status}`);
      }
      account = accountOf(await identity.json(), lookup);
    }
    // a write, or a newer attempt, that landed while the provider was answering wins
    if (
      this.#version() !== pending.basedOn ||
      this.ctx.storage.kv.get<PendingAttempt>("pending")?.nonce !== input.nonce
    )
      throw new Error(
        "the secret was changed while the provider was answering — the tokens were discarded; begin again",
      );
    const fact = await this.#write(path, record, { by });
    this.ctx.storage.kv.delete("pending");
    this.ctx.storage.kv.put<Completed>("completed", {
      nonce: input.nonce,
      version: this.#version(),
      scopes,
      account,
    });
    return { result: { next: pending.options.next, scopes }, facts: [{ path, events: [fact] }] };
  }

  async #collectFromUser(path: string, input: unknown): Promise<{ path: string; url: string }> {
    this.#pathOf(path);
    const collected = CollectInput.parse(input);
    const urls = originsOf(collected.egress.urls);
    if (urls.length === 0)
      throw new Error("itx.secrets.collectFromUser: egress.urls must name at least one URL");
    const unsafeUrl = collected.egress.urls.find((value) => {
      const url = new URL(value);
      return !["http:", "https:"].includes(url.protocol) || Boolean(url.username || url.password);
    });
    if (unsafeUrl)
      throw new Error(
        `itx.secrets.collectFromUser: egress URL ${JSON.stringify(unsafeUrl)} must be an http(s) URL without credentials`,
      );
    const nonce = crypto.randomUUID();
    this.ctx.storage.kv.put<Collecting>("collecting", {
      nonce,
      urls,
      use: secretUseOf(isRecord(input) ? input : undefined),
      anyoneWithLink: collected.anyoneWithLink === true,
      description: collected.description,
      fields: collected.fields,
      ...(collected.redirectUrl && { redirectUrl: new URL(collected.redirectUrl).href }),
      until: Date.now() + COLLECT_TTL_MS,
    });
    const url = new URL("/secrets/collect", platformOriginOf(this.env.DOMAIN));
    url.searchParams.set("path", path);
    url.searchParams.set("nonce", nonce);
    return { path, url: url.href };
  }

  async collectionForm(path: string, input: { nonce: string }): Promise<CollectionForm | null> {
    this.#pathOf(path);
    const collecting = this.#collecting(input.nonce);
    if (!collecting) return null;
    const { urls, description, fields, redirectUrl, use, anyoneWithLink } = collecting;
    return {
      urls,
      description,
      fields,
      use,
      anyoneWithLink,
      ...(redirectUrl && { redirectOrigin: new URL(redirectUrl).origin }),
    };
  }

  async collect(
    path: string,
    input: { nonce: string; values: Record<string, string>; by: PageCaller },
  ): Promise<SecretAnswer<{ redirectUrl: string | null }>> {
    this.#pathOf(path);
    const collecting = this.#collecting(input.nonce);
    if (!collecting)
      throw new Error("this link was used already, or it lapsed — ask for a new one");
    // the page admitted the browser; this holds whatever called
    if (!collecting.anyoneWithLink && !input.by?.member)
      throw new Error("only a member of the project, signed in, may fill this form");
    let material: SecretMaterial;
    let publicNames: string[] = [];
    if (!collecting.fields) {
      const value = input.values.value || "";
      if (!value) throw new Error("enter the value");
      material = value;
    } else {
      const object: Record<string, string> = {};
      for (const field of collecting.fields) {
        const value = input.values[field.name] ?? "";
        if (!value) throw new Error(`enter ${field.label}`);
        if (field.pattern && !new RegExp(`^(?:${field.pattern})$`, "v").test(value))
          throw new Error(`${field.label} is not in the form it asks for`);
        object[field.name] = value;
      }
      material = object;
      publicNames = collecting.fields.filter((field) => field.public).map((field) => field.name);
    }
    const fact = await this.#write(
      path,
      { material, urls: collecting.urls, refresh: null, ...collecting.use },
      {
        public: publicNames.length ? publicFieldsOf(material, publicNames) : undefined,
        by: input.by,
      },
    );
    this.ctx.storage.kv.delete("collecting");
    return {
      result: { redirectUrl: collecting.redirectUrl || null },
      facts: [{ path, events: [fact] }],
    };
  }

  #collecting(nonce: string): Collecting | null {
    const collecting = this.ctx.storage.kv.get<Collecting>("collecting");
    return collecting?.nonce === nonce && collecting.until > Date.now() ? collecting : null;
  }

  #rule(): ApprovalRule | null {
    return this.ctx.storage.kv.get<ApprovalRule>("approval-rule") ?? null;
  }

  #setRule(path: string, rule: ApprovalRule | null) {
    if (rule) this.ctx.storage.kv.put("approval-rule", rule);
    else this.ctx.storage.kv.delete("approval-rule");
    console.info({ event: "secret.approval-rule-configured", path, rule });
  }

  #heldRows(): HeldRow[] {
    const now = Date.now();
    const rows: HeldRow[] = [];
    for (const [key, row] of this.ctx.storage.kv.list<HeldRow>({ prefix: "held:" }))
      if (row.until > now) rows.push(row);
      else this.ctx.storage.kv.delete(key);
    return rows;
  }

  async approvals(path: string): Promise<{ rule: ApprovalRule | null; held: HeldRow[] }> {
    this.#pathOf(path);
    const held = this.#heldRows().filter(
      (row) => row.state === "waiting" || row.state === "approved",
    );
    return { rule: this.#rule(), held };
  }

  // A loosening needs a signed statement.
  async tightenRule(
    path: string,
    input: { rule: unknown; by: { userId: string; email: string } },
  ): Promise<SecretAnswer<{ rule: ApprovalRule }>> {
    this.#pathOf(path);
    const parsed = ApprovalRule.safeParse(input.rule);
    if (!parsed.success)
      throw codedError("INVALID_INPUT", parsed.error.issues.map((i) => i.message).join("; "));
    const rule = parsed.data;
    if (!isTightening(this.#rule(), rule))
      throw codedError(
        "FORBIDDEN",
        `the rule of ${path} would hold fewer requests: removing a method or a host needs a member's signed statement`,
      );
    this.#setRule(path, rule);
    await this.env.APPROVALS.getByName(INDEX).add(path);
    const by = { userId: input.by.userId, email: input.by.email };
    return {
      result: { rule },
      facts: [{ path, events: [{ type: RULE_CONFIGURED, payload: { rule, by } }] }],
    };
  }

  // A statement the auth Worker refused is a log line alone, since anyone can send one.
  async decide(path: string, envelope: Envelope): Promise<SecretAnswer<{ error?: string }>> {
    this.#pathOf(path);
    const verified = await this.env.AUTH.verify(envelope);
    if ("refused" in verified) {
      console.info({ event: "secret.statement-refused", path, reason: verified.refused });
      return { result: { error: verified.refused }, facts: [] };
    }
    const { statement } = verified;
    const signer: Signer = {
      principal: verified.signer.principal,
      key: verified.signer.key,
      label: verified.signer.label,
      userVerified: verified.signer.userVerified,
    };
    const answer = (fact: SecretFact, error?: string) => {
      console.info({ event: fact.type.replace("events.iterate.com/secret/", "secret."), path });
      return { result: error ? { error } : {}, facts: [{ path, events: [fact] }] };
    };
    const refuse = (reason: string) =>
      answer(
        {
          type: "events.iterate.com/secret/statement-refused",
          payload: { statementType: statement.type, reason, signer },
        },
        reason,
      );
    if (statement.path !== path) return refuse(`the statement is about ${statement.path}`);
    if (!verified.signer.member)
      return refuse("only a member's key approves, rejects or changes a rule");
    if (statement.type === RULE_CONFIGURED) {
      const given = statement.payload?.rule;
      const parsed = given === null ? null : ApprovalRule.safeParse(given);
      if (parsed && !parsed.success)
        return refuse(parsed.error.issues.map((issue) => issue.message).join("; "));
      const rule = parsed?.data || null;
      this.#setRule(path, rule);
      if (rule) await this.env.APPROVALS.getByName(INDEX).add(path);
      return answer({ type: RULE_CONFIGURED, payload: { rule, signer, signed: envelope } });
    }
    if (statement.type !== APPROVED && statement.type !== REJECTED)
      return refuse(`the vault does not act on ${statement.type}`);
    const digests = statement.about || [];
    if (!digests.length) return refuse("the statement names no request");
    const now = Date.now();
    const rows = digests.map((digest) => this.ctx.storage.kv.get<HeldRow>(`held:${digest}`));
    if (rows.some((row) => !row || row.state !== "waiting" || row.until <= now))
      return refuse("a request it names does not wait here");
    const reason = statement.payload?.reason;
    if (statement.type === REJECTED && (typeof reason !== "string" || !reason.trim()))
      return refuse("a rejection names its reason");
    for (const row of rows as HeldRow[])
      this.ctx.storage.kv.put<HeldRow>(`held:${row.digest}`, {
        ...row,
        state: statement.type === APPROVED ? "approved" : "rejected",
        signer,
        ...(statement.type === REJECTED && { reason: String(reason) }),
      });
    for (const digest of digests) this.#wake(digest);
    return answer(
      statement.type === APPROVED
        ? { type: APPROVED, payload: { digests, signer, signed: envelope } }
        : {
            type: REJECTED,
            payload: { digests, signer, signed: envelope, reason: String(reason) },
          },
    );
  }

  // A call with new bytes is answered `held` at once, so the project's log hears of it. The wait call
  // names a digest; nothing else it carries is read.
  async #hold(
    path: string,
    request: Request,
    waitFor: string | null,
    facts: SecretFact[],
  ): Promise<{ request: Request; digest: string; release: () => void }> {
    let row = waitFor
      ? this.#heldRows().find((held) => held.digest === waitFor)
      : await this.#rowOf(path, request, facts);
    if (!row)
      throw new HeldAnswer(404, "refused", `itx.fetch: no request ${waitFor} waits with ${path}`);
    const { digest, text } = row;
    const key = `held:${digest}`;
    if (row.state === "waiting") {
      await this.#settled(digest, HOLD_MS);
      row = this.ctx.storage.kv.get<HeldRow>(key) ?? row;
    }
    if (row.state === "sent") throw sentBefore(digest);
    if (row.state === "rejected")
      throw new HeldAnswer(
        403,
        "rejected",
        `itx.fetch: ${row.signer?.principal.email || row.signer?.principal.actor || "a member"} rejected this request (${digest}): ${row.reason}`,
      );
    if (row.state === "waiting") {
      console.info({ event: "secret.hold-expired", path, digest });
      facts.push({ type: "events.iterate.com/secret/hold-expired", payload: { digest } });
      throw new HeldAnswer(
        403,
        "waiting",
        `itx.fetch: this request with ${path} waits for a member's approval (${digest}), at /secrets/approvals?digest=${digest} on the platform's origin. Once it is approved, send the same request again: it goes then.`,
      );
    }
    const release = () => {
      // no await from here to the dispatch: the mark and the send are one step
      const now = this.ctx.storage.kv.get<HeldRow>(key);
      if (now?.state !== "approved") throw sentBefore(digest);
      this.ctx.storage.kv.put<HeldRow>(key, { ...now, state: "sent" });
    };
    return { request: requestOfText(text), digest, release };
  }

  async #rowOf(path: string, request: Request, facts: SecretFact[]): Promise<HeldRow> {
    if (Number(request.headers.get("content-length") || 0) > HELD_BODY_LIMIT)
      throw new HeldAnswer(413, "refused", tooLarge(path));
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > HELD_BODY_LIMIT) throw new HeldAnswer(413, "refused", tooLarge(path));
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new HeldAnswer(
        415,
        "refused",
        `itx.fetch: a request with ${path} waits for approval, and its body must be text (UTF-8)`,
      );
    }
    const text = requestText({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    const digest = await sha256Hex(text);
    const rows = this.#heldRows();
    const kept = rows.find((held) => held.digest === digest);
    if (kept) return kept;
    // each row keeps a body of up to `HELD_BODY_LIMIT` for a day
    if (rows.filter((held) => held.state === "waiting").length >= MAX_WAITING)
      throw new HeldAnswer(
        429,
        "refused",
        `itx.fetch: ${MAX_WAITING} requests with ${path} wait for approval already; approve or reject some first`,
      );
    const now = Date.now();
    const from = claimedOrigin(request.headers.get(ITERATE_CAUSE_HEADER));
    this.ctx.storage.kv.put<HeldRow>(`held:${digest}`, {
      digest,
      text,
      at: now,
      until: now + HELD_ROW_MS,
      from,
      state: "waiting",
    });
    const shown = { method: request.method, url: request.url, bodyStart: body.slice(0, 500) };
    console.info({
      event: "secret.approval-requested",
      path,
      digest,
      method: shown.method,
      url: shown.url,
      from,
    });
    facts.push({
      type: "events.iterate.com/secret/approval-requested",
      payload: { digest, ...shown, from },
    });
    await this.env.APPROVALS.getByName(INDEX).add(path);
    throw new HeldAnswer(202, "held", JSON.stringify({ digest }));
  }

  #settled(digest: string, ms: number): Promise<void> {
    return new Promise((settle) => {
      const waiters = this.#waiting.get(digest) ?? new Set();
      this.#waiting.set(digest, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        settle();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
    });
  }

  #wake(digest: string) {
    for (const done of [...(this.#waiting.get(digest) ?? [])]) done();
    this.#waiting.delete(digest);
  }

  // Every refusal is a 502 to the caller, never to the destination. A substituted value is cut out
  // of the answer's headers; the body goes back as the host sent it.
  override async fetch(incoming: Request): Promise<Response> {
    const path = this.#pathOf(incoming.headers.get(SECRET_USE_HEADER) ?? "");
    const headers = new Headers(incoming.headers);
    headers.delete(SECRET_USE_HEADER);
    const waitFor = headers.get(SECRET_HELD_HEADER);
    headers.delete(SECRET_HELD_HEADER);
    let request = new Request(incoming, { headers });
    const facts: SecretFact[] = [];
    const lent: Facts = [];
    const substituted = new Set<string>();
    const answered = (response: Response, own?: VaultAnswerKind) =>
      answerOf(response, [{ path, events: facts }, ...lent], substituted, own);
    // An ask of the Cloud uses no value of the secret: nothing is substituted, pinned or held, and
    // every header that names the secret is taken off.
    const connected = this.#current()?.cell.refresh;
    const ask = askOf(
      request,
      this.env.CLOUD_ORIGIN,
      connected?.kind === "oauth-refresh-token" && connected.client && "cloud" in connected.client
        ? connected.client.cloud
        : undefined,
    );
    if (ask) {
      const bare = new Headers(headers);
      for (const [name, value] of headers) if (secretPathsIn(value).length) bare.delete(name);
      console.info({ event: "secret.used", path, method: request.method, url: request.url });
      const response = await this.#brokered(ask, "ask")(new Request(request, { headers: bare }));
      facts.push({
        type: "events.iterate.com/secret/used",
        payload: { method: request.method, url: request.url, status: response.status },
      });
      return answered(response);
    }
    let held: { digest: string; release?: () => void } | undefined;
    const upgrades = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    // The pin is checked at every read: after a refresh it may have moved.
    const read = async () => {
      const current = this.#current();
      if (!current) return null;
      if (!originPinned(request.url, current.cell.urls))
        throw pinRefusal(path, request.url, current.cell.urls);
      const record = await this.#open(path, current);
      // a secret placed in headers alone is never spliced into a URL, where a host may log it,
      // redirect with it or quote it back
      if (record.placement === "header" && secretPathsIn(request.url).length)
        throw new SecretRefused(
          `itx.fetch: the secret ${path} is placed in headers alone — not in a request's URL (set it again with placement: "url" to allow that)`,
        );
      return { nonce: current.cell.nonce, record };
    };
    const usedFact = (status: number): SecretFact => ({
      type: "events.iterate.com/secret/used",
      payload: {
        method: request.method,
        url: request.url,
        status,
        ...(held && { digest: held.digest }),
      },
    });
    const send = async (outbound: Request, retried: boolean) => {
      // No await from here to the dispatch: a rule set while this request was being prepared (a
      // refresh can take seconds) holds it too.
      const ruleNow = this.#rule();
      if (!held && ruleNow && (upgrades || ruleMatches(ruleNow, request.method, request.url)))
        throw new HeldAnswer(
          409,
          "refused",
          `itx.fetch: ${path} got an approval rule that names this request while it was being sent; send it again`,
        );
      held?.release?.();
      if (held) held.release = undefined;
      // the record no project can drop, written before the request leaves
      console.info({
        event: "secret.used",
        path,
        method: request.method,
        url: request.url,
        retried,
        ...(held && { digest: held.digest }),
      });
      const response = await dispatch(outbound);
      facts.push(usedFact(response.status));
      return response;
    };
    try {
      let stored = await read();
      // A wait call is held whatever the rule says now: what it may send is the stored text alone.
      const rule = this.#rule();
      if (rule && upgrades)
        throw new SecretRefused(
          `itx.fetch: ${path} has an approval rule, so it opens no WebSocket`,
        );
      if (stored && (waitFor || (rule && ruleMatches(rule, request.method, request.url)))) {
        const approved = await this.#hold(path, request, waitFor, facts);
        held = { digest: approved.digest, release: approved.release };
        request = approved.request;
        stored = await read();
      }
      // Refused here too, not only at egress: this object is the boundary that holds the bytes.
      const resolve = (named: string) => {
        if (named !== path)
          throw new SecretRefused(
            `itx.fetch: getSecret(${JSON.stringify(named)}) does not belong to the secret ${path}`,
          );
        return stored?.record.material || null;
      };
      // The cast: workers-types' Request<Cf> against the bare Request the pure half takes.
      const retry = stored?.record.refresh ? (request.clone() as unknown as Request) : null;
      const refreshed = async () => {
        try {
          facts.push(...(await this.#refresh(path, stored!.nonce)));
          return null;
        } catch (cause) {
          if (cause instanceof RefreshFailed) {
            facts.push(...cause.facts);
            lent.push(...cause.lent);
          }
          return cause instanceof Error ? cause : new Error(String(cause));
        }
      };
      // At most two attempts: a mintable miss or a 401 from the pinned host mints, then one retry.
      for (let attempt = 0; ; attempt += 1) {
        const last = attempt > 0 || !retry || !stored;
        let outbound: Request;
        try {
          outbound = await substituteProjectSecrets(
            attempt ? retry! : request,
            resolve,
            substituted,
          );
        } catch (error) {
          if (!(error instanceof SecretRefused) || !error.mintable || last) throw error;
          const failed = await refreshed();
          if (failed)
            throw new SecretRefused(`${error.message}; the refresh failed: ${failed.message}`);
          stored = await read();
          continue;
        }
        const response = await send(outbound, attempt > 0);
        if (response.status !== 401 || last || (await refreshed())) return answered(response);
        await response.body?.cancel();
        stored = await read();
      }
    } catch (error) {
      if (!(error instanceof SecretRefused) && !(error instanceof HeldAnswer)) throw error;
      const status = error instanceof HeldAnswer ? error.status : 502;
      // only a use that was dispatched names the digest of the request that waited
      held = undefined;
      console.info({
        event: "secret.used",
        path,
        method: request.method,
        url: request.url,
        status,
      });
      facts.push(usedFact(status));
      const kind = error instanceof HeldAnswer ? error.kind : "refused";
      return answered(
        kind === "held"
          ? new Response(error.message, { status, headers: { "content-type": "application/json" } })
          : new Response(`${error.message}\n`, { status }),
        kind,
      );
    }
  }

  #refresh(path: string, nonce: string): Promise<SecretFact[]> {
    const inFlight = this.#refreshing;
    if (inFlight?.nonce === nonce) return inFlight.promise.then(() => []);
    const previous = inFlight?.promise.catch(() => {}) ?? Promise.resolve();
    const promise = previous
      .then(() => this.#doRefresh(path, nonce))
      .finally(() => {
        if (this.#refreshing?.promise === promise) this.#refreshing = undefined;
      });
    this.#refreshing = { nonce, promise };
    return promise;
  }

  // A stale mint must never resurrect material a write replaced: the cell's nonce fences it. A mint
  // is sealed at the same version.
  async #doRefresh(path: string, nonce: string): Promise<SecretFact[]> {
    const current = this.#current();
    if (current?.cell.nonce !== nonce) return [];
    const record = await this.#open(path, current);
    const { refresh, urls } = record;
    if (!refresh) throw new Error("no refresh strategy");
    const pinnedDispatch = (exchange: Request) => {
      if (!originPinned(exchange.url, urls))
        throw new Error(`the exchange endpoint ${new URL(exchange.url).origin} is outside the pin`);
      console.info({ event: "secret.refresh-request", path, url: new URL(exchange.url).origin });
      return dispatch(exchange);
    };
    let next: Record<string, unknown>;
    try {
      if (refresh.kind === "github-app-installation")
        next = {
          ...(isRecord(record.material) && record.material),
          accessToken: await this.#githubInstallationToken(path, refresh, record, pinnedDispatch),
        };
      else if (refresh.kind === "worker")
        // The cast: the generated `ctx.exports` types do not see ../worker.ts's entrypoints.
        next = await runExchangeCode({
          loader: this.env.LOADER,
          pinnedOutbound: (
            this.ctx.exports as unknown as {
              PinnedOutbound: (options: { props: { urls: string[] } }) => Fetcher;
            }
          ).PinnedOutbound({ props: { urls } }),
          context: path,
          urls,
          source: refresh.source,
          material: record.material,
        });
      else
        next = await refreshSecretMaterial(
          refresh,
          record.material,
          refresh.client && "cloud" in refresh.client
            ? this.#brokered(refresh.client.cloud, "token")
            : pinnedDispatch,
          this.#clientSecretOf(path),
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.info({ event: "secret.refreshed", path, ok: false, error: message });
      throw new RefreshFailed(
        message,
        [
          {
            type: "events.iterate.com/secret/refreshed",
            payload: { kind: refresh.kind, ok: false, error: message },
          },
        ],
        error instanceof LendRefused ? error.facts : [],
      );
    }
    const before = this.#current();
    if (before?.cell.nonce !== nonce) return [];
    const cell = await this.#sealCell(path, { ...record, material: next }, before.cell.version);
    // again, after the seal awaited
    const now = this.#current();
    if (now?.cell.nonce !== nonce) return [];
    this.ctx.storage.kv.put<Current>("current", { ...now, cell });
    console.info({ event: "secret.refreshed", path, ok: true, version: cell.version });
    return [
      {
        type: "events.iterate.com/secret/refreshed",
        payload: { kind: refresh.kind, ok: true },
      },
    ];
  }

  // `appId` and `privateKey` may each be a placeholder naming another secret, read at every mint as
  // a client secret is.
  async #githubInstallationToken(
    path: string,
    refresh: Extract<SecretRefresh, { kind: "github-app-installation" }>,
    record: SecretRecord,
    pinnedDispatch: (request: Request) => Promise<Response>,
  ): Promise<string> {
    // iterate Cloud's App key stays at the Cloud, which mints the token
    if ("cloud" in refresh.client) {
      const { cloud } = refresh.client;
      const { installationTokenEndpoint } = await cloudClientOf(this.env.CLOUD_ORIGIN, cloud);
      if (!installationTokenEndpoint) throw new Error(`${refresh.kind}: ${cloud} is no GitHub App`);
      const minted = await this.#brokered(
        cloud,
        "installation-token",
      )(
        new Request(installationTokenEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ installationId: refresh.installationId }),
        }),
      );
      const answer: unknown = await minted.json().catch(() => null);
      if (!minted.ok || !isRecord(answer) || typeof answer.token !== "string" || !answer.token)
        throw new Error(`${refresh.kind}: the Cloud answered ${minted.status} with no token`);
      return answer.token;
    }
    const material = isRecord(record.material) ? record.material : {};
    if (typeof material.appId !== "string" || typeof material.privateKey !== "string")
      throw new Error(`${refresh.kind}: the secret's material holds no "appId" and "privateKey"`);
    const clientSecretOf = this.#clientSecretOf(path);
    const app = {
      appId: await clientSecretOf(material.appId, refresh.apiOrigin),
      privateKey: await clientSecretOf(material.privateKey, refresh.apiOrigin),
    };
    // GitHub hands out PKCS#1 keys; @octokit/auth-app signs with WebCrypto here, which takes PKCS#8
    const privateKey = createPrivateKey(app.privateKey).export({ type: "pkcs8", format: "pem" });
    const { token: jwt } = await createAppAuth({
      appId: app.appId,
      privateKey: String(privateKey),
    })({
      type: "app",
    });
    const response = await pinnedDispatch(
      new Request(
        `${refresh.apiOrigin}/app/installations/${encodeURIComponent(refresh.installationId)}/access_tokens`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${jwt}`,
            "user-agent": "iterate",
          },
        },
      ),
    );
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(data) || typeof data.token !== "string" || !data.token)
      throw new Error(`${refresh.kind}: GitHub answered ${response.status} with no token`);
    return data.token;
  }
}

// A hostile project may set it to anything: shown as a claim, never checked.
function claimedOrigin(cause: string | null): string | undefined {
  if (!cause) return undefined;
  try {
    const { parent, chain } = JSON.parse(cause) as { parent?: unknown; chain?: unknown };
    if (typeof parent === "string") return parent.slice(0, 200);
    if (typeof chain === "string")
      return chain
        .replace(/^.*? with /, "")
        .replace(/ ~\S+$/, "")
        .slice(0, 200);
  } catch {
    // not the kernel's JSON
  }
  return cause.slice(0, 200);
}

const sentBefore = (digest: string) =>
  new HeldAnswer(
    409,
    "sent-before",
    `itx.fetch: this request (${digest}) was approved and sent once already; identical bytes are sent once`,
  );

const tooLarge = (path: string) =>
  `itx.fetch: a request with ${path} waits for approval, and its body may be at most ${HELD_BODY_LIMIT / 1024 / 1024} MiB`;

// `VAULT_ANSWER_HEADER` is the vault's alone: an upstream's copy goes. A 101 keeps its socket.
function answerOf(
  response: Response,
  facts: Facts,
  secrets: ReadonlySet<string>,
  own?: VaultAnswerKind,
): Response {
  const headers = new Headers(response.headers);
  let changed = response.headers.has(VAULT_ANSWER_HEADER) || Boolean(own);
  headers.delete(VAULT_ANSWER_HEADER);
  if (own) headers.set(VAULT_ANSWER_HEADER, own);
  for (const [name, value] of response.headers) {
    if (name === VAULT_ANSWER_HEADER) continue;
    let clean = value;
    for (const secret of secrets)
      // a shorter value would cut ordinary text, a length or a date, out of a header
      if (secret.length >= 8)
        for (const spelling of [secret, encodeURIComponent(secret)])
          clean = clean.replaceAll(spelling, "[redacted]");
    if (clean !== value) {
      headers.set(name, clean);
      changed = true;
    }
  }
  const answer = !changed
    ? response
    : response.webSocket
      ? new Response(null, { status: 101, webSocket: response.webSocket, headers })
      : new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
  return withFacts(
    answer,
    facts.filter(({ events }) => events.length),
  );
}

const UPSTREAM_ANSWER_MS = 50_000;

// No redirect is followed: it would carry a substituted secret to another origin. The runtime's own
// error quotes the URL, which may carry the secret. No abort signal: an upgrade's socket outlives it.
const dispatch = async (request: Request): Promise<Response> => {
  const { origin } = new URL(request.url);
  let overdue: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetch(request, { redirect: "manual" }),
      new Promise<Response>((answer) => {
        overdue = setTimeout(
          () =>
            answer(
              new Response(
                `itx.fetch: the pinned host ${origin} sent no answer within ${String(UPSTREAM_ANSWER_MS / 1000)} s\n`,
                { status: 504 },
              ),
            ),
          UPSTREAM_ANSWER_MS,
        );
      }),
    ]);
  } catch {
    throw new SecretRefused(`itx.fetch: the pinned host ${origin} could not be reached`);
  } finally {
    clearTimeout(overdue);
  }
};
