// The stored sign-in that several processes share (./node.ts `mindToken`), against an issuer that
// replaces the refresh token at each renewal, as a mind's does: one renewal at a time, behind the
// lock file of cli/config.ts `withSessionsLock`.
import {
  existsSync,
  mkdtempDisposableSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, onTestFinished, test as base, vi } from "vitest";

// the CLI's folder is read once, when cli/config.ts is loaded: so before the import
const config = mkdtempDisposableSync(join(tmpdir(), "iterate-test-"));
vi.stubEnv("XDG_CONFIG_HOME", config.path);
const { mindToken } = await import("./node.ts");
const { CONFIG_DIR, readSession, withSessionsLock, writeSession } = await import("./cli/config.ts");
const lock = join(CONFIG_DIR, "sessions.json.lock");
/** `test`, with the folder removed after the file's last test. */
const test = base.extend<{ folderRemoved: void }>({
  folderRemoved: [
    // oxlint-disable-next-line no-empty-pattern -- vitest reads the fixture's needs from this pattern
    async ({}, use) => {
      await use();
      config.remove();
    },
    { scope: "file", auto: true },
  ],
});

test("the sign-ins of this file are in its own folder, not the person's", () => {
  expect(CONFIG_DIR).toBe(join(config.path, "iterate"));
});

test("five callers of one stored sign-in that is about to end: one renewal, and each gets its token", async () => {
  const { issuer, resource } = await signInAboutToEnd();

  const tokens = await Promise.all(Array.from({ length: 5 }, () => tokenFor(resource)));

  expect(issuer).toMatchObject({ renewed: ["refresh-0"] });
  expect(tokens).toEqual(Array.from({ length: 5 }, () => "access-1"));
  // what the file keeps is what the issuer made last: the next renewal is not refused
  expect(readSession(resource)).toMatchObject({ token: "access-1", refreshToken: "refresh-1" });
});

test("while another process holds the lock no renewal is sent, and then the sign-in that it renewed is used", async () => {
  const { issuer, resource } = await signInAboutToEnd();
  writeFileSync(lock, "another process");

  const waiting = tokenFor(resource);
  await sleep(300);
  expect(issuer).toMatchObject({ renewed: [] });

  // the other process ends its renewal: the file, then the lock
  writeSession(resource, {
    ...readSession(resource)!,
    token: "access-of-the-other",
    refreshToken: "refresh-of-the-other",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  rmSync(lock);

  expect(await waiting).toBe("access-of-the-other");
  expect(issuer).toMatchObject({ renewed: [] });
});

test.for([
  ["two minutes ago", -120_000],
  ["two minutes ahead, after the clock moved", 120_000],
] as const)(
  "a lock that a stopped process left %s is taken over, and no lock is left",
  async ([, fromNowMs]) => {
    const { issuer, resource } = await signInAboutToEnd();
    writeFileSync(lock, "a process that stopped");
    const madeAt = new Date(Date.now() + fromNowMs);
    utimesSync(lock, madeAt, madeAt);

    expect(await tokenFor(resource)).toBe("access-1");
    expect(issuer).toMatchObject({ renewed: ["refresh-0"] });
    expect(existsSync(lock)).toBe(false);
  },
);

test("a process whose lock another one took over leaves that one's lock in place", async () => {
  onTestFinished(() => rmSync(lock, { force: true }));

  await withSessionsLock(async () => writeFileSync(lock, "another process"));

  expect(readFileSync(lock, "utf8")).toBe("another process");
});

test.for([
  ["invalid_grant", 400, { error: "invalid_grant", error_description: "Token revoked" }],
  ["invalid_client", 401, { error: "invalid_client", error_description: "Client not found" }],
] as const)("a renewal refused with %s clears the stored sign-in", async ([code, status, body]) => {
  const resource = await signInAgainst(() => ({ status, body }));

  await expect(tokenFor(resource)).rejects.toThrow(code);
  expect(readSession(resource)).toBeNull();
});

test("a transient 5xx on renewal keeps the stored sign-in", async () => {
  const resource = await signInAgainst(() => ({
    status: 503,
    body: { error: "temporarily_unavailable" },
  }));

  await expect(tokenFor(resource)).rejects.toThrow();
  expect(readSession(resource)).toMatchObject({ token: "access-0", refreshToken: "refresh-0" });
});

/** The bearer for `resource`, as a script asks for it: no sign-in when it cannot be renewed. */
const tokenFor = (resource: string) =>
  mindToken({ address: "iterate.example.com", resource, signIn: false });

/** A stored sign-in that ends in 30 seconds against a token endpoint that answers `reply`. */
async function signInAgainst(reply: () => { status: number; body: unknown }) {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const { status, body } = reply();
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => void server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const resource = `${url}/api`;
  writeSession(resource, {
    issuer: url,
    tokenEndpoint: `${url}/token`,
    clientId: "cli",
    token: "access-0",
    refreshToken: "refresh-0",
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  return resource;
}

/** A stored sign-in that ends in 30 seconds, at an issuer of its own. */
async function signInAboutToEnd() {
  const issuer = await rotatingIssuer();
  const resource = `${issuer.url}/api`;
  writeSession(resource, {
    issuer: issuer.url,
    tokenEndpoint: `${issuer.url}/token`,
    clientId: "cli",
    token: "access-0",
    refreshToken: "refresh-0",
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  return { issuer, resource };
}

/** A token endpoint on this machine. Each renewal makes the next refresh token; the one given must
 *  be the newest or the one before it (the mind's issuer keeps one earlier token, for a client
 *  that lost an answer). `renewed` holds the refresh token of each renewal, in order. */
async function rotatingIssuer() {
  const renewed: string[] = [];
  let newest = "refresh-0";
  let before = "";
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const given = new URLSearchParams(body).get("refresh_token") || "";
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (given !== newest && given !== before) return json(400, { error: "invalid_grant" });
      renewed.push(given);
      before = given;
      newest = `refresh-${renewed.length}`;
      json(200, {
        access_token: `access-${renewed.length}`,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: newest,
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => void server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, renewed };
}
