// The Agents app of the default config, in a browser, as a signed-in member: the checks of
// tasks/full-stack-apps.md that need a person, which scripts/smoke/apps.ts cannot run.
//
//   node --env-file-if-exists=.secrets scripts/apps-browser-proof.ts <domain>
// ITERATE_PROTOTYPE_TOKEN     the stand-in member token for the mind's API
// ITERATE_PROOF_SESSION_FILE  a member's session at iterate.<domain>: { name, value, domain, path }
// ITERATE_PROOF_SHOTS         the folder for screenshots (default: a new temp folder)
//
// A prototype stack alone: it starts an agent and sends it one message.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { z } from "zod";
import { mindRoot } from "./smoke/lib.ts";

const PROTOTYPES = ["jispwoso.com", "afoop.com"];
const domain = process.argv[2];
const token = process.env.ITERATE_PROTOTYPE_TOKEN;
const sessionFile = process.env.ITERATE_PROOF_SESSION_FILE;
if (!domain || !PROTOTYPES.includes(domain) || !token || !sessionFile) {
  console.error(
    `usage: node --env-file-if-exists=.secrets scripts/apps-browser-proof.ts <${PROTOTYPES.join("|")}>\n  needs ITERATE_PROTOTYPE_TOKEN and ITERATE_PROOF_SESSION_FILE`,
  );
  process.exit(2);
}
const session = z
  .object({
    name: z.string(),
    value: z.string(),
    domain: z.string(),
    path: z.string(),
    email: z.string().optional(),
  })
  .parse(JSON.parse(readFileSync(sessionFile, "utf8")));
const shots = process.env.ITERATE_PROOF_SHOTS || mkdtempSync(join(tmpdir(), "apps-proof-"));
mkdirSync(shots, { recursive: true });
const app = `https://agents.${domain}`;
const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail });
  console.log(`${pass ? "pass" : "FAIL"}  ${check}: ${detail}`);
};

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const { email: _email, ...cookie } = session;
  await context.addCookies([{ ...cookie, secure: true, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${String(error).slice(0, 200)}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text().slice(0, 200)}`);
  });
  const sockets: { url: string; closed: boolean }[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  page.on("websocket", (socket) => {
    const seen = { url: socket.url(), closed: false };
    sockets.push(seen);
    socket.on("close", () => (seen.closed = true));
  });

  // 1. the page: the host signs the member in by redirects alone, and serves the folder
  await page.goto(`${app}/`, { waitUntil: "domcontentloaded" });
  const shell = page.getByText("New agent", { exact: true }).first();
  await shell.waitFor({ timeout: 45_000 }).catch(() => {});
  const drawn = await shell.isVisible().catch(() => false);
  await page.screenshot({ path: join(shots, "1-home.png") });
  record(
    "the Agents app's page draws for a member, with no build",
    drawn && new URL(page.url()).origin === app,
    `at ${page.url()}; ${problems.length ? problems.slice(0, 3).join(" | ") : "no page errors"}`,
  );
  const refusals = problems.filter((problem) => /^[45]\d\d /.test(problem));
  const foot = await page.locator("body").innerText();
  record(
    "the sidebar shows who is signed in, and every request of the page is answered",
    Boolean(session.email) && foot.includes(session.email!.slice(0, 12)) && !refusals.length,
    `${session.email ? `${session.email} shown: ${foot.includes(session.email.slice(0, 12))}` : "the session file names no email"}; refused: ${refusals.join(", ") || "none"}`,
  );
  const itxSocket = sockets.find((socket) => new URL(socket.url).pathname === "/itx");
  record(
    "the page's socket to /itx opens and stays open",
    Boolean(itxSocket) && !itxSocket!.closed,
    itxSocket ? `${itxSocket.url}, closed: ${itxSocket.closed}` : "the page opened no /itx socket",
  );

  // 2. a new agent, started and messaged from the page
  const said = `Say the word pineapple and nothing else. (${crypto.randomUUID().slice(0, 8)})`;
  await page.getByRole("textbox", { name: "Message a new agent" }).fill(said);
  await page.getByRole("button", { name: "Start agent", exact: true }).click();
  await page
    .waitForURL((url) => url.searchParams.has("agent"), { timeout: 60_000 })
    .catch(() => {});
  const path = new URL(page.url()).searchParams.get("agent") || "";
  await page.waitForTimeout(20_000);
  await page.screenshot({ path: join(shots, "2-chat.png") });
  const body = await page.locator("body").innerText();
  record(
    "a message from the page starts an agent, and its chat shows",
    // in the member's own folder, or at the top for a person with no address
    /^\/agents\/(people\/[^/]+\/)?web\//.test(path) && body.includes(said.slice(0, 30)),
    `agent ${path || "(none)"}; answered: ${/pineapple/i.test(body.replace(said, ""))}`,
  );

  // 3. the log says how an event came. What the page appends itself is the member's, through the
  // page. Words sent with `itx.agents.get(path).message()` are appended by the agent's own facet,
  // as an `agent/message-received`: the member who asked, and the page, are on `source.onBehalfOf`.
  if (path) {
    const type = `proof/said-${crypto.randomUUID().slice(0, 8)}`;
    const appended = await page.evaluate(
      async ([agentPath, eventType, socketUrl]) => {
        // the page's own modules, through its import map: a second session of the same member
        const live = "@iterate-com/ui/live";
        const { newWebSocketRpcSession } = await import(live);
        const socket = new WebSocket(socketUrl);
        const itx = newWebSocketRpcSession(socket);
        try {
          await itx.cd(agentPath).append({ type: eventType, payload: { said: "from the page" } });
          return "appended";
        } catch (error) {
          return `refused: ${String(error).slice(0, 200)}`;
        } finally {
          socket.close();
        }
      },
      [path, type, `wss://agents.${domain}/itx`] as const,
    );
    const { events } = (await mindRoot(domain, token).cd(path).readEvents(0, 500)) as {
      events: {
        type: string;
        payload: { message?: unknown };
        source?: Record<string, unknown>;
      }[];
    };
    const mine = events.find((event) => event.type === type);
    const via = mine?.source?.via as { appPage?: string } | undefined;
    const principal = mine?.source?.principal as { email?: string } | undefined;
    record(
      "an event the page appends carries source.via.appPage, the principal and the host's grant",
      via?.appPage === `agents.${domain}` &&
        Boolean(principal?.email) &&
        Boolean(mine?.source?.grant),
      `${appended}; via ${JSON.stringify(via)}; principal ${principal?.email}; grant ${mine?.source?.grant ? "present" : "absent"}`,
    );
    const words = events.find(
      (event) =>
        event.type === "events.iterate.com/agent/message-received" &&
        JSON.stringify(event.payload.message ?? "").includes(said.slice(0, 30)),
    );
    const asked = words?.source?.onBehalfOf as
      | { principal?: { email?: string }; via?: { appPage?: string }; call?: string }
      | undefined;
    record(
      "the chat's words name the member who asked and this page, on source.onBehalfOf",
      Boolean(asked?.principal?.email) &&
        asked?.principal?.email === principal?.email &&
        asked?.via?.appPage === `agents.${domain}` &&
        asked?.call === "/agents#agents.get.message" &&
        !words?.source?.principal,
      `source ${JSON.stringify(words?.source)}`,
    );
    const label = await page
      .locator("[data-said-by]")
      .first()
      .innerText({ timeout: 15_000 })
      .catch(() => "");
    await page.screenshot({ path: join(shots, "3-said-by.png") });
    record(
      "the chat shows a label under the message: who said it, and through which page",
      Boolean(principal?.email) &&
        label.includes(principal!.email!) &&
        label.includes(`via agents.${domain}`),
      `label ${JSON.stringify(label)}`,
    );
  }

  // 4. the same member's cookie, from another origin of the mind: refused
  const other = await context.newPage();
  await other.goto(`https://${domain}/`, { waitUntil: "domcontentloaded" });
  const crossOrigin = await other.evaluate(
    (url) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(url);
        socket.addEventListener("open", () => resolve("opened"));
        socket.addEventListener("error", () => resolve("refused"));
        setTimeout(() => resolve("no answer in 10 s"), 10_000);
      }),
    `wss://agents.${domain}/itx`,
  );
  record(
    "a page of another origin cannot open the app's /itx with the member's cookie",
    crossOrigin === "refused",
    crossOrigin,
  );

  // 5. no page gets the socket by asking for it as a document
  const plain = await context.request.get(`${app}/itx`, { maxRedirects: 0 });
  record(
    "a plain request for /itx is no session and carries no serve header",
    plain.status() === 426 && !("x-iterate-serve" in plain.headers()),
    `${plain.status()}; header present: ${"x-iterate-serve" in plain.headers()}`,
  );
} finally {
  await browser.close();
}
console.log(`screenshots in ${shots}`);
process.exit(results.every((result) => result.pass) ? 0 : 1);
