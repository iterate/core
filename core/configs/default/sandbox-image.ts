// sandbox-image.ts — THE MIND'S OWN SANDBOX IMAGE (sandbox-image.md): iterate's full development
// image, copied from ghcr.io into the registry of the mind's own Cloudflare account. A Container
// starts only from registry.cloudflare.com, so a mind with no image of its own starts its
// sandboxes on Cloudflare's lean image (Node and npm, no git, no coding CLI).
//
// One pass (`sandboxImageForAgent`, `itx.config.sandboxImage`) goes on from what the account
// holds: it copies the blobs the registry lacks, puts the manifest, asks Cloudflare to prepare the
// image and names it on `/` with `events.iterate.com/mind/sandbox-image-configured`, once. Every
// call to Cloudflare goes with the mind's token at `/secrets/cloudflare` as a placeholder through
// `itx.fetch`; the registry gets a push credential that the token mints, and the blobs stream
// through the isolate's own `fetch`. The pass keeps its own facts on `/sandbox-image`.
import { z } from "zod";

/** iterate's published image, the same pin as core/alchemy/src/sandbox-image.ts (a mind's config
 *  cannot import core/alchemy). A test keeps the two equal. */
export const PUBLISHED_SANDBOX_IMAGE = {
  source: "ghcr.io/iterate/iterate-dev-image",
  // allow-high-entropy-next-line: the public image's content digest, a pin and no secret
  digest: "sha256:03e19e40cae1cddd093802f5cab2e0b7273395a0abebea0a111c07e23dceb419",
};
/** The repository the copy lands in, in the mind's account: the same name as a deploy's copy, so
 *  the two never copy a layer twice. */
const SANDBOX_IMAGE_REPOSITORY = "iterate-sandbox";

const CLOUDFLARE_TOKEN_SECRET = "/secrets/cloudflare";
/** The token goes as a placeholder, which the vault fills in on the way to api.cloudflare.com. */
const AUTHORIZATION = `Bearer getSecret("${CLOUDFLARE_TOKEN_SECRET}", { field: "token" })`;
const REGISTRY = "registry.cloudflare.com";
const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const ASK_EVERY_MS = 5_000;
/** The longest a pass waits for `ready` after its copy: measured, a whole copy took 207 s (its
 *  largest layer 187 s) and the preparation of new layers 145 s. */
const PASS_MS = 8 * 60_000;

export type SandboxImageOptions = {
  /** No new blob starts after this; a blob that has started is finished. Default 4 minutes. */
  copyBudgetMs?: number;
  /** The longest wait for Cloudflare's `ready`. Default 3 minutes, and less when the copy took
   *  long: a pass ends within about 8 minutes. */
  prepareBudgetMs?: number;
};

export type SandboxImageState = "no-connection" | "copying" | "preparing" | "ready" | "failed";

export type SandboxImageAnswer = {
  state: SandboxImageState;
  words: string;
  image?: string;
  copied?: number;
  left?: number;
};

/** What `sandboxImageForAgent` needs of the mind's root. */
export type SandboxImageItx = {
  secrets: { describe(path: string): Promise<{ set: boolean }> };
  fetch(request: Request): Promise<Response>;
  cd(path: string): {
    append(event: { type: string; payload: Record<string, unknown> }): Promise<unknown>;
    readEvents(
      afterOffset: number,
      limit: number,
    ): Promise<{ events: { offset: number; type: string; payload?: unknown }[] }>;
  };
};

/** A step that did not go as it must, with the host's own words. */
class StepFailed extends Error {
  constructor(step: string, status: number, said: string) {
    super(`${step}: ${status}${said ? ` ${said.slice(0, 300)}` : ""}`);
  }
}

/** `itx.config.sandboxImage(options)`: one pass of the copy. It never throws for an expected
 *  outcome: the answer's `state` says where the image is, and `words` what to do. */
export async function sandboxImageForAgent(
  itx: SandboxImageItx,
  options: SandboxImageOptions = {},
): Promise<SandboxImageAnswer> {
  const passBegan = Date.now();
  const copyBudgetMs = options.copyBudgetMs ?? 4 * 60_000;
  const prepareBudgetMs = options.prepareBudgetMs ?? 3 * 60_000;
  if (!(await itx.secrets.describe(CLOUDFLARE_TOKEN_SECRET)).set)
    return {
      state: "no-connection",
      words: `This mind has no Cloudflare connection: ${CLOUDFLARE_TOKEN_SECRET} is not set. Its stack's config must say cloudflareToken: true, which an owner turns on in iterate Cloud.`,
    };
  // The pass's own facts: for the next pass, and for a person who reads the log.
  const facts = itx.cd("/sandbox-image");
  let copied = 0;
  let image: string | undefined;
  try {
    const account = await accountOf(itx);
    image = `${REGISTRY}/${account}/${SANDBOX_IMAGE_REPOSITORY}@${PUBLISHED_SANDBOX_IMAGE.digest}`;
    const basic = await pushCredential(itx, account);
    const target = `https://${REGISTRY}/v2/${account}/${SANDBOX_IMAGE_REPOSITORY}`;
    const token = await sourceToken();
    const manifest = await manifestOf(token);

    // A blob the registry does not answer for is copied, as a deploy's copy does
    // (core/alchemy/scripts/sandbox-image.ts): when the registry refuses, the upload says why.
    const missing: ImageBlob[] = [];
    for (const blob of manifest.blobs) {
      const there = await fetch(`${target}/blobs/${blob.digest}`, {
        method: "HEAD",
        headers: { authorization: basic },
      });
      if (!there.ok) missing.push(blob);
    }
    missing.sort((a, b) => b.size - a.size);
    const began = Date.now();
    let failure: unknown;
    const copier = async () => {
      for (let blob = missing.shift(); blob; blob = missing.shift()) {
        if (failure !== undefined || Date.now() - began > copyBudgetMs) {
          missing.unshift(blob);
          return;
        }
        try {
          await copyBlob(target, basic, token, blob);
          copied++;
        } catch (error) {
          failure ??= error;
        }
      }
    };
    // Three at a time: one upload stream took 5 to 6 MB/s, and streams add up.
    await Promise.all(Array.from({ length: 3 }, copier));
    if (failure !== undefined) throw failure;
    if (missing.length) {
      const left = missing.length;
      await facts.append({
        type: "sandbox-image/pass",
        payload: { state: "copying", copied, left },
      });
      return {
        state: "copying",
        words: `Copied ${copied} blobs of the image into the account's registry; ${left} are left. Call itx.config.sandboxImage() again: it goes on where this pass stopped.`,
        image,
        copied,
        left,
      };
    }

    // A GET, not a HEAD: Cloudflare's registry can answer a HEAD with 200 for a manifest whose
    // content and layers it has lost, and a GET with 404.
    const present = await fetch(`${target}/manifests/${PUBLISHED_SANDBOX_IMAGE.digest}`, {
      headers: { authorization: basic, accept: MANIFEST_TYPES },
    });
    await present.body?.cancel();
    if (!present.ok) {
      const put = await fetch(`${target}/manifests/${PUBLISHED_SANDBOX_IMAGE.digest}`, {
        method: "PUT",
        headers: { authorization: basic, "content-type": manifest.type },
        body: manifest.bytes,
      });
      if (!put.ok) throw new StepFailed("manifest put", put.status, await put.text());
      await put.body?.cancel();
    }

    // A pass ends within PASS_MS, so that a script's ten minutes hold it: a copy that took long
    // leaves the wait for `ready` to the next pass.
    const waitMs = Math.max(0, Math.min(prepareBudgetMs, PASS_MS - (Date.now() - passBegan)));
    if (!(await prepared(itx, account, image, waitMs))) {
      await facts.append({
        type: "sandbox-image/pass",
        payload: { state: "preparing", copied, left: 0 },
      });
      return {
        state: "preparing",
        words:
          "The image is in the account's registry, and Cloudflare is still preparing it. Call itx.config.sandboxImage() again in a few minutes.",
        image,
        copied,
        left: 0,
      };
    }

    if (!(await configuredBefore(facts, image))) {
      await itx.cd("/").append({
        type: "events.iterate.com/mind/sandbox-image-configured",
        payload: { image },
      });
      await facts.append({
        type: "sandbox-image/configured",
        payload: { image, at: new Date().toISOString() },
      });
      await facts.append({
        type: "sandbox-image/pass",
        payload: { state: "ready", copied, left: 0 },
      });
    }
    return {
      state: "ready",
      words:
        "New sandboxes now start with git, gh, Node, pnpm, Chromium and the Claude and Codex CLIs. A sandbox with a saved disk keeps its disk.",
      image,
      copied,
      left: 0,
    };
  } catch (error) {
    const words = error instanceof Error ? error.message : String(error);
    await facts
      .append({ type: "sandbox-image/pass", payload: { state: "failed", copied, words } })
      .catch(() => {});
    return { state: "failed", words, image, copied };
  }
}

type ImageBlob = { digest: string; size: number };

/** One of Cloudflare's API answers, as far as this file reads it. */
const Answer = z.object({
  success: z.boolean().optional(),
  result: z.unknown().optional(),
  errors: z.unknown().optional(),
});

async function cloudflare(itx: SandboxImageItx, method: string, path: string, body?: unknown) {
  const answer = await itx.fetch(
    new Request(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        authorization: AUTHORIZATION,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await answer.text();
  const parsed = Answer.safeParse(jsonOf(text));
  const ok = answer.ok && parsed.success && parsed.data.success !== false;
  return {
    status: answer.status,
    ok,
    result: parsed.data?.result,
    said: parsed.success ? JSON.stringify(parsed.data.errors ?? "") : text,
  };
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The token's one account. */
async function accountOf(itx: SandboxImageItx): Promise<string> {
  const accounts = await cloudflare(itx, "GET", "/accounts");
  const ids = z.array(z.object({ id: z.string().min(1) })).safeParse(accounts.result).data;
  if (!accounts.ok || !ids) throw new StepFailed("accounts", accounts.status, accounts.said);
  if (ids.length !== 1)
    throw new StepFailed(
      "accounts",
      accounts.status,
      `the token names ${ids.length} accounts, not one`,
    );
  return ids[0]!.id;
}

const Credential = z.object({
  username: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
  password: z.string().min(1),
});

/** The registry takes only a credential that the account's API mints: Basic, for an hour. */
async function pushCredential(itx: SandboxImageItx, account: string): Promise<string> {
  const made = await cloudflare(
    itx,
    "POST",
    `/accounts/${account}/containers/registries/${REGISTRY}/credentials`,
    { expiration_minutes: 60, permissions: ["pull", "push"] },
  );
  if (made.status === 403)
    throw new StepFailed(
      "credential",
      403,
      `The mind's Cloudflare token lacks the permission "Workers Containers Write", so it cannot push to the account's registry. Tell a member; do not look for a way round. Cloudflare said: ${made.said}`,
    );
  const credential = Credential.safeParse(made.result).data;
  const user = credential?.username || credential?.user;
  if (!made.ok || !credential || !user) throw new StepFailed("credential", made.status, made.said);
  return `Basic ${btoa(`${user}:${credential.password}`)}`;
}

function sourceOf() {
  const [host, ...path] = PUBLISHED_SANDBOX_IMAGE.source.split("/");
  return { host: host!, repo: path.join("/") };
}

/** ghcr.io gives an anonymous pull token for a public image. */
async function sourceToken(): Promise<string> {
  const { host, repo } = sourceOf();
  const answer = await fetch(`https://${host}/token?service=${host}&scope=repository:${repo}:pull`);
  if (!answer.ok) throw new StepFailed("source token", answer.status, await answer.text());
  const body = z
    .object({ token: z.string().optional(), access_token: z.string().optional() })
    .parse(await answer.json());
  return `Bearer ${body.token || body.access_token}`;
}

const Manifest = z.object({
  config: z.object({ digest: z.string(), size: z.number() }),
  layers: z.array(z.object({ digest: z.string(), size: z.number() })),
});

/** The pinned manifest, as bytes (the registry must get the same bytes) and its blobs. */
async function manifestOf(token: string) {
  const { host, repo } = sourceOf();
  const answer = await fetch(
    `https://${host}/v2/${repo}/manifests/${PUBLISHED_SANDBOX_IMAGE.digest}`,
    {
      headers: { authorization: token, accept: MANIFEST_TYPES },
    },
  );
  if (!answer.ok) throw new StepFailed("manifest", answer.status, await answer.text());
  const type = answer.headers.get("content-type") || MANIFEST_TYPES.split(", ")[0]!;
  const bytes = new Uint8Array(await answer.arrayBuffer());
  const manifest = Manifest.safeParse(jsonOf(new TextDecoder().decode(bytes))).data;
  if (!manifest)
    throw new StepFailed("manifest", answer.status, "a list or no image, not one image");
  return { type, bytes, blobs: [manifest.config, ...manifest.layers] };
}

/** ghcr.io answers a blob with a redirect to its storage, which takes no authorization. */
async function readBlob(token: string, digest: string): Promise<Response> {
  const { host, repo } = sourceOf();
  const first = await fetch(`https://${host}/v2/${repo}/blobs/${digest}`, {
    headers: { authorization: token },
    redirect: "manual",
  });
  const place = first.headers.get("location");
  const read = first.status >= 300 && first.status < 400 && place ? await fetch(place) : first;
  if (!read.ok || !read.body) throw new StepFailed(`blob read ${digest}`, read.status, "");
  return read;
}

/** One streamed PATCH, as Docker pushes (the registry refuses a second part), then the PUT that
 *  closes the upload with the digest. */
async function copyBlob(target: string, basic: string, token: string, blob: ImageBlob) {
  const start = await fetch(`${target}/blobs/uploads/`, {
    method: "POST",
    headers: { authorization: basic },
  });
  await start.body?.cancel();
  const place = start.headers.get("location");
  if (!start.ok || !place) throw new StepFailed(`upload ${blob.digest}`, start.status, "");
  const read = await readBlob(token, blob.digest);
  const sized = new FixedLengthStream(blob.size);
  const stop = new AbortController();
  // Held from the start: a download that breaks rejects this pipe while the PATCH still runs, and
  // a rejection that nobody holds would take the mind's Worker with it.
  let broke: unknown;
  const piping = read
    .body!.pipeTo(sized.writable, { signal: stop.signal })
    .catch((error: unknown) => {
      broke = error;
    });
  const saidBy = (error: unknown) => (error instanceof Error ? error.message : String(error));
  // An upload that ended early may have left the body unread: without a reader the pipe's last
  // write never settles, so the body is cancelled here (a body the upload took refuses that).
  const endPipe = async () => {
    stop.abort();
    await sized.readable.cancel().catch(() => {});
    await piping;
  };
  let patch: Response;
  try {
    patch = await fetch(new URL(place, `https://${REGISTRY}`).toString(), {
      method: "PATCH",
      headers: { authorization: basic, "content-type": "application/octet-stream" },
      body: sized.readable,
    });
  } catch (error) {
    // the upload broke (or the download under it): the download ends too, and the blob is named
    await endPipe();
    throw new StepFailed(`blob ${blob.digest}`, 0, saidBy(broke ?? error));
  }
  if (patch.status < 200 || patch.status > 299) {
    await endPipe();
    throw new StepFailed(`blob ${blob.digest}`, patch.status, await patch.text());
  }
  await piping;
  if (broke !== undefined) throw new StepFailed(`blob read ${blob.digest}`, 0, saidBy(broke));
  await patch.body?.cancel();
  const close = new URL(patch.headers.get("location") || place, `https://${REGISTRY}`);
  close.searchParams.set("digest", blob.digest);
  const closed = await fetch(close.toString(), {
    method: "PUT",
    headers: { authorization: basic, "content-length": "0" },
  });
  if (!closed.ok)
    throw new StepFailed(`blob close ${blob.digest}`, closed.status, await closed.text());
  await closed.body?.cancel();
}

const Preparation = z.object({ status: z.string() });

/** Cloudflare prepares the image for Containers; it is asked again until it says `ready`. */
async function prepared(itx: SandboxImageItx, account: string, image: string, budgetMs: number) {
  const began = Date.now();
  for (;;) {
    const asked = await cloudflare(
      itx,
      "POST",
      `/accounts/${account}/containers/image-preparations`,
      {
        image,
      },
    );
    const status = Preparation.safeParse(asked.result).data?.status;
    if (!asked.ok || !status) throw new StepFailed("preparation", asked.status, asked.said);
    if (status === "ready") return true;
    if (status !== "pending")
      throw new StepFailed("preparation", asked.status, JSON.stringify(asked.result));
    if (Date.now() - began + ASK_EVERY_MS > budgetMs) return false;
    await new Promise((resolve) => setTimeout(resolve, ASK_EVERY_MS));
  }
}

/** Whether the helper ever named this image: EVERY fact on `/sandbox-image` is read, a page at a
 *  time. The log is the helper's own and grows by one fact a pass at most. A window of its newest
 *  facts would forget the naming after enough failed passes, and the next pass would name the
 *  image again, over a person's `{ image: null }`. */
async function configuredBefore(facts: ReturnType<SandboxImageItx["cd"]>, image: string) {
  for (let after = 0; ;) {
    const { events } = await facts.readEvents(after, 200);
    const named = events.some(
      (event) =>
        event.type === "sandbox-image/configured" &&
        z.object({ image: z.string() }).safeParse(event.payload).data?.image === image,
    );
    if (named) return true;
    const last = events.at(-1)?.offset;
    if (last === undefined || last <= after) return false;
    after = last;
  }
}
