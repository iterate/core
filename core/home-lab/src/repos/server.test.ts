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

void test("a read token pushes by no spelling of the path: the store judges the path that git gets", async () => {
  const store = await serveRepos({
    dir: mkdtempSync(join(tmpdir(), "repos-")),
    token: STORE,
    port: 0,
  });
  try {
    const ask = async (token: string, path: string, method = "POST") =>
      (
        await fetch(`${store.origin}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}` },
        })
      ).status;
    assert.equal(await ask(STORE, "/_repos/scratch", "PUT"), 201);
    const expires = Date.now() + HOUR;
    const read = await repoToken(STORE, { repo: "scratch", scope: "read", expires });
    const write = await repoToken(STORE, { repo: "scratch", scope: "write", expires });
    assert.deepEqual(
      [
        // git decodes the path, so this is a push: it was judged undecoded, and passed
        await ask(read, "/scratch.git/git-receive-%70ack"),
        await ask(read, "/scratch.git/%67it-receive-pack"),
        // encoded twice: no path of a repo, with any token
        await ask(read, "/scratch.git/git-receive-%2570ack"),
        await ask(write, "/scratch.git/git-receive-%2570ack"),
        await ask(STORE, "/scratch.git/git-receive-%2570ack"),
        // an encoding that is none
        await ask(read, "/scratch.git/git-receive-%zzack"),
        // git reads the last service of two
        await ask(
          read,
          "/scratch.git/info/refs?service=git-upload-pack&service=git-receive-pack",
          "GET",
        ),
        await ask(read, "/scratch.git/info/refs?service=git-receive-%70ack", "GET"),
        // a way out of the repo behind an encoded slash is no path
        await ask(read, "/scratch.git%2F..%2Fconfig.git/info/refs?service=git-upload-pack", "GET"),
      ],
      [401, 401, 400, 400, 400, 400, 401, 401, 400],
    );
    // the same spellings with the write token reach git, which answers them itself
    assert.notEqual(await ask(write, "/scratch.git/git-receive-%70ack"), 401);
    // and a read is still a read
    assert.equal(await ask(read, "/scratch.git/info/refs?service=git-upload-pack", "GET"), 200);
    assert.equal(await ask(read, "/scratch.git/info/refs?service=git-upload-%70ack", "GET"), 200);
  } finally {
    store.close();
  }
});

void test("a request that git refuses before it reads the body is answered, and the store goes on", async () => {
  const store = await serveRepos({
    dir: mkdtempSync(join(tmpdir(), "repos-")),
    token: STORE,
    port: 0,
  });
  try {
    const headers = { authorization: `Bearer ${STORE}` };
    assert.equal(
      (await fetch(`${store.origin}/_repos/scratch`, { method: "PUT", headers })).status,
      201,
    );
    // no service of git by that name: `git http-backend` answers and exits with the body unread.
    // Eight megabytes do not fit the pipe, so the write to it fails with EPIPE.
    const refused = await fetch(`${store.origin}/scratch.git/no-such-service`, {
      method: "POST",
      headers,
      body: new Uint8Array(8 * 1024 * 1024),
    });
    await refused.arrayBuffer();
    assert.ok(refused.status >= 400, String(refused.status));
    // the store's process is still there for the next request
    assert.equal((await fetch(`${store.origin}/_repos/scratch`, { headers })).status, 200);
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
