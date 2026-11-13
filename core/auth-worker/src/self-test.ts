// self-test.ts — THE OWNER'S SELF-TEST at `/self-test`: real checks of this stack, run as the
// signed-in member. The server half (`/self-test/facts`) looks from outside, as the public would, and
// reads this Worker's own tables. The page's half signs in as a standard MCP client (registration,
// consent, token) and runs short scripts through `/mcp`, so each runs with the member's own grant.
import { platformOriginOf, mindMcpUrlOf } from "iterate/mind-api";
import { sessionOf } from "./cookies.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { CLOUD_ACTOR } from "./key-rules.ts";
import { passkeyOwedResponse, standingOf } from "./members.ts";
import { notMemberPage, page, text } from "./pages.ts";
import { signInHref } from "./sign-in.ts";

const SELF_TEST_PATH = "/self-test";
const FACTS_PATH = `${SELF_TEST_PATH}/facts`;

type Result = { id: string; pass: boolean | null; detail: string };

export async function selfTestResponse(env: Env, request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname !== SELF_TEST_PATH && pathname !== FACTS_PATH) return null;
  if (request.method !== "GET") return new Response("Method not allowed\n", { status: 405 });
  const session = await sessionOf(env, request);
  const facts = pathname === FACTS_PATH;
  if (!session)
    return facts
      ? Response.json({ error: "signed out" }, { status: 401 })
      : Response.redirect(`${issuerOf(env)}${signInHref(env, SELF_TEST_PATH)}`, 302);
  const standing = await standingOf(env, session);
  const { domain } = iterateConfigOf(env);
  if (standing === "not-member")
    return facts
      ? Response.json({ error: "not a member" }, { status: 403 })
      : notMemberPage({ domain, email: session.email });
  if (standing === "passkey-owed")
    return facts
      ? Response.json({ error: "add a passkey first" }, { status: 403 })
      : passkeyOwedResponse(SELF_TEST_PATH);
  if (facts)
    return Response.json(
      { email: session.email, results: await serverResults(env, session.userId) },
      { headers: { "cache-control": "no-store" } },
    );
  return selfTestPage(env, session.email);
}

async function serverResults(env: Env, userId: string): Promise<Result[]> {
  const { domain, keys = [] } = iterateConfigOf(env);
  const attempt = async (id: string, run: () => Promise<Omit<Result, "id">>): Promise<Result> => {
    try {
      return { id, ...(await run()) };
    } catch (error) {
      return { id, pass: false, detail: error instanceof Error ? error.message : String(error) };
    }
  };
  const status = async (url: string, init: RequestInit = {}) => {
    const answer = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      ...init,
    });
    await answer.body?.cancel();
    return answer;
  };
  const agents = `https://agents.${domain}`;
  return Promise.all([
    attempt("apex", async () => {
      const { status: code } = await status(`https://${domain}/`);
      return { pass: code < 500, detail: `https://${domain}/ answered ${code}.` };
    }),
    attempt("host", async () => {
      const url = `https://self-test-${crypto.randomUUID().slice(0, 8)}.${domain}/`;
      const { status: code } = await status(url);
      return { pass: code < 500, detail: `${url} answered ${code}.` };
    }),
    attempt("https", async () => {
      const answer = await status(`http://${domain}/`);
      const location = answer.headers.get("location") || "";
      return {
        pass: answer.status >= 300 && answer.status < 400 && location.startsWith("https://"),
        detail: `http://${domain}/ answered ${answer.status}${location ? ` to ${location}` : ""}.`,
      };
    }),
    attempt("agents-app", async () => {
      const pageAnswer = await status(`${agents}/`, {
        headers: {
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          accept: "text/html",
        },
      });
      const socket = await status(`${agents}/itx`, {
        headers: { upgrade: "websocket", origin: agents },
      });
      const toSignIn = (pageAnswer.headers.get("location") || "").startsWith(
        `${platformOriginOf(domain)}/oauth2/auth`,
      );
      const challenged = /realm="iterate"/.test(socket.headers.get("www-authenticate") || "");
      return {
        pass: pageAnswer.status === 302 && toSignIn && socket.status === 401 && challenged,
        detail: `The page sent a signed-out visitor to sign in: ${toSignIn ? "yes" : `no (${pageAnswer.status})`}. Its live connection asked for sign-in: ${challenged ? "yes" : `no (${socket.status})`}.`,
      };
    }),
    attempt("passkey", async () => {
      const row = await env.DB.prepare(
        "select count(*) as n from keys where user_id = ?1 and revoked_at is null and credential_id is not null",
      )
        .bind(userId)
        .first<{ n: number }>();
      const n = row?.n || 0;
      return { pass: n > 0, detail: `You signed in with a passkey, and you have ${n}.` };
    }),
    attempt("first-owner", async () => {
      const row = await env.DB.prepare("select count(*) as n from spent_tickets").first<{
        n: number;
      }>();
      return row?.n
        ? { pass: true, detail: "The link from the wizard was used to sign in." }
        : {
            pass: null,
            detail: "No link from the wizard was used here: you signed in another way.",
          };
    }),
    attempt("cloud-key", async () => {
      const row = await env.DB.prepare(
        "select count(*) as n from keys where actor = ?1 and revoked_at is null",
      )
        .bind(CLOUD_ACTOR)
        .first<{ n: number }>();
      const trusted = keys.some((key) => key.actor === CLOUD_ACTOR) || Boolean(row?.n);
      return {
        pass: trusted,
        detail: trusted
          ? "This mind trusts the iterate Cloud's key."
          : "This mind does not trust the iterate Cloud's key.",
      };
    }),
  ]);
}

function selfTestPage(env: Env, email: string) {
  const { domain } = iterateConfigOf(env);
  const data = {
    domain,
    issuer: issuerOf(env),
    mcp: mindMcpUrlOf(domain),
    email,
    cloud: env.CLOUD_ORIGIN || null,
  };
  return page({
    title: `Self-test of ${domain}`,
    wide: true,
    body: `<h1>Self-test of ${text(domain)}</h1>
      <p>These checks use your mind for real, as you: they send mail, call the internet, use a throwaway secret and ask the agents' model one short question.</p>
      <p class="muted">The checks connect to your mind the way Claude Code does, so a consent page comes first: choose Allow there.</p>
      <p><button type="button" id="run">Run the self-test</button></p>
      <p id="summary" role="status"></p>
      <ul id="checks" class="stack"></ul>
      <p id="back" hidden></p>
      <p><a href="/">Back to the Dash</a></p>`,
    script: `const DATA = ${JSON.stringify(data).replaceAll("<", "\\u003c")};\n${SCRIPT}`,
  });
}

// What each check is called, in the order shown. "server": /self-test/facts; "page": this page;
// "run": a script through the MCP server's `run` tool, as the member.
const CHECKS: [id: string, name: string, help: string][] = [
  [
    "issuer",
    "iterate answers at your platform address",
    "Wait a few minutes after a deploy for the certificate, then run the self-test again. If it still fails, deploy again from the wizard.",
  ],
  [
    "apex",
    "Your domain's home page answers",
    "Check that the domain's DNS records in Cloudflare still point at iterate (an AAAA record 100:: for the domain, proxied), then deploy again from the wizard.",
  ],
  [
    "host",
    "Any name under your domain reaches your mind",
    "Check the wildcard DNS record (*.your domain, AAAA 100::, proxied) in Cloudflare, then deploy again from the wizard.",
  ],
  [
    "https",
    "http:// addresses move to https://",
    "Turn on Always Use HTTPS for the domain in Cloudflare, under SSL/TLS, Edge Certificates.",
  ],
  ["passkey", "You are signed in with a passkey", "Add a passkey on Your keys."],
  [
    "first-owner",
    "The link from the wizard signed you in",
    "Nothing to do: this only says how you first signed in.",
  ],
  [
    "mcp",
    "Apps like Claude Code can connect to your mind (MCP)",
    "Run the self-test again. If it fails again, deploy again from the wizard, and tell iterate what this line says.",
  ],
  [
    "mail-round",
    "Mail sent from your mind comes back to it",
    "In Cloudflare, open the domain, then Email, Email Routing: it must be on, with a catch-all rule that sends to a Worker. Then deploy again from the wizard.",
  ],
  [
    "mail-owner",
    "Mail to you was accepted for delivery",
    "In Cloudflare, open the domain, then Email, Email Sending: the domain must be verified. New accounts can send to their own address only until Cloudflare raises the limit.",
  ],
  [
    "http-out",
    "Your mind's code can reach the internet",
    "Run the self-test again. If it fails again, deploy again from the wizard.",
  ],
  [
    "secret",
    "A secret is filled in on the way out, and your code never sees it",
    "Run the self-test again. If it fails again, deploy again from the wizard, and tell iterate what this line says.",
  ],
  [
    "model",
    "The agents' model answers",
    "Set up AI agents in the wizard: connect an AI provider or buy credit for Cloudflare's AI Gateway.",
  ],
  [
    "agents-app",
    "The Agents app answers at agents.<domain>",
    "Deploy again from the wizard. If the mind's config has no Agents app, this check fails until it has one.",
  ],
  [
    "cloud",
    "The iterate Cloud is connected, so it can pass on webhooks",
    "Open the wizard for this domain: it connects the Cloud once the deploy answers. A mind deployed without the wizard has no Cloud, and this check stays failed.",
  ],
];

// The scripts run in the mind's own code and return JSON; the page writes in DOMAIN and OWNER.
const RUN_SCRIPTS = {
  "mail-round": `async (itx) => {
  const marker = crypto.randomUUID().slice(0, 8);
  const subject = "iterate self-test " + marker;
  const sent = await itx.email.send({ to: "self-test-" + marker + "@" + DOMAIN, subject, text: "A check of the self-test: this mail goes out and comes back." });
  const back = await itx.cd("/integrations/email").waitForEvent({ type: "events.iterate.com/email/received", payload: { subject }, afterOffset: sent.offset, timeoutMs: 120000 }).catch((error) => null);
  return back ? { pass: true, detail: "It went out and came back within two minutes." } : { pass: false, detail: "It went out (" + sent.type + "), and did not come back within two minutes." };
}`,
  "mail-owner": `async (itx) => {
  const sent = await itx.email.send({ to: OWNER, subject: "Your iterate mind can send mail", text: "This is the self-test of " + DOMAIN + ". Your mind sent this mail, so mail out works. Nothing to do." });
  return { pass: sent.type === "events.iterate.com/email/sent", detail: "Cloudflare took the mail to " + OWNER + " (" + sent.type + "). Look for it in your inbox." };
}`,
  "http-out": `async (itx) => {
  const answer = await itx.fetch(new Request("https://example.com/"));
  await answer.body?.cancel();
  return { pass: answer.status === 200, detail: "https://example.com/ answered " + answer.status + "." };
}`,
  secret: `async (itx) => {
  const path = "/secrets/self-test-" + crypto.randomUUID().slice(0, 8);
  const value = crypto.randomUUID();
  const hash = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await itx.secrets.set(path, value, { urls: ["https://httpbin.org"] });
  try {
    const answer = await itx.fetch(new Request("https://httpbin.org/headers", { headers: { "x-self-test": 'getSecret("' + path + '")' } }));
    const body = await answer.json().catch(() => null);
    const arrived = (await hash(String(body?.headers?.["X-Self-Test"] ?? ""))) === (await hash(value));
    return { pass: answer.status === 200 && arrived, detail: "A throwaway secret went to httpbin.org: " + (arrived ? "it arrived filled in." : "it did not arrive (" + answer.status + ").") };
  } finally {
    await itx.secrets.delete(path);
  }
}`,
  model: `async (itx) => {
  const answer = await itx.ai.run("openai/gpt-6.1-sol", { input: "Reply with the one word: ok", max_output_tokens: 200 }, { returnRawResponse: true, gateway: { id: "default", skipCache: true } });
  const body = await answer.text();
  if (answer.ok) return { pass: true, detail: "The model answered through the account's AI Gateway." };
  return { pass: false, detail: "No model yet: the AI Gateway answered " + answer.status + ". " + body.slice(0, 200) };
}`,
  cloud: `async (itx) => {
  const enrolled = await itx.cd("/integrations/cloud").waitForEvent({ type: "events.iterate.com/cloud/deployment-enrolled", afterOffset: 0, timeoutMs: 3000 }).catch(() => null);
  return { pass: Boolean(enrolled), detail: enrolled ? "The Cloud has this mind's key, and its statement landed here." : "The Cloud has not enrolled this mind yet." };
}`,
};

const SCRIPT = `
const CHECKS = ${JSON.stringify(CHECKS)};
const RUN_SCRIPTS = ${JSON.stringify(RUN_SCRIPTS)};
const REDIRECT = DATA.issuer + "${SELF_TEST_PATH}";
const list = document.getElementById("checks");
const summary = document.getElementById("summary");
const button = document.getElementById("run");
const store = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} }, drop: (k) => { try { sessionStorage.removeItem(k); } catch {} } };
const rows = new Map();
for (const [id, name, help] of CHECKS) {
  const li = document.createElement("li");
  const title = document.createElement("strong");
  title.textContent = name.replace("<domain>", DATA.domain);
  const state = document.createElement("span");
  state.className = "muted";
  state.textContent = " Not run yet.";
  const detail = document.createElement("p");
  detail.className = "muted";
  li.append(title, state, detail);
  list.append(li);
  rows.set(id, { state, detail, help, name });
}
const results = {};
const show = (id, pass, detail) => {
  const row = rows.get(id);
  results[id] = pass;
  row.state.textContent = pass === true ? " Works." : pass === false ? " Failed." : pass === "running" ? " Checking…" : " Not needed.";
  row.state.className = pass === false ? "" : "muted";
  row.detail.textContent = pass === false ? detail + " What to do: " + row.help : detail;
};
const attempt = async (id, run) => {
  show(id, "running", "");
  try { const r = await run(); show(id, r.pass, r.detail); } catch (error) { show(id, false, error.message || String(error)); }
};
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const form = (fields) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

async function begin() {
  button.disabled = true;
  summary.textContent = "Registering the self-test as an app of your mind…";
  const metadata = await (await fetch("/.well-known/oauth-authorization-server")).json();
  const registered = await fetch(metadata.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "The self-test of " + DATA.domain, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }) });
  if (!registered.ok) throw new Error("The registration of the self-test as an app was refused (" + registered.status + ").");
  const client = (await registered.json()).client_id;
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64(crypto.getRandomValues(new Uint8Array(16)));
  store.set("self-test", JSON.stringify({ client, verifier, state, token: metadata.token_endpoint }));
  const challenge = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  location.assign(metadata.authorization_endpoint + "?" + new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: REDIRECT, scope: "iterate", state, code_challenge: challenge, code_challenge_method: "S256", resource: DATA.mcp }));
}

async function tokenFromRedirect() {
  const query = new URLSearchParams(location.search);
  if (!query.has("code") && !query.has("error")) return null;
  history.replaceState(null, "", location.pathname);
  const kept = JSON.parse(store.get("self-test") || "null");
  store.drop("self-test");
  if (query.has("error")) throw new Error("The consent was not given (" + query.get("error") + ").");
  if (!kept || query.get("state") !== kept.state) throw new Error("This sign-in was not started on this page. Press the button to start again.");
  const answer = await fetch(kept.token, form({ grant_type: "authorization_code", code: query.get("code"), redirect_uri: REDIRECT, client_id: kept.client, code_verifier: kept.verifier, resource: DATA.mcp }));
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok || !body.access_token) throw new Error("The token endpoint refused the code (" + answer.status + ").");
  return body.access_token;
}

// The MCP server answers in Server-Sent Events: each message is one data: line.
let rpcId = 0;
let protocolVersion = "2025-06-18";
async function mcp(token, method, params, notification) {
  const message = { jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(notification ? {} : { id: ++rpcId }) };
  const answer = await fetch(DATA.mcp, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": protocolVersion }, body: JSON.stringify(message) });
  if (notification) { await answer.body?.cancel(); return null; }
  if (!answer.ok) throw new Error(method + " answered " + answer.status + ".");
  const raw = await answer.text();
  const messages = (answer.headers.get("content-type") || "").includes("text/event-stream")
    ? raw.split("\\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(raw)];
  const reply = messages.find((m) => m.id === message.id);
  if (!reply) throw new Error(method + " gave no answer.");
  if (reply.error) throw new Error(method + ": " + reply.error.message);
  return reply.result;
}

async function runScript(token, id) {
  const script = RUN_SCRIPTS[id].replaceAll("DOMAIN", JSON.stringify(DATA.domain)).replaceAll("OWNER", JSON.stringify(DATA.email));
  const result = await mcp(token, "tools/call", { name: "run", arguments: { script } });
  if (result.isError) throw new Error(result.content?.[0]?.text || "The script failed.");
  return result.structuredContent?.result ?? JSON.parse(result.content[0].text);
}

async function runAll(token) {
  button.disabled = true;
  summary.textContent = "Running the checks. Mail can take up to two minutes.";
  const server = fetch("${FACTS_PATH}").then((r) => r.json());
  await Promise.all([
    attempt("issuer", async () => {
      const answer = await fetch("/.well-known/oauth-authorization-server");
      const doc = await answer.json().catch(() => null);
      return { pass: answer.ok && doc?.issuer === DATA.issuer, detail: "The sign-in document answered " + answer.status + (doc?.issuer ? ", issuer " + doc.issuer : "") + "." };
    }),
    ...["apex", "host", "https", "agents-app", "passkey", "first-owner"].map((id) => attempt(id, async () => {
      const facts = await server;
      const found = facts.results?.find((r) => r.id === id);
      if (!found) throw new Error(facts.error || "The stack gave no answer for this check.");
      return found;
    })),
    (async () => {
      await attempt("mcp", async () => {
        const resource = await fetch("/.well-known/oauth-protected-resource/mcp").then((r) => r.json());
        const challenge = await fetch(DATA.mcp, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
        await challenge.body?.cancel();
        if (resource.resource !== DATA.mcp || !resource.authorization_servers?.includes(DATA.issuer)) throw new Error("The MCP server's resource document names another issuer.");
        if (challenge.status !== 401) throw new Error("The MCP server answered " + challenge.status + " to a request with no sign-in, not 401.");
        if (!token) throw new Error("There is no token: the sign-in as an app did not finish.");
        const init = await mcp(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "iterate-self-test", version: "1" } });
        protocolVersion = init.protocolVersion || protocolVersion;
        await mcp(token, "notifications/initialized", undefined, true);
        const tools = await mcp(token, "tools/list", {});
        const names = (tools.tools || []).map((t) => t.name);
        return { pass: names.includes("run"), detail: "Signed in as an app, then initialize (" + (init.serverInfo?.name || "a server") + ") and tools/list (" + names.join(", ") + ")." };
      });
      if (results.mcp !== true) {
        for (const id of Object.keys(RUN_SCRIPTS)) show(id, false, "Not run: the MCP check above failed, and this check runs through it.");
        return;
      }
      await Promise.all(Object.keys(RUN_SCRIPTS).map((id) => attempt(id, async () => {
        const ran = await runScript(token, id);
        if (id !== "cloud") return ran;
        // both halves: this stack trusts the Cloud's key, and the Cloud's statement landed here
        const trusted = (await server).results?.find((r) => r.id === "cloud-key");
        return { pass: ran.pass && trusted?.pass === true, detail: (trusted?.detail || "") + " " + ran.detail };
      })));
    })(),
  ]);
  const failed = CHECKS.filter(([id]) => results[id] === false);
  const passed = CHECKS.filter(([id]) => results[id] === true).length;
  summary.textContent = failed.length ? failed.length + " of " + CHECKS.length + " checks failed. Each failed check says what to do." : "Everything works: " + passed + " checks passed.";
  button.disabled = false;
  button.textContent = "Run the self-test again";
  if (DATA.cloud) {
    const back = document.getElementById("back");
    const link = document.createElement("a");
    link.href = DATA.cloud + "/#self-test=" + encodeURIComponent(DATA.domain + ":" + passed + ":" + failed.map(([id]) => id).join(","));
    link.textContent = "Back to the wizard";
    back.replaceChildren(link);
    back.hidden = false;
  }
}

button.addEventListener("click", () => begin().catch((error) => { summary.textContent = error.message; button.disabled = false; }));
tokenFromRedirect().then(
  (token) => { if (token) return runAll(token); },
  (error) => { summary.textContent = error.message; return runAll(null); },
);`;
