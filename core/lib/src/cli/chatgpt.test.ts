// chatgpt.test.ts — `iterate chatgpt connect` without OpenAI: the consent URL, what the callback
// listener does with each request, and the finish script's text.
import { createHash } from "node:crypto";
import { expect, onTestFinished, test, vi } from "vitest";
import { authorizeUrl, finishScript, waitForCallback } from "./chatgpt.ts";

test("the consent URL asks OpenAI for the plan's usage, for this project's host id, with PKCE", () => {
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

test("the listener answers another sign-in's callback 400 and stays open, then takes the code", async () => {
  const { promise: listening, resolve } = Promise.withResolvers<void>();
  const port = 41455;
  const callback = waitForCallback("s", resolve, port);
  await listening;
  const base = `http://127.0.0.1:${port}/auth/callback`;
  const stray = await fetch(`${base}?state=other&code=c&client_id=x`);
  const answered = await fetch(`${base}?state=s&code=c&client_id=oaiapp_1`);
  expect({
    stray: stray.status,
    answered: answered.status,
    page: (await answered.text()).includes("You can close this tab"),
    callback: await callback,
  }).toEqual({
    stray: 400,
    answered: 200,
    page: true,
    callback: { code: "c", clientId: "oaiapp_1" },
  });
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
  // the script runs as the project would run it, with fetch and itx recorded
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
