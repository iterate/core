// chatgpt.ts — `iterate chatgpt connect`: A PERSON'S CHATGPT PLAN PAYS FOR THE MIND'S RESPONSES
// API REQUESTS, with nothing to paste. OpenAI's Sign in with ChatGPT for open-source tools
// (https://developers.openai.com/siwc/token-sharing-open-source) ends at a loopback address,
// http://127.0.0.1:1455/auth/callback, on the computer the browser runs on. A mind runs
// elsewhere, so this process listens there and hands the code to the mind:
//
//   1. the mind says its host id (made once, kept in its kv)
//   2. this process listens on 127.0.0.1:1455 and opens OpenAI's consent in the browser
//   3. OpenAI sends the browser back here with a code and the client it registered
//   4. the mind trades the code for tokens and keeps them, in one `itx.run` script
//
// The tokens are made inside the mind and never reach this computer. This process holds the
// PKCE verifier and the code for one sign-in, and sends both to the mind once. The names below
// are the ChatGPT integration's (the `iterate-chatgpt` package), which reads and writes the same.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { MindItx } from "../node.ts";
import { standalonePage } from "../standalone-page.ts";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
/** There is nothing to register: the sign-in starts as this client, and OpenAI registers a public
 *  client for the person during the consent and names it in the callback (`client_id`). */
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
/** The only redirect a public client gets. */
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
/** Requests for this resource are what the plan pays for. The code exchange is refused without it. */
const RESOURCE = "https://api.openai.com/v1";
/** The secret that holds the tokens: `accessToken`, `refreshToken` and `clientId`. */
const SECRET = "/secrets/chatgpt";
/** The only origins the tokens are ever sent to. */
const PIN = ["https://api.openai.com", "https://auth.openai.com"];
const HOST_KEY = "chatgpt/host";
const ACCOUNT_KEY = "chatgpt/account";
/** A sign-in the integration's Connect page has open, which this one ends. */
const PENDING_KEY = "chatgpt/pending";
/** The agents' default model: `llm.model` in agents/contract.ts. The contract module is not
 *  imported, so the CLI's bundle stays without the agents' code. */
const TEST_MODEL = "gpt-6.1-sol";
const WAIT_MS = 15 * 60_000;

export type Account = { id: string; email?: string; plan?: string; at: string };

/** The account an id token names: its OpenID `sub`, its address, and the plan when the token says.
 *  The claims are not verified: the token comes straight from OpenAI's token endpoint over TLS, and
 *  they only label the account. The function runs in the mind (`finishScript` puts its text
 *  there), so it refers to nothing outside itself. */
function accountOf(idToken: string | undefined): Account {
  let claims: Record<string, any> = {};
  const part = idToken?.split(".")[1];
  if (part) {
    try {
      const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(
        atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
        (character) => character.charCodeAt(0),
      );
      claims = JSON.parse(new TextDecoder().decode(bytes));
    } catch {}
  }
  if (typeof claims.sub !== "string" || claims.sub === "")
    throw new Error("OpenAI's answer names no account");
  const plan: unknown = claims["https://api.openai.com/auth"]?.chatgpt_plan_type;
  return {
    id: claims.sub,
    ...(typeof claims.email === "string" && { email: claims.email }),
    ...(typeof plan === "string" && { plan }),
    at: new Date().toISOString(),
  };
}

/** The exchange code the secret refreshes itself with (the platform runs it in a jail whose only
 *  egress is the secret's pin): trade the refresh token for new tokens with the client OpenAI
 *  registered. OpenAI rotates the refresh token, so the answer's is kept. */
const EXCHANGE_SOURCE = `const TOKEN_URL = ${JSON.stringify(TOKEN_URL)};
const RESOURCE = ${JSON.stringify(RESOURCE)};
export async function exchange(material, fetch) {
  if (!material.refreshToken || !material.clientId)
    throw new Error("the secret holds no refresh token or client id");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: material.clientId,
      refresh_token: material.refreshToken,
      resource: RESOURCE,
    }).toString(),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code = (body.error && body.error.code) || body.code || body.error || "";
    throw new Error(
      "ChatGPT refused the refresh (" + response.status + (typeof code === "string" && code ? " " + code : "") +
        "): connect ChatGPT again",
    );
  }
  const tokens = await response.json();
  if (!tokens.access_token) throw new Error("ChatGPT's refresh answered with no access token");
  return {
    ...material,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || material.refreshToken,
  };
}
`;

const random = () => randomBytes(32).toString("base64url");

/** OpenAI's consent page for one sign-in. `hostId` is the mind's `urn:uuid:` id: OpenAI
 *  attributes the plan's usage to it. */
export function authorizeUrl(input: {
  hostId: string;
  state: string;
  verifier: string;
  nonce: string;
}): URL {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: DYNAMIC_CLIENT_ID,
    // what the consent page calls the app; the person may rename it there
    agent_name_hint: "iterate",
    ext_agent_host_id: input.hostId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    state: input.state,
    code_challenge: createHash("sha256").update(input.verifier).digest("base64url"),
    code_challenge_method: "S256",
    nonce: input.nonce,
  }).toString();
  return url;
}

/** What a request to the callback says: another sign-in's (or a stray request), OpenAI's refusal,
 *  or the code and the client OpenAI registered. */
export type Callback =
  | { kind: "other" }
  | { kind: "error"; message: string }
  | { kind: "code"; code: string; clientId: string };

function readCallback(url: URL, state: string): Callback {
  if (url.pathname !== new URL(REDIRECT_URI).pathname || url.searchParams.get("state") !== state)
    return { kind: "other" };
  const error = url.searchParams.get("error");
  if (error)
    return {
      kind: "error",
      message: `ChatGPT did not connect: ${url.searchParams.get("error_description") ?? error}`,
    };
  const code = url.searchParams.get("code");
  const clientId = url.searchParams.get("client_id")?.trim();
  if (!code || !clientId)
    return { kind: "error", message: "OpenAI's address holds no code or names no client." };
  return { kind: "code", code, clientId };
}

/** Listen on 127.0.0.1:1455 until OpenAI's callback for `state` comes, or 15 minutes pass.
 *  `onListening` runs once the port is ours, so the browser opens only then. */
export function waitForCallback(
  state: string,
  onListening: () => void,
  port = Number(new URL(REDIRECT_URI).port),
): Promise<{ code: string; clientId: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ code: string; clientId: string }>();
  const server = createServer((request, response) => {
    const callback = readCallback(new URL(request.url || "/", REDIRECT_URI), state);
    if (callback.kind === "other") {
      response
        .writeHead(400, { "content-type": "text/plain; charset=utf-8" })
        .end("This address belongs to another sign-in.\n");
      return;
    }
    const failed = callback.kind === "error";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      standalonePage({
        title: failed ? "ChatGPT did not connect" : "Almost done",
        head: "",
        body: failed
          ? "<h1>ChatGPT did not connect</h1><p>You can close this tab. The terminal says why.</p>"
          : "<h1>Almost done</h1><p>You can close this tab. The terminal finishes the connection.</p>",
      }),
    );
    close();
    if (callback.kind === "error") reject(new Error(callback.message));
    else resolve({ code: callback.code, clientId: callback.clientId });
  });
  const timeout = setTimeout(() => {
    close();
    reject(new Error("Nobody came back from the ChatGPT sign-in within 15 minutes."));
  }, WAIT_MS);
  const close = () => {
    clearTimeout(timeout);
    server.close();
    server.closeAllConnections();
  };
  server.on("error", (error: NodeJS.ErrnoException) => {
    close();
    reject(
      error.code === "EADDRINUSE"
        ? new Error(
            `Port ${port} on 127.0.0.1 is in use, probably by a Codex sign-in. Close it and start again.`,
          )
        : error,
    );
  });
  server.listen(port, "127.0.0.1", onListening);
  return promise;
}

/** The mind's host id, made once, and who is connected now. */
function hostScript(): string {
  return `async (itx) => {
  let id = await itx.kv.get(${JSON.stringify(HOST_KEY)});
  if (!id) {
    id = crypto.randomUUID();
    await itx.kv.put(${JSON.stringify(HOST_KEY)}, id);
  }
  const account = JSON.parse((await itx.kv.get(${JSON.stringify(ACCOUNT_KEY)})) || "null");
  return {
    hostId: "urn:uuid:" + id,
    connected: (await itx.secrets.list()).some((secret) => secret.path === ${JSON.stringify(SECRET)}),
    email: account?.email,
  };
}`;
}

/** The mind trades the code for tokens and keeps them: the secret, its refresh code, and the
 *  account. It answers only `{ email, plan }`. Every value goes in as JSON. */
export function finishScript(input: { code: string; clientId: string; verifier: string }): string {
  return `async (itx) => {
  const accountOf = ${accountOf.toString()};
  const answer = await fetch(${JSON.stringify(TOKEN_URL)}, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(${JSON.stringify({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    })}).toString(),
  });
  if (!answer.ok)
    throw new Error("OpenAI would not hand over tokens (HTTP " + answer.status + ": " + (await answer.text()).slice(0, 200) + "). Start again.");
  const tokens = await answer.json();
  if (!tokens.access_token || !tokens.refresh_token)
    throw new Error("OpenAI's answer holds no access or refresh token. Start again.");
  if (!String(tokens.scope || "").split(/\\s+/).includes("chatgpt.tokens.use.direct"))
    throw new Error("OpenAI did not grant the plan's usage to this sign-in. Is this a Plus or Pro personal account?");
  const account = accountOf(tokens.id_token);
  await itx.secrets.set(
    ${JSON.stringify(SECRET)},
    { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, clientId: ${JSON.stringify(input.clientId)} },
    { urls: ${JSON.stringify(PIN)}, refresh: { kind: "worker", source: ${JSON.stringify(EXCHANGE_SOURCE)} } },
  );
  await itx.kv.put(${JSON.stringify(ACCOUNT_KEY)}, JSON.stringify(account));
  await itx.kv.delete(${JSON.stringify(PENDING_KEY)});
  return { email: account.email, plan: account.plan };
}`;
}

/** One Responses request the plan pays for, sent from the mind; it answers the text. */
function testScript(): string {
  return `async (itx) => {
  const response = await fetch(${JSON.stringify(`${RESOURCE}/responses`)}, {
    method: "POST",
    headers: {
      authorization: ${JSON.stringify(`Bearer getSecret(${JSON.stringify(SECRET)}, { field: "accessToken" })`)},
      "content-type": "application/json",
    },
    // a plan's token answers only a stream, keeps nothing, and takes input as a list
    body: JSON.stringify({
      model: ${JSON.stringify(TEST_MODEL)},
      input: [{ role: "user", content: "Reply with the single word: ready" }],
      reasoning: { effort: "low" },
      stream: true,
      store: false,
    }),
  });
  const stream = await response.text();
  if (!response.ok) throw new Error("OpenAI answered " + response.status + ": " + stream.slice(0, 300));
  let text = "";
  for (const line of stream.split("\\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5));
      if (event.type === "response.output_text.delta") text += event.delta;
    } catch {}
  }
  return text.trim();
}`;
}

/** The whole sign-in against a connected mind. `openBrowser` prints and opens the consent page. */
export async function connectChatgpt(input: {
  itx: MindItx;
  address: string;
  test: boolean;
  print: (line: string) => void;
  openBrowser: (url: URL) => void | Promise<void>;
}): Promise<{ message: string; test?: string }> {
  const { itx, address, print } = input;
  const mind = (await itx.run(hostScript())) as {
    hostId: string;
    connected: boolean;
    email?: string;
  };
  if (mind.connected)
    print(
      `${address} has a ChatGPT plan already (${mind.email || "an account it does not name"}). This sign-in replaces it.`,
    );
  const state = random();
  const verifier = random();
  const url = authorizeUrl({ hostId: mind.hostId, state, verifier, nonce: random() });
  const callback = await waitForCallback(state, () => {
    print("Sign in with a personal ChatGPT Plus or Pro account, and allow iterate.");
    void input.openBrowser(url);
    print("Waiting for the browser to come back (15 minutes at most)...");
  });
  print(`Signed in. ${address} now gets its tokens from OpenAI...`);
  const account = (await itx.run(finishScript({ ...callback, verifier }))) as {
    email?: string;
    plan?: string;
  };
  const message = `Connected ${account.email || "an account"}${account.plan ? ` (${account.plan})` : ""} to ${address}. The mind keeps the tokens in ${SECRET} and refreshes them itself.`;
  if (!input.test) return { message };
  print("Connected. A test request on the plan...");
  return { message, test: (await itx.run(testScript())) as string };
}
