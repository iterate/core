// chatgpt.test.ts — `iterate chatgpt connect` without OpenAI: the consent URL, what the callback
// listener does with each request, the Cloud's page it sends the browser to, and the finish
// script's text.
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  authorizeUrl,
  connectedUrl,
  finishScript,
  hostScript,
  waitForCallback,
} from "./chatgpt.ts";

test("the consent URL asks OpenAI for the plan's usage, for this mind's host id, with PKCE", () => {
  const url = authorizeUrl({
    hostId: "urn:uuid:1",
    state: "the-state",
    verifier: "the-verifier",
    nonce: "the-nonce",
  });
  expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: "dynamic_agent_client",
    agent_name_hint: "iterate",
    ext_agent_host_id: "urn:uuid:1",
    response_type: "code",
    redirect_uri: "http://127.0.0.1:1455/auth/callback",
    resource: "https://api.openai.com/v1",
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    state: "the-state",
    code_challenge: createHash("sha256").update("the-verifier").digest("base64url"),
    code_challenge_method: "S256",
    nonce: "the-nonce",
  });
});

test("the listener answers another sign-in's callback 400, then holds the code's request until the terminal step answers it", async () => {
  const { promise: listening, resolve } = Promise.withResolvers<void>();
  const port = 41455;
  const callback = waitForCallback("s", resolve, port);
  await listening;
  const base = `http://127.0.0.1:${port}/auth/callback`;
  const stray = await fetch(`${base}?state=other&code=c&client_id=x`);
  const answered = fetch(`${base}?state=s&code=c&client_id=oaiapp_1`, { redirect: "manual" });
  const { answer, ...handed } = await callback;
  // the browser waits while the mind stores the secret
  const early = await Promise.race([answered.then(() => "answered"), sleep(50).then(() => "held")]);
  answer({ kind: "redirect", to: new URL("https://cloud.example.com/connected?ai=chatgpt") });
  const response = await answered;
  expect({
    stray: stray.status,
    early,
    status: response.status,
    location: response.headers.get("location"),
    handed,
  }).toEqual({
    stray: 400,
    early: "held",
    status: 303,
    location: "https://cloud.example.com/connected?ai=chatgpt",
    handed: { code: "c", clientId: "oaiapp_1" },
  });
});

test("with no Cloud the listener's own page says whether ChatGPT connected", async () => {
  const pageAfter = async (port: number, failed: boolean) => {
    const { promise: listening, resolve } = Promise.withResolvers<void>();
    const callback = waitForCallback("s", resolve, port);
    await listening;
    const answered = fetch(`http://127.0.0.1:${port}/auth/callback?state=s&code=c&client_id=x`);
    (await callback).answer({ kind: "page", failed });
    const text = await (await answered).text();
    return text.match(/<h1>(.*?)<\/h1>/)?.[1];
  };
  expect([await pageAfter(41457, false), await pageAfter(41458, true)]).toEqual([
    "ChatGPT is connected",
    "ChatGPT did not connect",
  ]);
});

test("the Cloud's page is on the origin the mind names, and only on an origin", () => {
  expect(connectedUrl("https://cloud.example.com", "example.com")?.href).toBe(
    "https://cloud.example.com/connected?ai=chatgpt&domain=example.com",
  );
  expect(
    [null, "", "cloud.example.com", "https://cloud.example.com/x", "javascript:alert(1)"].map(
      (cloud) => connectedUrl(cloud, "example.com"),
    ),
  ).toEqual([null, null, null, null, null]);
});

test("the listener ends with OpenAI's description when the sign-in was refused", async () => {
  const { promise: listening, resolve } = Promise.withResolvers<void>();
  const port = 41456;
  const callback = waitForCallback("s", resolve, port);
  void callback.catch(() => {});
  await listening;
  await fetch(
    `http://127.0.0.1:${port}/auth/callback?state=s&error=access_denied&error_description=No+plan`,
  );
  await expect(callback).rejects.toThrow("ChatGPT did not connect: No plan");
});

test("the finish script keeps every value inside its JSON string", async () => {
  const clientId = `oaiapp_"); globalThis.leaked = ("`;
  const script = finishScript({ code: "c\nd", clientId, verifier: "v" });
  // the script runs as the mind would run it, with fetch and itx recorded
  const seen: { body?: string; material?: unknown; account?: string } = {};
  const fakeFetch = async (_url: string, init: { body: string }) => {
    seen.body = init.body;
    const claims = btoa(JSON.stringify({ sub: "u1", email: "a@example.com" }));
    return Response.json({
      access_token: "at",
      refresh_token: "rt",
      id_token: `h.${claims}.s`,
      scope: "openid chatgpt.tokens.use.direct",
    });
  };
  const itx = {
    secrets: { set: async (_path: string, material: unknown) => void (seen.material = material) },
    kv: {
      put: async (_key: string, value: string) => void (seen.account = value),
      delete: async () => {},
    },
  };
  vi.stubGlobal("fetch", fakeFetch);
  onTestFinished(() => void vi.unstubAllGlobals());
  const module = await import(
    `data:text/javascript,${encodeURIComponent(`export default ${script}`)}`
  );
  const run = module.default as (itx: unknown) => Promise<unknown>;
  expect(await run(itx)).toEqual({ email: "a@example.com" });
  expect({
    leaked: "leaked" in globalThis,
    body: Object.fromEntries(new URLSearchParams(seen.body)),
    material: seen.material,
    account: JSON.parse(seen.account!).id,
  }).toEqual({
    leaked: false,
    body: {
      grant_type: "authorization_code",
      client_id: clientId,
      code: "c\nd",
      code_verifier: "v",
      redirect_uri: "http://127.0.0.1:1455/auth/callback",
      resource: "https://api.openai.com/v1",
    },
    material: { accessToken: "at", refreshToken: "rt", clientId },
    account: "u1",
  });
});

test("the host script names the Cloud of the newest enrolment the Cloud signed, and none when no Cloud enrolled the mind", async () => {
  const module = await import(
    `data:text/javascript,${encodeURIComponent(`export default ${hostScript()}`)}`
  );
  const run = module.default as (itx: unknown) => Promise<{ cloud: string | null }>;
  const itxWith = (read: () => Promise<unknown>) => ({
    kv: { get: async () => "1", put: async () => {} },
    secrets: { list: async () => [] },
    cd: (path: string) => ({
      readEvents: path === "/integrations/cloud" ? read : async () => ({ events: [] }),
    }),
  });
  const enrolled = (cloud: unknown, actor = "iterate-cloud") => ({
    type: "events.iterate.com/cloud/deployment-enrolled",
    payload: { cloud },
    source: { signer: { principal: { actor }, key: "k" } },
  });
  const unsigned = {
    type: "events.iterate.com/cloud/deployment-enrolled",
    payload: { cloud: "https://unsigned.example.com" },
  };
  const clouds = await Promise.all(
    [
      async () => ({
        events: [
          enrolled("https://a.example.com"),
          { type: "other" },
          enrolled("https://b.example.com"),
        ],
      }),
      async () => ({ events: [] }),
      async () => ({ events: [enrolled(42)] }),
      async () => Promise.reject(new Error("no such context")),
      // an unsigned statement, or one another key signed, is ignored, even when it is newer
      async () => ({
        events: [
          enrolled("https://a.example.com"),
          unsigned,
          enrolled("https://other.example.com", "someone-else"),
        ],
      }),
      async () => ({ events: [unsigned, enrolled("https://other.example.com", "someone-else")] }),
    ].map(async (read) => (await run(itxWith(read))).cloud),
  );
  expect(clouds).toEqual([
    "https://b.example.com",
    null,
    null,
    null,
    "https://a.example.com",
    null,
  ]);
});
