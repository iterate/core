// src/secret/durable-object.ts — THE SECRET: the `secret` facet on the context at `/secrets/<name>`
// (contract.ts says whose the material is: the log's, sealed in its facts). This facet is the one
// code that opens the current cell and sees the material in the clear: `fetch(request)`. Its own
// storage holds only the in-flight bookkeeping: the pending OAuth attempt, a held exchange, lends. A request naming this secret arrives from a context's egress
// (iterate-context-durable-object.ts `#egress`: forwarded to this path, and there to this facet), the
// placeholder is substituted HERE, the pin checked, the request dispatched — and when the pinned host
// answers 401, or the material has no `accessToken` yet, the refresh strategy re-mints in this same
// trusted code and the request is retried ONCE. One facet = one writer: a rotating refresh token is
// never raced by two contexts. A WebSocket upgrade is a dispatch like any other: the 101 and its
// socket ride the fetch channel back through the parent to the caller — this facet HOLDS no socket,
// it dials one and hands it back, so the socket lives as long as the dial does (measured 2026-09-21,
// test/vitest/os-workers/facets.test.ts: the frames round-trip; the facet's abort
// closes it, 1006). The one exception is an upgrade whose FRAMES carry the credential (Discord's
// IDENTIFY; secrets.ts `SECRET_FRAMES_HEADER`): this facet holds the upstream socket and pumps
// frames, substituting its placeholder in client text frames (`proxyFrames`,
// test/vitest/os-workers/secret-sockets-over-lends.test.ts).
//
// The verbs `itx.secrets` runs (context/built-ins.ts — ON THIS PATH, so the log's order is the
// value's, and through the facet host's platform entry: a caller's itx expression reaches the reads
// alone, `publicMethods`): `seal(record)` answers the cell the built-in's `secret/set` carries, and
// `clear()` forgets the bookkeeping; the FACTS (`secret/set`, `secret/deleted`, on this path and
// cross-posted to the owner's root) are the built-in's, attributed to the caller — a facet's own
// appends speak for the project, so only its own outcomes are made here.
// `beginOAuth` keeps the pending attempt and hands back the authorize URL; `completeOAuth` exchanges
// the code into the record (secret-oauth.ts). A client secret another of the owner's secrets holds is
// read from that secret's facet at the exchange and at every refresh (`clientSecretFor`), never
// stored here. The deployment's own app at a provider (an integration's
// `client: { platform }`, ITERATE `integrations.<provider>`) is attached here, where ITERATE is,
// and only ever toward that app's own provider; a project's own app is this secret's material. The
// two facts this facet appends itself, best-effort:
// `secret/used` per dispatch and `secret/refreshed` per refresh outcome. It hosts the secret processor
// (processor.ts): `snapshot()` says whether material was set and whether the secret was deleted, by
// the offsets of the facts that say so. Hosted from `ctx.exports` (first-party-facets.ts): ordinary
// bundled worker code with the worker's real env — the at-rest key and the signing secret among it.
// A secret refreshed by EXCHANGE CODE (`refresh: { kind: "worker", source }`) is the one place loaded
// code runs under this facet, in its jail (exchange-jail.ts): no env, the pin as its only egress.

import { createPrivateKey } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { EventInput } from "iterate/stream/processor";
import type {
  SecretEqualsVerification,
  SecretHmacVerification,
  SecretMaterial,
  SecretRefresh,
  SealedSecretCell,
} from "iterate/api";
import { codedError, jsonEqual, reportIssue, resolveContextPath } from "iterate/lib";
import { signClaims, verifyAdminSecret } from "../caller.ts";
import {
  iterateConfigOf,
  atRestKeysOf,
  sessionSigningSecretOf,
  type IterateConfigEnv,
} from "../iterate-config.ts";
import { contextStub } from "../context-stub.ts";
import { DurableObjectNameCodec, pathUnderOwner, resourceScope } from "../context/paths.ts";
import { DROPPED_CLOSE_CODE, relayedCloseCode } from "../context/websocket-close.ts";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { ControlPlane } from "../control-plane/edge.ts";
import type { IterateContextDurableObject } from "../iterate-context-durable-object.ts";
import { MOVE_OFFER_TTL_MS, type HeldToken } from "../integrations/connections.ts";
import { grantedScopesOf, lendVerdict, slackTeamOfTokenResponse } from "../integrations/rules.ts";
import { xEndpointsOf } from "../integrations/x.ts";
import { googleEndpointsOf } from "../integrations/google.ts";
import { githubApiOriginOf } from "../integrations/github.ts";
import { cloudflareEndpointsOf } from "../integrations/cloudflare.ts";
import {
  decryptSecretMaterial,
  encryptSecretMaterial,
  type EncryptedMaterial,
  type MaterialKeys,
} from "../secret-at-rest.ts";
import {
  accountOf,
  beginSecretOAuth,
  completeSecretOAuth,
  SECRET_OAUTH_TTL_MS,
  secretOAuthCallbackPathOf,
  type NormalizedSecretOAuthOptions,
  type PendingSecretOAuth,
  type SecretOAuthState,
} from "../secret-oauth.ts";
import {
  clientSecretReferenceOf,
  isRecord,
  LEND_USE_HEADER,
  LENT_AS_HEADER,
  oauthTokenRequest,
  oauthTokensOf,
  originPinned,
  pinRefusal,
  SecretRefused,
  refreshSecretMaterial,
  SECRET_FRAMES_HEADER,
  secretMaterialStringOf,
  secretPathsIn,
  signLendUse,
  substituteProjectSecrets,
  substituteSecretInFrame,
  verifySecretEquals,
  verifySecretHmac,
  type SecretRecord,
} from "../secrets.ts";
import {
  SecretContract,
  type LendRevokedReason,
  type SecretRefreshKind,
  type SecretState,
} from "./contract.ts";
import { runExchangeCode } from "./exchange-jail.ts";
import {
  SecretKeyAgreement,
  SecretKeyField,
  SecretKeySignature,
  x25519PublicKey,
  x25519SharedSecret,
  x25519Sign,
} from "./key-ops.ts";
import { SecretProcessor } from "./processor.ts";

/** The deployment's apps a strategy names as its client (`{ platform }`, secrets.ts). */
type OAuthPlatform = NonNullable<
  Extract<SecretRefresh, { kind: "oauth-refresh-token" }>["client"]
>["platform"];

/** THE CURRENT MATERIAL, as the reduce keeps it: the offset of the write that put it there and the
 *  sealed cell that fact carried. The offset is what a refresh and a code exchange are fenced on
 *  (processor.ts says how a write that landed meanwhile wins). `pending` is the OAuth attempt in
 *  flight; `completed` the last one finished (its nonce and the nonce of the cell it wrote), so its
 *  callback completes idempotently instead of exchanging twice. */
type Material = {
  /** The fact the current cell came in on: a set, or the mint or reseal that followed it. */
  offset: number;
  /** The write that began it (`setAt`, contract.ts): what an attempt is fenced on. */
  setAt: number;
  /** The nonce of the cell that write carried: whether a write this facet sealed is the one. */
  setNonce?: string;
  cell: SealedSecretCell;
};

/** THE OAUTH ATTEMPT IN FLIGHT (storage `pending`): what `beginOAuth` began, and the write
 *  lineage it began on (`setAt`). A write since ends it: `written` drops it, and its exchange
 *  refuses to land over the write; a mint or a reseal meanwhile is no write. */
type PendingAttempt = PendingSecretOAuth & { basedOn: number | null };

/** A MINT WHOSE FACT HAS YET TO LAND (storage `minted`): the cell `#doRefresh` sealed, and the
 *  write it refreshed. A provider may have rotated the refresh token on that mint, so the cell is
 *  kept until its `secret/refreshed` lands (`#material` lands it on the next read) or a write
 *  supersedes it (`written`, or a newer offset). */
type Minted = { cell: SealedSecretCell; basedOn: number; kind: SecretRefreshKind };

/** A cell from before the facts carried them (storage `stored`): the record sealed and bound to a
 *  write counter. Opened once and sealed again with a nonce on its first read (`#material`), then
 *  forgotten. */
type LegacyStored = {
  record: Omit<SecretRecord, "material"> & { material: EncryptedMaterial };
  revision: number;
};

/** A CONSENT'S EXCHANGE HELD ASIDE (storage `held`): iterate's Slack app's token for a workspace
 *  another project's connection holds, never on the log (`completeOAuth`'s gate) — it waits,
 *  unused, until that workspace's move here admits it (`admitHeldToken`), before `until`. Its
 *  material sealed like a fact's, with the material's offset as it stood (`basedOn`): any write
 *  since (`seal`, `clear`, a new `beginOAuth`) drops it, and so do the move's failure
 *  (`dropHeldToken`) and its expiry (`revive`, on the context's alarm). */
type HeldExchange = {
  cell: SealedSecretCell;
  basedOn: number | null;
  nonce: string;
  scopes: string[];
  until: number;
  team: { id: string; name: string };
};

/** THE LAST OAUTH ATTEMPT FINISHED (storage `completed`): its nonce, the cell it sealed and the
 *  material's offset as it stood (`basedOn`), the scopes granted, and whether the attempt was begun
 *  with the project's own redirect. The cell is kept here until its fact lands: a replay answers
 *  it again while it is the material, or while nothing landed since the attempt started (its fact
 *  was refused, and the replay lands it); once a write landed in between, the replay is refused. */
type Completed = {
  nonce: string;
  cell: SealedSecretCell;
  basedOn: number | null;
  scopes: string[];
  account?: { id: string; name: string | null };
  userspaceRedirect?: boolean;
};

/** THE LENDS of this secret (storage `lends`), by lend id: the project it is lent to (or
 *  `every-project`) and the path it is lent as there. A revoked lend is gone. A lend to every project
 *  keeps each project that borrows it under its own key (`borrowerKey`), so a revocation reaches
 *  them all and one project's return ends the lend for it alone. */
type Lends = Record<string, { to: string; as: string }>;

/** A project that borrows a lend to every project: its storage key. */
const borrowerKey = (lendId: string, projectId: string) => `borrower:${lendId}:${projectId}`;

/** The lends a `clear` or an `endLend` ended, each with the projects it reached. */
type EndedLends = Record<string, { to: string; as: string; borrowers: string[] }>;

/** THE LENDS ENDED HERE WHOSE OTHER SIDE IS NOT DONE (storage `ending`): each one's fact and the
 *  projects it reached still to be told (context/built-ins.ts `finishEndedLend`), kept until they are,
 *  so a retry of the revocation or the delete that ended it finishes it. Admission refuses them:
 *  they are no longer in `lends`. */
type EndingLends = Record<
  string,
  { to: string; as: string; borrowers: string[]; reason: LendRevokedReason }
>;

/** A BORROWED secret's record (storage `borrowed`, instead of `stored`): the lender's secret context
 *  (its Durable Object name), its path under the lender's root and the lend. No material. */
type Borrowed = { lender: string; lenderPath: string; lendId: string };

/** THE FIELDS A REFRESH STRATEGY MINTS into a secret's material (secrets.ts `refreshSecretMaterial`,
 *  `#githubInstallationToken`, exchange code's `accessToken`): a merge that changes the strategy
 *  drops them (`seal`). */
const MINTED_FIELDS: string[] = ["accessToken", "expiresAt"];

/** How long a use trusts an installation's route read for an earlier use (`#assertInstallationRouted`):
 *  the most a project that lost an installation keeps using a token it had minted. */
const INSTALLATION_ROUTE_RECHECK_MS = 30_000;

export class SecretFacet extends StreamProcessorDurableObject<
  SecretState,
  {
    ITX?: ItxEntrypointService;
    DB: D1Database;
    ITERATE_CONTEXT: DurableObjectNamespace<IterateContextDurableObject>;
    LOADER: WorkerLoader;
  } & IterateConfigEnv,
  ItxEntrypointScope
> {
  /** The secret's READS alone — the current cell, and whether the secret was deleted, by the facts
   *  that say so. Everything else here is the platform's: `seal`, `clear`,
   *  `beginOAuth`, `completeOAuth`, `verifyHmac` and `clientSecretFor` are `itx.secrets`'s
   *  (context/built-ins.ts, whose verbs append the attributed facts), `fetch` is egress's and
   *  `exportForProjectSeed` the operator's native RPC — each reaches this facet through the facet
   *  host's platform entry. */
  static override publicMethods = [
    "snapshot",
    "liveSnapshot",
    "waitUntilProcessed",
    "deriveSharedSecret",
    "publicKeyOf",
    "signWithKey",
  ];

  processor = new SecretProcessor();

  /** The one refresh in flight, keyed by the revision it read (single-flight: N callers who 401
   *  together on the same material share ONE mint). A caller holding a NEWER revision — a write
   *  landed while a mint for the old material was running, and the fence will drop that mint — is
   *  never coalesced onto it: its own mint queues behind the running one. */
  #refreshing: { offset: number; promise: Promise<void> } | undefined;

  /** The one reseal in flight (`#reseal`), by the offset of the cell it reseals. */
  #resealing: { offset: number; promise: Promise<number> } | undefined;

  /** When each iterate-App installation's route to this project was last read for a use
   *  (`#assertInstallationRouted`), by installation id. */
  readonly #installationRouteReadAt = new Map<string, number>();
  /** When each iterate-Slack-app workspace's route was last read for a use (`#assertWorkspaceNotMoved`). */
  readonly #workspaceRouteReadAt = new Map<string, number>();

  /** This facet's identity, from its context's name (`ctx.props`, sdk/index.ts): the context, and
   *  the PATH THE PLACEHOLDER SPELLS — the context's path relative to the resource owner's root
   *  (context/paths.ts `resourceScope`): `/secrets/shop` for a project's `/secrets/shop` and for a
   *  user's `/users/<id>/secrets/shop` alike. */
  #address(): { context: string; path: string } {
    const context = this.ctx.props.iterateContextName;
    const { projectId, path } = DurableObjectNameCodec.parse(context);
    return { context, path: pathUnderOwner(resourceScope(projectId, path), path) };
  }

  /** THE CELL A WRITE CARRIES (`itx.secrets.set` puts it in its `secret/set`): the record whole —
   *  material always travels with its complete policy, so a value never inherits a pin or a strategy
   *  it was not set with — or, with `merge`, the record's fields over the current material's, under
   *  the same pin. What a strategy MINTED belongs to that strategy: a merge that changes or removes
   *  `refresh` drops it (`MINTED_FIELDS`), so a token minted under one strategy — an installation's,
   *  which its route guards — never outlives it under another, or under none. Nothing is kept or
   *  dropped here: the fact is the write, the reduce keeps its cell, and `written` cleans up once
   *  it landed, so a refused fact leaves everything as it was. */
  async seal(record: SecretRecord, merge = false): Promise<SealedSecretCell> {
    const current = merge ? await this.#material() : null;
    if (current) {
      const { cell } = current;
      // the pin travels with the material it guards: a merge never moves material elsewhere
      if ([...cell.urls].sort().join() !== [...record.urls].sort().join())
        throw new Error(`secrets: a merge keeps the pin ${cell.urls.join(", ")}`);
      const { record: opened } = await this.#open(current);
      const kept = isRecord(opened.material) ? { ...opened.material } : {};
      if (!jsonEqual(opened.refresh || null, record.refresh || null))
        for (const field of MINTED_FIELDS) delete kept[field];
      // the workspace a token is refused for travels with it, like the pin
      record = {
        ...record,
        material: { ...kept, ...(isRecord(record.material) && record.material) },
        routedAccount: opened.routedAccount,
      };
    }
    return this.#sealCell(record);
  }

  /** A WRITE LANDED at `offset` (the built-in's `secret/set` folded): what it supersedes goes — an
   *  OAuth attempt begun on older material, a token held on it (its callback must not write over
   *  this material), a mint of it whose fact had not landed, a cell from before the facts carried
   *  them, and a borrow (material of its own replaces the lender's, as the reduce says; `fetch`
   *  forwards on the borrow only while storage holds it). Each attempt, token or mint is fenced on
   *  the material's offset it began on, so one begun on this very write, in the moment since it
   *  became visible, stays; and one left behind by a crash in between dies on its own fence. */
  async written(input: { offset: number }): Promise<void> {
    const stale = (basedOn: number | null) => basedOn === null || basedOn < input.offset;
    const gone: string[] = ["stored", "revision", "borrowed"];
    const pending = await this.ctx.storage.get<PendingAttempt>("pending");
    if (pending && stale(pending.basedOn)) gone.push("pending");
    const held = await this.ctx.storage.get<HeldExchange>("held");
    if (held && stale(held.basedOn)) gone.push("held");
    const minted = await this.ctx.storage.get<Minted>("minted");
    if (minted && stale(minted.basedOn)) gone.push("minted");
    await this.ctx.storage.delete(gone);
  }

  /** The record as a fact carries it: the material encrypted under the deployment's key, bound to
   *  this context, the pin and a nonce minted for this one write. */
  async #sealCell(record: SecretRecord): Promise<SealedSecretCell> {
    const { context } = this.#address();
    const nonce = crypto.randomUUID();
    const material = await encryptSecretMaterial(
      record.material,
      { context, urls: record.urls, nonce },
      this.#keys(),
    );
    return {
      context,
      urls: record.urls,
      refresh: record.refresh,
      routedAccount: record.routedAccount,
      nonce,
      material,
    };
  }

  /** THE CURRENT MATERIAL: the cell the reduce keeps for the latest write, or null while none is
   *  stored (never set, deleted, or borrowed). A write from before the facts carried cells left its
   *  cell in storage, bound to a write counter: it is opened once, sealed again with a nonce, and
   *  put on the log as a `secret/resealed` of that write, so the log holds it from then on. */
  async #material(): Promise<Material | null> {
    const { state } = await super.snapshot();
    if (!state.material || state.borrowed) return null;
    const { setAt, setNonce } = state.material;
    // a mint whose fact did not land (`#doRefresh`): landed now, while the write it refreshed is
    // still the material, and the log read again for where it sits; stale once a write landed
    // since. A refused append (a paused stream) keeps the mint, and the material is the minted
    // cell on the write it refreshed — the tokens a provider rotated to, never the ones it
    // retired — until a read lands it.
    const minted = await this.ctx.storage.get<Minted>("minted");
    if (minted) {
      if (minted.basedOn !== state.material.offset) await this.ctx.storage.delete("minted");
      else {
        const landed = await this.#fact({
          type: "events.iterate.com/secret/refreshed",
          payload: { kind: minted.kind, ok: true, sealed: minted.cell, basedOn: minted.basedOn },
        });
        if (landed === null)
          return { offset: state.material.offset, setAt, setNonce, cell: minted.cell };
        await this.waitUntilProcessed({ offset: landed });
        await this.ctx.storage.delete("minted");
        return this.#material();
      }
    }
    if (state.material.sealed) {
      // a cell from before, superseded by one on the log, goes
      if (await this.ctx.storage.get("stored"))
        await this.ctx.storage.delete(["stored", "revision"]);
      return { offset: state.material.offset, setAt, setNonce, cell: state.material.sealed };
    }
    const legacy = await this.ctx.storage.get<LegacyStored>("stored");
    if (!legacy) return null;
    const { context, path } = this.#address();
    let opened: Awaited<ReturnType<typeof decryptSecretMaterial>>;
    try {
      opened = await decryptSecretMaterial(
        legacy.record.material,
        { context, urls: legacy.record.urls, revision: legacy.revision },
        this.#keys(),
      );
    } catch {
      throw new SecretRefused(
        `itx.fetch: the stored material of ${path} cannot be opened (a rotated key, or another context's record) — set the secret again`,
      );
    }
    const cell = await this.#sealCell({ ...legacy.record, material: opened.material });
    const landed = await this.#fact({
      type: "events.iterate.com/secret/resealed",
      payload: { sealed: cell, basedOn: state.material.offset },
    });
    if (landed === null) return { offset: state.material.offset, setAt, cell };
    await this.waitUntilProcessed({ offset: landed });
    await this.ctx.storage.delete(["stored", "revision"]);
    // the log says where the cell sits now (a write that landed first wins)
    return this.#material();
  }

  /** THE STATE, read by anyone the facet admits (the owner's `itx.cd(path).facets.get("secret")`,
   *  the Dash, a backup): a cell from before the facts carried them is put on the log first
   *  (`#material`), so every read of a secret's state is its migration, and an operator sweep that
   *  reads each secret's state migrates a deployment. */
  override async snapshot(): Promise<{ offset: number; state: SecretState }> {
    await this.#material();
    return super.snapshot();
  }

  /** The current record with its material in the clear, for this facet's own use only, and the
   *  offset its cell sits at now. A cell the previous key opened (a rotation in progress) is sealed
   *  again under the current key and put on the log as a `secret/resealed` of this write, so a
   *  rotation completes one read at a time: the offset answered is then the reseal's, which a
   *  mint of this read is fenced on. A cell neither key opens — one under a key that is gone, or
   *  bound elsewhere — is a refusal that names the fix. */
  async #open({ offset, cell }: Material): Promise<{ record: SecretRecord; offset: number }> {
    // THIS facet's address is the binding, never the cell's own claim: a cell copied from another
    // secret's log into a fact on this path does not open
    const { context, path } = this.#address();
    const binding = { context, urls: cell.urls, nonce: cell.nonce };
    let opened: Awaited<ReturnType<typeof decryptSecretMaterial>>;
    try {
      if (cell.context !== context) throw new Error("another context's cell");
      opened = await decryptSecretMaterial(cell.material, binding, this.#keys());
    } catch {
      throw new SecretRefused(
        `itx.fetch: the stored material of ${path} cannot be opened (a rotated key, or another context's record) — set the secret again`,
      );
    }
    const record: SecretRecord = {
      material: opened.material,
      urls: cell.urls,
      refresh: cell.refresh,
      routedAccount: cell.routedAccount,
    };
    if (opened.rotated) offset = await this.#reseal(offset, record);
    return { record, offset };
  }

  /** THE RESEAL of a rotated cell (`#open`): one per cell at a time, shared by every open of it
   *  meanwhile, so a second does not land a reseal the reduce would drop. Answers the offset the
   *  cell sits at once its fact landed, read from the log: the reseal's, or the one it began on
   *  when the fact was refused (a paused stream) or a write landed first and the reduce dropped it
   *  (whatever is fenced on that offset then drops too, and reads again). */
  #reseal(offset: number, record: SecretRecord): Promise<number> {
    const inFlight = this.#resealing;
    if (inFlight?.offset === offset) return inFlight.promise;
    const promise = (async () => {
      const cell = await this.#sealCell(record);
      const landed = await this.#fact({
        type: "events.iterate.com/secret/resealed",
        payload: { sealed: cell, basedOn: offset },
      });
      if (landed === null) return offset;
      await this.waitUntilProcessed({ offset: landed });
      const { state } = await super.snapshot();
      return state.material?.sealed?.nonce === cell.nonce ? state.material.offset : offset;
    })().finally(() => {
      if (this.#resealing?.promise === promise) this.#resealing = undefined;
    });
    this.#resealing = { offset, promise };
    return promise;
  }

  #keys(): MaterialKeys {
    return atRestKeysOf(iterateConfigOf(this.env));
  }

  /** Operator recovery exports the current cell as the log holds it (the seed is the operator's
   *  tool, scripts/os/project-seed.ts); the credential arrives over native RPC, never through
   *  project-authored rewrites. The same cell is on the secret's log for its owner to read. */
  async exportForProjectSeed(adminSecret: unknown) {
    if (
      typeof adminSecret !== "string" ||
      !(await verifyAdminSecret(adminSecret, iterateConfigOf(this.env).adminBearer.exposeSecret()))
    )
      throw codedError("FORBIDDEN", "Secret recovery exports require operator authority.");
    const current = await this.#material();
    if (!current)
      throw codedError("INVALID_INPUT", "This secret has no current material to back up.");
    const { path } = this.#address();
    return { path, ...current.cell };
  }

  /** Forget the bookkeeping of the material the built-in's `secret/deleted` drops: any attempt, a
   *  held exchange, the lends (ended, for the built-in to tell the other side) and a borrow. A
   *  mint or an exchange started before the delete names a write the fact superseded, so it cannot
   *  land after it (the reduce drops it), even under a new write. */
  async clear(): Promise<{ lends: EndedLends; borrowed: Borrowed | null }> {
    const lends: EndedLends = {};
    const ending = (await this.ctx.storage.get<EndingLends>("ending")) ?? {};
    for (const [lendId, lend] of Object.entries(
      (await this.ctx.storage.get<Lends>("lends")) ?? {},
    )) {
      lends[lendId] = { ...lend, borrowers: await this.#takeBorrowers(lendId, lend) };
      ending[lendId] = { ...lends[lendId]!, reason: "lender" };
    }
    const borrowed = (await this.ctx.storage.get<Borrowed>("borrowed")) ?? null;
    await this.ctx.storage.put<EndingLends>("ending", ending);
    await this.ctx.storage.delete([
      "stored",
      "revision",
      "pending",
      "held",
      "completed",
      "lends",
      "borrowed",
    ]);
    // what the clear ended, for the built-in to end on the other side (context/built-ins.ts `delete`)
    return { lends, borrowed };
  }

  /** The projects a lend reaches, forgotten here: a lend to every project's borrowers, or the one
   *  project it is lent to. */
  async #takeBorrowers(lendId: string, lend: { to: string }): Promise<string[]> {
    if (lend.to !== "every-project") return [lend.to];
    const prefix = borrowerKey(lendId, "");
    const keys = [...(await this.ctx.storage.list({ prefix })).keys()];
    for (let at = 0; at < keys.length; at += 128)
      await this.ctx.storage.delete(keys.slice(at, at + 128));
    return keys.map((key) => key.slice(prefix.length));
  }

  // ── LENDS: a person's account connected to a project, or the deployment's own secret (the
  // operator's) lent to projects — used by the project, the material never leaving this facet. The
  // platform's `connectToProject` or the operator's `itx.secrets.lend` keeps the lend here (`lend`)
  // and the borrower's path keeps only `{ lender, lendId }` (`borrow`); a use of the borrowed path is
  // forwarded to the lender's context over its `fetch` with the lend signed
  // (iterate-context-durable-object.ts `#lentFetch`), admitted here (`admitLend`:
  // integrations/rules.ts `lendVerdict`) and run by this facet's own dispatch (`fetch` with
  // `LENT_AS_HEADER`). The facts are the built-ins' (context/built-ins.ts).

  /** Keep a lend: the pin of the material it lends, for the borrower's catalog. */
  async lend(input: { lendId: string; to: string; as: string }): Promise<{ urls: string[] }> {
    const current = await this.#material();
    if (!current)
      throw codedError(
        "INVALID_INPUT",
        `${this.#address().path} holds no material of its own to lend`,
      );
    const lends = (await this.ctx.storage.get<Lends>("lends")) ?? {};
    await this.ctx.storage.put<Lends>("lends", {
      ...lends,
      [input.lendId]: { to: input.to, as: input.as },
    });
    return { urls: current.cell.urls };
  }

  /** The live lend of this secret to `projectId`, as `as`, or null: a person's account connected to
   *  that project already (context/built-ins.ts `connectToProject`, which keeps it again). */
  async lendOf(projectId: string, as: string): Promise<{ lendId: string } | null> {
    const lends = (await this.ctx.storage.get<Lends>("lends")) ?? {};
    const lendId = Object.keys(lends).find(
      (id) => lends[id]!.to === projectId && lends[id]!.as === as,
    );
    return lendId ? { lendId } : null;
  }

  /** The lend this path borrows, or null (context/built-ins.ts `dropLend`). */
  async borrowedLendId(): Promise<string | null> {
    return (await this.ctx.storage.get<Borrowed>("borrowed"))?.lendId ?? null;
  }

  /** A project borrows a lend to every project (`borrowed`), or its borrow failed and it does not
   *  (`!borrowed`). The lend and the path it is lent as, or null when the lend is gone. */
  async everyProjectBorrower(
    lendId: string,
    projectId: string,
    borrowed: boolean,
  ): Promise<{ as: string; urls: string[] } | null> {
    const lend = ((await this.ctx.storage.get<Lends>("lends")) ?? {})[lendId];
    const current = await this.#material();
    if (!lend || lend.to !== "every-project" || !current) return null;
    if (borrowed) await this.ctx.storage.put(borrowerKey(lendId, projectId), true);
    else await this.ctx.storage.delete(borrowerKey(lendId, projectId));
    return { as: lend.as, urls: current.cell.urls };
  }

  /** The lend ended: what it was and the projects it ended for, or null when it is already gone. A
   *  `borrower` named (the borrower's own delete) must be the one it was lent to — or, a lend to
   *  every project, ends for that project alone and the lend stands. */
  async endLend(
    lendId: string,
    borrower?: string,
    reason: LendRevokedReason = "lender",
  ): Promise<{ to: string; as: string; borrowers: string[] } | null> {
    const { [lendId]: lend, ...rest } = (await this.ctx.storage.get<Lends>("lends")) ?? {};
    if (!lend) return null;
    if (borrower && lend.to === "every-project") {
      if (!(await this.ctx.storage.get(borrowerKey(lendId, borrower)))) return null;
      await this.ctx.storage.delete(borrowerKey(lendId, borrower));
      return { ...lend, borrowers: [borrower] };
    }
    if (borrower && lend.to !== borrower) throw new Error("this lend is to another project");
    const ended = { ...lend, borrowers: await this.#takeBorrowers(lendId, lend) };
    const ending = (await this.ctx.storage.get<EndingLends>("ending")) ?? {};
    await this.ctx.storage.put<EndingLends>("ending", {
      ...ending,
      [lendId]: { ...ended, reason },
    });
    await this.ctx.storage.put<Lends>("lends", rest);
    return ended;
  }

  /** The lends ended here whose other side is not done yet (`EndingLends`). */
  async endingLends(): Promise<EndingLends> {
    return (await this.ctx.storage.get<EndingLends>("ending")) ?? {};
  }

  /** A lend's end is done on every side: forgotten — or, with projects still `untold`, kept with
   *  them alone, for a retry. */
  async finishEndingLend(lendId: string, untold: string[] = []): Promise<void> {
    const { [lendId]: ended, ...rest } = (await this.ctx.storage.get<EndingLends>("ending")) ?? {};
    await this.ctx.storage.put<EndingLends>(
      "ending",
      ended && untold.length ? { ...rest, [lendId]: { ...ended, borrowers: untold } } : rest,
    );
  }

  /** This path borrows: it holds the lend alone, and every use is forwarded to the lender. */
  async borrow(borrowed: Borrowed): Promise<void> {
    // coded: a lend to every project skips a project that keeps its own (built-ins.ts `lendInto`)
    if (await this.#material())
      throw codedError(
        "INVALID_INPUT",
        `${this.#address().path} holds a secret of its own — delete it first`,
      );
    // one lend per path: a second would leave the first live at its lender, unseen
    const held = await this.ctx.storage.get<Borrowed>("borrowed");
    if (held && held.lendId !== borrowed.lendId)
      throw new Error(`${this.#address().path} borrows another lend already — delete it first`);
    await this.ctx.storage.put<Borrowed>("borrowed", borrowed);
  }

  /** The lend this path borrows ended at the lender: forget it. False when this path borrows
   *  another lend, or none. */
  async dropBorrowed(lendId: string): Promise<boolean> {
    const borrowed = await this.ctx.storage.get<Borrowed>("borrowed");
    if (borrowed?.lendId !== lendId) return false;
    await this.ctx.storage.delete("borrowed");
    return true;
  }

  /** Whether `borrower` may use this secret under the lend: the path it borrows as, or why not. */
  async admitLend(input: {
    lendId: string;
    borrower: string;
  }): Promise<{ as: string } | { refused: string; revoke?: "membership-ended" }> {
    const lend = ((await this.ctx.storage.get<Lends>("lends")) ?? {})[input.lendId] ?? null;
    const { projectId, path } = DurableObjectNameCodec.parse(this.#address().context);
    const owner = resourceScope(projectId, path);
    const borrowing =
      lend?.to === "every-project" &&
      Boolean(await this.ctx.storage.get(borrowerKey(input.lendId, input.borrower)));
    const lender =
      owner.kind === "global"
        ? ("instance" as const)
        : {
            reachesBorrower:
              lend?.to === input.borrower &&
              owner.kind === "users" &&
              (await new ControlPlane(this.env).reachesProject(
                { userId: owner.ownerId },
                input.borrower,
              )),
          };
    return lendVerdict({ lend, borrower: input.borrower, borrowing, lender });
  }

  /** THE VERIFY OPERATION (for webhooks): is `signature` the HMAC-SHA256
   *  of `payload` under this secret's material? The material is opened HERE and the answer is one
   *  bit — nothing comes out, and no request goes anywhere, so the pin is not consulted. The
   *  candidate arrives from an unauthenticated caller (a webhook): a secret never set, or a material
   *  with no key at the field, answers false rather than describing itself; the comparison is
   *  constant-time. */
  async verifyHmac(input: SecretHmacVerification): Promise<boolean> {
    const current = await this.#material();
    if (!current) return false;
    const { material } = (await this.#open(current)).record;
    return verifySecretHmac(material, input);
  }

  /** THE EQUALS OPERATION: is `value` this secret's string (at `field`)? Opened HERE, one bit out,
   *  the pin not consulted, exactly as `verifyHmac`: a secret never set or a material with no string
   *  at the field answers false, and the comparison is constant-time. */
  async verifyEquals(input: SecretEqualsVerification): Promise<boolean> {
    const current = await this.#material();
    if (!current) return false;
    const { material } = (await this.#open(current)).record;
    return verifySecretEquals(material, input);
  }

  /** DIFFIE-HELLMAN with one of this secret's stored private keys (key-ops.ts): userspace runs its
   *  protocol itself (e.g. the Noise and Signal agreements of a WhatsApp device) and calls this for
   *  each agreement that uses a stored key. `field` names the 32-byte X25519 private in the material
   *  (e.g. "noiseKey.private"); the private never leaves — only the shared secret of it and
   *  `peerPublicHex` does. */
  async deriveSharedSecret(input: unknown): Promise<string> {
    const { field, peerPublicHex } = SecretKeyAgreement.parse(input);
    const priv = this.#privateAt(await this.#materialRecord(), field);
    return Buffer.from(await x25519SharedSecret(priv, Buffer.from(peerPublicHex, "hex"))).toString(
      "hex",
    );
  }

  /** The public key of one of this secret's stored private keys, so userspace can place a device
   *  public on the wire without the material having to carry it. */
  async publicKeyOf(input: unknown): Promise<string> {
    const { field } = SecretKeyField.parse(input);
    return Buffer.from(
      await x25519PublicKey(this.#privateAt(await this.#materialRecord(), field)),
    ).toString("hex");
  }

  /** XEdDSA sign a message with one of this secret's stored private keys (key-ops.ts): userspace
   *  builds the message (e.g. the account details a WhatsApp device's identity key signs at pairing)
   *  and gets back only the 64-byte signature, never the key. */
  async signWithKey(input: unknown): Promise<string> {
    const { field, messageHex } = SecretKeySignature.parse(input);
    const priv = this.#privateAt(await this.#materialRecord(), field);
    return Buffer.from(x25519Sign(priv, Buffer.from(messageHex, "hex"))).toString("hex");
  }

  /** This secret's object material in the clear, or a refusal when it holds none — a borrowed secret
   *  keeps no material here. */
  async #materialRecord(): Promise<Record<string, unknown>> {
    const current = await this.#material();
    if (!current) throw codedError("SECRET_NOT_SET", "key-ops: this secret holds no key material");
    const { material } = (await this.#open(current)).record;
    if (!isRecord(material))
      throw codedError("INVALID_INPUT", "key-ops: material is not an object of key fields");
    return material;
  }

  /** The 32-byte X25519 private at a dotted `field` of the material (e.g. "noiseKey.private"). */
  #privateAt(material: Record<string, unknown>, field: string): Uint8Array {
    let node: unknown = material;
    for (const part of field.split(".")) node = isRecord(node) ? node[part] : undefined;
    if (typeof node !== "string")
      throw codedError("INVALID_INPUT", `key-ops: material has no hex key at "${field}"`);
    return Buffer.from(node, "hex");
  }

  /** OAUTH, step one: keep the pending attempt, hand back the authorize URL. The `state` is a
   *  platform-signed claim naming this context, a nonce only this attempt knows and `next`; the
   *  redirect URI is the platform's callback for the client, or the project's own page
   *  (`redirectUri`, secret-oauth.ts), which the built-in composed under the project's ingress. A new
   *  attempt replaces an unfinished one; the record, if any, stays until the exchange writes over
   *  it. Nothing lands on any log until the exchange succeeds — an abandoned attempt leaves no
   *  trace. */
  async beginOAuth(
    options: NormalizedSecretOAuthOptions,
    /** the platform origin the callback hangs under — the caller's (a facet knows none itself) */
    platformOrigin: string,
  ): Promise<{ authorizationUrl: string; nonce: string }> {
    const config = iterateConfigOf(this.env);
    const nonce = crypto.randomUUID();
    const state: SecretOAuthState = {
      kind: "secret-oauth",
      context: this.#address().context,
      nonce,
      exp: Date.now() + SECRET_OAUTH_TTL_MS,
      next: options.next,
    };
    const { clientId, clientSecret } = this.#oauthClientOf(options);
    // a placeholder that cannot resolve is refused now, before a human is sent to consent
    await this.#clientSecretOf(clientSecret, options.tokenEndpoint);
    const { pending, authorizationUrl } = await beginSecretOAuth(
      { ...options, clientId },
      {
        redirectUri:
          options.redirectUri || `${platformOrigin}${secretOAuthCallbackPathOf(options.client)}`,
        state: await signClaims(state, await sessionSigningSecretOf(config)),
        nonce,
      },
    );
    // a new attempt replaces the one in flight: an exchange started before it finds no pending
    // attempt of its nonce when it comes to write (`completeOAuth`'s fence)
    await this.ctx.storage.put<PendingAttempt>("pending", {
      ...pending,
      basedOn: (await this.#material())?.setAt ?? null,
    });
    await this.ctx.storage.delete("held");
    // the nonce names this attempt to whoever finishes it (integrations/verbs.ts): the callback
    // carries it, signed, in `state`
    return { authorizationUrl, nonce };
  }

  /** The OAuth client an attempt exchanges with: the one passed in the clear, or the deployment's
   *  app (`{ platform }`), refused toward any endpoint but its own provider's — the exchange, and
   *  every refresh after it, would carry its secret there. */
  #oauthClientOf(options: {
    client: NormalizedSecretOAuthOptions["client"] | { platform: OAuthPlatform };
    clientId: string;
    clientSecret: string;
    authorizationEndpoint?: string;
    tokenEndpoint: string;
  }): { clientId: string; clientSecret: string } {
    const { client } = options;
    if (!client) return { clientId: options.clientId, clientSecret: options.clientSecret };
    const app = this.#platformOAuthApp(client.platform);
    for (const endpoint of [options.authorizationEndpoint, options.tokenEndpoint])
      if (endpoint && !app.origins.includes(new URL(endpoint).origin))
        throw new Error(
          `secrets: the platform's ${client.platform} app is at ${app.origins.join(", ")} — not ${new URL(endpoint).origin}`,
        );
    return { clientId: app.clientId, clientSecret: app.clientSecret };
  }

  /** The deployment's app at a provider (ITERATE `integrations.<provider>`) and the origins its
   *  provider's OAuth endpoints answer on; refused when the deployment has none. GitHub's is the
   *  App's user-authorization client (a GitHub sign-in's token refreshes with it). */
  #platformOAuthApp(provider: OAuthPlatform) {
    const { slack, google, cloudflare, github, x } = iterateConfigOf(this.env).integrations;
    const googleEndpoints = googleEndpointsOf(google?.googleOrigin);
    const app =
      provider === "x"
        ? x && {
            app: x,
            origins: [
              new URL(xEndpointsOf(x.xOrigin).authorizationEndpoint).origin,
              new URL(xEndpointsOf(x.xOrigin).tokenEndpoint).origin,
            ],
          }
        : provider === "slack"
          ? slack && { app: slack, origins: [slack.slackOrigin] }
          : provider === "google"
            ? google && {
                app: google,
                origins: [
                  ...new Set(
                    [googleEndpoints.authorizationEndpoint, googleEndpoints.tokenEndpoint].map(
                      (endpoint) => new URL(endpoint).origin,
                    ),
                  ),
                ],
              }
            : provider === "cloudflare"
              ? cloudflare && {
                  app: cloudflare,
                  origins: [
                    new URL(cloudflareEndpointsOf(cloudflare.cloudflareOrigin).tokenEndpoint)
                      .origin,
                  ],
                }
              : github && { app: github, origins: [github.githubOrigin] };
    if (!app)
      throw new Error(
        `secrets: this deployment has no ${provider} app (ITERATE integrations.${provider} is unset)`,
      );
    return {
      clientId: app.app.oauthClientId,
      clientSecret: app.app.oauthClientSecret.exposeSecret(),
      origins: app.origins,
    };
  }

  /** THE CLIENT SECRET AS SENT to `tokenEndpoint` by the code exchange and every refresh: the one
   *  held, or, when it is a placeholder (secrets.ts `clientSecretReferenceOf`), the value the secret
   *  it names holds now. That secret is under this one's owner, never this one, and answers only
   *  for an origin it is pinned to (`clientSecretFor`). The value is read at each request and
   *  stored nowhere here, so a rotation takes effect at the next one. */
  readonly #clientSecretOf = async (clientSecret: string, tokenEndpoint: string) => {
    const reference = clientSecretReferenceOf(clientSecret);
    if (!reference) return clientSecret;
    const { context, path } = this.#address();
    if (reference.path === path)
      throw codedError(
        "INVALID_INPUT",
        `secrets: the client secret getSecret("${reference.path}") names ${path} itself — collect the client secret into a secret of its own`,
      );
    const { projectId, path: contextPath } = DurableObjectNameCodec.parse(context);
    const owner = resourceScope(projectId, contextPath);
    const address = DurableObjectNameCodec.address({
      projectId,
      path: resolveContextPath(owner.rootPath, `.${reference.path}`),
    });
    const input = { origin: new URL(tokenEndpoint).origin, field: reference.field };
    // The platform-only built-in answers the named secret's facet's `clientSecretFor`: a string.
    return (await contextStub(this.env.ITERATE_CONTEXT, address, "secret.client-secret").invoke(
      ["itx", "builtins", "secrets", ["clientSecretFor", reference.path, input]],
      [],
      { principal: null, platform: true },
    )) as string;
  };

  /** A CLIENT SECRET THIS SECRET HOLDS, for another secret's token request to `origin`
   *  (`#clientSecretOf`, over the platform-only `itx.secrets.clientSecretFor`) or a webhook's
   *  signature to it (context/built-ins.ts `webhookSigningKey`): the value, or the
   *  string at `field` of a JSON one, while `origin` is in the pin, which binds this use as it binds
   *  every other. Only material of its own: a borrowed secret is refused. Never in `publicMethods`. */
  async clientSecretFor(input: { origin: string; field?: string }): Promise<string> {
    const { path } = this.#address();
    const current = await this.#material();
    if (!current)
      throw codedError(
        "INVALID_INPUT",
        (await this.ctx.storage.get<Borrowed>("borrowed"))
          ? `secrets: ${path} is borrowed — a client secret is one of the owner's own secrets`
          : `secrets: ${path} holds no secret — collect the client secret there first (itx.secrets.collectFromUser)`,
      );
    if (!originPinned(input.origin, current.cell.urls))
      throw codedError(
        "INVALID_INPUT",
        `secrets: the secret ${path} is pinned to ${current.cell.urls.join(", ")}, not ${input.origin} — the token endpoint's origin — so it is never sent there as a client secret`,
      );
    let record: SecretRecord;
    try {
      record = (await this.#open(current)).record;
      await this.#assertInstallationRouted(record.refresh);
      await this.#assertWorkspaceNotMoved(record.routedAccount);
    } catch (error) {
      // the refusals egress answers 502 are this caller's expected outcomes too
      if (!(error instanceof SecretRefused)) throw error;
      throw codedError("INVALID_INPUT", error.message.replace(/^itx\.fetch: /, "secrets: "));
    }
    const value = secretMaterialStringOf(record.material, input.field);
    if (value) return value;
    throw codedError(
      "INVALID_INPUT",
      input.field
        ? `secrets: ${path} has no string at field "${input.field}"`
        : typeof record.material === "string"
          ? `secrets: ${path} is empty`
          : `secrets: ${path} is a JSON object: name its field, getSecret("${path}", { field: "…" })`,
    );
  }

  /** OAUTH, step two (the callback, through `itx.secrets.completeOAuth` on this path): the code for
   *  the pending attempt the nonce names → the exchange → the record, as a write. A stale or foreign
   *  callback (a back button, an older authorize URL, a replay with a junk code) fails without
   *  touching the live attempt; the attempt is consumed only when its exchange succeeds. The
   *  exchange lands only if nothing else wrote this facet while the provider was answering: a write
   *  or a clear in that window wins and the tokens are discarded (from the fence to the completion
   *  mark only storage awaits follow, which the input gate holds together). Answers the pin and the
   *  strategy kind the record was stored with — what the fact carries; never the material. IDEMPOTENT for the attempt
   *  it completed: the same callback again (a refreshed tab, or the built-in retrying after its fact
   *  append failed) runs no second exchange and answers the same pin, as long as the record is still
   *  the one this attempt wrote — so the log can always catch up with a live facet. `held` says the
   *  record was NOT written: iterate's Slack app's token for a
   *  workspace another project holds waits aside (`HeldExchange`) — the same callback again answers
   *  it again. `viaPlatformCallback` is the platform callback's own mark: project code (a page of
   *  the project's, through `itx.secrets.completeOAuth`) completes only an attempt begun with its
   *  own `redirectUri`, never a deployment app's, whose finish routes accounts and offers moves
   *  (secret-oauth-callback.ts). */
  async completeOAuth(input: {
    code: string;
    nonce: string;
    viaPlatformCallback?: boolean;
  }): Promise<{
    urls: string[];
    refresh?: SecretRefresh["kind"];
    scopes: string[];
    account?: { id: string; name: string | null };
    held?: HeldToken;
    /** The record written, sealed: what the built-in's `secret/set` carries (a replay whose fact
     *  was refused answers the same cell, so the retried fact carries it). Absent for a held
     *  token, and for a replay whose fact landed: nothing lands again. */
    sealed?: SealedSecretCell;
  }> {
    // project code completes only an attempt begun with its own redirectUri — a replay of one the
    // platform's callback completed, and a held exchange, are the callback's as much as the attempt
    const projectCodeRefused = () =>
      codedError(
        "FORBIDDEN",
        "secrets.completeOAuth: this attempt comes back to the platform's callback, which completes it — only an attempt begun with redirect is completed from a page of the project's",
      );
    const replayed = await this.#completed(input.nonce);
    if (replayed) {
      if (!input.viaPlatformCallback && !replayed.userspaceRedirect) throw projectCodeRefused();
      const { userspaceRedirect: _userspace, ...answer } = replayed;
      return answer;
    }
    const kept = await this.ctx.storage.get<HeldExchange>("held");
    // a token held before the facts carried cells has no cell to admit: that consent starts over
    if (kept && !kept.cell) await this.ctx.storage.delete("held");
    if (kept?.cell && kept.nonce === input.nonce && kept.until > Date.now()) {
      if (!input.viaPlatformCallback) throw projectCodeRefused();
      return {
        urls: kept.cell.urls,
        refresh: kept.cell.refresh?.kind,
        scopes: kept.scopes,
        held: { externalId: kept.team.id, account: kept.team.name, until: kept.until },
      };
    }
    const pending = await this.ctx.storage.get<PendingAttempt>("pending");
    if (!pending || pending.nonce !== input.nonce)
      throw new Error("no pending attempt matches this callback — begin again");
    if (pending.until <= Date.now()) {
      await this.ctx.storage.delete("pending");
      throw new Error("the attempt expired — begin again");
    }
    if (!input.viaPlatformCallback && !pending.options.redirectUri) throw projectCodeRefused();
    // the write lineage as it stands when the exchange starts: what the write is fenced against
    // (a mint or a reseal meanwhile is no write). An attempt begun before a write landed is over,
    // whether or not `written` dropped it.
    const startedOn = (await this.#material())?.setAt ?? null;
    if (pending.basedOn !== startedOn) {
      await this.ctx.storage.delete("pending");
      throw new Error("the secret was changed since this attempt began — begin again");
    }
    const credentials = this.#oauthClientOf(pending.options);
    // What the provider says it granted, and the Slack workspace, off the token response (rules.ts).
    let scopes: string[] = [];
    const answered: { team: ReturnType<typeof slackTeamOfTokenResponse> } = { team: null };
    const { client, expectAccount } = pending.options;
    // The account the tokens are for, named by an endpoint rather than the token response: the
    // caller's `account` (a client of the project's own), or X's /2/users/me for the deployment's
    // X client, which has no ID token (https://docs.x.com/x-api/users/get-my-user). The exchange
    // then checks `expectAccount` here, not off the token response.
    const lookup =
      pending.options.account ||
      (client?.platform === "x" && expectAccount
        ? {
            url: xEndpointsOf(new URL(pending.options.tokenEndpoint).origin).userEndpoint,
            id: "data.id",
            name: "data.username",
          }
        : null);
    const record = await completeSecretOAuth(
      lookup ? { ...pending, options: { ...pending.options, expectAccount: null } } : pending,
      input.code,
      async (exchange) => {
        if (!originPinned(exchange.url, pending.options.urls))
          throw new Error(`the token endpoint ${new URL(exchange.url).origin} is outside the pin`);
        const response = await dispatch(exchange);
        const answer: unknown = await response
          .clone()
          .json()
          .catch(() => null);
        scopes = grantedScopesOf(answer, pending.options.scope || "");
        answered.team = slackTeamOfTokenResponse(answer);
        return response;
      },
      credentials,
      this.#clientSecretOf,
    );
    // The account, verified before the revision fence and the write: another account's tokens
    // are never stored.
    let account: { id: string; name: string | null } | undefined;
    if (lookup) {
      if (!originPinned(lookup.url, record.urls))
        throw new Error(`the account endpoint ${new URL(lookup.url).origin} is outside the pin`);
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
      if (expectAccount && account.id !== expectAccount)
        throw codedError(
          "IDENTITY_CONFLICT",
          `the provider authorized a different account (${account.id}) than this connection's (${expectAccount}); connect it as a new connection instead`,
        );
    }
    const slackTeam = client?.platform === "slack" ? answered.team : null;
    if (slackTeam) record.routedAccount = { provider: "slack", externalId: slackTeam.id };
    // read before the fence, which only storage awaits may follow
    const hold = Boolean(slackTeam && (await this.#routedToAnotherProject(slackTeam.id)));
    const until = Date.now() + MOVE_OFFER_TTL_MS;
    // the context's alarm revives this facet when the offer runs out, which drops the token
    if (hold) {
      using itx = this.getItx();
      await itx.processors.claim(this.ctx.props.name, until);
    }
    // THE FENCE: a write that landed meanwhile, or a newer attempt that replaced this one, wins
    const stillPending = await this.ctx.storage.get<PendingAttempt>("pending");
    if (
      ((await this.#material())?.setAt ?? null) !== startedOn ||
      stillPending?.nonce !== input.nonce
    )
      throw new Error(
        "the secret was changed while the provider was answering — the tokens were discarded; begin again",
      );
    if (slackTeam && hold) {
      const held: HeldExchange = {
        cell: await this.#sealCell(record),
        basedOn: startedOn,
        nonce: input.nonce,
        scopes,
        until,
        team: slackTeam,
      };
      await this.ctx.storage.put<HeldExchange>("held", held);
      await this.ctx.storage.delete("pending");
      return {
        urls: record.urls,
        refresh: record.refresh?.kind,
        scopes,
        held: { externalId: slackTeam.id, account: slackTeam.name, until },
      };
    }
    const sealed = await this.seal(record);
    await this.ctx.storage.put<Completed>("completed", {
      nonce: input.nonce,
      cell: sealed,
      basedOn: startedOn,
      scopes,
      account,
      ...(pending.options.redirectUri && { userspaceRedirect: true }),
    });
    // the attempt is complete: its replay answers from `completed`
    await this.ctx.storage.delete("pending");
    return { urls: record.urls, refresh: record.refresh?.kind, scopes, account, sealed };
  }

  /** What the attempt `nonce` completed, while its cell is still the material (a replay's answer,
   *  and nothing to land) or its fact has yet to land (the cell the replayed fact carries), or
   *  null; one it completed that was written or cleared since is refused. Says whether the attempt was begun with the
   *  project's own `redirectUri` (`completeOAuth` admits project code to that replay alone; a
   *  record from before the mark is the platform callback's). */
  async #completed(nonce: string): Promise<{
    urls: string[];
    refresh?: SecretRefresh["kind"];
    scopes: string[];
    account?: { id: string; name: string | null };
    userspaceRedirect: boolean;
    /** The cell it wrote, while its fact has yet to land: what the retried fact carries. */
    sealed?: SealedSecretCell;
  } | null> {
    const completed = await this.ctx.storage.get<Completed>("completed");
    if (completed?.nonce !== nonce) return null;
    // one from before the facts carried cells holds no cell to answer or land: its consent is over
    if (!completed.cell) {
      await this.ctx.storage.delete("completed");
      return null;
    }
    const current = await this.#material();
    // landed: the current lineage began with the cell this attempt sealed (the log says so, not a
    // stamp), and the replay lands nothing — a second set of the cell would roll back a mint since;
    // still to land: nothing wrote since the attempt began, so the replay lands it
    const landed = current?.setNonce === completed.cell.nonce;
    const stillToLand = (current?.setAt ?? null) === completed.basedOn;
    if (!landed && !stillToLand)
      throw new Error(
        "this attempt completed, but the secret was written or cleared since — begin again",
      );
    return {
      urls: completed.cell.urls,
      refresh: completed.cell.refresh?.kind,
      scopes: completed.scopes,
      account: completed.account,
      userspaceRedirect: completed.userspaceRedirect === true,
      ...(!landed && { sealed: completed.cell }),
    };
  }

  /** THE GATE ON ITERATE'S SLACK APP'S TOKENS: one for a workspace another project's connection
   *  holds is never stored here, where egress would substitute it, but held aside until that
   *  workspace moves here; and one stored here is refused on use once another project holds the
   *  workspace (`#assertWorkspaceNotMoved`) — as iterate's GitHub App's tokens are used only while
   *  their installation is routed here (`#assertInstallationRouted`). A project's own app routes
   *  nothing. */
  async #routedToAnotherProject(teamId: string): Promise<boolean> {
    const route = await new ControlPlane(this.env).integrationRouteOf("slack", teamId);
    const { projectId } = DurableObjectNameCodec.parse(this.#address().context);
    return Boolean(route && route.projectId !== projectId);
  }

  /** THE HELD TOKEN ADMITTED (the platform's move of its workspace here, integrations/verbs.ts
   *  `confirmIntegrationMove`, once the route is this project's): the record sealed like any
   *  write's, while nothing was written since it was held and before it expires, then marked
   *  `completed` — so the same call again, after the built-in's fact failed, answers the same
   *  without a second write. Answers the pin, the strategy kind and the cell the fact carries;
   *  a replay answers the same cell while the fact has yet to land, and no cell once it has. */
  async admitHeldToken(input: {
    nonce: string;
  }): Promise<{ urls: string[]; refresh?: SecretRefresh["kind"]; sealed?: SealedSecretCell }> {
    const replayed = await this.#completed(input.nonce);
    if (replayed)
      return { urls: replayed.urls, refresh: replayed.refresh, sealed: replayed.sealed };
    const held = await this.ctx.storage.get<HeldExchange>("held");
    // one held before the facts carried cells has no cell to admit
    if (held?.nonce !== input.nonce || !held.cell)
      throw new Error("no token is held for this consent any more — connect again");
    await this.ctx.storage.delete("held");
    if (held.until <= Date.now() || ((await this.#material())?.setAt ?? null) !== held.basedOn)
      throw new Error(
        "the token held for this consent expired, or the secret was written since — connect again",
      );
    const { cell } = held;
    const { material } = await decryptSecretMaterial(
      cell.material,
      { context: cell.context, urls: cell.urls, nonce: cell.nonce },
      this.#keys(),
    );
    const sealed = await this.seal({
      material,
      urls: cell.urls,
      refresh: cell.refresh,
      routedAccount: cell.routedAccount,
    });
    await this.ctx.storage.put<Completed>("completed", {
      nonce: input.nonce,
      cell: sealed,
      basedOn: held.basedOn,
      scopes: held.scopes,
    });
    return { urls: cell.urls, refresh: cell.refresh?.kind, sealed };
  }

  /** THE REVIVE the context's alarm owes this facet — also for a held token's offer running out
   *  (`completeOAuth` claims it for `until`): a token past it is dropped. A revive before then (a new
   *  incarnation's: a first-party facet's claim falls due at its context's birth) spent that claim,
   *  so the offer's end is claimed again. */
  override async revive(): Promise<void> {
    await super.revive();
    const held = await this.ctx.storage.get<HeldExchange>("held");
    if (!held) return;
    if (held.until <= Date.now()) await this.ctx.storage.delete("held");
    else {
      using itx = this.getItx();
      await itx.processors.claim(this.ctx.props.name, held.until);
    }
  }

  /** WHAT A FAILED MOVE LEFT OF ITS CONSENT, gone: the held token (`held`); or the record, cleared,
   *  while it is still the one that consent's admit stored — checked and cleared with storage alone
   *  between, so a write since (someone else's) stays — answering what the clear ended for the
   *  built-in's facts; or nothing (`gone`). */
  async dropHeldToken(input: {
    nonce: string;
  }): Promise<"held" | "gone" | { lends: EndedLends; borrowed: Borrowed | null }> {
    const held = await this.ctx.storage.get<HeldExchange>("held");
    if (held?.nonce === input.nonce) {
      await this.ctx.storage.delete("held");
      return "held";
    }
    const completed = await this.ctx.storage.get<Completed>("completed");
    const current = await this.#material();
    if (
      completed?.nonce !== input.nonce ||
      !completed.cell ||
      current?.setNonce !== completed.cell.nonce
    )
      return "gone";
    return this.clear();
  }

  /** Substitute, pin, dispatch — refresh and retry once on a mintable miss or a 401. A refusal is
   *  a 502 to the caller with the reason (never the destination, never the value). Every dispatch
   *  is a `secret/used` fact on this path — the request AS RECEIVED (its placeholders, never a
   *  value) and the upstream's status — appended off the response path. A WebSocket upgrade is a
   *  dispatch like any other: the 101 and its socket go straight back. */
  override async fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    // A borrower's use, admitted by this context (iterate-context-durable-object.ts `#lentFetch`,
    // the one sender: every egress strips `x-itx-lend*`): its placeholders spell the borrower's path
    // `as`, which this facet answers for as its own, and `secret/used` names the borrower.
    const lentAs = headers.get(LENT_AS_HEADER);
    headers.delete(LENT_AS_HEADER);
    if (lentAs)
      return this.#serve(
        new Request(request, { headers }),
        JSON.parse(lentAs) as { as: string; borrower: string },
      );
    const borrowed = await this.ctx.storage.get<Borrowed>("borrowed");
    if (!borrowed) return this.#serve(request, null);
    // The lender's context over FETCH, never a Workers-RPC method call: a 101's socket crosses a
    // fetch channel only. The lend rides signed (secrets.ts `LEND_USE_HEADER`).
    headers.set(
      LEND_USE_HEADER,
      await signLendUse(
        {
          lender: borrowed.lender,
          lendId: borrowed.lendId,
          borrower: DurableObjectNameCodec.parse(this.#address().context).projectId,
        },
        await sessionSigningSecretOf(iterateConfigOf(this.env)),
      ),
    );
    return this.env.ITERATE_CONTEXT.getByName(borrowed.lender).fetch(
      new Request(request, { headers }),
    );
  }

  /** The dispatch itself, for this secret's own path — or, for a lend, the borrower's path `as` too. */
  async #serve(request: Request, lent: { as: string; borrower: string } | null): Promise<Response> {
    const { path } = this.#address();
    // The record AS OF NOW, its pin checked against THIS request every time it is read — after a
    // refresh (or a write that won the revision fence) the pin may have moved, and the retried
    // request must honour the pin the new material was set with.
    const read = async () => {
      const current = await this.#material();
      if (!current) return null;
      if (!originPinned(request.url, current.cell.urls))
        throw pinRefusal(path, request.url, current.cell.urls);
      // the offset the cell sits at after the open (a rotation reseals it): what a mint is fenced on
      return this.#open(current);
    };
    const used = (response: Response): Response => {
      this.ctx.waitUntil(
        this.#fact({
          type: "events.iterate.com/secret/used",
          payload: {
            method: request.method,
            url: request.url,
            status: response.status,
            ...(lent && { borrower: lent.borrower }),
          },
        }),
      );
      return response;
    };
    // The Discord shape (secrets.ts `SECRET_FRAMES_HEADER`): the upgrade names this secret for its
    // frames, and this facet proxies the socket to substitute them.
    const framesFor = request.headers.get(SECRET_FRAMES_HEADER);
    if (framesFor) {
      const headers = new Headers(request.headers);
      headers.delete(SECRET_FRAMES_HEADER);
      request = new Request(request, { headers });
    }
    try {
      if (
        framesFor &&
        (request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
          !secretPathsIn(framesFor).some((named) => named === path || named === lent?.as))
      )
        throw new SecretRefused(
          `itx.fetch: ${SECRET_FRAMES_HEADER} names this secret on a WebSocket upgrade only`,
        );
      let stored = await read();
      if (stored) await this.#assertInstallationRouted(stored.record.refresh);
      if (stored) await this.#assertWorkspaceNotMoved(stored.record.routedAccount);
      // This facet answers for ONE secret: a placeholder naming another is refused here, not only
      // at the egress that routed the request (the facet is the boundary that holds the bytes).
      const resolve = (named: string) => {
        if (named !== path && named !== lent?.as)
          throw new SecretRefused(
            `itx.fetch: getSecret(${JSON.stringify(named)}) does not belong to the secret ${path}`,
          );
        return stored?.record.material || null;
      };
      // A refresh-and-retry needs the request twice; clone while it is undisturbed. (The cast is
      // workers-types' Request<Cf> vs the bare Request the pure half takes.)
      let retry = stored?.record.refresh ? (request.clone() as unknown as Request) : null;
      let substituted: Request;
      try {
        substituted = await substituteProjectSecrets(request, resolve);
      } catch (error) {
        // No accessToken yet with a strategy configured: mint first (the first-use case), then go.
        if (!(error instanceof SecretRefused) || !retry || !error.mintable || !stored) throw error;
        try {
          await this.#refresh(stored.offset);
        } catch (cause) {
          throw new SecretRefused(
            `${error.message}; the refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
        stored = await read();
        substituted = await substituteProjectSecrets(retry, resolve);
        retry = null; // one refresh per request: a just-minted token gets no second go
      }
      // A socket whose frames name this secret is proxied, with the material as of its dial.
      const answer = (response: Response) =>
        used(
          framesFor && response.webSocket && stored
            ? proxyFrames(response, [path, ...(lent ? [lent.as] : [])], stored.record.material)
            : response,
        );
      const response = await dispatch(substituted);
      if (response.status !== 401 || !retry || !stored) return answer(response);
      try {
        await this.#refresh(stored.offset);
      } catch {
        // The provider (or the material) refused the refresh: the 401 is the caller's answer.
        return used(response);
      }
      await response.body?.cancel();
      stored = await read();
      return answer(await dispatch(await substituteProjectSecrets(retry, resolve)));
    } catch (error) {
      // A refusal is a 502 to the caller with the reason — never the destination, never the value.
      if (error instanceof SecretRefused)
        return new Response(`${error.message}\n`, { status: 502 });
      throw error;
    }
  }

  /** AN INSTALLATION'S TOKEN IS USED ONLY WHILE ITS ROUTE IS THIS PROJECT'S: iterate's GitHub App
   *  mints only for an installation the control plane routes here (`#githubInstallationToken`),
   *  and a token already minted is refused once the route went elsewhere (a move, a disconnect) —
   *  re-read at most every INSTALLATION_ROUTE_RECHECK_MS, so a project that lost an installation
   *  keeps using it that long at most, from any secret path it minted it at. */
  async #assertInstallationRouted(refresh: SecretRecord["refresh"]): Promise<void> {
    if (refresh?.kind !== "github-app-installation" || !("platform" in refresh.client)) return;
    const { installationId } = refresh;
    const readAt = this.#installationRouteReadAt.get(installationId);
    if (readAt !== undefined && Date.now() - readAt < INSTALLATION_ROUTE_RECHECK_MS) return;
    const { projectId } = DurableObjectNameCodec.parse(this.#address().context);
    const route = await new ControlPlane(this.env).integrationRouteOf("github", installationId);
    if (route?.projectId !== projectId) {
      this.#installationRouteReadAt.delete(installationId);
      throw new SecretRefused(
        `itx.fetch: GitHub installation ${installationId} is not connected to this project`,
      );
    }
    this.#installationRouteReadAt.set(installationId, Date.now());
  }

  /** A WORKSPACE'S TOKEN IS REFUSED ONCE IT MOVED: iterate's Slack app's token for a workspace
   *  another project's connection now holds (a move took it while this project's cleanup had not
   *  run) — re-read at most every INSTALLATION_ROUTE_RECHECK_MS, like an installation's. A workspace
   *  no project holds is not refused: its connect routes it after the token's first use. */
  async #assertWorkspaceNotMoved(routed: SecretRecord["routedAccount"]): Promise<void> {
    if (!routed) return;
    const readAt = this.#workspaceRouteReadAt.get(routed.externalId);
    if (readAt !== undefined && Date.now() - readAt < INSTALLATION_ROUTE_RECHECK_MS) return;
    if (await this.#routedToAnotherProject(routed.externalId)) {
      this.#workspaceRouteReadAt.delete(routed.externalId);
      throw new SecretRefused(
        `itx.fetch: Slack workspace ${routed.externalId} is connected to another project`,
      );
    }
    this.#workspaceRouteReadAt.set(routed.externalId, Date.now());
  }

  #refresh(offset: number): Promise<void> {
    const inFlight = this.#refreshing;
    if (inFlight?.offset === offset) return inFlight.promise;
    // A different write is being refreshed (or none): run this one after it settles, never alongside.
    const previous = inFlight?.promise.catch(() => {}) ?? Promise.resolve();
    const promise = previous
      .then(() => this.#doRefresh(offset))
      .finally(() => {
        if (this.#refreshing?.promise === promise) this.#refreshing = undefined;
      });
    this.#refreshing = { offset, promise };
    return promise;
  }

  /** Run the strategy against the record AS READ NOW; commit only if nothing was written meanwhile
   *  (the offset fence) — a stale mint must never resurrect material a write replaced. The outcome,
   *  either way, is a fact on this path: `secret/refreshed { kind, ok, error? }`, and one that
   *  minted carries the new material sealed, as the write it refreshed (`basedOn`); the reduce
   *  keeps it while that write is still the material. */
  async #doRefresh(offset: number): Promise<void> {
    const current = await this.#material();
    // A write landed first: whatever it holds (new material, or no strategy any more) is the
    // answer, and the caller re-reads it — so the fence comes before any look at the strategy.
    if (current?.offset !== offset) return;
    // a rotation reseals the cell on this open: the mint is then of the reseal
    const { record, offset: at } = await this.#open(current);
    const { refresh, urls } = record;
    if (!refresh) throw new Error("no refresh strategy"); // unreachable: this write was read with one
    // Refresh moves bytes only toward pinned hosts, like any use.
    const pinnedDispatch = (exchange: Request) => {
      if (!originPinned(exchange.url, urls))
        throw new Error(`the exchange endpoint ${new URL(exchange.url).origin} is outside the pin`);
      return dispatch(exchange);
    };
    let next: Record<string, unknown>;
    try {
      if (refresh.kind === "github-app-installation")
        next = {
          ...(isRecord(record.material) && record.material),
          accessToken: await this.#githubInstallationToken(refresh, record, pinnedDispatch),
        };
      else if (refresh.kind === "oauth-refresh-token" && refresh.client?.platform)
        next = await this.#platformRefresh(refresh, refresh.client, record, pinnedDispatch);
      else if (refresh.kind === "oauth-refresh-token" && refresh.client)
        // A record from before own-app mode left the platform names `client: { project }` and holds
        // that client's `clientId` and `clientSecret` beside the tokens: a client in the clear.
        next = await refreshSecretMaterial(
          { ...refresh, client: undefined },
          record.material,
          pinnedDispatch,
          this.#clientSecretOf,
        );
      else if (refresh.kind === "worker")
        // Exchange code runs in its jail (exchange-jail.ts), its egress the pin alone. The cast:
        // `ctx.exports` is typed from the generated worker types, which do not see the entrypoint
        // worker.ts exports; the SDK mints `ItxEntrypoint` from it the same way.
        next = await runExchangeCode({
          loader: this.env.LOADER,
          pinnedOutbound: (
            this.ctx.exports as unknown as {
              PinnedOutbound: (options: { props: { urls: string[] } }) => Fetcher;
            }
          ).PinnedOutbound({ props: { urls } }),
          context: this.#address().context,
          urls,
          source: refresh.source,
          material: record.material,
        });
      else
        next = await refreshSecretMaterial(
          refresh,
          record.material,
          pinnedDispatch,
          this.#clientSecretOf,
        );
    } catch (error) {
      await this.#fact({
        type: "events.iterate.com/secret/refreshed",
        payload: {
          kind: refresh.kind,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
    if ((await this.#material())?.offset !== at) return;
    // the mint is kept until its fact lands: a provider may have rotated the refresh token on it
    const minted: Minted = {
      cell: await this.#sealCell({ ...record, material: next }),
      basedOn: at,
      kind: refresh.kind,
    };
    await this.ctx.storage.put<Minted>("minted", minted);
    const landed = await this.#factOrThrow({
      type: "events.iterate.com/secret/refreshed",
      payload: { kind: refresh.kind, ok: true, sealed: minted.cell, basedOn: at },
    });
    // the retry that follows reads the material again: only once the reduce holds the new cell
    await this.waitUntilProcessed({ offset: landed });
    await this.ctx.storage.delete("minted");
  }

  /** The refresh grant with the deployment's client (`oauth-refresh-token` + `client`): its
   *  credentials attached here, toward its own provider only (`#oauthClientOf`). */
  async #platformRefresh(
    refresh: Extract<SecretRefresh, { kind: "oauth-refresh-token" }>,
    client: { platform: OAuthPlatform },
    record: SecretRecord,
    pinnedDispatch: (request: Request) => Promise<Response>,
  ): Promise<Record<string, unknown>> {
    const material = isRecord(record.material) ? record.material : {};
    if (typeof material.refreshToken !== "string" || !material.refreshToken)
      throw new Error(`${refresh.kind}: the secret's material has no "refreshToken"`);
    const credentials = this.#oauthClientOf({
      client,
      clientId: "",
      clientSecret: "",
      tokenEndpoint: refresh.tokenEndpoint,
    });
    const response = await pinnedDispatch(
      oauthTokenRequest({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        tokenEndpoint: refresh.tokenEndpoint,
        clientAuth: refresh.clientAuth || "client_secret_basic",
        params: { grant_type: "refresh_token", refresh_token: material.refreshToken },
      }),
    );
    // A provider may rotate the refresh token on use; keep the newest.
    return { ...material, ...(await oauthTokensOf(response, refresh.kind)) };
  }

  /** A GitHub App installation's token: an App JWT (@octokit/auth-app) traded at the
   *  installation's `access_tokens`. The project's own App signs with the `appId` and `privateKey`
   *  this secret's material holds — each either the value, or a `getSecret("/secrets/<name>",
   *  { field })` placeholder naming another of the owner's secrets pinned to the API's origin,
   *  read there at every mint as a client secret is (`#clientSecretOf`), so one secret holding the
   *  App's key serves every installation's. The deployment's App signs with ITERATE's key, at its
   *  own GitHub only, and only for an installation the control plane routes to THIS project — so no
   *  project mints for an installation another project connected. */
  async #githubInstallationToken(
    refresh: Extract<SecretRefresh, { kind: "github-app-installation" }>,
    record: SecretRecord,
    pinnedDispatch: (request: Request) => Promise<Response>,
  ): Promise<string> {
    let app: { appId: string; privateKey: string };
    if ("project" in refresh.client) {
      const material = isRecord(record.material) ? record.material : {};
      if (typeof material.appId !== "string" || typeof material.privateKey !== "string")
        throw new Error(`${refresh.kind}: the secret's material holds no "appId" and "privateKey"`);
      app = {
        appId: await this.#clientSecretOf(material.appId, refresh.apiOrigin),
        privateKey: await this.#clientSecretOf(material.privateKey, refresh.apiOrigin),
      };
    } else {
      const github = iterateConfigOf(this.env).integrations.github;
      if (!github)
        throw new Error("this deployment has no GitHub App (ITERATE integrations.github is unset)");
      if (refresh.apiOrigin !== githubApiOriginOf(github.githubOrigin))
        throw new Error(
          `the platform's GitHub App answers at ${githubApiOriginOf(github.githubOrigin)}`,
        );
      const { projectId } = DurableObjectNameCodec.parse(this.#address().context);
      const route = await new ControlPlane(this.env).integrationRouteOf(
        "github",
        refresh.installationId,
      );
      if (route?.projectId !== projectId)
        throw new Error(
          `GitHub installation ${refresh.installationId} is not connected to this project`,
        );
      app = { appId: github.appId, privateKey: github.privateKey.exposeSecret() };
    }
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

  /** A fact about this secret onto its own log — a use, a refresh's outcome — the platform's own
   *  append through this facet's loopback (no principal). Best-effort: what it records already
   *  happened, and a lost fact must not fail the request that caused it. */
  /** This facet's own fact on its path, one the material depends on: the offset it landed at, or
   *  the append's failure thrown. */
  async #factOrThrow(event: EventInput<typeof SecretContract>): Promise<number> {
    using itx = this.getItx();
    // the scope's append is typed for its caller's spelling; it answers the appended events
    const [landed] = (await itx.append(event)) as unknown as { offset: number }[];
    if (!landed) throw new Error(`secret: ${event.type} did not land`);
    return landed.offset;
  }

  /** This facet's own fact on its path, best-effort: the offset it landed at, or null when the
   *  append failed (reported, never thrown: a dispatch's answer does not wait on its fact). */
  async #fact(event: EventInput<typeof SecretContract>): Promise<number | null> {
    try {
      using itx = this.getItx();
      // the scope's append is typed for its caller's spelling; it answers the appended events
      const [landed] = (await itx.append(event)) as unknown as { offset: number }[];
      return landed?.offset ?? null;
    } catch (error) {
      reportIssue("secret.fact-append-failed", error, { type: event.type });
      return null;
    }
  }
}

/** THE FRAME PROXY: the upstream's 101 held HERE, and a new socket handed to the caller — every
 *  client→server text frame with this secret's placeholders substituted (secrets.ts
 *  `substituteSecretInFrame`), everything else relayed as is, and each side's close the other's. A
 *  frame naming another secret closes both, 1008. The socket pins this facet (and so its context)
 *  for as long as it is open — as a passed-through 101 already does — plus the frame pump's CPU. */
function proxyFrames(upstream: Response, paths: string[], material: SecretMaterial): Response {
  const outbound = upstream.webSocket!;
  const [caller, inbound] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  outbound.accept();
  inbound.accept();
  const closeBoth = (code: number, reason: string) => {
    for (const socket of [inbound, outbound])
      try {
        socket.close(code, reason);
      } catch {
        // already closed
      }
  };
  inbound.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return outbound.send(event.data);
    try {
      outbound.send(substituteSecretInFrame(event.data, paths, material));
    } catch (error) {
      closeBoth(1008, error instanceof SecretRefused ? error.message.slice(0, 120) : "refused");
    }
  });
  outbound.addEventListener("message", (event) => inbound.send(event.data));
  const relayClose = (to: WebSocket) => (event: CloseEvent) => {
    try {
      to.close(relayedCloseCode(event.code), event.reason);
    } catch {
      // already closed
    }
  };
  inbound.addEventListener("close", relayClose(outbound));
  outbound.addEventListener("close", relayClose(inbound));
  inbound.addEventListener("error", () => closeBoth(DROPPED_CLOSE_CODE, "caller socket error"));
  outbound.addEventListener("error", () => closeBoth(DROPPED_CLOSE_CODE, "upstream socket error"));
  const protocol = upstream.headers.get("sec-websocket-protocol");
  return new Response(null, {
    status: 101,
    webSocket: caller,
    headers: protocol ? { "sec-websocket-protocol": protocol } : {},
  });
}

/** The terminal fetch. A substituted secret follows NO redirect: a 3xx to another origin would carry
 *  the credential there (the Fetch standard strips `Authorization` on a cross-origin redirect, not
 *  other headers) — the caller sees the 3xx. A network failure is answered generically: the runtime's
 *  own error quotes the request URL, which may by now carry the substituted secret. */
const dispatch = async (request: Request): Promise<Response> => {
  try {
    return await fetch(request, { redirect: "manual" });
  } catch {
    throw new SecretRefused(
      `itx.fetch: the pinned host ${new URL(request.url).origin} could not be reached`,
    );
  }
};
