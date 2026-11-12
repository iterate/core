import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serveRepos } from "./server.ts";
import { repoGrantOf, repoToken } from "./token.ts";

const STORE = "the-store's-own-token";
const HOUR = 3600_000;

void test("a repo's token opens that repo's git traffic alone: no other repo, no admin path, and a push only with write", async () => {
  const store = await serveRepos({
    dir: mkdtempSync(join(tmpdir(), "repos-")),
    token: STORE,
    port: 0,
  });
  try {
    const ask = async (token: string, path: string, method = "GET") =>
      (
        await fetch(`${store.origin}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}` },
        })
      ).status;
    // the store's own token makes the repos, as the platform does
    assert.equal(await ask(STORE, "/_repos/scratch", "PUT"), 201);
    assert.equal(await ask(STORE, "/_repos/config", "PUT"), 201);
    const expires = Date.now() + HOUR;
    const read = await repoToken(STORE, { repo: "scratch", scope: "read", expires });
    const write = await repoToken(STORE, { repo: "scratch", scope: "write", expires });
    const fetches = "/info/refs?service=git-upload-pack";
    const pushes = "/info/refs?service=git-receive-pack";
    assert.deepEqual(
      [
        await ask(read, `/scratch.git${fetches}`),
        await ask(read, `/scratch.git${pushes}`),
        await ask(read, "/scratch.git/git-receive-pack", "POST"),
        await ask(read, `/config.git${fetches}`),
        await ask(read, "/_repos"),
        await ask(read, "/_repos/config", "DELETE"),
        await ask(write, `/scratch.git${pushes}`),
        await ask(write, `/config.git${pushes}`),
        // git's basic auth carries the token as the password
        (
          await fetch(`${store.origin}/scratch.git${fetches}`, {
            headers: { authorization: `Basic ${Buffer.from(`x:${read}`).toString("base64")}` },
          })
        ).status,
      ],
      [200, 401, 401, 401, 401, 401, 200, 401, 200],
    );
    // the repos are as they were: the refused delete deleted nothing
    assert.equal(await ask(STORE, "/_repos/config"), 200);
  } finally {
    store.close();
  }
});

void test("a token that is over, changed, or signed by another store says nothing", async () => {
  const grant = { repo: "scratch", scope: "read", expires: Date.now() + HOUR } as const;
  const token = await repoToken(STORE, grant);
  assert.deepEqual(await repoGrantOf(STORE, token), grant);
  assert.equal(await repoGrantOf(STORE, token, grant.expires + 1), null);
  assert.equal(await repoGrantOf("another store's token", token), null);
  // the grant's text swapped for a wider one, under the old mac
  const [version, , mac] = token.split(".");
  const wider = Buffer.from(JSON.stringify({ ...grant, scope: "write" })).toString("base64url");
  assert.equal(await repoGrantOf(STORE, `${version}.${wider}.${mac}`), null);
  assert.equal(await repoGrantOf(STORE, STORE), null);
  assert.equal(await repoGrantOf(STORE, ""), null);
});
