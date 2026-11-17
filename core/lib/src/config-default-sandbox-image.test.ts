// The default config's sandbox image copy (core/configs/default/sandbox-image.ts): one pass from
// ghcr.io into the registry of the mind's own Cloudflare account, the preparation, and the one
// event that names the image. Stand-ins answer for api.cloudflare.com (through `itx.fetch`), and
// for ghcr.io, its storage and registry.cloudflare.com (through the global `fetch`). The real
// hosts' quirks and timings are out of scope: the probe on a real mind measured those.
import { readFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import {
  PUBLISHED_SANDBOX_IMAGE,
  sandboxImageForAgent,
  type SandboxImageAnswer,
} from "../../configs/default/sandbox-image.ts";

const IMAGE = `registry.cloudflare.com/account-1/iterate-sandbox@${PUBLISHED_SANDBOX_IMAGE.digest}`;
const BASIC = `Basic ${btoa("pusher:push-word")}`;
const CONFIGURED = {
  type: "events.iterate.com/mind/sandbox-image-configured",
  payload: { image: IMAGE },
};

test("a first pass on an empty registry copies every blob, puts the manifest and names the image once", async () => {
  const hosts = standIns();

  expect(await sandboxImageForAgent(hosts.itx)).toMatchObject({
    state: "ready",
    image: IMAGE,
    copied: 5,
    left: 0,
    words:
      "New sandboxes now start with git, gh, Node, pnpm, Chromium and the Claude and Codex CLIs. A sandbox with a saved disk keeps its disk.",
  });

  // toEqual: each blob has exactly one upload, one PATCH of its whole size, one closing PUT
  expect(uploadsByDigest(hosts)).toEqual([
    { digest: "sha256:config", patches: [100], closedWith: "sha256:config" },
    { digest: "sha256:layer-a", patches: [5000], closedWith: "sha256:layer-a" },
    { digest: "sha256:layer-b", patches: [3000], closedWith: "sha256:layer-b" },
    { digest: "sha256:layer-c", patches: [2000], closedWith: "sha256:layer-c" },
    { digest: "sha256:layer-d", patches: [1000], closedWith: "sha256:layer-d" },
  ]);
  expect(hosts).toMatchObject({
    manifestPuts: [{ type: "application/vnd.oci.image.manifest.v1+json", bytes: manifestText() }],
    preparationAsks: [{ image: IMAGE }],
    contexts: {
      "/": [CONFIGURED],
      "/sandbox-image": [
        { type: "sandbox-image/configured", payload: { image: IMAGE } },
        { type: "sandbox-image/pass", payload: { state: "ready", copied: 5, left: 0 } },
      ],
    },
  });
});

test("a second pass copies nothing, appends nothing on / or its own context, and answers ready", async () => {
  const hosts = standIns();
  await sandboxImageForAgent(hosts.itx);
  const before = structuredClone(hosts.contexts);

  expect(await sandboxImageForAgent(hosts.itx)).toMatchObject({ state: "ready", copied: 0 });

  expect(hosts).toMatchObject({ uploads: { length: 5 }, manifestPuts: { length: 1 } });
  // no context got an event, and no new context was written
  expect(hosts).toMatchObject({ contexts: before });
  expect(Object.keys(hosts.contexts)).toEqual(Object.keys(before));
});

test("a pass cut by its copy budget answers copying, and the next copies only what is missing", async () => {
  // The clock jumps past the 4 minutes at the first PATCH: the three copiers have each
  // taken a blob, largest first, and no fourth starts.
  vi.useFakeTimers({ toFake: ["Date"] });
  const hosts = standIns({ jumpAtFirstPatch: 6 * 60_000 });

  expect(await sandboxImageForAgent(hosts.itx)).toMatchObject({
    state: "copying",
    copied: 3,
    left: 2,
    words:
      "Copied 3 blobs of the image into the account's registry; 2 are left. Call itx.config.sandboxImage() again: it goes on where this pass stopped.",
  });
  expect(hosts).toMatchObject({
    manifestPuts: [],
    preparationAsks: [],
    contexts: {
      "/sandbox-image": [
        { type: "sandbox-image/pass", payload: { state: "copying", copied: 3, left: 2 } },
      ],
    },
  });
  expect(hosts.contexts["/"]).toBeUndefined();
  expect(uploadsByDigest(hosts).map((upload) => upload.digest)).toEqual([
    "sha256:layer-a",
    "sha256:layer-b",
    "sha256:layer-c",
  ]);

  expect(await sandboxImageForAgent(hosts.itx)).toMatchObject({ state: "ready", copied: 2 });
  expect(uploadsByDigest(hosts).map((upload) => upload.digest)).toEqual([
    "sha256:config",
    "sha256:layer-a",
    "sha256:layer-b",
    "sha256:layer-c",
    "sha256:layer-d",
  ]);
  expect(hosts.contexts).toMatchObject({ "/": [CONFIGURED] });
  vi.useRealTimers();
});

test("a mind with no Cloudflare token answers no-connection and sends nothing to any host", async () => {
  const hosts = standIns({ secretSet: false });

  expect(await sandboxImageForAgent(hosts.itx)).toEqual({
    state: "no-connection",
    words:
      "This mind has no Cloudflare connection: /secrets/cloudflare is not set. Its stack's config must say cloudflareToken: true, which an owner turns on in iterate Cloud.",
  });
  expect(hosts).toMatchObject({ cloudflare: [], requests: [] });
  expect(Object.keys(hosts.contexts)).toEqual([]);
});

const CANNOT_COPY =
  "This mind's Cloudflare connection cannot copy the image. The mind's token reads the account and changes nothing in it, so it cannot push to the account's registry. A deploy of the stack copies the image when its config says mind.sandboxImage: \"published\": tell a member. Do not call itx.config.sandboxImage() again.";

test("a 403 at the push credential answers cannot-copy, says not to call again, and makes no further request", async () => {
  const hosts = standIns({ credentialStatus: 403 });

  const answer = await sandboxImageForAgent(hosts.itx);

  expect(answer).toEqual({ state: "cannot-copy", words: CANNOT_COPY });
  expect(answer.words).toMatch(/^This mind's Cloudflare connection cannot copy the image\. /);
  expect(answer.words).not.toMatch(/Call itx\.config\.sandboxImage\(\) again/);
  // the refused credential is the last call: nothing after it, at Cloudflare or any other host
  expect(hosts.cloudflare.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "GET /accounts",
    "POST /accounts/account-1/containers/registries/registry.cloudflare.com/credentials",
  ]);
  expect(hosts).toMatchObject({
    requests: [],
    contexts: {
      "/sandbox-image": [
        { type: "sandbox-image/pass", payload: { state: "cannot-copy", step: "credential" } },
      ],
    },
  });
  expect(hosts.contexts["/"]).toBeUndefined();
});

test("a 403 at the account's own lookup answers the same cannot-copy, with no request after it", async () => {
  const hosts = standIns({ accountsStatus: 403 });

  expect(await sandboxImageForAgent(hosts.itx)).toEqual({
    state: "cannot-copy",
    words: CANNOT_COPY,
  });
  expect(hosts.cloudflare.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "GET /accounts",
  ]);
  expect(hosts).toMatchObject({
    requests: [],
    contexts: {
      "/sandbox-image": [
        { type: "sandbox-image/pass", payload: { state: "cannot-copy", step: "accounts" } },
      ],
    },
  });
});

test("a preparation that stays pending for the 3 minutes answers preparing and names no image", async () => {
  vi.useFakeTimers();
  const hosts = standIns({ preparation: "pending" });

  const answer = await withClockDriven(sandboxImageForAgent(hosts.itx));

  expect(answer).toMatchObject({
    state: "preparing",
    image: IMAGE,
    copied: 5,
    left: 0,
    words:
      "The image is in the account's registry, and Cloudflare is still preparing it. Call itx.config.sandboxImage() again in a few minutes.",
  });
  // asked at 0, 5, …, 180 s: the last ask is at the budget, and no wait goes past it
  expect(hosts.preparationAsks).toHaveLength(37);
  expect(hosts.contexts).toMatchObject({
    "/sandbox-image": [{ type: "sandbox-image/pass", payload: { state: "preparing" } }],
  });
  expect(hosts.contexts["/"]).toBeUndefined();
  vi.useRealTimers();
});

test("after the image is named, sixty failed passes later a pass still names nothing again: a person's { image: null } stays", async () => {
  const hosts = standIns({
    credentialStatuses: [200, ...Array.from({ length: 60 }, () => 500)],
  });
  await sandboxImageForAgent(hosts.itx);
  for (let pass = 0; pass < 60; pass++)
    expect(await sandboxImageForAgent(hosts.itx)).toMatchObject({ state: "failed" });

  expect(await sandboxImageForAgent(hosts.itx)).toMatchObject({ state: "ready", copied: 0 });

  // exact: the one naming of the first pass, and sixty-two facts (named, ready, sixty failures)
  expect(hosts).toMatchObject({ contexts: { "/": [{ offset: 1, ...CONFIGURED }] } });
  expect(hosts.contexts["/sandbox-image"]?.map((fact) => fact.type).toSorted()).toEqual([
    "sandbox-image/configured",
    ...Array.from({ length: 61 }, () => "sandbox-image/pass"),
  ]);
});

test("a download that breaks answers failed with the blob's name, and the next pass copies that blob", async () => {
  const hosts = standIns({ breakDownloads: 1 });

  expect(await sandboxImageForAgent(hosts.itx)).toMatchObject({
    state: "failed",
    words: expect.stringMatching(/^blob sha256:[a-z0-9-]+: 0 the storage closed the download$/),
  });
  // no manifest and no naming: the pass wrote its own fact alone
  expect(hosts).toMatchObject({ manifestPuts: [] });
  expect(Object.keys(hosts.contexts)).toEqual(["/sandbox-image"]);

  expect(await sandboxImageForAgent(hosts.itx)).toMatchObject({ state: "ready" });
  expect(hosts).toMatchObject({ contexts: { "/": [{ offset: 1, ...CONFIGURED }] } });
});

test("an upload that throws ends its download and answers failed with the blob's name", async () => {
  const hosts = standIns({ patchThrows: 1 });

  expect(await sandboxImageForAgent(hosts.itx)).toMatchObject({
    state: "failed",
    words: expect.stringMatching(
      /^blob sha256:[a-z0-9-]+: 0 the connection to the registry broke$/,
    ),
  });
  // The pass ended: an upload that never read its body must not leave the pipe waiting for a
  // reader. Nothing was put or named.
  expect(hosts).toMatchObject({ manifestPuts: [] });
  expect(Object.keys(hosts.contexts)).toEqual(["/sandbox-image"]);

  expect(await sandboxImageForAgent(hosts.itx)).toMatchObject({ state: "ready" });
  expect(hosts).toMatchObject({ contexts: { "/": [{ offset: 1, ...CONFIGURED }] } });
});

test("ghcr's token is asked a second time when it does not answer, and a second silence answers failed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  // the pause before the second ask is a timer: it is run here, not waited for
  const through = async (pass: Promise<unknown>) => {
    for (let turn = 0; turn < 20; turn++) await vi.advanceTimersByTimeAsync(500);
    return await pass;
  };
  const once = standIns({ tokenTimeouts: 1 });

  expect(await through(sandboxImageForAgent(once.itx))).toMatchObject({
    state: "ready",
    copied: 5,
  });
  // exact: two asks of the token, the second answered, and the first failure kept as a fact
  expect(once.requests.filter((request) => request.path === "/token").length).toBe(2);
  expect(once).toMatchObject({
    contexts: {
      "/sandbox-image": [
        {
          type: "sandbox-image/asked-again",
          payload: { step: "source token", words: "source token: 522 error code: 522\n" },
        },
        { type: "sandbox-image/configured" },
        { type: "sandbox-image/pass", payload: { state: "ready" } },
      ],
    },
  });

  const twice = standIns({ tokenTimeouts: 2 });

  expect(await through(sandboxImageForAgent(twice.itx))).toMatchObject({
    state: "failed",
    words: "source token: 522 error code: 522\n",
    copied: 0,
  });
  // nothing reached the registry, and nothing was named
  expect(twice.requests.filter((request) => request.host === "registry.cloudflare.com")).toEqual(
    [],
  );
  expect(Object.keys(twice.contexts)).toEqual(["/sandbox-image"]);
  vi.useRealTimers();
});

test("ghcr's storage gets no authorization; the registry gets the Basic credential and never the token's placeholder", async () => {
  const hosts = standIns();

  await sandboxImageForAgent(hosts.itx);

  const storage = hosts.requests.filter((request) => request.host === "storage.ghcr.test");
  const registry = hosts.requests.filter((request) => request.host === "registry.cloudflare.com");
  const ghcr = hosts.requests.filter((request) => request.host === "ghcr.io");
  expect({
    storage: storage.map((request) => request.authorization),
    registry: [...new Set(registry.map((request) => request.authorization))],
    ghcr: [...new Set(ghcr.map((request) => request.authorization))],
    cloudflare: [...new Set(hosts.cloudflare.map((request) => request.authorization))],
  }).toEqual({
    storage: [null, null, null, null, null],
    registry: [BASIC],
    ghcr: [null, "Bearer ghcr-token"],
    cloudflare: ['Bearer getSecret("/secrets/cloudflare", { field: "token" })'],
  });
});

test("the template's pin is the deploy's pin in core/alchemy/src/sandbox-image.ts", async () => {
  // Read as text: core/lib does not depend on core/alchemy.
  const deploy = await readFile(
    new URL("../../alchemy/src/sandbox-image.ts", import.meta.url),
    "utf8",
  );

  expect({
    source: /source: "([^"]+)"/.exec(deploy)?.[1],
    digest: /digest: "([^"]+)"/.exec(deploy)?.[1],
    repository: /SANDBOX_IMAGE_REPOSITORY = "([^"]+)"/.exec(deploy)?.[1],
  }).toEqual({ ...PUBLISHED_SANDBOX_IMAGE, repository: "iterate-sandbox" });
});

/** The pass, with the fake clock moved on each time it waits, until it answers. */
async function withClockDriven(pass: Promise<SandboxImageAnswer>) {
  let answer: SandboxImageAnswer | undefined;
  void pass.then((value) => (answer = value));
  for (;;) {
    await vi.waitFor(() => {
      if (!answer && vi.getTimerCount() === 0) throw new Error("the pass has not yet waited");
    });
    if (answer) return answer;
    await vi.advanceTimersByTimeAsync(5_000);
  }
}

function uploadsByDigest(hosts: ReturnType<typeof standIns>) {
  return hosts.uploads
    .map(({ digest, patches, closedWith }) => ({ digest, patches, closedWith }))
    .sort((a, b) => a.digest.localeCompare(b.digest));
}

const BLOBS = [
  { digest: "sha256:config", size: 100 },
  { digest: "sha256:layer-c", size: 2000 },
  { digest: "sha256:layer-a", size: 5000 },
  { digest: "sha256:layer-d", size: 1000 },
  { digest: "sha256:layer-b", size: 3000 },
];

function manifestText() {
  const [config, ...layers] = BLOBS;
  return JSON.stringify({ schemaVersion: 2, config, layers });
}

/** The mind (its secret and contexts) and the three hosts, with what each was sent. */
function standIns({
  secretSet = true,
  accountsStatus = 200,
  credentialStatus = 200,
  credentialStatuses = [],
  preparation = "ready",
  jumpAtFirstPatch = 0,
  breakDownloads = 0,
  patchThrows = 0,
  tokenTimeouts = 0,
}: {
  secretSet?: boolean;
  /** The status of `GET /accounts`: 200 names one account. */
  accountsStatus?: number;
  credentialStatus?: number;
  /** One status for each credential call, in order; after them, `credentialStatus`. */
  credentialStatuses?: number[];
  preparation?: "ready" | "pending";
  jumpAtFirstPatch?: number;
  /** How many downloads from ghcr's storage break before their first byte. */
  breakDownloads?: number;
  /** How many of the registry's PATCH requests throw before they read a byte. */
  patchThrows?: number;
  /** How many asks of ghcr's token answer 522 before one answers. */
  tokenTimeouts?: number;
} = {}) {
  const left = { breakDownloads, patchThrows, tokenTimeouts };
  const contexts: Record<string, { offset: number; type: string; payload: unknown }[]> = {};
  const cloudflare: { method: string; path: string; authorization: string | null }[] = [];
  const requests: { method: string; host: string; path: string; authorization: string | null }[] =
    [];
  const uploads: { id: number; digest: string; patches: number[]; closedWith?: string }[] = [];
  const manifestPuts: { type: string | null; bytes: string }[] = [];
  const preparationAsks: unknown[] = [];
  const registry = new Set<string>();
  let manifestThere = false;
  const repository = "/v2/account-1/iterate-sandbox";
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const itx = {
    secrets: { describe: async (path: string) => ({ path, set: secretSet }) },
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const path = url.pathname.replace("/client/v4", "");
      cloudflare.push({
        method: request.method,
        path,
        authorization: request.headers.get("authorization"),
      });
      if (path === "/accounts")
        return accountsStatus === 200
          ? json({ success: true, result: [{ id: "account-1" }] })
          : json(
              { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
              accountsStatus,
            );
      if (path.endsWith("/containers/registries/registry.cloudflare.com/credentials")) {
        const status = credentialStatuses.shift() ?? credentialStatus;
        return status === 200
          ? json({ success: true, result: { username: "pusher", password: "push-word" } })
          : json(
              {
                success: false,
                errors: [{ code: 10000, message: "Authentication error" }],
              },
              status,
            );
      }
      if (path.endsWith("/containers/image-preparations")) {
        preparationAsks.push(await request.json());
        return json({ success: true, result: { status: preparation } });
      }
      return json({ success: false }, 404);
    },
    cd: (path: string) => ({
      append: async (event: { type: string; payload: Record<string, unknown> }) => {
        const log = (contexts[path] ??= []);
        log.push({ offset: log.length + 1, ...event });
        return [log.at(-1)];
      },
      readEvents: async (afterOffset: number, limit: number) => ({
        events: (contexts[path] ?? [])
          .filter((event) => event.offset > afterOffset)
          .slice(0, limit),
      }),
    }),
  };

  vi.stubGlobal(
    "FixedLengthStream",
    class extends TransformStream {
      constructor(_size: number) {
        super();
      }
    },
  );
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method || "GET";
    const headers = new Headers(init.headers);
    requests.push({
      method,
      host: url.host,
      path: url.pathname,
      authorization: headers.get("authorization"),
    });
    if (url.host === "ghcr.io") {
      if (url.pathname === "/token")
        return left.tokenTimeouts-- > 0
          ? new Response("error code: 522\n", { status: 522 })
          : json({ token: "ghcr-token" });
      if (
        url.pathname === `/v2/iterate/iterate-dev-image/manifests/${PUBLISHED_SANDBOX_IMAGE.digest}`
      )
        return new Response(manifestText(), {
          headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
        });
      const digest = url.pathname.split("/blobs/")[1];
      return new Response(null, {
        status: 307,
        headers: { location: `https://storage.ghcr.test/${digest}?signed=yes` },
      });
    }
    if (url.host === "storage.ghcr.test") {
      const blob = BLOBS.find((one) => one.digest === url.pathname.slice(1));
      const breaks = left.breakDownloads-- > 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (breaks) return controller.error(new Error("the storage closed the download"));
            controller.enqueue(new Uint8Array(blob?.size ?? 0));
            controller.close();
          },
        }),
      );
    }
    if (url.host !== "registry.cloudflare.com") return new Response(null, { status: 404 });
    if (method === "HEAD" && url.pathname.startsWith(`${repository}/blobs/`))
      return new Response(null, {
        status: registry.has(url.pathname.split("/blobs/")[1]!) ? 200 : 404,
      });
    if (method === "POST" && url.pathname === `${repository}/blobs/uploads/`) {
      uploads.push({ id: uploads.length + 1, digest: "", patches: [] });
      return new Response(null, {
        status: 202,
        headers: { location: `${repository}/blobs/uploads/${uploads.length}` },
      });
    }
    const upload = uploads.find((one) => url.pathname === `${repository}/blobs/uploads/${one.id}`);
    if (upload && method === "PATCH") {
      if (left.patchThrows-- > 0) throw new TypeError("the connection to the registry broke");
      if (jumpAtFirstPatch && !uploads.some((one) => one.patches.length))
        vi.setSystemTime(Date.now() + jumpAtFirstPatch);
      upload.patches.push((await new Response(init.body).arrayBuffer()).byteLength);
      return new Response(null, { status: 202, headers: { location: url.pathname } });
    }
    if (upload && method === "PUT") {
      upload.closedWith = url.searchParams.get("digest") ?? undefined;
      upload.digest = upload.closedWith || "";
      registry.add(upload.digest);
      return new Response(null, { status: 201 });
    }
    if (url.pathname === `${repository}/manifests/${PUBLISHED_SANDBOX_IMAGE.digest}`) {
      if (method === "GET") return new Response(null, { status: manifestThere ? 200 : 404 });
      if (method === "PUT") {
        manifestPuts.push({
          type: headers.get("content-type"),
          bytes: await new Response(init.body).text(),
        });
        manifestThere = true;
        return new Response(null, { status: 201 });
      }
    }
    return new Response(null, { status: 400 });
  });

  return {
    itx,
    contexts,
    cloudflare,
    requests,
    uploads,
    manifestPuts,
    preparationAsks,
  };
}
