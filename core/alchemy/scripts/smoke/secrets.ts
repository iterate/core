import { z } from "zod";
import { attempt, mindRoot, type Check } from "./lib.ts";

const ECHO = "https://httpbin.org";

export async function secretChecks(domain: string): Promise<Check[]> {
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token) return [];
  const root = () => mindRoot(domain, token);
  const path = "/secrets/smoke-key";
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  // The echo is compared as its SHA-256 inside loaded code, so neither the value nor the echo lands
  // on a log.
  const use = async (url: string, headers: Record<string, string>, echoed = "X-Smoke-Key") =>
    z
      .object({ status: z.number(), echoed: z.string() })
      .parse(
        await root().run(
          `async (itx) => { const response = await itx.fetch(new Request(${JSON.stringify(url)}, { headers: ${JSON.stringify(headers)} })); const body = await response.json().catch(() => null); const echoed = String(body?.headers?.[${JSON.stringify(echoed)}] ?? ""); const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(echoed)))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); return { status: response.status, echoed: digest }; }`,
        ),
      );
  const placeholder = { "x-smoke-key": `getSecret("${path}")` };
  let replayed: unknown;
  return [
    await attempt(`secrets: set ${path}, pinned to ${ECHO}`, async () => {
      const answer = await root().secrets.set(path, first, { urls: [ECHO] });
      const set = (await logOf(root, path)).findLast(
        (event) => event.type === "events.iterate.com/secret/set",
      );
      replayed = set && { type: set.type, payload: set.payload };
      return {
        pass: answer.path === path && Boolean(set),
        detail: `secret/set landed: ${Boolean(set)}`,
      };
    }),
    await attempt("secrets: itx.fetch to the pin sends the value", async () => {
      const { status, echoed } = await use(`${ECHO}/headers`, placeholder);
      const arrived = echoed === (await sha256(first));
      return {
        pass: status === 200 && arrived,
        detail: `${status}, the value arrived: ${arrived}`,
      };
    }),
    await attempt("secrets: the log has secret/set then secret/used, and no value", async () => {
      const log = await logOf(root, path);
      const types = log.map((event) => event.type);
      const set = types.lastIndexOf("events.iterate.com/secret/set");
      const used = types.lastIndexOf("events.iterate.com/secret/used");
      const holdsValue = JSON.stringify(log).includes(first);
      return {
        pass: set >= 0 && used > set && !holdsValue,
        detail: `secret/used ${used > set ? "after" : "not after"} secret/set; an event holds the value: ${holdsValue}`,
      };
    }),
    await attempt("secrets: itx.fetch to another origin is refused", async () => {
      const { status } = await use("https://example.com/", placeholder);
      return { pass: status === 502, detail: `${status}` };
    }),
    await attempt(
      "secrets: the refused use is on the log, a secret/used with status 502",
      async () => {
        const refused = (await logOf(root, path)).some(
          (event) =>
            event.type === "events.iterate.com/secret/used" &&
            (event.payload as { status?: unknown } | undefined)?.status === 502,
        );
        return { pass: refused, detail: `a refused use on the log: ${refused}` };
      },
    ),
    await attempt("secrets: an old secret/set replayed into the log changes nothing", async () => {
      await root().secrets.set(path, second, { urls: [ECHO] });
      await root()
        .cd(path)
        .append(replayed as { type: string; payload: Record<string, unknown> });
      const { status, echoed } = await use(`${ECHO}/headers`, placeholder);
      const current = echoed === (await sha256(second));
      return {
        pass: status === 200 && current,
        detail: `${status}, the newer value is the one sent: ${current}`,
      };
    }),
    await attempt("secrets: the vault signs and verifies an HMAC", async () => {
      const key = crypto.randomUUID();
      const hmacPath = "/secrets/smoke-hmac";
      await root().secrets.set(hmacPath, key, {
        urls: [ECHO],
        operations: ["signHmac", "verifyHmac"],
      });
      const signature = await root().secrets.signHmac(hmacPath, { payload: "smoke" });
      const expected = await hmacSha256Hex(key, "smoke");
      const verified = await root().secrets.verifyHmac(hmacPath, { payload: "smoke", signature });
      const forged = await root().secrets.verifyHmac(hmacPath, {
        payload: "smoke",
        signature: "0".repeat(64),
      });
      await root().secrets.delete(hmacPath);
      return {
        pass: signature === expected && verified && !forged,
        detail: `signature as expected: ${signature === expected}; verified: ${verified}; a forged one: ${forged}`,
      };
    }),
    await attempt(
      "secrets: the signing is on the log, a secret/operated naming signHmac",
      async () => {
        const signed = (await logOf(root, "/secrets/smoke-hmac")).some(
          (event) =>
            event.type === "events.iterate.com/secret/operated" &&
            (event.payload as { verb?: unknown } | undefined)?.verb === "signHmac",
        );
        return { pass: signed, detail: `an operation on the log: ${signed}` };
      },
    ),
    await attempt(
      "secrets: a placeholder in a URL is refused for a secret placed in headers",
      async () => {
        const { status } = await use(`${ECHO}/anything?k=getSecret("${path}")`, {});
        return { pass: status === 502, detail: `${status}` };
      },
    ),
    await attempt("secrets: a secret made with no operations refuses signHmac", async () => {
      const bare = "/secrets/smoke-no-operations";
      await root().secrets.set(bare, crypto.randomUUID(), { urls: [ECHO] });
      try {
        await root().secrets.signHmac(bare, { payload: "smoke" });
        return { pass: false, detail: "it signed" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { pass: message.includes("was not made to answer it"), detail: message };
      } finally {
        await root().secrets.delete(bare);
      }
    }),
    await attempt(
      "secrets: the twenty-first failed verification in a minute is refused",
      async () => {
        const throwaway = `/secrets/smoke-limit-${crypto.randomUUID()}`;
        await root().secrets.set(throwaway, crypto.randomUUID(), {
          urls: [ECHO],
          operations: ["verifyEquals"],
        });
        const refusedAt = z
          .object({ at: z.number(), message: z.string() })
          .parse(
            await root().run(
              `async (itx) => { for (let at = 1; at <= 21; at += 1) { try { await itx.secrets.verifyEquals(${JSON.stringify(throwaway)}, { value: "wrong" }); } catch (error) { return { at, message: String(error?.message || error) }; } } return { at: 0, message: "never refused" }; }`,
            ),
          );
        await root().secrets.delete(throwaway);
        return {
          pass: refusedAt.at === 21 && refusedAt.message.includes("limit"),
          detail: `refused at ${refusedAt.at}: ${refusedAt.message}`,
        };
      },
    ),
    await attempt(
      "secrets: the collection form sends a signed-out browser to sign in",
      async () => {
        const { url } = await root().secrets.collectFromUser({
          path: "/secrets/smoke-collect",
          egress: { urls: [ECHO] },
        });
        const response = await fetch(url, { redirect: "manual" });
        await response.body?.cancel();
        const location = response.headers.get("location") || "";
        return {
          pass: response.status === 303 && location.startsWith("/sign-in?next="),
          detail: `${response.status} ${location.split("?")[0]}`,
        };
      },
    ),
    await attempt("secrets: after delete, a use is refused", async () => {
      await root().secrets.delete(path);
      const { status } = await use(`${ECHO}/headers`, placeholder);
      return { pass: status === 502, detail: `${status}` };
    }),
    ...(await petshopRefresh(root)),
  ];
}

async function petshopRefresh(root: () => ReturnType<typeof mindRoot>): Promise<Check[]> {
  const origin = process.env.ITERATE_SMOKE_PETSHOP_ORIGIN;
  if (!origin) return [];
  return [
    await attempt(
      `secrets: a refresh at ${origin}, its client secret held by another secret`,
      async () => {
        const redirectUri = "https://smoke.invalid/callback";
        const registered = z.object({ client_id: z.string(), client_secret: z.string() }).parse(
          await (
            await fetch(`${origin}/oauth/register`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ redirect_uris: [redirectUri] }),
            })
          ).json(),
        );
        const authorize = new URL(`${origin}/oauth/authorize`);
        authorize.searchParams.set("client_id", registered.client_id);
        authorize.searchParams.set("redirect_uri", redirectUri);
        authorize.searchParams.set("state", "smoke");
        const code = new URL(
          (await fetch(authorize, { redirect: "manual" })).headers.get("location") || "",
        ).searchParams.get("code");
        const tokens = z.object({ refresh_token: z.string() }).parse(
          await (
            await fetch(`${origin}/oauth/token`, {
              method: "POST",
              headers: {
                authorization: `Basic ${btoa(`${registered.client_id}:${registered.client_secret}`)}`,
                "content-type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code: code || "",
                redirect_uri: redirectUri,
              }),
            })
          ).json(),
        );
        const clientPath = "/secrets/smoke-petshop-client";
        const tokensPath = "/secrets/smoke-petshop";
        await root().secrets.set(clientPath, registered.client_secret, {
          urls: [origin],
          lendTo: [tokensPath],
        });
        await root().secrets.set(
          tokensPath,
          {
            clientId: registered.client_id,
            clientSecret: `getSecret("${clientPath}")`,
            refreshToken: tokens.refresh_token,
          },
          {
            urls: [origin],
            refresh: { kind: "oauth-refresh-token", tokenEndpoint: `${origin}/oauth/token` },
          },
        );
        const status = z
          .number()
          .parse(
            await root().run(
              `async (itx) => (await itx.fetch(new Request(${JSON.stringify(`${origin}/api/pets`)}, { headers: { authorization: 'Bearer getSecret("${tokensPath}", { field: "accessToken" })' } }))).status`,
            ),
          );
        const refreshed = (await logOf(root, tokensPath)).some(
          (event) =>
            event.type === "events.iterate.com/secret/refreshed" &&
            (event.payload as { ok?: unknown } | undefined)?.ok === true,
        );
        return {
          pass: status === 200 && refreshed,
          detail: `${status}; a secret/refreshed that minted is on the log: ${refreshed}`,
        };
      },
    ),
  ];
}

async function logOf(root: () => ReturnType<typeof mindRoot>, path: string) {
  const events: { type: string; offset: number; payload?: unknown }[] = [];
  for (let after = 0; ;) {
    const page = await root().cd(path).readEvents(after, 500);
    events.push(...page.events);
    if (page.atHead || page.scannedThroughOffset <= after) return events;
    after = page.scannedThroughOffset;
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(key: string, payload: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
