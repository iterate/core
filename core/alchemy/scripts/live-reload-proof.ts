// An app's page takes a new commit by itself (core/configs/default/apps/live-reload/live-reload.js),
// in a browser, as a signed-in member, against a prototype stack whose config repo has the
// template's apps.
//
//   node --env-file-if-exists=.secrets scripts/live-reload-proof.ts <domain>
// ITERATE_PROTOTYPE_TOKEN     the stand-in member token for the mind's API: it commits
// ITERATE_PROOF_SESSION_FILE  a member's session at iterate.<domain>: { name, value, domain, path }
// ITERATE_PROOF_SHOTS         the folder for screenshots (default: a new temp folder)
//
// It commits to the config repo three times: a stylesheet's change, a script's change, and the two
// files as they were. The Docs app is the page: it reads the repo and starts no agent.
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
    `usage: node --env-file-if-exists=.secrets scripts/live-reload-proof.ts <${PROTOTYPES.join("|")}>\n  needs ITERATE_PROTOTYPE_TOKEN and ITERATE_PROOF_SESSION_FILE`,
  );
  process.exit(2);
}
const session = z
  .object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string() })
  .parse(JSON.parse(readFileSync(sessionFile, "utf8")));
const shots = process.env.ITERATE_PROOF_SHOTS || mkdtempSync(join(tmpdir(), "live-reload-proof-"));
mkdirSync(shots, { recursive: true });
const app = `https://docs.${domain}`;
const STYLES = "apps/docs/public/app.css";
const SCRIPT = "apps/docs/public/app.js";
const marker = crypto.randomUUID().slice(0, 8);

const root = () => mindRoot(domain, token);
const repo = () => root().repos.get("/repos/config");
/** A commit, and its publication: the page hears of the same event. */
async function commit(message: string, changes: { path: string; content: string }[]) {
  // the tip first: the API's session is one round trip, and ends at the first await after it is made
  const parent = await repo().tip();
  const { commitOid } = await repo().commitFiles({ message, changes, parent });
  if (!commitOid) throw new Error(`${message}: the commit changed nothing`);
  const outcome = z
    .object({ type: z.string(), payload: z.object({ error: z.string().optional() }) })
    .parse(
      await root().waitForEvent({
        type: [
          "events.iterate.com/mind/worker-updated",
          "events.iterate.com/mind/worker-update-failed",
        ],
        payload: { commitOid },
        afterOffset: 0,
        timeoutMs: 120_000,
      }),
    );
  if (outcome.type !== "events.iterate.com/mind/worker-updated")
    throw new Error(`commit ${commitOid} was not published: ${outcome.payload.error}`);
  return commitOid;
}

let step = 0;
function must(condition: unknown, why: string): asserts condition {
  if (!condition) throw new Error(why);
}

const files = await repo().listFiles();
must(
  files.paths.includes("apps/live-reload/live-reload.js"),
  "the config repo has no apps/live-reload/live-reload.js: deploy a build whose template has it",
);
/** A file of the repo that is text. */
const textOf = async (path: string) => z.string().parse(await repo().readFile(path));
const before = { styles: await textOf(STYLES), script: await textOf(SCRIPT) };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addCookies([{ ...session, secure: true, httpOnly: true, sameSite: "Lax" }]);
// EVERY FRAME OF EVERY DOCUMENT OF THE APP says what a person sees of the app: whether what was
// held from before the reload is over it, and what the app's own element shows under that. Kept
// across the reload in the tab's own storage.
await context.addInitScript(`
  if (location.hostname.startsWith("docs.")) {
    const frames = [];
    const sample = () => {
      const live = document.getElementById("root");
      if (live)
        frames.push({
          covered: Boolean(document.querySelector("[inert][aria-hidden]")),
          shows: (live.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40),
        });
      if (frames.length < 900) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    window.proofFrames = () => frames;
  }
`);
const page = await context.newPage();
const problems: string[] = [];
page.on("pageerror", (error) => problems.push(String(error).slice(0, 200)));

async function run(title: string, body: () => Promise<string>) {
  step += 1;
  try {
    const detail = await body();
    await page.screenshot({ path: join(shots, `${step}.png`) });
    console.log(`pass  ${step}. ${title}  (${detail})`);
  } catch (error) {
    await page.screenshot({ path: join(shots, `${step}-failed.png`) }).catch(() => undefined);
    console.log(
      `FAIL  ${step}. ${title}  (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
    );
    await restore().catch(() => undefined);
    await browser.close();
    process.exit(1);
  }
}
/** The Docs app's two files as they were before the proof. */
async function restore() {
  const now = { styles: await textOf(STYLES), script: await textOf(SCRIPT) };
  const changes = [
    ...(now.styles === before.styles ? [] : [{ path: STYLES, content: before.styles }]),
    ...(now.script === before.script ? [] : [{ path: SCRIPT, content: before.script }]),
  ];
  if (changes.length) await commit("live-reload-proof: the Docs app as it was", changes);
}
/** Until `expression` is true in the page. Asked from here, a few times a second: a page's own
 *  rules may refuse a script that polls inside it, and a reload ends whatever ran in the page. */
async function shown(expression: string, seconds: number) {
  for (const end = Date.now() + seconds * 1000; ; await page.waitForTimeout(200)) {
    const yes = await page.evaluate(expression).catch(() => false);
    if (yes === true) return;
    if (Date.now() > end) throw new Error(`not within ${seconds} s: ${expression.slice(0, 80)}`);
  }
}
/** Whether this document is the one the proof marked: a reload makes a new one. */
const sameDocument = async () => z.boolean().parse(await page.evaluate(`"proofMarked" in window`));
const mark = () => page.evaluate(`void (window.proofMarked = true)`);
const drawn = () =>
  page.getByText("worker.ts", { exact: true }).first().waitFor({ timeout: 45_000 });

console.log(
  `proving that an app's page takes a commit by itself, on ${app}; screenshots in ${shots}`,
);

await run("the Docs app draws for a member, with the shared script loaded", async () => {
  await page.goto(`${app}/`, { waitUntil: "domcontentloaded" });
  await drawn();
  const loaded = await page.evaluate(
    `performance.getEntriesByType("resource").some((entry) => entry.name.endsWith("/live-reload.js"))`,
  );
  must(loaded, "the page did not load /live-reload.js");
  await mark();
  return `at ${page.url()}`;
});

await run("a commit that changes a stylesheet changes the page, and nothing reloads", async () => {
  await commit("live-reload-proof: a stylesheet's change", [
    {
      path: STYLES,
      content: `${before.styles}\n:root {\n  --live-reload-proof: "${marker}";\n}\n`,
    },
  ]);
  const at = Date.now();
  await shown(
    `getComputedStyle(document.documentElement).getPropertyValue("--live-reload-proof").includes("${marker}")`,
    30,
  );
  must(await sameDocument(), "the page reloaded for a stylesheet");
  const sheets = await page.locator('link[rel="stylesheet"][href^="/app.css"]').count();
  must(sheets === 1, `the page has ${sheets} links to its stylesheet`);
  return `the new rule showed ${Math.round((Date.now() - at) / 100) / 10} s after the publication, in the same document, with one link to /app.css`;
});

await run("a commit that changes a script waits while somebody types in the page", async () => {
  // a field of the proof's own, with text in it and the caret in it
  await page.evaluate(`{
    const field = document.createElement("textarea");
    field.id = "proof-typing";
    field.style.cssText = "position:fixed;bottom:8px;right:8px;z-index:9";
    document.body.append(field);
  }`);
  await page.locator("#proof-typing").fill("half a message");
  await page.locator("#proof-typing").focus();
  await commit("live-reload-proof: a script's change", [
    {
      path: SCRIPT,
      content: `${before.script}\ndocument.documentElement.dataset.liveReloadProof = "${marker}";\n`,
    },
  ]);
  // the publication is served within five seconds, and the page looks eight times a second apart
  await page.waitForTimeout(12_000);
  must(await sameDocument(), "the page reloaded under a person who was typing");
  return "12 s after the publication the document is the same, and the text is in the field";
});

await run(
  "when the person leaves the field the page reloads by itself, and what they saw stays until the app has drawn again",
  async () => {
    await page.evaluate(`document.getElementById("proof-typing").blur()`);
    await shown(`document.documentElement.dataset.liveReloadProof === "${marker}"`, 30);
    must(!(await sameDocument()), "the script changed with no reload: not what this proof expects");
    await drawn();
    // the cover goes 400 ms after the app last changed its element
    await page.locator("[inert][aria-hidden]").waitFor({ state: "detached", timeout: 10_000 });
    const frames = z
      .array(z.object({ covered: z.boolean(), shows: z.string() }))
      .parse(await page.evaluate("window.proofFrames()"));
    const held = frames.filter((frame) => frame.covered).length;
    // a frame with no cover in which the app's element showed nothing of the app
    const bare = frames.filter(
      (frame) =>
        !frame.covered && !frame.shows.includes("worker.ts") && !frame.shows.includes("Docs"),
    );
    must(held > 0, "nothing was held over the app after the reload");
    must(
      bare.length === 0,
      `${bare.length} of ${frames.length} frames showed the app bare: "${bare[0]?.shows}"`,
    );
    return `the new script ran in a new document; of ${frames.length} frames, ${held} showed what was held and none showed the app bare`;
  },
);

await run("the proof puts the Docs app back as it was, and the page takes that too", async () => {
  await mark();
  await restore();
  await shown(`!("proofMarked" in window)`, 40);
  await drawn();
  must(!problems.length, `the page threw: ${problems.slice(0, 2).join(" | ")}`);
  return "the page reloaded for the script as it was; no page error in the whole run";
});

await browser.close();
console.log(`proven: ${step} of ${step}`);
process.exit(0);
