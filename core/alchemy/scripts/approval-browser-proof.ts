//   node --env-file-if-exists=.secrets scripts/approval-browser-proof.ts <domain>
// ITERATE_PROTOTYPE_TOKEN       the stand-in member token for the mind's API
// ITERATE_SMOKE_PETSHOP_ORIGIN  the pet shop's origin
// ITERATE_PROOF_EMAIL           the member who signs in, by a mailed code: one with no passkey. When
//                               not a member yet, ITERATE_SMOKE_APPROVER_KEY signs the add.
// ITERATE_PROOF_CODE_COMMAND    a shell command that prints the mailed code; else it is asked on stdin
// ITERATE_PROOF_SESSION_COOKIE  a session cookie's value: no sign-in, and no ITERATE_PROOF_EMAIL needed
// ITERATE_PROOF_PASSKEY         with the session of a software passkey: that passkey's file,
//                               { credentialId, privateKey }, which signs the proof's new passkey
// ITERATE_PROOF_SHOTS           the folder for screenshots (default: a new temp folder)
// ITERATE_PROOF_DASH_ORIGIN     the hosted Dash: its Approvals page must list the request that waits
// ITERATE_PROOF_LIVE            a live stack's domain, to allow it: one approval, no rejection, and
//                               the rule, the passkey and the secret are removed at the end
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium, type Page } from "playwright";
import { platformOriginOf } from "iterate/mind-api";
import { z } from "zod";
import { addPasskey, authenticator, lendPasskey, touched } from "./proof-passkeys.ts";
import { signerOf, slackToken } from "./smoke/approvals.ts";
import { mindRoot } from "./smoke/lib.ts";

const PROTOTYPES = ["jispwoso.com", "templesteins.com"];
/** A live stack is proven only when named twice, and nothing the proof made is left on it. */
const live =
  Boolean(process.env.ITERATE_PROOF_LIVE) && process.env.ITERATE_PROOF_LIVE === process.argv[2];
const TARGETS = live ? [...PROTOTYPES, process.argv[2]!] : PROTOTYPES;
/** core/auth-worker/src/cookies.ts `SESSION_COOKIE`, which the package does not export. */
const SESSION_COOKIE = "__Host-iterate-auth-session";
const PATH = live ? "/secrets/proof-approvals" : "/secrets/approval-proof";
const TYPES = {
  requested: "events.iterate.com/secret/approval-requested",
  approved: "events.iterate.com/secret/request-approved",
  rejected: "events.iterate.com/secret/request-rejected",
  used: "events.iterate.com/secret/used",
};

const USAGE = `usage: node --env-file-if-exists=.secrets scripts/approval-browser-proof.ts <domain>
  <domain> is one of ${TARGETS.join(", ")}
  needs ITERATE_PROTOTYPE_TOKEN, ITERATE_SMOKE_PETSHOP_ORIGIN, and ITERATE_PROOF_EMAIL
  (or ITERATE_PROOF_SESSION_COOKIE); see the head of this file for the rest`;

const domain = process.argv[2];
if (!domain || domain === "--help" || domain === "-h" || process.argv.length > 3) {
  console.error(USAGE);
  process.exit(2);
}
if (!TARGETS.includes(domain)) {
  console.error(`refused: ${domain} is not one of ${TARGETS.join(", ")}`);
  process.exit(2);
}
const env = process.env;
const missing = [
  !env.ITERATE_PROTOTYPE_TOKEN && "ITERATE_PROTOTYPE_TOKEN",
  !env.ITERATE_SMOKE_PETSHOP_ORIGIN && "ITERATE_SMOKE_PETSHOP_ORIGIN",
  !env.ITERATE_PROOF_EMAIL && !env.ITERATE_PROOF_SESSION_COOKIE && "ITERATE_PROOF_EMAIL",
].filter(Boolean);
if (missing.length) {
  console.error(`set ${missing.join(", ")}\n${USAGE}`);
  process.exit(2);
}
const token = env.ITERATE_PROTOTYPE_TOKEN!;
const petshop = env.ITERATE_SMOKE_PETSHOP_ORIGIN!.replace(/\/$/, "");
const issuer = platformOriginOf(domain);
const shots = env.ITERATE_PROOF_SHOTS || mkdtempSync(join(tmpdir(), "approval-proof-"));
mkdirSync(shots, { recursive: true });

let step = 0;
async function run<T>(title: string, body: () => Promise<{ detail: string; value?: T }>) {
  step += 1;
  try {
    const { detail, value } = await body();
    console.log(`pass  ${step}. ${title}  (${detail})`);
    return value as T;
  } catch (error) {
    console.log(
      `FAIL  ${step}. ${title}  (${error instanceof Error ? error.message : String(error)})`,
    );
    // a live stack keeps nothing of a proof that failed half way
    if (live && !cleaning) console.log(`after the failure: ${await cleanUp()}`);
    else if (!cleaning) await removePasskey().catch(() => undefined);
    await browser.close();
    process.exit(1);
  }
}
let cleaning = false;
async function cleanUp(): Promise<string> {
  cleaning = true;
  const failed: string[] = [];
  const part = async (name: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      failed.push(
        `${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
    }
  };
  await part("the rule", async () => {
    await page.goto(`${issuer}/secrets/approvals`);
    const rule = page.locator("form[data-rule]", { has: page.locator("h3", { hasText: PATH }) });
    if (!(await rule.count())) return;
    await rule.getByRole("button", { name: "Remove, signed" }).click();
    await rule.waitFor({ state: "detached" });
  });
  await part("the passkey", removePasskey);
  await part("the secret", async () => {
    await root().secrets.delete(PATH);
    const left = await root().secrets.list();
    must(!left.some((secret) => secret.path === PATH), "still listed");
  });
  return failed.length
    ? `NOT REMOVED: ${failed.join("; ")}`
    : `the rule (signed), the passkey "${label}" and ${PATH} are removed`;
}

// Its authenticator ends with this browser, and a member who holds a passkey signs in with nothing
// else: a passkey left behind locks the member out.
async function removePasskey() {
  await page.goto(`${issuer}/keys`);
  const key = page.locator("li", { hasText: label });
  if (await key.getByRole("button", { name: "Remove" }).count()) {
    await key.getByRole("button", { name: "Remove" }).click();
    await page.waitForLoadState();
  }
  const listed = await page.request.get(`${issuer}/keys.json`);
  // 401: the session was this passkey's, and ended with it
  if (listed.status() === 401) return;
  const { keys } = z
    .object({ keys: z.array(z.object({ label: z.string() })) })
    .parse(await listed.json());
  must(!keys.some((key) => key.label === label), "still a live key");
}

function must(condition: unknown, why: string): asserts condition {
  if (!condition) throw new Error(why);
}

async function signIn(
  page: Page,
  { email, readCode }: { email: string; readCode: () => Promise<string> },
) {
  await page.goto(`${issuer}/sign-in/email?${new URLSearchParams({ next: "/keys" })}`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send a code" }).click();
  await page.waitForURL(`${issuer}/sign-in/email/code`);
  const code = (await readCode()).match(/\d{6}/)?.[0];
  must(code, "no six-digit code was read");
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${issuer}/keys`).catch(async () => {
    const said = await page
      .locator("strong")
      .last()
      .textContent()
      .catch(() => null);
    throw new Error(
      `not signed in: at ${new URL(page.url()).pathname}${said ? `, "${said}"` : ""}`,
    );
  });
}

async function readCode(email: string): Promise<string> {
  if (env.ITERATE_PROOF_CODE_COMMAND)
    return execSync(env.ITERATE_PROOF_CODE_COMMAND, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question(`the six-digit code mailed to ${email}: `);
  } finally {
    terminal.close();
  }
}

async function ensureMember(email: string): Promise<string> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const members = await fetch(`${issuer}/members`, { headers });
  must(members.ok, `GET /members answered ${members.status}`);
  const { config, added } = z
    .object({
      config: z.array(z.object({ email: z.string().optional() }).loose()),
      added: z.array(z.object({ email: z.string() })),
    })
    .parse(await members.json());
  const lower = email.toLowerCase();
  if (added.some((row) => row.email === lower)) return "added before";
  if (config.some((rule) => rule.email?.toLowerCase() === lower)) return "in the stack's config";
  // a token adds no one: a member's key signs the add (core/auth-worker/src/signed-change.ts)
  must(env.ITERATE_SMOKE_APPROVER_KEY, `${email} is no member: set ITERATE_SMOKE_APPROVER_KEY`);
  const signer = await signerOf(domain!, env.ITERATE_SMOKE_APPROVER_KEY);
  const answer = await fetch(`${issuer}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      await signer.sign({
        path: "/",
        type: "events.iterate.com/account/member-added",
        payload: { email },
      }),
    ),
  });
  const body = z
    .object({ error: z.string().optional() })
    .loose()
    .parse(await answer.json());
  if (answer.status === 400 && body.error?.includes("a member already")) return body.error;
  must(answer.ok, `POST /members answered ${answer.status}: ${body.error}`);
  return "added now";
}

const root = () => mindRoot(domain, token);
const team = `TPROOF${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const url = `${petshop}/api/chat.postMessage`;

/** The fake refuses any token but the real one, so a recorded message was sent with it. */
const recorded = async () =>
  z
    .object({ messages: z.array(z.object({ text: z.string() }).loose()) })
    .parse(await (await fetch(`${petshop}/__test-controls/slack/messages?team=${team}`)).json())
    .messages.map((message) => message.text);

const send = (text: string) =>
  root()
    .run(
      `async (itx) => { const response = await itx.fetch(new Request(${JSON.stringify(url)}, { method: "POST", headers: { authorization: 'Bearer getSecret("${PATH}")', "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify({ channel: "proof", text }))} })); const body = await response.text(); let ok = null; try { ok = JSON.parse(body).ok ?? null; } catch {} return { status: response.status, kind: response.headers.get("x-iterate-vault-answer"), ok, said: response.status === 200 ? "" : body.slice(0, 500) }; }`,
    )
    .then((answer) =>
      z
        .object({
          status: z.number(),
          kind: z.string().nullable(),
          ok: z.boolean().nullable(),
          said: z.string(),
        })
        .parse(answer),
    );

type LogEvent = { type: string; payload?: unknown };
async function logOf(): Promise<LogEvent[]> {
  const events: LogEvent[] = [];
  for (let after = 0; ;) {
    const page = await root().cd(PATH).readEvents(after, 500);
    events.push(...page.events);
    if (page.atHead || page.scannedThroughOffset <= after) return events;
    after = page.scannedThroughOffset;
  }
}

async function waiting(text: string): Promise<string> {
  for (let tries = 0; tries < 20; tries += 1) {
    const fact = (await logOf()).findLast(
      (event) =>
        event.type === TYPES.requested &&
        String((event.payload as { bodyStart?: unknown })?.bodyStart).includes(text),
    );
    if (fact) return String((fact.payload as { digest: unknown }).digest);
    await new Promise((settle) => setTimeout(settle, 1000));
  }
  throw new Error("no approval-requested fact on the log in 20 s");
}

async function listed(page: Page, digest: string, text: string) {
  await page.goto(`${issuer}/secrets/approvals?digest=${digest}`);
  const row = page.locator(`[id="request-${digest}"]`);
  await row.waitFor({ timeout: 10_000 });
  const legend = (await row.locator("legend").textContent())?.trim();
  must(legend === `POST ${url}`, `its line says ${JSON.stringify(legend)}`);
  const shown = (await row.locator("[data-text]").textContent()) || "";
  must(shown.includes(text), "its body is not shown");
  await page
    .locator(`[id="request-${digest}"][data-checked="${digest}"]`)
    .waitFor({ timeout: 5_000 });
}

async function choose(page: Page, digest: string, button: string) {
  const section = page.locator(`section[data-secret="${PATH}"]`);
  for (const box of await section.locator("[data-pick]:checked").all())
    if ((await box.getAttribute("data-pick")) !== digest) await box.uncheck();
  must(await section.locator(`[data-pick="${digest}"]`).isChecked(), "its box is not chosen");
  await section.getByRole("button", { name: button }).click();
}

async function gone(page: Page, digest: string) {
  for (let tries = 0; tries < 15; tries += 1) {
    await page.waitForLoadState();
    const failure = page.locator("[data-failure]");
    if (await failure.isVisible()) throw new Error(`the page says: ${await failure.textContent()}`);
    if (!(await page.locator(`[id="request-${digest}"]`).count())) return;
    await new Promise((settle) => setTimeout(settle, 1000));
    await page.reload();
  }
  throw new Error("the request is still listed after 15 s");
}

console.log(`proving approvals on ${issuer}; screenshots in ${shots}`);
console.log(
  `a stand-in: the secret ${PATH} and the pet shop's Slack fake at ${petshop}, not Gmail; the real POST to Gmail is Jonas's to do`,
);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await authenticator(cdp, "internal", true);
// the software passkey that opened the given session, on a key of its own: it signs the new passkey
const lent = env.ITERATE_PROOF_PASSKEY ? await authenticator(cdp, "usb", false) : null;
if (lent) await lendPasskey(cdp, lent, issuer, env.ITERATE_PROOF_PASSKEY!);
const label = `proof ${new Date().toISOString().slice(0, 16)}`;

const email = await run("a browser session on the issuer", async () => {
  if (env.ITERATE_PROOF_SESSION_COOKIE) {
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: env.ITERATE_PROOF_SESSION_COOKIE,
        url: issuer,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    const me = await page.request.get(`${issuer}/keys.json`);
    must(me.ok(), `GET /keys.json with the cookie answered ${me.status()}`);
    const { email } = z.object({ email: z.string() }).parse(await me.json());
    return { value: email, detail: `the given session cookie, as ${email}` };
  }
  const email = env.ITERATE_PROOF_EMAIL!;
  const membership = await ensureMember(email);
  await signIn(page, { email, readCode: () => readCode(email) });
  return { value: email, detail: `${email}, a member (${membership}), signed in by a mailed code` };
});

await run("a passkey added on /keys, by the virtual authenticator", async () => {
  const how = await addPasskey(page, issuer, label, {
    theOld: async () => lent && touched(cdp, lent, true),
  });
  if (lent) await touched(cdp, lent, false);
  const answer = await page.request.get(`${issuer}/keys.json`);
  const { keys } = z
    .object({ keys: z.array(z.object({ label: z.string(), format: z.string() })) })
    .parse(await answer.json());
  must(
    keys.some((key) => key.label === label && key.format === "webauthn"),
    "GET /keys.json does not name it",
  );
  return { detail: `"${label}" listed, and named by GET /keys.json; ${how}` };
});

const before = await run("a stand-in secret, and its rule set on /secrets/approvals", async () => {
  // the token first: the API's session is one round trip, and ends at the first await after it is made
  const tokenOfFake = await slackToken(petshop, team);
  await root().secrets.set(PATH, tokenOfFake, { urls: [petshop] });
  const host = new URL(petshop).hostname;
  await page.goto(`${issuer}/secrets/approvals`);
  const form = page.locator("form[data-rule]", { hasText: "A new rule" });
  await form.getByLabel("Secret").fill(PATH);
  await form.getByLabel("Methods").fill("POST");
  await form.getByLabel("Hosts").fill(host);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL(`${issuer}/secrets/approvals`);
  await page
    .locator("form[data-rule] h3", { hasText: PATH })
    .waitFor()
    .catch(() => {
      throw new Error("the rule is not listed after Save");
    });
  return {
    value: (await logOf()).length,
    detail: `${PATH} pinned to ${petshop}; POST to ${host} waits`,
  };
});

const first = `proof ${crypto.randomUUID()}`;
let settled = false;
const { held, digest } = await run("an agent's POST with the secret waits", async () => {
  const held = send(first);
  void held.then(
    () => (settled = true),
    () => (settled = true),
  );
  const digest = await waiting(first);
  const sent = await recorded();
  must(!settled, "the call returned");
  must(sent.length === 0, `the upstream saw ${sent.length}`);
  return {
    value: { held, digest },
    detail: `digest ${digest}; the call has not returned; the upstream saw nothing`,
  };
});

await run("the Dash lists it while it waits", async () => {
  const dash = env.ITERATE_PROOF_DASH_ORIGIN?.replace(/\/$/, "");
  if (!dash) return { detail: "skipped: ITERATE_PROOF_DASH_ORIGIN is not set" };
  const tab = await context.newPage();
  tab.setDefaultTimeout(60_000);
  const approvals = `${dash}/minds/${domain}/approvals`;
  await tab.goto(approvals, { waitUntil: "networkidle" });
  const connect = tab.getByRole("button", { name: "Connect" });
  if (await connect.isVisible()) {
    await connect.click();
    await tab.waitForURL((url) => !url.pathname.startsWith("/connect"));
  }
  if (new URL(tab.url()).pathname !== new URL(approvals).pathname)
    await tab.goto(approvals, { waitUntil: "networkidle" });
  const link = tab.locator(`a[href="${issuer}/secrets/approvals?digest=${digest}"]`);
  await link.waitFor();
  await tab.screenshot({ path: join(shots, "dash-waiting.png"), fullPage: true });
  const name = (await link.textContent())?.trim();
  await tab.close();
  return { detail: `a row with "${name}", which opens the signing page; dash-waiting.png` };
});

await run("he sees it listed, its text hashing to its id", async () => {
  await listed(page, digest, first);
  await page.screenshot({ path: join(shots, "5-listed.png"), fullPage: true });
  return { detail: `POST ${url}, its body, and the page's own check of its text; 5-listed.png` };
});

await run("he approves it with his passkey", async () => {
  await choose(page, digest, "Approve the chosen requests");
  await gone(page, digest);
  await page.screenshot({ path: join(shots, "6-approved.png"), fullPage: true });
  return { detail: "signed by the virtual authenticator; no longer listed; 6-approved.png" };
});

await run("the request goes through", async () => {
  const answer = await held;
  const sent = await recorded();
  must(
    answer.status === 200 && answer.ok === true,
    `the call returned ${answer.status}, ok ${answer.ok}`,
  );
  must(sent.length === 1 && sent[0] === first, `the upstream saw ${sent.length}`);
  return { detail: "200, ok true; the upstream saw one request, sent with the real token" };
});

await run("the record on the secret's context", async () => {
  const events = (await logOf()).slice(before);
  const requested = events.findIndex(
    (event) =>
      event.type === TYPES.requested && (event.payload as { digest?: string }).digest === digest,
  );
  const approved = events.findIndex(
    (event) =>
      event.type === TYPES.approved &&
      (event.payload as { digests?: string[] }).digests?.includes(digest),
  );
  const used = events.findIndex(
    (event) =>
      event.type === TYPES.used && (event.payload as { digest?: string }).digest === digest,
  );
  must(
    requested >= 0 && approved > requested && used > approved,
    `out of order or missing: requested ${requested}, approved ${approved}, used ${used}`,
  );
  const { signer } = events[approved]!.payload as {
    signer: { principal: { email?: string }; label: string };
  };
  must(
    signer.principal.email?.toLowerCase() === email.toLowerCase(),
    `approved by ${signer.principal.email}`,
  );
  must(signer.label === label, `approved with the key "${signer.label}"`);
  const { status } = events[used]!.payload as { status: number };
  must(status === 200, `used with the upstream's status ${status}`);
  return {
    detail: `waits, then approved by ${email} with "${label}", then used with ${digest}, status ${status}`,
  };
});

await run("a rejection, with a reason", async () => {
  if (live) return { detail: "skipped on a live stack: one request is enough there" };
  const second = `proof ${crypto.randomUUID()}`;
  const reason = `the proof rejects it ${crypto.randomUUID().slice(0, 8)}`;
  const held = send(second);
  const digest = await waiting(second);
  await listed(page, digest, second);
  page.once("dialog", (dialog) => void dialog.accept(reason));
  await choose(page, digest, "Reject them");
  await gone(page, digest);
  const answer = await held;
  must(
    answer.status === 403 && answer.kind === "rejected",
    `the call returned ${answer.status} ${answer.kind}`,
  );
  must(answer.said.includes(reason), "the answer does not carry the reason");
  must((await recorded()).length === 1, "the upstream saw more");
  return { detail: `403 rejected, with the reason; the upstream saw nothing more` };
});

await run("nothing is left behind", async () => {
  if (!live && !env.ITERATE_PROOF_CLEANUP) {
    await removePasskey();
    return {
      detail: `a prototype keeps its rule and its secret; the passkey "${label}" is removed`,
    };
  }
  const detail = await cleanUp();
  must(!detail.startsWith("NOT REMOVED"), detail);
  return { detail };
});

await browser.close();
