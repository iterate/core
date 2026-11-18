// The default config's Dash, in a browser, as a signed-in member: each page of it on a deployed
// stack, drawn by the pinned build of @iterate-com/ui. It starts an agent from the home, with one
// message, and follows it into the agent view, the raw view, the sidebar, the Agents page and ⌘K.
//
//   node scripts/dash-browser-proof.ts <domain>
// ITERATE_PROOF_FIRST_OWNER_TICKET  a first owner's ticket: the member signs in at /keys/first
//                                   (passkey-sign-in-proof.ts, step 1). A ticket signs in once.
// ITERATE_PROOF_STORAGE_STATE       a file for the browser's storage: when it exists, the run
//                                   takes its session and needs no ticket; else the run writes it
//                                   as soon as the member is signed in, and again with the passkey.
//                                   The proof's passkey is kept beside it (`<file>.passkey.json`)
// ITERATE_PROOF_SHOTS               the folder for screenshots (default: a new temp folder)
//
// The member adds a passkey with a virtual authenticator, as passkey-sign-in-proof.ts step 2 does.
// A run that passes removes it at the end. Removing it ends the member's session, so a run that
// fails keeps both, and the next run lends the browser the kept passkey and needs no new ticket. It appends one event to the mind's root context, to see the
// explorer follow the log.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { platformOriginOf } from "iterate/mind-api";
import { z } from "zod";
import { addPasskey, authenticator, touched } from "./proof-passkeys.ts";

/** The kit's parts that only their own page loads: the home loads none of them, and of the
 *  agent's parts only the composer. */
const HEAVY = [
  "components/agent-chat/agent-chat",
  "repo-ide",
  "context-explorer",
  "analytics-page",
  "secrets-page",
  "integrations-page",
  "mcp-connect",
];
/** The sidebar, in its order: the Dash's pages, then the Apps, then the Access rows, and last the
 *  agents' "View all". */
const SIDEBAR = [
  "Home",
  "Contexts",
  "Config repo",
  "Secrets",
  "Integrations",
  "Analytics",
  "MCP",
  "Docs",
  "Voice",
  "Approvals",
  "Keys",
  "Members",
  "Self-test",
  "View all",
];

const domain = process.argv[2];
const env = process.env;
const ticket = env.ITERATE_PROOF_FIRST_OWNER_TICKET;
const stateFile = env.ITERATE_PROOF_STORAGE_STATE;
const signedIn = Boolean(stateFile && existsSync(stateFile));
if (!domain || process.argv.length > 3 || !(ticket || signedIn)) {
  console.error(
    "usage: dash-browser-proof.ts <domain>, with ITERATE_PROOF_FIRST_OWNER_TICKET or an existing ITERATE_PROOF_STORAGE_STATE",
  );
  process.exit(2);
}
const issuer = platformOriginOf(domain);
const dash = `https://dash.${domain}`;
const shots = env.ITERATE_PROOF_SHOTS || mkdtempSync(join(tmpdir(), "dash-proof-"));
mkdirSync(shots, { recursive: true });
const keptFile = stateFile && `${stateFile}.passkey.json`;
/** The passkey a failed run kept: its name on /keys, and the virtual authenticator's credential. */
const Kept = z.object({
  label: z.string(),
  // as WebAuthn.getCredentials answers it, whole: a resident credential needs its userHandle too
  credential: z.looseObject({
    credentialId: z.string(),
    isResidentCredential: z.boolean(),
    privateKey: z.string(),
    signCount: z.number(),
  }),
});
const kept =
  signedIn && keptFile && existsSync(keptFile)
    ? Kept.parse(JSON.parse(readFileSync(keptFile, "utf8")))
    : null;
const label = kept?.label || `proof ${new Date().toISOString().slice(0, 19)}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  ...(signedIn && { storageState: stateFile }),
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const authenticatorId = await authenticator(cdp, "internal", true);

// WHAT GOES WRONG ON THE WAY, for the whole run: each step fails with what happened during it
const problems: string[] = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${String(error).slice(0, 200)}`));
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console: ${message.text().slice(0, 200)}`);
});
page.on("requestfailed", (request) =>
  problems.push(`failed: ${request.url()} (${request.failure()?.errorText})`),
);
const responses: string[] = [];
page.on("response", (response) => {
  responses.push(response.url());
  if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
});
const sockets: { url: string; closed: boolean }[] = [];
page.on("websocket", (socket) => {
  const seen = { url: socket.url(), closed: false };
  sockets.push(seen);
  socket.on("close", () => (seen.closed = true));
});
/** What the run says to its new agent, the agent it started, and the member's address. */
const said = `Say the word pineapple and nothing else. (${crypto.randomUUID().slice(0, 8)})`;
let agent = "";
let member = "";

let step = 0;
let failed = 0;
/** One step: a `pass` or `FAIL` line with its detail, and a screenshot. A step fails when its
 *  body throws, or when the page had an error or a failed request while it ran. */
async function run(title: string, body: () => Promise<string>) {
  step += 1;
  // each step starts with no dialog open, so a step that failed with ⌘K open takes no other along
  for (let tries = 0; tries < 3 && (await page.getByRole("dialog").count()); tries += 1)
    await page.keyboard.press("Escape");
  const before = problems.length;
  let line: string;
  let pass = false;
  try {
    const detail = await body();
    const during = problems.slice(before);
    pass = during.length === 0;
    line = pass ? detail : `${detail}; on the way: ${during.slice(0, 4).join(" | ")}`;
  } catch (error) {
    const during = problems.slice(before);
    line = `${error instanceof Error ? error.message.split("\n")[0] : String(error)}${during.length ? `; on the way: ${during.slice(0, 4).join(" | ")}` : ""}`;
  }
  if (!pass) failed += 1;
  console.log(`${pass ? "pass" : "FAIL"}  ${step}. ${title}  (${line})`);
  await page
    .screenshot({ path: join(shots, `${step}${pass ? "" : "-failed"}.png`) })
    .catch(() => undefined);
}
function must(condition: unknown, why: string): asserts condition {
  if (!condition) throw new Error(why);
}
/** The Dash's sidebar link to one of its rows, by its name. */
const row = (name: string) =>
  page.locator('[data-slot="sidebar"]').getByRole("link", { name, exact: true });
/** Whether a page showed this note (`data-spinner`) since the run began to watch for notes. */
const sawNote = async (note: string) =>
  (await page.evaluate(`window.__notes.includes(${JSON.stringify(note)})`)) === true;
/** The page's address as the Dash writes it: the path, read as the context path it holds, and
 *  the query (`/agents/people/ada@example.com/web/x`, `/repo?view=…`). */
const addressOf = () => {
  const url = new URL(page.url());
  return decodeURI(url.pathname) + url.search;
};

console.log(`proving the Dash on ${dash}; screenshots in ${shots}`);

try {
  if (!signedIn) {
    await run("the member signs in with the first owner's ticket", async () => {
      await page.goto(`${issuer}/keys/first#${ticket}`);
      await page.waitForURL(`${issuer}/keys`);
      if (stateFile) await context.storageState({ path: stateFile });
      return `at /keys${stateFile ? "; the session is saved" : ""}`;
    });
    if (failed) throw new Error("no session: the steps after the sign-in cannot run");
  }
  if (kept)
    await run("the saved session is a member's, with the passkey a failed run kept", async () => {
      await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: kept.credential });
      await page.goto(`${issuer}/keys`);
      must(page.url() === `${issuer}/keys`, `the saved session is no session: at ${page.url()}`);
      await page.locator("li", { hasText: label }).waitFor();
      return `${label} lent to the virtual authenticator`;
    });
  else
    await run("the member adds a passkey on /keys, by the virtual authenticator", async () => {
      if (signedIn) {
        await page.goto(`${issuer}/keys`);
        must(page.url() === `${issuer}/keys`, `the saved session is no session: at ${page.url()}`);
      }
      const how = await addPasskey(page, issuer, label);
      if (stateFile && keptFile) {
        await context.storageState({ path: stateFile });
        const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
        must(credentials.length === 1, `the authenticator holds ${credentials.length} passkeys`);
        writeFileSync(keptFile, JSON.stringify({ label, credential: credentials[0] }), {
          mode: 0o600,
        });
      }
      return `${label}: ${how}${stateFile ? "; the session and the passkey are saved" : ""}`;
    });
  if (failed) throw new Error("no member's session: the Dash's steps cannot run");

  await run(
    "iterate.<domain>/ leads to the Dash's home, signed in: the composer and what waits",
    async () => {
      responses.length = 0;
      await page.goto(`${issuer}/`);
      await page.waitForURL((url) => url.origin === dash, { timeout: 30_000 });
      await page.getByPlaceholder("Message a new agent").waitFor({ timeout: 45_000 });
      await page.getByRole("heading", { name: "Waiting for you" }).waitFor();
      // a marker of this one document: a full load of the page loses it
      await page.evaluate("window.__dashProof = 1");
      return `${page.url()} shows the composer and "Waiting for you"`;
    },
  );

  await run("the home loads none of the kit's larger parts", async () => {
    await page.waitForLoadState("networkidle");
    const heavy = responses.filter((url) => HEAVY.some((part) => url.includes(part)));
    const kit = responses.filter((url) => url.includes("esm.iterate.com")).length;
    must(heavy.length === 0, `the home loaded ${heavy.join(", ")}`);
    return `${kit} modules from esm.iterate.com, none of ${HEAVY.join(", ")}`;
  });

  await run(
    "the sidebar lists the pages, the Apps and the Access rows, then the agents; Analytics says Off",
    async () => {
      const sidebar = page.locator('[data-slot="sidebar"]');
      const names = (
        await sidebar.locator('[data-slot="sidebar-menu-button"]').allInnerTexts()
      ).map((text) => text.trim());
      const listed = names.filter((name) => SIDEBAR.includes(name));
      must(
        JSON.stringify(listed) === JSON.stringify(SIDEBAR),
        `the sidebar lists ${names.join(", ")}`,
      );
      // the Agents section is the sidebar's: the Agents page has no row of its own among the pages
      await sidebar.getByText("Agents", { exact: true }).first().waitFor();
      must(!names.includes("Agents"), "the Agents page has a row among the pages");
      const analytics = sidebar
        .locator('[data-slot="sidebar-menu-item"]')
        .filter({ hasText: "Analytics" });
      await analytics.getByText("Off", { exact: true }).waitFor({ timeout: 10_000 });
      return `${listed.join(", ")}; Analytics: Off`;
    },
  );

  await run("the page's socket to /itx opens, stays open, and is the member's", async () => {
    const socket = sockets.find((seen) => new URL(seen.url).pathname === "/itx");
    must(socket, "the page opened no /itx socket");
    must(!socket.closed, `${socket.url} closed`);
    member = await page.evaluate(async (socketUrl) => {
      const live = "@iterate-com/ui/live";
      const { newWebSocketRpcSession } = await import(live);
      const itx = newWebSocketRpcSession(new WebSocket(socketUrl));
      try {
        return String((await itx.whoami()).principal?.email || "");
      } finally {
        itx[Symbol.dispose]();
      }
    }, `wss://dash.${domain}/itx`);
    must(member, "whoami named no email");
    const foot = await page.locator('[data-slot="sidebar"]').innerText();
    must(foot.includes(member.slice(0, 12)), `the sidebar does not show ${member}`);
    return `${socket.url} is open; the sidebar shows ${member}`;
  });

  await run(
    "a message from the home starts an agent in the member's folder, and its agent view shows",
    async () => {
      await page.getByPlaceholder("Message a new agent").fill(said);
      await page.getByTitle("Send message").click();
      await page.waitForURL((url) => url.pathname.startsWith("/agents/"), { timeout: 60_000 });
      // an agent's path is the URL's path, as it is
      agent = addressOf();
      must(/^\/agents\/(people\/[^/]+\/)?web\/[^?]+$/.test(agent), `the agent is ${agent}`);
      const main = page.locator("main");
      await main.getByText(said.slice(0, 30)).first().waitFor({ timeout: 30_000 });
      // the agent view's own header row, drawn once its module has loaded
      const pageHeader = page.locator("[data-page-header]");
      await pageHeader.getByRole("link", { name: "Raw view" }).waitFor({ timeout: 30_000 });
      const header = await pageHeader.innerText();
      must(header.includes(agent.slice(0, 20)), `the header says ${header}`);
      const raw = await pageHeader.getByRole("link", { name: "Raw view" }).getAttribute("href");
      must(raw === encodeURI(`/contexts${agent}`), `Raw view leads to ${raw}`);
      const answered = await main
        .getByText(/^pineapple\W*$/i)
        .first()
        .waitFor({ timeout: 60_000 })
        .then(
          () => "yes",
          () => "not in 60 s",
        );
      return `${agent}; its header and Raw view link; answered: ${answered}`;
    },
  );

  await run(
    "the log says how it came: what the page appends is the member's through dash.<domain>, and the words are on their behalf",
    async () => {
      must(agent, "no agent was started");
      const type = `proof/said-${crypto.randomUUID().slice(0, 8)}`;
      const events = await page.evaluate(
        async ([agentPath, eventType, socketUrl]) => {
          // the page's own modules, through its import map: a second session of the same member
          const live = "@iterate-com/ui/live";
          const { newWebSocketRpcSession } = await import(live);
          const itx = newWebSocketRpcSession(new WebSocket(socketUrl));
          try {
            await itx.cd(agentPath).append({ type: eventType, payload: { said: "from the page" } });
            return JSON.stringify((await itx.cd(agentPath).readEvents(0, 500)).events);
          } finally {
            // the session ends first, then its socket: a close of the socket alone leaves capnweb
            // to send the releases of its stubs on a closed socket, which the console reports
            itx[Symbol.dispose]();
          }
        },
        [agent, type, `wss://dash.${domain}/itx`] as const,
      );
      const log = z
        .array(
          z.looseObject({
            type: z.string(),
            payload: z.looseObject({ message: z.unknown().optional() }).optional(),
            source: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .parse(JSON.parse(events));
      const Source = z.looseObject({
        principal: z.looseObject({ email: z.string().optional() }).optional(),
        via: z.looseObject({ appPage: z.string().optional() }).optional(),
        call: z.string().optional(),
        grant: z.unknown().optional(),
      });
      const mine = Source.parse(log.find((event) => event.type === type)?.source || {});
      must(
        mine.via?.appPage === `dash.${domain}` && mine.principal?.email === member && mine.grant,
        `the page's event: ${JSON.stringify(mine)}`,
      );
      const words = log.find(
        (event) =>
          event.type === "events.iterate.com/agent/message-received" &&
          JSON.stringify(event.payload?.message ?? "").includes(said.slice(0, 30)),
      );
      const source = z
        .looseObject({ onBehalfOf: Source.optional(), principal: z.unknown().optional() })
        .parse(words?.source || {});
      const asked = source.onBehalfOf;
      must(
        asked?.principal?.email === member &&
          asked.via?.appPage === `dash.${domain}` &&
          asked.call === "/agents#agents.get.message" &&
          !source.principal,
        `the words' source: ${JSON.stringify(source)}`,
      );
      const label = await page.locator("[data-said-by]").first().innerText({ timeout: 15_000 });
      must(
        label.includes(member) && label.includes(`via dash.${domain}`),
        `the label under the message says ${label}`,
      );
      return `the page's event and the words name ${member} via dash.${domain}; the chat's label says "${label}"`;
    },
  );

  await run(
    "Raw view opens the agent's log on the Contexts page, and Agent view leads back",
    async () => {
      must(agent, "no agent was started");
      await page.getByRole("link", { name: "Raw view" }).click();
      must(addressOf() === `/contexts${agent}`, `at ${page.url()}`);
      await page.locator("[data-offset]").first().waitFor({ timeout: 30_000 });
      await page.getByRole("link", { name: "Agent view" }).click();
      must(addressOf() === agent, `back at ${page.url()}`);
      await page.getByText(said.slice(0, 30)).first().waitFor();
      return `${agent}: its log, then its chat again`;
    },
  );

  await run(
    "the sidebar lists the new agent, and View all is the Agents page with it",
    async () => {
      must(agent, "no agent was started");
      const sidebar = page.locator('[data-slot="sidebar"]');
      await sidebar.locator(`[data-agent-path="${agent}"]`).waitFor({ timeout: 30_000 });
      await row("View all").click();
      must(addressOf() === "/agents", `at ${page.url()}`);
      await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
      await page.locator(`main [data-agent-path="${agent}"]`).first().waitFor({ timeout: 30_000 });
      return `${agent} in the sidebar and on /agents`;
    },
  );

  await run(
    "⌘K opens on the Agents tab, finds the new agent by its path, and opens it",
    async () => {
      must(agent, "no agent was started");
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog");
      const selected = await palette
        .getByRole("tab", { name: "Agents" })
        .getAttribute("aria-selected");
      must(selected === "true", `the Agents tab is selected: ${selected}`);
      await palette.locator("input").fill(agent.split("/").at(-1)!);
      await palette.getByText(agent).first().waitFor();
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => decodeURI(url.pathname) === agent);
      return `found by ${agent.split("/").at(-1)}; Enter opened ${addressOf()}`;
    },
  );

  await run("⌘K's Raw contexts tab finds any context, and Enter opens its raw view", async () => {
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog");
    await palette.getByRole("tab", { name: "Raw contexts" }).click();
    await palette.locator("input").fill("integrations");
    await palette.getByRole("option").first().waitFor();
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.pathname.startsWith("/contexts/"));
    return `Enter opened ${addressOf()}`;
  });

  await run(
    "/ in ⌘K completes a path one segment at a time, and Enter opens the raw view",
    async () => {
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog");
      const input = palette.locator("input");
      await input.fill("/ag");
      await palette
        .getByText(/completes/)
        .first()
        .waitFor();
      await palette.getByRole("option").filter({ hasText: "/agents/" }).first().waitFor();
      await page.keyboard.press("Tab");
      const completed = await input.inputValue();
      must(completed === "/agents/", `Tab made ${completed}`);
      await palette.getByRole("option").first().waitFor();
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.pathname.startsWith("/contexts/agents/"));
      return `/ag, Tab: ${completed}; Enter opened ${addressOf()}`;
    },
  );

  // every text a page draws from here on, so that a step can ask whether a note was shown
  await page.evaluate(`(() => {
    const seen = (window.__notes = []);
    const note = () => {
      for (const element of document.querySelectorAll('[data-spinner="true"]'))
        if (element.textContent) seen.push(element.textContent.trim());
    };
    new MutationObserver(note).observe(document.body, { childList: true, subtree: true });
  })()`);

  await run("Contexts draws the root context's log, and follows it live", async () => {
    await row("Contexts").click();
    must(addressOf() === "/contexts", `at ${page.url()}`);
    const rows = page.locator("[data-offset]");
    await rows.first().waitFor({ timeout: 30_000 });
    const before = await rows.count();
    // one event on the root's log, from a second session of this member on the page's own modules
    const type = `proof/dash-${crypto.randomUUID().slice(0, 8)}`;
    const appended = await page.evaluate(
      async ([eventType, socketUrl]) => {
        const live = "@iterate-com/ui/live";
        const { newWebSocketRpcSession } = await import(live);
        const itx = newWebSocketRpcSession(new WebSocket(socketUrl));
        try {
          await itx.cd("/").append({ type: eventType, payload: { said: "the Dash's proof" } });
          return "appended";
        } catch (error) {
          return `refused: ${String(error).slice(0, 200)}`;
        } finally {
          itx[Symbol.dispose]();
        }
      },
      [type, `wss://dash.${domain}/itx`] as const,
    );
    must(appended === "appended", `the event was not appended: ${appended}`);
    await page.locator(`[data-event-type][title="${type}"]`).waitFor({ timeout: 30_000 });
    return `${before} rows of /; ${type} appended from a second session showed in the open log`;
  });

  await run(
    "Config repo lists /repos/config, and opening apps/dash/public/app.js shows its text",
    async () => {
      await row("Config repo").click();
      must(addressOf() === "/repo", `at ${page.url()}`);
      // the tree's rows are its own (pierre's, in a shadow root): one per path, by `data-item-path`
      const item = (path: string) => page.locator(`[role="treeitem"][data-item-path="${path}"]`);
      await item("agent-kinds/").waitFor({ timeout: 45_000 });
      await item("apps/").waitFor();
      // a person's click on the file's row, under apps/dash/public
      const file = "apps/dash/public/app.js";
      await item(file).click();
      await page.waitForURL((url) => url.searchParams.get("view")?.includes(file) === true);
      await page
        .locator(".cm-content")
        .getByText("THE DASH'S PAGE", { exact: false })
        .waitFor({ timeout: 30_000 });
      return `the tree lists agent-kinds/ and apps/; a click on ${file} opens it at ${decodeURIComponent(addressOf())}, and the editor shows "THE DASH'S PAGE"`;
    },
  );

  await run(
    "Secrets draws, its New secret sheet opens as a history entry, and Back closes it",
    async () => {
      await row("Secrets").click();
      must(addressOf() === "/secrets", `at ${page.url()}`);
      await page
        .getByRole("heading", { name: "Secrets", exact: true })
        .waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "New secret" }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByText("New secret", { exact: true }).waitFor();
      const opened = decodeURIComponent(addressOf());
      must(opened.includes('"new":1'), `the sheet's URL is ${opened}`);
      await page.goBack();
      await sheet.waitFor({ state: "hidden" });
      must(addressOf() === "/secrets", `after Back at ${page.url()}`);
      return `the sheet opened at ${opened} and Back closed it, at ${addressOf()}`;
    },
  );

  await run("Integrations and MCP draw, and Analytics draws the telemetry-off page", async () => {
    await row("Integrations").click();
    await page.getByRole("heading", { name: "Integrations", exact: true }).first().waitFor({
      timeout: 30_000,
    });
    await page.screenshot({ path: join(shots, `${step}-integrations.png`) });
    await row("MCP").click();
    await page.getByText("claude mcp add", { exact: false }).first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: join(shots, `${step}-mcp.png`) });
    await row("Analytics").click();
    await page
      .getByText("Telemetry is off for this mind", { exact: false })
      .waitFor({ timeout: 30_000 });
    return "Integrations: its heading; MCP: the claude mcp add command; Analytics: Telemetry is off for this mind";
  });

  await run("Back and Forward move between the pages with no full load", async () => {
    for (const name of ["Integrations", "MCP", "Analytics"]) {
      await row(name).click();
      await page.waitForURL((url) => url.pathname === `/${name.toLowerCase()}`);
    }
    const visited: string[] = [];
    for (const move of ["back", "back", "forward"] as const) {
      await (move === "back" ? page.goBack() : page.goForward());
      await page.waitForTimeout(500);
      visited.push(`${move} ${addressOf()}`);
    }
    const expected = ["back /mcp", "back /integrations", "forward /mcp"];
    must(JSON.stringify(visited) === JSON.stringify(expected), `moved: ${visited.join(", ")}`);
    await page.getByText("claude mcp add", { exact: false }).first().waitFor();
    const marker = await page.evaluate("window.__dashProof");
    must(marker === 1, "the page was loaded again: its marker is gone");
    return `${visited.join(", ")}; the document is the first one`;
  });

  await run("a sidebar click to a page already loaded shows it with no Loading note", async () => {
    await page.evaluate("window.__notes.length = 0");
    await row("Integrations").click();
    await page.getByRole("heading", { name: "Integrations", exact: true }).first().waitFor();
    await row("MCP").click();
    await page.getByText("claude mcp add", { exact: false }).first().waitFor();
    const loading = await sawNote("Loading the page…");
    const reading = await sawNote("Reading the mind…");
    must(
      !loading && !reading,
      `shown: ${loading ? "Loading the page… " : ""}${reading ? "Reading the mind…" : ""}`,
    );
    return "Integrations, then MCP: neither showed a note on the way";
  });
  await run(
    "a page of another origin cannot open the Dash's /itx with the member's cookie",
    async () => {
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
        `wss://dash.${domain}/itx`,
      );
      await other.close();
      must(crossOrigin === "refused", crossOrigin);
      return "refused";
    },
  );

  await run("a plain request for /itx is no session and carries no serve header", async () => {
    const plain = await context.request.get(`${dash}/itx`, { maxRedirects: 0 });
    must(
      plain.status() === 426 && !("x-iterate-serve" in plain.headers()),
      `${plain.status()}; header present: ${"x-iterate-serve" in plain.headers()}`,
    );
    return "426, no serve header";
  });
} catch (error) {
  console.log(`stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // A run that passed removes the proof's passkey, which signs its own removal; that ends the
  // member's session too. A run that failed keeps both for the next run.
  if (failed && keptFile && existsSync(keptFile))
    console.log(`kept: the passkey "${label}" and the session, for the next run`);
  else
    await run("the proof's passkey is removed", async () => {
      await touched(cdp, authenticatorId, true);
      await page.goto(`${issuer}/keys`);
      const mine = page
        .locator("li", { hasText: label })
        .filter({ has: page.getByRole("button", { name: "Remove" }) });
      const rows = await mine.count();
      if (!rows) return "the run added none";
      await mine.first().getByRole("button", { name: "Remove" }).click();
      await page.locator("li", { hasText: label }).waitFor({ state: "detached", timeout: 15_000 });
      // the passkey's removal ended the session: its saved state is no session for a next run
      if (keptFile) rmSync(keptFile, { force: true });
      if (stateFile) rmSync(stateFile, { force: true });
      return `${label} removed`;
    });
  await browser.close();
}
console.log(`proven: ${step - failed} of ${step}; screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
