// A proxy to the binding, by the repo's path: git itself lives in the repo facet (../repo/).
import { RpcTarget } from "capnweb";
import { failureKind, retryPlatformFailures, UPSTREAM_ONCE } from "iterate/platform-retry";
import type { ArtifactToken, CfArtifactRepoApi, CfArtifactsApi } from "iterate/api";
import { errorCode } from "iterate/lib";
import { unavailableError } from "core-itx";

// typed to what this proxy calls; `list` is unfiltered
export interface ArtifactsNamespace {
  create(name: string, options?: { setDefaultBranch?: string }): Promise<ArtifactCreateResult>;
  get(name: string): Promise<ArtifactRepoHandle>;
  list(options?: { limit?: number; cursor?: string }): Promise<ArtifactListResult>;
  delete(name: string): Promise<boolean>;
}
interface ArtifactCreateResult {
  token: string;
}
interface ArtifactRepoHandle {
  // a method: the handle is a Workers-RPC stub, whose data fields do not cross the wire
  info(): Promise<{ remote: string }>;
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<ArtifactToken>;
}
interface ArtifactListResult {
  repos: { name: string }[];
  cursor?: string;
}

// An RpcTarget, so a client can pipeline `get(path).createToken(…)` across the /api hop. It holds
// the repo's name, never the binding's handle: a kept handle holds this actor's session to Artifacts
// open until the next deploy. `fork(name)` is withheld: it takes a raw name.
class ScopedArtifactRepoRpcTarget extends RpcTarget implements CfArtifactRepoApi {
  readonly #namespace: ArtifactsNamespace;
  readonly #name: string;
  constructor(namespace: ArtifactsNamespace, name: string) {
    super();
    this.#namespace = namespace;
    this.#name = name;
  }
  createToken(...[scope, ttlSeconds]: Parameters<CfArtifactRepoApi["createToken"]>) {
    return retryingOnePlatformFailure("createToken", this.#name, () =>
      withArtifactRepoHandle(this.#namespace, this.#name, "createToken", (handle) =>
        handle.createToken(scope, ttlSeconds),
      ),
    );
  }
  async remote() {
    const { remote } = await retryingOnePlatformFailure("remote", this.#name, () =>
      withArtifactRepoHandle(this.#namespace, this.#name, "info", (handle) => handle.info()),
    );
    return remote;
  }
}

// The handle and the answer object each keep this actor's session to Artifacts open until disposed.
async function withArtifactRepoHandle<T>(
  namespace: ArtifactsNamespace,
  name: string,
  method: "createToken" | "info",
  verb: (handle: ArtifactRepoHandle) => Promise<T>,
): Promise<T> {
  const handle = await answeredInTime(`get(${name})`, namespace.get(name));
  try {
    const answer = await answeredInTime(`${method}(${name})`, verb(handle));
    const copy = structuredClone(answer);
    release(answer);
    return copy;
  } finally {
    release(handle);
  }
}

// twice the slowest healthy answer measured (200 creates at once, each within 9.7 s)
const ARTIFACTS_ANSWER_MS = 20_000;

// A call Artifacts leaves unanswered is lost, not refused, so the kind is `disconnected`. A binding
// call cannot be cancelled and may still land: a late answer is released on arrival.
function answeredInTime<T>(call: string, answer: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refused = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      answer.then(release, () => {});
      reject(
        unavailableError(
          "disconnected",
          `Cloudflare Artifacts did not answer ${call} within ${ARTIFACTS_ANSWER_MS / 1000} s`,
        ),
      );
    }, ARTIFACTS_ANSWER_MS);
  });
  return Promise.race([answer, refused]).finally(() => clearTimeout(timer));
}

function release(value: unknown) {
  (value as Partial<Disposable> | null | undefined)?.[Symbol.dispose]?.();
}

// `/repos/config` → `repos--config`. Injective because a segment may not contain `--`.
function repoArtifactName(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) throw refusal("the mind's root context is not a repo");
  for (const segment of segments)
    if (segment.includes("--") || !/^[a-zA-Z0-9._-]+$/.test(segment))
      throw refusal(
        `"${path}" cannot back an Artifacts repo — a path segment is [a-zA-Z0-9._-]+ without "--" (got "${segment}")`,
      );
  const name = segments.join("--");
  if (!/^[a-zA-Z0-9]/.test(name))
    throw refusal(
      `"${path}" cannot back an Artifacts repo — its name must start with a letter or digit`,
    );
  return name;
}

const refusal = (message: string) => new Error(`itx.cfArtifacts: ${message}`);

// API error 10200. A call left unanswered is UNAVAILABLE, naming a repo whose name may hold the digits.
const isRepoNotFound = (error: unknown): boolean =>
  errorCode(error) !== "UNAVAILABLE" &&
  /not found|10200/i.test(String((error as { message?: unknown })?.message ?? error));

const isRepoBeingCreated = (error: unknown) => /currently being created/i.test(String(error));

/** API error 10201. Taken is not there: Artifacts deletes asynchronously, and until a deletion lands
 *  its name answers `create` "already exists" while `get` answers "not found". */
const isRepoAlreadyThere = (error: unknown): boolean =>
  /already exists/i.test(error instanceof Error ? error.message : String(error));

/** A create can answer 10400 after ~13.5 s and hold the name 3–13 s more (measured), and a deletion
 *  frees its name a few seconds after the delete. Counted from the answer that first found it taken. */
const TAKEN_NAME_WAIT_MS = 20_000;

// Only for a verb that is safe to run twice: a read, a token, a delete (a second one answers "not
// found"), a create (a name its failed attempt took reads as created: `isRetry`).
function retryingOnePlatformFailure<T>(
  verb: string,
  name: string,
  attempt: (isRetry: boolean) => Promise<T>,
): Promise<T> {
  let attempts = 0;
  return retryPlatformFailures(() => attempt(attempts++ > 0), {
    area: "cfartifacts",
    schedule: UPSTREAM_ONCE,
    idempotent: true,
    // Artifacts' 10400 ("An internal error occurred.") arrives unstamped
    kind: (error) =>
      errorCode(error) !== "UNAVAILABLE" &&
      /An internal error occurred|\b10400\b/.test(
        error instanceof Error ? error.message : String(error),
      )
        ? "disconnected"
        : failureKind(error),
    describe: (error) => ({
      name,
      verb,
      message: error instanceof Error ? error.message : String(error),
    }),
  });
}

export function mindScopedArtifacts(input: { namespace: ArtifactsNamespace }): CfArtifactsApi {
  return {
    create: async (path) => {
      const name = repoArtifactName(path);
      // a handle and a token: either may be where the binding says "not found" or "being created"
      const reads = () =>
        retryingOnePlatformFailure("probe", name, () =>
          withArtifactRepoHandle(input.namespace, name, "createToken", (handle) =>
            handle.createToken("read", 60),
          ).then(
            () => true,
            (error) => {
              if (!isRepoNotFound(error) && !isRepoBeingCreated(error)) throw error;
              return false;
            },
          ),
        );
      // Create first, then read only a name the create found taken: it counts as the repo once it reads.
      let takenSince = 0;
      let created = false;
      for (let round = 1, waitMs = 1000; ; round++, waitMs = Math.min(waitMs * 2, 4000)) {
        const answer = await retryingOnePlatformFailure("create", name, async (isRetry) => {
          try {
            release(await answeredInTime(`create(${name})`, input.namespace.create(name)));
            return { created: true, taken: false };
          } catch (error) {
            if (!isRepoAlreadyThere(error) && !isRepoBeingCreated(error)) throw error;
            // after a failed create, the name may be taken by that create, landed all the same
            return { created: isRetry, taken: true };
          }
        });
        created ||= answer.created;
        takenSince ||= Date.now();
        const settled = !answer.taken || (await reads());
        const waitedMs = Date.now() - takenSince;
        const givingUp = !settled && waitedMs + waitMs > TAKEN_NAME_WAIT_MS;
        if ((settled && round > 1) || givingUp)
          console.info({
            event: "cfartifacts.create-waited-for-taken-name",
            namespace: "iterate-context",
            name,
            rounds: round,
            waitedMs,
            outcome: settled ? (answer.taken ? "reads" : "created") : "still-taken",
          });
        if (settled) return { created };
        if (givingUp)
          throw new Error(
            `itx.cfArtifacts: the Artifacts repo name ${name} is taken, yet no repo by that name has read in ${waitedMs} ms — a deletion of that name Artifacts has not finished (it deletes asynchronously), or a create that landed and does not read yet; create it again once the name reads or is free`,
          );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    },
    get: async (path) => new ScopedArtifactRepoRpcTarget(input.namespace, repoArtifactName(path)),
    list: async (options) => {
      const page = await retryingOnePlatformFailure("list", "", () =>
        answeredInTime("list", input.namespace.list(options)),
      );
      return {
        repos: page.repos.map((r) => ({ path: `/${r.name.split("--").join("/")}` })),
        // oxlint-disable-next-line iterate/simple-truthiness-check -- a wire view: an absent cursor stays ABSENT (capnweb serializes an undefined-valued key as present)
        ...(page.cursor !== undefined && { cursor: page.cursor }),
      };
    },
    delete: async (path) => {
      const name = repoArtifactName(path);
      try {
        return await retryingOnePlatformFailure("delete", name, () =>
          answeredInTime(`delete(${name})`, input.namespace.delete(name)),
        );
      } catch (error) {
        if (!isRepoNotFound(error)) throw error;
        return false;
      }
    },
  };
}
