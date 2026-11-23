import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  DEPLOY_SCOPES,
  describeNetworkError,
  KeptSignIn,
  keptSignInStep,
  lockHeld,
  lockKept,
  madeByTheDeploy,
  parsed,
  renewedSignIn,
  resilientFetch,
} from "./cloudflare-access.ts";

const now = Date.parse("2026-11-19T10:00:00Z");
const kept: KeptSignIn = {
  kind: "iterate-cloudflare-sign-in",
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: now + 30 * 60_000,
  scopes: DEPLOY_SCOPES.join(" "),
  lacks: [],
  signedInAt: "2026-11-19T09:30:00.000Z",
};

test("a kept sign-in is read from its JSON, with or without spaces around it, and nothing else is one", () => {
  expect(parsed(KeptSignIn, ` ${JSON.stringify(kept)}\n`)).toEqual(kept);
  expect(parsed(KeptSignIn, JSON.stringify({ ...kept, kind: "other" }))).toBeUndefined();
  expect(parsed(KeptSignIn, JSON.stringify({ ...kept, refreshToken: undefined }))).toBeUndefined();
  expect(parsed(KeptSignIn, "not json")).toBeUndefined();
});

test("a kept access token serves a run while it has more than 20 minutes left, and is renewed after", () => {
  expect(keptSignInStep(kept, now)).toBe("use");
  expect(keptSignInStep(kept, now + 10 * 60_000)).toBe("renew");
  expect(keptSignInStep({ ...kept, expiresAt: now - 1 }, now)).toBe("renew");
});

test("a renewal keeps Cloudflare's new refresh token and the scopes it names, and a lost renewal says whether a person must sign in again", () => {
  const renewed = renewedSignIn(
    kept,
    {
      access_token: "access-2",
      refresh_token: "refresh-2",
      expires_in: 3600,
      scope: DEPLOY_SCOPES.filter((scope) => scope !== "d1.write").join(" "),
    },
    now,
  );
  expect(renewed).toEqual({
    renewed: {
      ...kept,
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: now + 3600_000,
      lacks: ["d1.write"],
      renewedAt: "2026-11-19T10:00:00.000Z",
    },
  });
  // no new refresh token: the earlier one stays; no scope named: what was known stays
  expect(renewedSignIn(kept, { access_token: "access-2" }, now)).toMatchObject({
    renewed: { refreshToken: "refresh-1", lacks: [] },
  });

  expect(
    renewedSignIn(kept, { error: "invalid_grant", error_description: "revoked" }, now),
  ).toEqual({ ended: true, why: "invalid_grant: revoked" });
  expect(renewedSignIn(kept, { error: "temporarily_unavailable" }, now)).toMatchObject({
    ended: false,
  });
  expect(renewedSignIn(kept, { error: "HTTP 429" }, now)).toMatchObject({ ended: false });
  expect(renewedSignIn(kept, { error: "invalid_client" }, now)).toMatchObject({ ended: false });
  expect(renewedSignIn(kept, {}, now)).toEqual({ ended: false, why: "an answer with no token" });
});

test("a lock holds while the process it names lives, and a lock with no live process is taken over", () => {
  const alive = (pid: number) => pid === 42;
  expect(lockHeld("42", alive)).toBe(true);
  expect(lockHeld("42\n", alive)).toBe(true);
  expect(lockHeld("43", alive)).toBe(false);
  expect(lockHeld("", alive)).toBe(false);
  expect(lockHeld("-1", alive)).toBe(false);
});

test("the tokens that a sign-out lists are the stack's two telemetry tokens, by name", () => {
  expect(madeByTheDeploy("iterate-iterate-telemetry-catalog")).toBe(true);
  expect(madeByTheDeploy("iterate-garple-telemetry-analytics")).toBe(true);
  expect(madeByTheDeploy("iterate deploy")).toBe(false);
  expect(madeByTheDeploy("iterate-jeeves-telemetry-catalog-old")).toBe(false);
});

test("a command refuses a kept sign-in whose lock a live process holds", () => {
  const folder = mkdtempSync(join(tmpdir(), "kept-lock-"));
  const file = join(folder, "sign-in.json");
  writeFileSync(`${file}.lock`, String(process.ppid));
  try {
    expect(() => lockKept(file)).toThrow(`Another command (process ${process.ppid})`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("describeNetworkError unwraps Node fetch cause and gives actionable hints for TLS and IPv6/timeout failures", () => {
  const certErr = new TypeError("fetch failed", {
    cause: Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    }),
  });
  const certText = describeNetworkError(certErr, "https://dash.cloudflare.com/oauth2/device/auth");
  expect(certText).toContain("dash.cloudflare.com");
  expect(certText).toContain("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
  expect(certText).toContain("NODE_USE_SYSTEM_CA=1");

  const timeoutErr = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
  });
  const timeoutText = describeNetworkError(timeoutErr, "https://api.cloudflare.com/client/v4/user");
  expect(timeoutText).toContain("ETIMEDOUT");
  expect(timeoutText).toContain("ipv4first");
});

test("resilientFetch retries transient network errors and 503 responses, then surfaces cause on exhaustion", async () => {
  let calls = 0;
  const ok = await resilientFetch(
    "https://api.cloudflare.com/client/v4/user",
    { method: "GET" },
    {
      attempts: 3,
      backoffMs: 1,
      wait: async () => {},
      fetcher: (async () => {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        if (calls === 2) return new Response("busy", { status: 503 });
        return Response.json({ success: true });
      }) as unknown as typeof fetch,
    },
  );
  expect(ok).toMatchObject({ status: 200 });
  expect(calls).toBe(3);

  await expect(
    resilientFetch(
      "https://dash.cloudflare.com/oauth2/device/auth",
      { method: "POST" },
      {
        attempts: 2,
        backoffMs: 1,
        wait: async () => {},
        fetcher: (async () => {
          throw new TypeError("fetch failed", { cause: { code: "ENETUNREACH" } });
        }) as unknown as typeof fetch,
      },
    ),
  ).rejects.toThrow(/dash\.cloudflare\.com.*ENETUNREACH.*ipv4first/);
});
