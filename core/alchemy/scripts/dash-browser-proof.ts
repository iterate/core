// The default config's Dash, in a browser, as a signed-in member: each page of it on a deployed
// stack, drawn by the pinned build of @iterate-com/ui.
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

/** The kit's parts that only their own page loads: the overview loads none of them. */
const HEAVY = [
  "repo-ide",
  "context-explorer",
  "analytics-page",
  "secrets-page",
  "integrations-page",
  "mcp-connect",
];
/** The sidebar, in its order: the Dash's pages, then the Apps, then the Access rows. */
const SIDEBAR = [
  "Overview",
  "Contexts",
  "Config repo",
  "Secrets",
  "Integrations",
  "Analytics",
  "MCP",
  "Agents",
  "Onboarding",
  "Docs",
  "Voice",
  "Approvals",
  "Keys",
  "Members",
  "Self-test",
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

let step = 0;
let failed = 0;
/** One step: a `pass` or `FAIL` line with its detail, and a screenshot. A step fails when its
 *  body throws, or when the page had an error or a failed request while it ran. */
async function run(title: string, body: () => Promise<string>) {
  step += 1;
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
const searchOf = () => new URL(page.url()).search;

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
    "iterate.<domain>/ leads to the Dash's overview, signed in, with the member's address",
    async () => {
      responses.length = 0;
      await page.goto(`${issuer}/`);
      await page.waitForURL((url) => url.origin === dash, { timeout: 30_000 });
      await page.getByRole("heading", { name: "The mind" }).waitFor({ timeout: 45_000 });
      const words = (await page.locator("header p").first().innerText()).replace(/\s+/g, " ");
      const address = /Signed in as (\S+@\S+?)\./.exec(words)?.[1];
      must(address, `the overview says: ${words}`);
      const heading = await page.locator("h1").first().innerText();
      must(heading === domain, `the overview's heading is ${heading}`);
      // a marker of this one document: a full load of the page loses it
      await page.evaluate("window.__dashProof = 1");
      return `${page.url()} says "${words.slice(0, 80)}…"; the heading is ${heading}`;
    },
  );

  await run("the overview loads none of the kit's larger parts", async () => {
    await page.waitForLoadState("networkidle");
    const heavy = responses.filter((url) => HEAVY.some((part) => url.includes(part)));
    const kit = responses.filter((url) => url.includes("esm.iterate.com")).length;
    must(heavy.length === 0, `the overview loaded ${heavy.join(", ")}`);
    return `${kit} modules from esm.iterate.com, none of ${HEAVY.join(", ")}`;
  });

  await run(
    "the sidebar lists the pages, the Apps and the Access rows; Analytics says Off",
    async () => {
      const names = (
        await page
          .locator('[data-slot="sidebar"] [data-slot="sidebar-menu-button"]')
          .allInnerTexts()
      ).map((text) => text.trim());
      const listed = names.filter((name) => SIDEBAR.includes(name));
      must(
        JSON.stringify(listed) === JSON.stringify(SIDEBAR),
        `the sidebar lists ${names.join(", ")}`,
      );
      const analytics = page
        .locator('[data-slot="sidebar"] [data-slot="sidebar-menu-item"]')
        .filter({ hasText: "Analytics" });
      await analytics.getByText("Off", { exact: true }).waitFor({ timeout: 10_000 });
      return `${listed.join(", ")}; Analytics: Off`;
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
    must(searchOf() === "?page=contexts", `at ${page.url()}`);
    const rows = page.locator("[data-offset]");
    await rows.first().waitFor({ timeout: 30_000 });
    const before = await rows.count();
    // one event on the root's log, from a second session of this member on the page's own modules
    const type = `proof/dash-${crypto.randomUUID().slice(0, 8)}`;
    const appended = await page.evaluate(
      async ([eventType, socketUrl]) => {
        const live = "@iterate-com/ui/live";
        const { newWebSocketRpcSession } = await import(live);
        const socket = new WebSocket(socketUrl);
        const itx = newWebSocketRpcSession(socket);
        try {
          await itx.cd("/").append({ type: eventType, payload: { said: "the Dash's proof" } });
          return "appended";
        } catch (error) {
          return `refused: ${String(error).slice(0, 200)}`;
        } finally {
          socket.close();
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
      must(searchOf() === "?page=repo", `at ${page.url()}`);
      // the tree's rows are its own (pierre's, in a shadow root): one per path, by `data-item-path`
      const item = (path: string) => page.locator(`[role="treeitem"][data-item-path="${path}"]`);
      await item("agent-kinds/").waitFor({ timeout: 45_000 });
      await item("apps/").waitFor();
      // a person's click on the file's row, under apps/dash/public (apps/agents/public has one too)
      const file = "apps/dash/public/app.js";
      await item(file).click();
      await page.waitForURL((url) => url.searchParams.get("view")?.includes(file) === true);
      await page
        .locator(".cm-content")
        .getByText("THE DASH'S PAGE", { exact: false })
        .waitFor({ timeout: 30_000 });
      return `the tree lists agent-kinds/ and apps/; a click on ${file} opens it at ${decodeURIComponent(searchOf())}, and the editor shows "THE DASH'S PAGE"`;
    },
  );

  await run(
    "Secrets draws, its New secret sheet opens as a history entry, and Back closes it",
    async () => {
      await row("Secrets").click();
      must(searchOf() === "?page=secrets", `at ${page.url()}`);
      await page
        .getByRole("heading", { name: "Secrets", exact: true })
        .waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "New secret" }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByText("New secret", { exact: true }).waitFor();
      const opened = decodeURIComponent(searchOf());
      must(opened.includes('"new":1'), `the sheet's URL is ${opened}`);
      await page.goBack();
      await sheet.waitFor({ state: "hidden" });
      must(searchOf() === "?page=secrets", `after Back at ${page.url()}`);
      return `the sheet opened at ${opened} and Back closed it, at ${searchOf()}`;
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
    const visited: string[] = [];
    for (const move of ["back", "back", "forward"] as const) {
      await (move === "back" ? page.goBack() : page.goForward());
      await page.waitForTimeout(500);
      visited.push(`${move} ${searchOf()}`);
    }
    const expected = ["back ?page=mcp", "back ?page=integrations", "forward ?page=mcp"];
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
