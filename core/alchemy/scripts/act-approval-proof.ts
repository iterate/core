//   node --env-file-if-exists=.secrets scripts/act-approval-proof.ts <domain>
// A mail and a verb's call that wait for a member's yes (iterate/acts), against a deployed stack,
// in headless Chromium at a phone's width with a virtual authenticator that holds the member's
// software passkey. The mail goes to an address of the mind's own domain, so the proof reads it
// back. The verb is a stand-in bridge's, lent with a key of its own (`iterate provide --key`).
// ITERATE_PROTOTYPE_TOKEN       the stand-in member token for the mind's API: the agent's side
// ITERATE_PROOF_SESSION_COOKIE  the member's session cookie's value on iterate.<domain>
// ITERATE_PROOF_PASSKEY         that member's software passkey's file: { credentialId, privateKey }
// ITERATE_PROOF_SHOTS           the folder for screenshots (default: a new temp folder)
// ITERATE_PROOF_LATE=0          leave out the two approvals after the caller stopped waiting, a
//                               mail's and a verb's (each waits the caller's five minutes)
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { mindApiUrlOf, platformOriginOf } from "iterate/mind-api";
import { type Envelope, keyIdOf, statementText } from "iterate/signed";
import { z } from "zod";
import { authenticator, credentialIdOf, lendPasskey, pressedAt } from "./proof-passkeys.ts";
import { mindRoot } from "./smoke/lib.ts";

/** core/auth-worker/src/cookies.ts `SESSION_COOKIE`, which the package does not export. */
const SESSION_COOKIE = "__Host-iterate-auth-session";
const TYPES = {
  held: "events.iterate.com/approval/act-held",
  approved: "events.iterate.com/approval/act-approved",
  rejected: "events.iterate.com/approval/act-rejected",
  expired: "events.iterate.com/approval/hold-expired",
  done: "events.iterate.com/approval/act-done",
  sent: "events.iterate.com/email/sent",
  received: "events.iterate.com/email/received",
};

const domain = process.argv[2];
const env = process.env;
const token = env.ITERATE_PROTOTYPE_TOKEN;
if (
  !domain ||
  process.argv.length > 3 ||
  !token ||
  !env.ITERATE_PROOF_SESSION_COOKIE ||
  !env.ITERATE_PROOF_PASSKEY
) {
  console.error(
    "usage: act-approval-proof.ts <domain>, with ITERATE_PROTOTYPE_TOKEN, ITERATE_PROOF_SESSION_COOKIE and ITERATE_PROOF_PASSKEY",
  );
  process.exit(2);
}
const issuer = platformOriginOf(domain);
const page_ = `${issuer}/secrets/approvals`;
const shots = env.ITERATE_PROOF_SHOTS || mkdtempSync(join(tmpdir(), "act-approval-proof-"));
mkdirSync(shots, { recursive: true });
const marker = crypto.randomUUID().slice(0, 8);
const root = () => mindRoot(domain, token);

const browser = await chromium.launch({ headless: true });
// a phone: the owner approves from one
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
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
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await lendPasskey(cdp, await authenticator(cdp, "usb", true), issuer, env.ITERATE_PROOF_PASSKEY);

let step = 0;
async function run<T>(title: string, body: () => Promise<{ detail: string; value?: T }>) {
  step += 1;
  try {
    const { detail, value } = await body();
    console.log(`pass  ${step}. ${title}  (${detail})`);
    await page.screenshot({ path: join(shots, `${step}.png`), fullPage: true });
    return value as T;
  } catch (error) {
    console.log(
      `FAIL  ${step}. ${title}  (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
    );
    await page.screenshot({ path: join(shots, `${step}-failed.png`), fullPage: true });
    await cleanUp().catch(() => undefined);
    await browser.close();
    process.exit(1);
  }
}
function must(condition: unknown, why: string): asserts condition {
  if (!condition) throw new Error(why);
}
const settled = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Event = { offset: number; type: string; payload: Record<string, unknown> };
async function eventsOf(path: string, after = 0): Promise<Event[]> {
  const events: Event[] = [];
  for (;;) {
    const read = await root().cd(path).readEvents(after, 500);
    // the API's events have these three fields and more: the proof reads these alone
    events.push(...(read.events as Event[]));
    if (read.atHead || read.scannedThroughOffset <= after) return events;
    after = read.scannedThroughOffset;
  }
}
async function until<T>(what: string, seconds: number, read: () => Promise<T | undefined | false>) {
  for (const deadline = Date.now() + seconds * 1000; ; await settled(2_000)) {
    const got = await read();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`${what}: not within ${seconds} s`);
  }
}

/** Until the page's script has hashed the held act's text and found it to be the act's id. A
 *  locator, since the page's policy refuses a script that the browser is handed as text. */
const checked = (digest: string) =>
  page.locator(`#act-${digest}[data-checked="${digest}"]`).waitFor();

/** The agent's side: a mail to the mind's own domain. It answers how the call ended. */
const mail = (subject: string) =>
  root()
    .email.send({
      to: `approval-${marker}@${domain}`,
      subject,
      text: `A mail of act-approval-proof.ts, ${marker}.\nIt waits for a member's yes.`,
    })
    .then(
      (sent) => ({ sent: z.object({ type: z.string(), offset: z.number() }).parse(sent) }),
      (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
    );
// each held act is found once: two calls of one verb are two acts
const found = new Set<string>();
// only facts of this run count: the log keeps every earlier run's
const before = (await eventsOf("/approvals")).at(-1)?.offset ?? 0;
const heldDigest = (subject: string) =>
  until(`the fact that "${subject}" waits`, 30, async () => {
    const fact = (await eventsOf("/approvals")).findLast(
      (event) =>
        event.offset > before &&
        event.type === TYPES.held &&
        String(event.payload.summary).endsWith(subject) &&
        !found.has(String(event.payload.digest)),
    );
    if (!fact) return undefined;
    found.add(String(fact.payload.digest));
    return String(fact.payload.digest);
  });
const arrivals = async (subject: string) =>
  (await eventsOf("/integrations/email")).filter(
    (event) => event.type === TYPES.received && event.payload.subject === subject,
  ).length;

/** The page's own post of the rules, with the session alone: as its script sends it. */
const setRulesBySession = async (rules: unknown[]) =>
  z
    .object({ status: z.number(), signed: z.boolean().optional() })
    .parse(
      await page.evaluate(
        `fetch("/secrets/approvals/act-rules", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify({ rules }))} }).then(async (answer) => ({ status: answer.status, signed: (await answer.json()).signed }))`,
      ),
    );
const rule = { verb: "email.send", to: [`*@${domain}`] };
let bridge: ChildProcess | undefined;
let bridgeKey = "";
/** The ids of the rules that this run proposed: a run that stops takes the open ones away. */
const proposals: string[] = [];
/** The secret that a step made for itself, until that step removed it. */
let proofSecret = "";
/** What the bridge's process printed: its link, that it is live, and each call it got. */
let said = "";
async function cleanUp() {
  bridge?.kill("SIGINT");
  // on /keys, with the passkey: a session alone removes no key
  if (bridgeKey) {
    await page.goto(`${issuer}/keys`);
    const remove = page.locator(`form[data-remove]:has(input[name="key"][value="${bridgeKey}"])`);
    if (await remove.count()) {
      await remove.getByRole("button", { name: "Remove" }).click();
      await remove.waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
    }
  }
  await page.goto(page_);
  const unlock = page.getByRole("button", { name: "Unlock, signed" });
  if (await unlock.count()) {
    await unlock.click();
    await page.getByRole("button", { name: "Lock, signed" }).waitFor();
  }
  await setRulesBySession([]);
  if (proofSecret) await root().secrets.delete(proofSecret);
  // a proposal that was approved or rejected is gone already, and its rejection changes nothing
  for (const reject of proposals)
    await page.evaluate(
      `fetch("/secrets/approvals/proposals", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify({ reject }))} }).then((answer) => answer.status)`,
    );
}

console.log(`proving a mail that waits for approval on ${issuer}; screenshots in ${shots}`);

// The two steps that come first show on a stack what core/secrets-worker/src/approvals-page.ts
// says of the page where a passkey signs.
await run(
  "each page where a passkey signs is the platform's own: it loads from its own origin alone, and an answer of the mind on that origin is an attachment in a sandbox",
  async () => {
    const loaded: { origin: string; kind: string }[] = [];
    const note = (request: { url(): string; resourceType(): string }) =>
      loaded.push({ origin: new URL(request.url()).origin, kind: request.resourceType() });
    page.on("request", note);
    const policies: string[] = [];
    for (const path of ["/secrets/approvals", "/keys", "/members", "/oauth2/device"]) {
      const answer = await page.goto(`${issuer}${path}`, { waitUntil: "networkidle" });
      const policy = answer?.headers()["content-security-policy"] || "";
      must(new URL(page.url()).origin === issuer, `${path} led to ${page.url()}`);
      // nothing by default, no frame, no base; a script by the page's own nonce and from no host
      must(
        policy.startsWith("default-src 'none'") &&
          policy.includes("frame-ancestors 'none'") &&
          policy.includes("base-uri 'none'") &&
          !/script-src[^;]*(https?:|\*|'unsafe|'self')/.test(policy),
        `${path} has the policy ${policy}`,
      );
      policies.push(policy.replace(/'nonce-[^']+'/, "'nonce-…'"));
    }
    page.off("request", note);
    // a picture is no code: a verified client's own logo may come from its own domain
    const elsewhere = loaded.filter(({ origin, kind }) => origin !== issuer && kind !== "image");
    must(!elsewhere.length, `a page loaded ${JSON.stringify(elsewhere)}`);
    const minds = await fetch(`${issuer}/api/proof-${marker}`);
    const [disposition, policy, sniff] = [
      "content-disposition",
      "content-security-policy",
      "x-content-type-options",
    ].map((name) => minds.headers.get(name) || "");
    must(
      disposition.startsWith("attachment") &&
        policy.startsWith("sandbox") &&
        !policy.includes("allow-same-origin") &&
        sniff === "nosniff",
      `the mind's answer at /api has ${JSON.stringify({ disposition, policy, sniff })}`,
    );
    const related = await fetch(`${issuer}/.well-known/webauthn`);
    must(!related.ok, `/.well-known/webauthn answered ${related.status}: it names other origins`);
    return {
      detail: `${loaded.length} requests of four pages, each to ${issuer}; the approvals page's policy is ${policies[0]}; the mind's answer at /api/… is ${minds.status} with ${disposition} and ${policy}; /.well-known/webauthn is ${related.status}`,
    };
  },
);

await run(
  "a press on another host of the mind signs nothing: the browser makes none there for the platform's passkey, and the server refuses one that is made anyway",
  async () => {
    const file = z.string().parse(env.ITERATE_PROOF_PASSKEY);
    const rpId = new URL(issuer).hostname;
    const other = `https://proof-${marker}.${domain}`;
    const here = { origin: issuer, rpId };
    const { rules } = await root().approvals.rules();
    const now = Date.now();
    // a statement that sets the rules for mail and calls: here, to the rules that are there
    const statement = () =>
      statementText({
        mind: domain,
        path: "/approvals",
        type: "events.iterate.com/approval/rule-set",
        payload: { rules },
        at: now,
        expires: now + 5 * 60_000,
      });
    const posted = async (envelope: Envelope, origin = issuer) => {
      const answer = await fetch(`${page_}/statements`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(envelope),
      });
      const said = z
        .object({ error: z.string().optional(), ok: z.boolean().optional() })
        .parse(await answer.json());
      return said.error || (said.ok ? "taken" : `HTTP ${answer.status}`);
    };
    const refusals = {
      // what a page of the mind's own would send, were a browser to make the press for it
      onAnotherHost: await posted(await pressedAt(file, statement(), { origin: other, rpId })),
      // A host under the platform's, the one other place where a browser makes this press. No
      // such host is served: the zone's wildcard name and certificate reach one label alone.
      underThePlatform: await posted(
        await pressedAt(file, statement(), { origin: `https://proof.${rpId}`, rpId }),
      ),
      // the relying party that a browser does allow such a page: the mind's bare domain
      forTheBareDomain: await posted(
        await pressedAt(file, statement(), { origin: issuer, rpId: domain }),
      ),
      // a press for one statement, sent with another
      forAnotherStatement: await posted(await pressedAt(file, statement(), here, statement())),
    };
    must(
      refusals.onAnotherHost === "the assertion was made on another origin" &&
        refusals.underThePlatform === refusals.onAnotherHost &&
        refusals.forTheBareDomain === "the assertion is for another relying party" &&
        refusals.forAnotherStatement === "the assertion is for another statement",
      `the server said ${JSON.stringify(refusals)}`,
    );
    const pressedHere = await pressedAt(file, statement(), here);
    const [first, again] = [await posted(pressedHere), await posted(pressedHere)];
    must(
      first === "taken" && again === "the statement was seen before",
      `a press on the platform's own page was ${first}, and the same press again was ${again}`,
    );

    // The browser's side, on a page that the mind serves: the passkey is for the platform's host,
    // and a browser makes a press for a relying party only on that host or one under it.
    await page.goto(`${other}/`).catch(() => undefined);
    must(new URL(page.url()).origin === other, `${other} led to ${page.url()}`);
    const pressOn = async (relyingParty: string) =>
      z.string().parse(
        await page.evaluate(`(async () => {
          const id = Uint8Array.from(atob(${JSON.stringify(credentialIdOf(file))}.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
          try {
            await navigator.credentials.get({ publicKey: {
              challenge: crypto.getRandomValues(new Uint8Array(32)),
              rpId: ${JSON.stringify(relyingParty)},
              userVerification: "required",
              allowCredentials: [{ type: "public-key", id }],
              timeout: 10000,
            } });
            return "a press";
          } catch (error) {
            return error.name;
          }
        })()`),
      );
    const answered = {
      forThePlatform: await pressOn(rpId),
      forTheBareDomain: await pressOn(domain),
    };
    must(
      answered.forThePlatform === "SecurityError" && answered.forTheBareDomain !== "a press",
      `on ${other} the browser answered ${JSON.stringify(answered)}`,
    );

    // A session's write from a page of the mind's own: the cookie rides it, and it counts for nothing.
    await page.goto(page_);
    const bySession = await setRulesBySession(rules);
    const cookie = `${SESSION_COOKIE}=${env.ITERATE_PROOF_SESSION_COOKIE}`;
    const fromTheMind = await fetch(`${issuer}/secrets/approvals/act-rules`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: other, cookie },
      body: JSON.stringify({ rules }),
      redirect: "manual",
    });
    must(
      bySession.status === 200 && fromTheMind.status !== 200,
      `the session's write was ${bySession.status} from the page and ${fromTheMind.status} from ${other}`,
    );
    return {
      detail: `the server refused a press for ${other} and one for https://proof.${rpId} (${refusals.onAnotherHost}), one for the bare domain (${refusals.forTheBareDomain}) and one sent with another statement (${refusals.forAnotherStatement}); it took a press for ${issuer} once (${again}); on ${other} the browser answered ${answered.forThePlatform} for ${rpId} and ${answered.forTheBareDomain} for ${domain}; a session's write of the rules was ${bySession.status} from the page and ${fromTheMind.status} with the origin ${other}`,
    };
  },
);

await run(
  "the member opens /secrets/approvals on a phone and adds a rule: a mail to the mind's own domain waits",
  async () => {
    await cleanUp();
    await page.goto(page_);
    const form = page.locator("form[data-act-rule]");
    await form.getByLabel("What waits").fill(rule.verb);
    await form.locator('input[name="to"]').fill(rule.to[0]!);
    await form.getByRole("button", { name: "Add the rule" }).click();
    await page.locator("li", { hasText: `A mail to ${rule.to[0]}` }).waitFor();
    await page.getByText("These rules are open").waitFor();
    return {
      detail: `"A mail to ${rule.to[0]}", saved with the session alone: the rules are open`,
    };
  },
);

const first = `approved ${marker}`;
const waiting = mail(first);
const digest = await run(
  "an agent's mail waits: the fact is on /approvals at once and nothing is sent",
  async () => {
    const held = await heldDigest(first);
    must(!(await arrivals(first)), "the mail arrived before anyone approved it");
    return { value: held, detail: `act ${held.slice(0, 12)} waits; no mail arrived` };
  },
);

await run(
  "the page lists it as a person reads a mail, From and the reply address first, and fits a phone",
  async () => {
    await page.goto(`${page_}?digest=${digest}`);
    const row = page.locator(`#act-${digest}`);
    await checked(digest);
    const words = (await row.innerText()).replace(/\s+/g, " ");
    const from = words.indexOf("From ");
    const replies = words.indexOf("Replies go to ");
    const to = words.indexOf(`To approval-${marker}@${domain}`);
    must(
      from >= 0 && replies > from && to > replies,
      `the parts are not in order: ${words.slice(0, 200)}`,
    );
    must(words.includes(`Subject ${first}`), "no subject");
    must(words.includes("It waits for a member's yes."), "no body");
    must(
      words.includes("Its caller waits for your answer now."),
      "it does not say that the caller waits",
    );
    must(
      words.includes("Checked: this is exactly what will be done."),
      "the page did not check the text",
    );
    const overflow = z
      .number()
      .parse(await page.evaluate("document.documentElement.scrollWidth - window.innerWidth"));
    must(overflow <= 0, `the page is ${overflow} px wider than the phone`);
    return { detail: `${words.slice(from, replies + 40).trim()} …; no sideways scroll at 390 px` };
  },
);

await run("the member approves with the passkey, and the mail goes once", async () => {
  await page.locator("[data-acts]").getByRole("button", { name: "Approve the chosen" }).click();
  await page.locator(`#act-${digest}`).waitFor({ state: "detached" });
  const answer = await waiting;
  must(
    "sent" in answer && answer.sent.type === TYPES.sent,
    `the call ended with ${JSON.stringify(answer)}`,
  );
  await until("the mail to arrive", 120, async () => (await arrivals(first)) > 0);
  const approved = (await eventsOf("/approvals")).findLast(
    (event) =>
      event.type === TYPES.approved && JSON.stringify(event.payload.digests).includes(digest),
  );
  must(approved, "no act-approved fact");
  const signer = z
    .object({ signer: z.object({ label: z.string() }) })
    .parse(approved.payload).signer;
  return {
    detail: `the agent's call returned email/sent; the mail arrived; approved with the key "${signer.label}"`,
  };
});

await run("the same mail again is not sent: one approval, one mail", async () => {
  const again = await mail(first);
  must(
    "refused" in again && again.refused.includes("sent before"),
    `it ended with ${JSON.stringify(again)}`,
  );
  await settled(10_000);
  const count = await arrivals(first);
  must(count === 1, `${count} mails arrived`);
  return { detail: `${again.refused.slice(0, 110)}; 1 mail arrived in all` };
});

await run(
  "a rejection ends the agent's call with the member's reason, and nothing is sent",
  async () => {
    const subject = `rejected ${marker}`;
    const refused = mail(subject);
    const held = await heldDigest(subject);
    await page.goto(`${page_}?digest=${held}`);
    await checked(held);
    page.once("dialog", (dialog) => void dialog.accept("not to this address"));
    await page.locator("[data-acts]").getByRole("button", { name: "Reject them" }).click();
    await page.locator(`#act-${held}`).waitFor({ state: "detached" });
    const answer = await refused;
    must(
      "refused" in answer && answer.refused.includes("not to this address"),
      `it ended with ${JSON.stringify(answer)}`,
    );
    must(!(await arrivals(subject)), "the rejected mail arrived");
    return { detail: answer.refused.slice(0, 140) };
  },
);

await run(
  "a mail with a text part and another HTML part shows both to the approver, and a recipient that is not one address is refused",
  async () => {
    const subject = `two bodies ${marker}`;
    const html = `<p>Pay at <a href="https://example.net/${marker}">this link</a>.</p>`;
    const send = (to: string) =>
      root()
        .email.send({ to, subject, text: `See you at five, ${marker}.`, html })
        .then(
          () => ({ sent: true as const }),
          (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
        );
    // a name before the address can hold another address: a rule would read the first one
    const odd = await send(`"<approval-${marker}@example.org>" <approval-${marker}@${domain}>`);
    must(
      "refused" in odd && odd.refused.includes("its address alone"),
      `a recipient with a name ended with ${JSON.stringify(odd)}`,
    );
    const refused = send(`approval-${marker}@${domain}`);
    const held = await heldDigest(subject);
    await page.goto(`${page_}?digest=${held}`);
    await checked(held);
    const words = (await page.locator(`#act-${held}`).innerText()).replace(/\s+/g, " ");
    must(
      words.includes(`See you at five, ${marker}.`) && words.includes(html),
      `the page shows: ${words.slice(0, 300)}`,
    );
    must(words.includes("HTML part"), "the page does not say that the mail has an HTML part");
    page.once("dialog", (dialog) => void dialog.accept("two bodies"));
    await page.locator("[data-acts]").getByRole("button", { name: "Reject them" }).click();
    await page.locator(`#act-${held}`).waitFor({ state: "detached" });
    const answer = await refused;
    must("refused" in answer, `it ended with ${JSON.stringify(answer)}`);
    return {
      detail:
        "the page shows the text and the HTML's source, and names the HTML part; a recipient with a name before its address is refused before anything waits",
    };
  },
);

if (env.ITERATE_PROOF_LATE !== "0")
  await run(
    "a mail whose caller gave up after five minutes is approved later: it is sent then, and the caller's context says so",
    async () => {
      const subject = `late ${marker}`;
      const gaveUp = await mail(subject);
      must(
        "refused" in gaveUp && gaveUp.refused.includes("can be approved for a day"),
        `it ended with ${JSON.stringify(gaveUp)}`,
      );
      const held = await heldDigest(subject);
      must(!(await arrivals(subject)), "the mail arrived with no approval");
      await page.goto(`${page_}?digest=${held}`);
      await checked(held);
      const words = await page.locator(`#act-${held}`).innerText();
      must(
        words.includes("Its caller stopped waiting."),
        "the page does not say that the caller stopped waiting",
      );
      await page.locator("[data-acts]").getByRole("button", { name: "Approve the chosen" }).click();
      // the page reloads at once, and the mind sends the mail a moment later
      await until("the mail to arrive", 120, async () => (await arrivals(subject)) > 0);
      // the member's API session called from the mind's root, so that is the caller's context
      const done = await until("the fact on the caller's context", 60, async () =>
        (await eventsOf("/")).findLast(
          (event) => event.type === TYPES.done && event.payload.digest === held,
        ),
      );
      must(done.payload.ok === true, `act-done says ${JSON.stringify(done.payload)}`);
      await page.goto(page_);
      must(
        !(await page.locator(`#act-${held}`).count()),
        "the act is still listed after it was done",
      );
      return {
        detail: `the call threw after five minutes ("…can be approved for a day…"); approved later, the mail arrived, and / holds act-done { ok: true }`,
      };
    },
  );

await run(
  "locked with the passkey: the session alone can no longer take the rule away, a signature can",
  async () => {
    await page.goto(page_);
    await page.getByRole("button", { name: "Lock, signed" }).click();
    await page.getByText("These rules are locked").waitFor();
    const bySession = await setRulesBySession([]);
    must(
      bySession.status === 403 && bySession.signed === true,
      `the session alone got ${JSON.stringify(bySession)}`,
    );
    // the page's own Remove signs when the gate says it must
    await page
      .locator("li", { hasText: `A mail to ${rule.to[0]}` })
      .getByRole("button", { name: "Remove" })
      .click();
    await page.getByText("No rule for mail or calls yet.").waitFor();
    await page.getByRole("button", { name: "Unlock, signed" }).click();
    await page.getByText("These rules are open").waitFor();
    const free = await mail(`free ${marker}`);
    must("sent" in free, `with no rule the mail ended with ${JSON.stringify(free)}`);
    return {
      detail:
        "locked: the session alone got 403; Remove signed with the passkey; unlocked again; a mail with no rule goes at once",
    };
  },
);

await run(
  "a mail that a rule would read as another mail: a recipient whose domain ends in a dot and a subject of two lines are refused, and a rule for one mailbox holds that mailbox with a tag",
  async () => {
    const sending = (to: string, subject: string) =>
      root()
        .email.send({ to, subject, text: `A mail of act-approval-proof.ts, ${marker}.` })
        .then(
          () => ({ sent: true as const }),
          (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
        );
    // a mail that waits answers nothing for five minutes
    const soon = <T>(call: Promise<T>) =>
      Promise.race([call, settled(20_000).then(() => ({ waits: true as const }))]);
    const rejected = async (digest: string, reason: string) => {
      await page.goto(`${page_}?digest=${digest}`);
      await checked(digest);
      page.once("dialog", (dialog) => void dialog.accept(reason));
      await page.locator("[data-acts]").getByRole("button", { name: "Reject them" }).click();
      await page.locator(`#act-${digest}`).waitFor({ state: "detached" });
    };
    // every part runs, so a run on a build without one of the three says all that it lacks
    const wrong: string[] = [];
    await setRulesBySession([rule]);

    // The mail service reads `host.` as `host`, and a rule for `*@host` read it as another text.
    const dotted = await soon(
      sending(`approval-${marker}@${domain}.`, `a dot at the end ${marker}`),
    );
    if (!("refused" in dotted && dotted.refused.includes("its address alone")))
      wrong.push(`a recipient at "${domain}." ended with ${JSON.stringify(dotted)}`);

    // What comes after a line break in a subject is a header of its own, a Bcc for one.
    const twoLines = `two lines ${marker}\r\nBcc: approval-${marker}@example.org`;
    const broken = sending(`approval-${marker}@${domain}`, twoLines);
    const brokenEnded = await soon(broken);
    if (!("refused" in brokenEnded && brokenEnded.refused.includes("has a line break"))) {
      wrong.push(`a subject of two lines ended with ${JSON.stringify(brokenEnded)}`);
      if ("waits" in brokenEnded) {
        await rejected(await heldDigest(twoLines), "two lines");
        await broken;
      }
    }

    // A tag is the same mailbox: a rule that names the mailbox holds its mail.
    await setRulesBySession([{ verb: "email.send", to: [`approval-${marker}@${domain}`] }]);
    const tag = `a tag ${marker}`;
    const tagged = sending(`approval-${marker}+bills@${domain}`, tag);
    const first = await Promise.race([
      tagged,
      heldDigest(tag).then(
        (digest) => ({ digest }),
        () => ({ waits: true as const }),
      ),
    ]);
    if ("digest" in first) {
      await rejected(first.digest, "not with a tag");
      const ended = await tagged;
      if (!("refused" in ended && ended.refused.includes("not with a tag")))
        wrong.push(`the mail with a tag ended with ${JSON.stringify(ended)}`);
    } else
      wrong.push(`a mail to the rule's mailbox with a tag ended with ${JSON.stringify(first)}`);

    await setRulesBySession([]);
    must(!wrong.length, wrong.join("; "));
    return {
      detail: `refused before anything waits: ${"refused" in dotted ? dotted.refused.slice(0, 110) : ""} / ${"refused" in brokenEnded ? brokenEnded.refused.slice(0, 90) : ""}; the rule for approval-${marker}@${domain} held the mail to approval-${marker}+bills@${domain}, and the rejection ended it`,
    };
  },
);

// ── a verb: a stand-in for a WhatsApp bridge, itx.proofWhatsapp.jonas.sendMessage(jid, { text }) ──

const SEND = "itx.proofWhatsapp.jonas.sendMessage";
/** THE BRIDGE'S STUB BY ITS KEY, as a script of the mind reads it: from the row that gives the lent
 *  name to the stub. The list of stub keys holds other things too, a page's live subscription for
 *  one, so the key is not "the last one". */
const BRIDGE_KEY = `(await (async () => { const row = (await itx.cd("/").rewriteRules.list()).find((rule) => rule.match === "${SEND.split(".").slice(0, -1).join(".")}"); return /rpcStubs\\.get\\((["'])(.*?)\\1\\)/.exec(typeof row.target === "string" ? row.target : JSON.stringify(row.target))[2]; })())`;
const send = (text: string) =>
  root()
    .run(`async (itx) => ${SEND}("jo@s.whatsapp.net", { text: ${JSON.stringify(text)} })`)
    .then(
      (answer) => ({ answer: JSON.stringify(answer) }),
      (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
    );

await run(
  "a bridge lends itx.proofWhatsapp.jonas, and the mind's own code names its sendMessage in a rule while the rules are open",
  async () => {
    const folder = mkdtempSync(join(tmpdir(), "act-approval-bridge-"));
    writeFileSync(
      join(folder, "proof-whatsapp.mjs"),
      `export const description = "A stand-in of act-approval-proof.ts for a WhatsApp bridge: it sends nothing.";
export default () => ({
  // each call is printed, so the proof reads from the bridge itself whether it was called
  sendMessage: (jid, content) => {
    console.log("BRIDGE CALLED " + JSON.stringify([jid, content]).slice(0, 1200));
    return { sentTo: jid, text: content.text };
  },
  chats: () => ["jo@s.whatsapp.net"],
  // what a subscription's row delivers to: no rule names it
  heard: (events) => {
    console.log("BRIDGE HEARD " + JSON.stringify(events).slice(0, 1200));
  },
});
`,
    );
    bridge = spawn(
      process.execPath,
      [
        join(import.meta.dirname, "../../lib/bin/iterate.js"),
        ...["provide", join(folder, "proof-whatsapp.mjs"), "--name", "proofWhatsapp.jonas"],
        ...["--key", join(folder, "bridge.key"), "--mind", domain],
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    for (const stream of [bridge.stdout, bridge.stderr])
      stream?.on("data", (chunk: Buffer) => (said += chunk.toString()));
    const link = new URL(
      await until(
        "the bridge's link",
        30,
        async () => /https:\/\/\S+\/keys\/enrol\?\S+/.exec(said)?.[0],
      ),
    );
    bridgeKey = await keyIdOf(link.searchParams.get("publicKey") || "");
    // the consent page itself, at the phone's width: Allow is a press of the member's passkey
    await page.goto(String(link));
    await page.getByRole("button", { name: "Allow with your passkey" }).click();
    await page.getByRole("heading", { name: "Added" }).waitFor({ timeout: 15_000 });
    await until("the lend", 60, async () => said.includes("itx.proofWhatsapp.jonas is live"));
    const free = await send(`free ${marker}`);
    must("answer" in free, `with no rule the send ended with ${JSON.stringify(free)}`);
    // one verb, not every verb under the name: a read stays free
    const rules = await root().approvals.setRules([{ verb: SEND }]);
    // the kernel reads the rules again within five seconds
    await settled(7_000);
    const read = await root().run(`async (itx) => itx.proofWhatsapp.jonas.chats()`);
    must(Array.isArray(read), `a verb the rule does not name answered ${JSON.stringify(read)}`);
    return {
      detail: `with no rule a send answers at once; itx.approvals.setRules gave ${JSON.stringify(rules)}; chats(), which the rule does not name, answers at once`,
    };
  },
);

await run(
  "an agent's sendMessage waits, the page shows who it goes to and what it says, and the approval runs it",
  async () => {
    const text = `hello ${marker}, with a member's yes`;
    const call = send(text);
    const held = await heldDigest(SEND);
    await page.goto(`${page_}?digest=${held}`);
    await checked(held);
    const words = (await page.locator(`#act-${held}`).innerText()).replace(/\s+/g, " ");
    must(words.includes(`Call ${SEND}`), `the page says: ${words.slice(0, 160)}`);
    must(
      words.includes("jo@s.whatsapp.net") && words.includes(text),
      "the page does not show who it goes to and what it says",
    );
    const overflow = z
      .number()
      .parse(await page.evaluate("document.documentElement.scrollWidth - window.innerWidth"));
    must(overflow <= 0, `the page is ${overflow} px wider than the phone`);
    await page.locator("[data-acts]").getByRole("button", { name: "Approve the chosen" }).click();
    const ended = await call;
    must(
      "answer" in ended && ended.answer.includes(text),
      `the call ended with ${JSON.stringify(ended)}`,
    );
    return {
      detail: `held as act ${held.slice(0, 12)}; the page shows the recipient and the text; approved with the passkey; the call answered ${ended.answer}`,
    };
  },
);

await run(
  "an agent's context calls the bridge that is lent at the root: its table sends the name to the root, the call waits there, and the approval runs it",
  async () => {
    // An agent's context has the row `itx => itx.cd('/')`: a name it has no row for is the root's.
    const below = `/proof/agent-${marker}`;
    await root()
      .cd(below)
      .append({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx", target: "itx.cd('/')" },
      });
    const text = `from a context below the root ${marker}`;
    const call = root()
      .cd(below)
      .run(`async (itx) => ${SEND}("jo@s.whatsapp.net", { text: ${JSON.stringify(text)} })`)
      .then(
        (answer) => ({ answer: JSON.stringify(answer) }),
        (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
      );
    const held = await heldDigest(SEND).catch(async (error: unknown) => {
      // a kernel that asks with the table of the caller's context finds no rule, and the call runs
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; the call ended with ${JSON.stringify(await call).slice(0, 200)}`,
      );
    });
    must(!said.includes(text), "the bridge was called with no approval");
    await page.goto(`${page_}?digest=${held}`);
    await checked(held);
    await page.locator("[data-acts]").getByRole("button", { name: "Approve the chosen" }).click();
    const ended = await call;
    must(
      "answer" in ended && ended.answer.includes(text) && said.includes(text),
      `the call ended with ${JSON.stringify(ended)}`,
    );
    return {
      detail: `the call from ${below} was held as act ${held.slice(0, 12)}; approved with the passkey, the bridge got it and the call answered ${ended.answer}`,
    };
  },
);

await run(
  "the same function by the stub's own key is held too, and a rejection ends the call",
  async () => {
    const call = root()
      .run(
        `async (itx) => { const key = ${BRIDGE_KEY}; return itx.cd("/").rpcStubs.get(key).sendMessage("jo@s.whatsapp.net", { text: "by its key ${marker}" }); }`,
      )
      .then(
        (answer) => ({ answer: JSON.stringify(answer) }),
        (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
      );
    const held = await heldDigest(SEND);
    await page.goto(`${page_}?digest=${held}`);
    await checked(held);
    page.once("dialog", (dialog) => void dialog.accept("not by that name"));
    await page.locator("[data-acts]").getByRole("button", { name: "Reject them" }).click();
    const ended = await call;
    must(
      "refused" in ended && ended.refused.includes("not by that name"),
      `the call ended with ${JSON.stringify(ended)}`,
    );
    return { detail: ended.refused.slice(0, 150) };
  },
);

await run(
  "the same function by another spelling of a step is held too: an argument more where the stub is found, and the stub's own invoke",
  async () => {
    // Each call is one expression, given whole to `itx.invoke`, with the stub found by its key.
    const byKey = (text: string, steps: (key: string) => unknown[]) =>
      root()
        .run(
          `async (itx) => { const key = ${BRIDGE_KEY}; return itx.invoke(${JSON.stringify([
            "itx",
            ["cd", "/"],
            "rpcStubs",
            ...steps("THE-KEY"),
          ]).replace('"THE-KEY"', "key")}); }`,
        )
        .then(
          (answer) => ({ answer: JSON.stringify(answer) }),
          (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
        )
        .then((ended) => ({ ...ended, text }));
    const rejected = async (text: string, steps: (key: string) => unknown[]) => {
      const call = byKey(text, steps);
      const held = await heldDigest(SEND).catch(async (error: unknown) => {
        // a kernel that reads the step as another thing asks nobody, and the call runs at once
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; the call ended with ${JSON.stringify(await call).slice(0, 200)}`,
        );
      });
      await page.goto(`${page_}?digest=${held}`);
      await checked(held);
      page.once("dialog", (dialog) => void dialog.accept("not by that spelling"));
      await page.locator("[data-acts]").getByRole("button", { name: "Reject them" }).click();
      const ended = await call;
      must(
        "refused" in ended && ended.refused.includes("not by that spelling"),
        `the call ended with ${JSON.stringify(ended)}`,
      );
      must(!said.includes(text), "the bridge was called with no approval");
    };
    const to = "jo@s.whatsapp.net";
    // `get(key, 0)`: the function that finds a stub read its first argument alone
    const more = `an argument more ${marker}`;
    await rejected(more, (key) => [
      ["get", key, 0],
      ["sendMessage", to, { text: more }],
    ]);
    // `stub.invoke([[verb, ...]])`: the stub's handle hands those steps to the stub
    const door = `its own invoke ${marker}`;
    await rejected(door, (key) => [
      ["get", key],
      ["invoke", [["sendMessage", to, { text: door }]]],
    ]);
    // and where no rule is in the way, the spelling is an error by itself
    const free = await byKey("", (key) => [["get", key, 0], ["chats"]]);
    must(
      "refused" in free && free.refused.includes("takes no argument after its own"),
      `chats() by get(key, 0) ended with ${JSON.stringify(free)}`,
    );
    return {
      detail: `get(key, 0).sendMessage and get(key).invoke([[sendMessage]]) each waited as ${SEND} and ended by the rejection; get(key, 0).chats(): ${free.refused.slice(0, 80)}`,
    };
  },
);

await run(
  "the held verb with a name read after its call is refused: the call would run whatever comes after it",
  async () => {
    // One expression: the call, then a name of its answer. It is given whole to `invoke`: a chain
    // written as code sends its call alone, and that call is held as any call is.
    const expression = JSON.stringify([
      ...SEND.split(".").slice(0, -1),
      ["sendMessage", "jo@s.whatsapp.net", { text: `goes on ${marker}` }],
      "sentTo",
    ]);
    const ended = await root()
      .run(`async (itx) => itx.invoke(${expression})`)
      .then(
        (answer) => ({ answer: JSON.stringify(answer) }),
        (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
      );
    must(
      "refused" in ended && ended.refused.includes("nothing after it"),
      `the call ended with ${JSON.stringify(ended)}`,
    );
    return { detail: ended.refused.slice(0, 170) };
  },
);

await run(
  "a verb of the mind's own code is held when a script calls it, as a lent verb is",
  async () => {
    // itx.config.slack is a function of the config's worker: a script's resolver walks it itself
    const rules = await root().approvals.setRules([{ verb: SEND }, { verb: "itx.config.slack" }]);
    must(rules.length === 2, `the rules are ${JSON.stringify(rules)}`);
    await settled(7_000);
    const call = root()
      .run(`async (itx) => itx.config.slack("auth.test", { proof: "${marker}" })`)
      .then(
        (answer) => ({ answer: JSON.stringify(answer) }),
        (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
      );
    const held = await heldDigest("itx.config.slack");
    await page.goto(`${page_}?digest=${held}`);
    await checked(held);
    page.once("dialog", (dialog) => void dialog.accept("not to Slack"));
    await page.locator("[data-acts]").getByRole("button", { name: "Reject them" }).click();
    const ended = await call;
    must(
      "refused" in ended && ended.refused.includes("not to Slack"),
      `the call ended with ${JSON.stringify(ended)}`,
    );
    await root().approvals.setRules([{ verb: SEND }]);
    return { detail: `held as act ${held.slice(0, 12)}; ${ended.refused.slice(0, 110)}` };
  },
);

await run(
  "a rule for a verb whose row crosses to another context holds it: itx.agents is a facet of /agents, by the root's name and by the facet's own",
  async () => {
    const row = (await root().rewriteRules.list()).find((one) => one.match === "itx.agents");
    const target = row?.target || "";
    must(
      /cd\((["'])\/agents\1\)\.facets\.get\((["'])agents\2,/.test(target),
      `itx.agents is not a facet of /agents that is found with a spec: ${target.slice(0, 120)}`,
    );
    const rules = await root().approvals.setRules([{ verb: SEND }, { verb: "itx.agents.delete" }]);
    must(rules.length === 2, `the rules are ${JSON.stringify(rules)}`);
    await settled(7_000);
    /** The script's call must wait as `itx.agents.delete`: what the page says of it, and the
     *  rejection ends the call. */
    const rejected = async (reason: string, script: string) => {
      const call = root()
        .run(script)
        .then(
          (answer) => ({ answer: JSON.stringify(answer) }),
          (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
        );
      const held = await heldDigest("itx.agents.delete").catch(async (error: unknown) => {
        await root().approvals.setRules([{ verb: SEND }]);
        // a kernel that reads the rule's name where the call arrives finds no such name there
        throw new Error(
          `${reason}: ${error instanceof Error ? error.message : String(error)}; the call ended with ${JSON.stringify(await call).slice(0, 200)}`,
        );
      });
      await page.goto(`${page_}?digest=${held}`);
      await checked(held);
      const words = (await page.locator(`#act-${held}`).innerText()).replace(/\s+/g, " ");
      page.once("dialog", (dialog) => void dialog.accept(reason));
      await page.locator("[data-acts]").getByRole("button", { name: "Reject them" }).click();
      const ended = await call;
      must(
        "refused" in ended && ended.refused.includes(reason),
        `the call ended with ${JSON.stringify(ended)}`,
      );
      return words;
    };
    // an agent that never was: where a kernel does not hold the call, nothing is deleted
    const none = `/agents/proof/none-${marker}`;
    const words = await rejected(
      "not by the root's name",
      `async (itx) => itx.agents.delete(${JSON.stringify(none)})`,
    );
    must(
      words.includes("Call itx.agents.delete") && words.includes("In context /"),
      `the page does not say which context read the name: ${words.slice(0, 200)}`,
    );
    // The facet found by its name alone, with no spec, is the same facet. With the same argument
    // it is the same act too, which the member just rejected: so it names another agent.
    await rejected(
      "not by the facet's own name",
      `async (itx) => itx.invoke(${JSON.stringify(["itx", ["cd", "/agents"], "facets", ["get", "agents"], ["delete", `${none}-2`]])})`,
    );
    await root().approvals.setRules([{ verb: SEND }]);
    return {
      detail: `itx.agents.delete(path) and itx.cd("/agents").facets.get("agents").delete(path) each waited as itx.agents.delete, read in context /, and ended by the rejection`,
    };
  },
);

await run(
  "a held verb whose name becomes another function while it waits is not run when a member approves it",
  async () => {
    const call = send(`re-pointed ${marker}`);
    const held = await heldDigest(SEND);
    // While it waits, the mind's table gives the name to another function of the same bridge.
    const row = { match: SEND, target: "itx.proofWhatsapp.jonas.chats" };
    const rule = "events.iterate.com/itx/rewrite-rule-configured";
    await root().append({ type: rule, payload: row });
    await page.goto(`${page_}?digest=${held}`);
    await checked(held);
    await page.locator("[data-acts]").getByRole("button", { name: "Approve the chosen" }).click();
    const ended = await call;
    // the row goes whatever the call did: the steps after this one use the name
    await root().append({
      type: rule,
      payload: { match: SEND, target: null, ifTarget: row.target },
    });
    must(
      "refused" in ended && ended.refused.includes("changed while it waited"),
      `the call ended with ${JSON.stringify(ended)}`,
    );
    return { detail: ended.refused.slice(0, 150) };
  },
);

await run(
  "a held verb whose name goes, while it waits, to a function that no rule holds is not run when a member approves it",
  async () => {
    // The rule names the bridge: it holds every verb of the bridge, and no other function.
    const bridgeName = SEND.split(".").slice(0, -1).join(".");
    const rules = await root().approvals.setRules([{ verb: bridgeName }]);
    must(rules.length === 1, `the rules are ${JSON.stringify(rules)}`);
    await settled(7_000);
    const call = send(`to no rule's function ${marker}`);
    const held = await heldDigest(SEND);
    // While it waits, a row for the verb's own name sends it to a function outside the rule.
    const row = { match: SEND, target: "itx.whoami" };
    const rule = "events.iterate.com/itx/rewrite-rule-configured";
    await root().append({ type: rule, payload: row });
    await page.goto(`${page_}?digest=${held}`);
    await checked(held);
    await page.locator("[data-acts]").getByRole("button", { name: "Approve the chosen" }).click();
    const ended = await call;
    // the row and the rule go whatever the call did: the steps after this one use the name
    await root().append({
      type: rule,
      payload: { match: SEND, target: null, ifTarget: row.target },
    });
    await root().approvals.setRules([{ verb: SEND }]);
    must(
      "refused" in ended && ended.refused.includes("changed while it waited"),
      `the member approved a message, and the call ended with ${JSON.stringify(ended).slice(0, 300)}`,
    );
    return { detail: ended.refused.slice(0, 170) };
  },
);

await run(
  "a rule that names the bridge holds a verb under that name: the gate reads a rule as the kernel does",
  async () => {
    // one name above the verb, and no `.*`: the kernel holds the call and asks the gate about it
    const above = SEND.replace(/\.sendMessage$/, "");
    const rules = await root().approvals.setRules([{ verb: above }]);
    must(rules.length === 1, `the rules are ${JSON.stringify(rules)}`);
    await settled(7_000);
    const text = `under a name ${marker}`;
    const call = send(text);
    const held = await heldDigest(SEND).catch(async (error: unknown) => {
      // a gate that reads the rule more narrowly answers "free", and the call runs at once
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; the call ended with ${JSON.stringify(await call).slice(0, 200)}`,
      );
    });
    await page.goto(`${page_}?digest=${held}`);
    await checked(held);
    page.once("dialog", (dialog) => void dialog.accept("not under that name"));
    await page.locator("[data-acts]").getByRole("button", { name: "Reject them" }).click();
    const ended = await call;
    await root().approvals.setRules([{ verb: SEND }]);
    must(!said.includes(text), "the bridge was called with no approval");
    must(
      "refused" in ended && ended.refused.includes("not under that name"),
      `the call ended with ${JSON.stringify(ended)}`,
    );
    return {
      detail: `the rule ${above} held ${SEND} as act ${held.slice(0, 12)}; ${ended.refused.slice(0, 100)}`,
    };
  },
);

await run("an agent proposes a rule, and the member's passkey signs it into one", async () => {
  const proposed = await root().approvals.propose({ verb: "email.send", to: ["*@example.org"] });
  must(proposed.signAt === `${page_}#proposed`, `it says to sign at ${proposed.signAt}`);
  proposals.push(proposed.id);
  // It waits where the held mail and calls wait: the member ticks it, reads it and approves.
  // The page is loaded by its plain address: a browser that is on the page already does not
  // load it again for an address that differs by its fragment alone.
  await page.goto(page_);
  const waits = page.locator("section[data-proposals]#proposed");
  await waits.locator(`[data-proposal="${proposed.id}"]`).getByRole("checkbox").check();
  await waits.getByRole("button", { name: "Approve the chosen" }).click();
  await page
    .locator("li", { hasText: "A mail to *@example.org" })
    .getByRole("button", { name: "Remove" })
    .waitFor();
  const { rules, locked } = await root().approvals.rules();
  must(rules.length === 2 && !locked, `the rules are ${JSON.stringify(rules)}`);
  return {
    detail: `itx.approvals.propose answered a link to the page; signed, the rules are ${JSON.stringify(rules)}`,
  };
});

await run(
  "an agent proposes a rule for a request with a secret: it holds nothing until the member signs it, and then a JMAP send waits while a read goes",
  async () => {
    // A secret of the proof's own for Fastmail's API, with a made-up token: Fastmail answers it
    // 401, so nothing can be read or sent. What counts is which requests the vault lets through.
    const secret = `/secrets/proof-fastmail-${marker}`;
    proofSecret = secret;
    await root().secrets.set(secret, `not-a-token-${marker}`, {
      urls: ["https://api.fastmail.com/"],
    });
    const jmap = (methodCalls: unknown[]) =>
      root()
        .run(
          `async (itx) => { const response = await itx.fetch(new Request("https://api.fastmail.com/jmap/api/", { method: "POST", headers: { authorization: 'Bearer getSecret("${secret}")', "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"], methodCalls }))} })); return response.status; }`,
        )
        .then(
          (status) => ({ status: Number(status), refused: "" }),
          // no status: the call was refused, with these words
          (error: unknown) => ({
            status: 0,
            refused: error instanceof Error ? error.message : String(error),
          }),
        );
    const read = [["Email/query", { accountId: "u0", limit: 1 }, "0"]];
    const send = [
      ["Email/set", { accountId: "u0", create: { draft: { subject: `proof ${marker}` } } }, "0"],
      ["EmailSubmission/set", { accountId: "u0", create: { sent: { emailId: "#draft" } } }, "1"],
    ];
    const rule = {
      secret,
      methods: ["POST"],
      hosts: ["api.fastmail.com"],
      jsonStrings: ["EmailSubmission/set"],
      freePaths: ["/jmap/upload/"],
    };
    // the agent's side: loaded code proposes, and can do no more
    const proposed = z
      .object({ id: z.string(), signAt: z.string() })
      .parse(await root().run(`async (itx) => itx.approvals.propose(${JSON.stringify(rule)})`));
    must(proposed.signAt === `${page_}#proposed`, `it says to sign at ${proposed.signAt}`);
    // a proposal is no rule: the send goes through to Fastmail, which refuses the made-up token
    const unsigned = await jmap(send);
    must(
      unsigned.status === 401,
      `with the rule proposed and not signed, a JMAP send ended with ${JSON.stringify(unsigned)}`,
    );
    // The page has it among what waits, with what it holds, what stays free, and that the secret
    // has no rule now. The member ticks it and approves, as for a held act.
    proposals.push(proposed.id);
    await page.goto(page_);
    const row = page.locator(`section[data-proposals] [data-proposal="${proposed.id}"]`);
    const words = (await row.innerText()).replace(/\s+/g, " ");
    must(
      words.includes(
        `A request with ${secret} waits when it is POST to api.fastmail.com and its JSON body holds EmailSubmission/set`,
      ) &&
        words.includes("What stays free") &&
        words.includes(`${secret} has no rule now.`),
      `the page says of the proposal: ${words.slice(0, 300)}`,
    );
    await row.getByRole("checkbox").check();
    await page
      .locator("section[data-proposals]")
      .getByRole("button", { name: "Approve the chosen" })
      .click();
    await row.waitFor({ state: "detached" });
    await page.locator("form[data-rule] h3", { hasText: secret }).waitFor();
    // In force now: a read goes, and a send waits.
    const reads = await jmap(read);
    must(
      reads.status === 401,
      `with the rule signed, a JMAP read ended with ${JSON.stringify(reads)}`,
    );
    const held = jmap(send);
    const waits = page.locator(`section[data-secret="${secret}"]`);
    await until("the JMAP send on the approvals page", 40, async () => {
      await page.goto(page_);
      return (await waits.count()) > 0;
    });
    // the member rejects it, so that the caller's call ends now
    await waits.locator("[data-pick]:not([disabled])").first().check();
    page.once("dialog", (dialog) => void dialog.accept("the proof rejects it"));
    await waits.getByRole("button", { name: "Reject them" }).click();
    const ended = await held;
    must(
      ended.status === 403 || ended.refused,
      `the held send ended with ${JSON.stringify(ended)}`,
    );
    await root().secrets.delete(secret);
    proofSecret = "";
    return {
      detail: `itx.approvals.propose answered a link to the page; proposed and not signed, a JMAP send went through to Fastmail (401 for the made-up token); the page said what the rule holds and what stays free; signed with the passkey, a read went through (401) and a send waited on the page until the member rejected it (${JSON.stringify(ended).slice(0, 80)})`,
    };
  },
);

await run(
  "a subscription does not deliver to the held verb: the bridge is not called for its event",
  async () => {
    // A row's delivery calls its target itself. No caller is there who could wait for a member.
    // Loaded code writes the row as an event: its `subscribe` lends a live callback only.
    // Four rows hear one event. One aims at a verb of the bridge that no rule names, one at the
    // bridge's held verb, one at a held verb of the mind's own code, and one at a held verb whose
    // row crosses to another context.
    const own = "itx.config.slack";
    const across = "itx.agents.delete";
    const rules = await root().approvals.setRules([
      { verb: SEND },
      { verb: own },
      { verb: across },
    ]);
    must(rules.length === 3, `the rules are ${JSON.stringify(rules)}`);
    await settled(7_000);
    const type = `proof/said-${marker}`;
    const rows = {
      free: { name: `proof-free-verb-${marker}`, target: SEND.replace(/sendMessage$/, "heard") },
      lent: { name: `proof-held-verb-${marker}`, target: SEND },
      own: { name: `proof-held-own-verb-${marker}`, target: own },
      across: { name: `proof-held-verb-across-${marker}`, target: across },
    };
    const configured = Object.values(rows).map((row) =>
      JSON.stringify({
        type: "events.iterate.com/itx/subscription-configured",
        payload: { ...row, consumes: [type] },
      }),
    );
    await root().run(
      `async (itx) => { for (const row of [${configured.join(", ")}]) await itx.append(row); await itx.append({ type: "${type}", payload: { said: "by a subscription ${marker}" } }); }`,
    );
    // the bridge prints each call it gets, and a delivery's call carries the event's type
    const got = (mark: string) =>
      said.split("\n").find((line) => line.startsWith(mark) && line.includes(type));
    try {
      // the row no rule holds delivers: a delivery does reach the bridge
      await until("the bridge hears the event by the row that no rule holds", 40, async () =>
        got("BRIDGE HEARD"),
      );
      // The kernel walks the mind's own verb itself, so that row halts and says why. So does the
      // row whose verb is a facet's of another context.
      const haltedRow = (name: string, what: string) =>
        until(`the row to ${what} halts`, 40, async () => {
          const read = JSON.stringify(await root().subscriptions.get(name));
          return read.includes('"halted"') && read;
        });
      const halted = await haltedRow(rows.own.name, "the mind's own held verb");
      const haltedAcross = await haltedRow(rows.across.name, "the held verb of another context");
      // A delivery to a live stub is a push: its refusal is dropped with a line in the Worker's
      // log, and the row stays. So the proof of the bridge's verb is that no call comes, well
      // after the same event reached the bridge by the other row.
      await settled(10_000);
      const called = got("BRIDGE CALLED");
      // both faults are said, so a run against a kernel that does not ask shows the two of them
      const faults = [
        ...(halted.includes("waits for a member's approval")
          ? []
          : [`the row to the mind's own verb halted for another reason: ${halted.slice(0, 300)}`]),
        ...(haltedAcross.includes("waits for a member's approval")
          ? []
          : [
              `the row to the verb of another context halted for another reason: ${haltedAcross.slice(0, 300)}`,
            ]),
        ...(called ? [`the bridge was called for the event: ${called.slice(0, 200)}`] : []),
      ];
      must(faults.length === 0, faults.join("; "));
    } finally {
      for (const { name } of Object.values(rows)) await root().subscribe({ name, target: null });
      await root().approvals.setRules([{ verb: SEND }]);
    }
    return {
      detail:
        "one event, four rows: the bridge heard it by the row no rule names; the row to the mind's own held verb and the row to a held verb of another context (itx.agents.delete) each halted and say why; 10 s later the bridge's held verb had no call",
    };
  },
);

if (env.ITERATE_PROOF_LATE !== "0")
  await run(
    "a call whose caller gave up after five minutes is approved later: the bridge gets it then, also when its caller's context reads the name as another function, and a name re-pointed meanwhile is not run",
    async () => {
      const kept = `late ${marker}`;
      const moved = `late and re-pointed ${marker}`;
      const far = `late, from a context that reads the name as another ${marker}`;
      const rule = "events.iterate.com/itx/rewrite-rule-configured";
      const across = "itx.agents.delete";
      await root().approvals.setRules([{ verb: SEND }, { verb: across }]);
      await settled(7_000);
      // four calls wait at once: each is its own act
      const first = send(kept);
      const heldKept = await heldDigest(SEND);
      const second = send(moved);
      const heldMoved = await heldDigest(SEND);
      // The third caller is in a context of its own, whose table gives the verb's name to another
      // function of the bridge. It names the mind's root, so the root's table reads the name.
      const elsewhere = `/proof/late-${marker}`;
      const masked = { match: SEND, target: "itx.proofWhatsapp.jonas.chats" };
      await root().cd(elsewhere).append({ type: rule, payload: masked });
      const third = root()
        .cd(elsewhere)
        .run(
          `async (itx) => itx.cd("/").proofWhatsapp.jonas.sendMessage("jo@s.whatsapp.net", { text: ${JSON.stringify(far)} })`,
        )
        .then(
          (answer) => ({ answer: JSON.stringify(answer) }),
          (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
        );
      const heldFar = await heldDigest(SEND);
      // The fourth call names a facet of another context by the facet's own name, with no spec.
      // The rule's name finds that facet with one, and a late approval calls the rule's name.
      const none = `/agents/proof/none-late-${marker}`;
      const fourth = root()
        .run(
          `async (itx) => itx.invoke(${JSON.stringify(["itx", ["cd", "/agents"], "facets", ["get", "agents"], ["delete", none]])})`,
        )
        .then(
          (answer) => ({ answer: JSON.stringify(answer) }),
          (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
        );
      const heldAcross = await heldDigest(across);
      for (const ended of await Promise.all([first, second, third, fourth]))
        must(
          "refused" in ended && ended.refused.includes("can be approved for a day"),
          `a call ended with ${JSON.stringify(ended)}`,
        );
      must(!said.includes(kept) && !said.includes(far), "the bridge was called with no approval");
      const approve = async (digest: string) => {
        await page.goto(`${page_}?digest=${digest}`);
        await checked(digest);
        await page
          .locator("[data-acts]")
          .getByRole("button", { name: "Approve the chosen" })
          .click();
      };
      // the member's API session called from the mind's root, so that is the caller's context
      const doneFact = (digest: string, caller = "/") =>
        until(`the fact on the caller's context ${caller}`, 90, async () =>
          (await eventsOf(caller)).findLast(
            (event) => event.type === TYPES.done && event.payload.digest === digest,
          ),
        );
      await approve(heldKept);
      const done = await doneFact(heldKept);
      must(done.payload.ok === true, `act-done says ${JSON.stringify(done.payload)}`);
      must(said.includes(kept), "act-done says ok, and the bridge printed no call");
      // The third act is done where it was held, at the root, and not by the caller's own name.
      const doneFar = await (async () => {
        await approve(heldFar);
        return doneFact(heldFar, elsewhere);
      })().finally(() =>
        root()
          .cd(elsewhere)
          .append({ type: rule, payload: { match: SEND, target: null, ifTarget: masked.target } }),
      );
      must(
        doneFar.payload.ok === true && said.includes(far),
        `the bridge ${said.includes(far) ? "got" : "did not get"} the call from ${elsewhere}, and act-done there says ${JSON.stringify(doneFar.payload).slice(0, 300)}`,
      );
      // The fourth act is the rule's own verb, whatever spelling its caller used. Its agent never
      // was, so the function's own answer is the mark that the call reached it.
      await approve(heldAcross);
      const doneAcross = await doneFact(heldAcross);
      must(
        String(doneAcross.payload.error).includes("nothing to delete"),
        `the call by the facet's own name was not done: act-done says ${JSON.stringify(doneAcross.payload).slice(0, 300)}`,
      );
      await root().approvals.setRules([{ verb: SEND }]);
      // The second act's name goes to another function of the bridge before the member approves.
      const row = { match: SEND, target: "itx.proofWhatsapp.jonas.chats" };
      await root().append({ type: rule, payload: row });
      // the kernel reads the mind's table again within five seconds
      await settled(7_000);
      const notRun = await (async () => {
        await approve(heldMoved);
        return doneFact(heldMoved);
      })().finally(() =>
        // the row goes whatever came of it: the steps after this one use the name
        root().append({ type: rule, payload: { match: SEND, target: null, ifTarget: row.target } }),
      );
      must(
        notRun.payload.ok === false &&
          String(notRun.payload.error).includes("changed while it waited"),
        `act-done says ${JSON.stringify(notRun.payload)}`,
      );
      must(!said.includes(moved), "the bridge was called for the name that was re-pointed");
      return {
        detail: `all four calls threw after five minutes; approved later, the bridge got the first and / holds act-done { ok: true }; it got the one from ${elsewhere} too, whose own table gives the name to chats(), and that context holds act-done { ok: true }; the call by the facet's own name reached itx.agents.delete (its answer: nothing to delete); the second, re-pointed before its approval, was not run: ${String(notRun.payload.error).slice(0, 90)}`,
      };
    },
  );

await run(
  "a device's sign-in: where the mind asks for it, Continue is a press of the member's passkey, and the session alone signs in no device",
  async () => {
    const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
    const metadata = z
      .object({
        registration_endpoint: z.string(),
        device_authorization_endpoint: z.string(),
        token_endpoint: z.string(),
        revocation_endpoint: z.string().optional(),
      })
      .parse(await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json());
    // a device asks: a client of its own, then a code for its person to confirm
    const registration = await fetch(metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: `proof device ${marker}`,
        token_endpoint_auth_method: "none",
        grant_types: [DEVICE_GRANT, "refresh_token"],
      }),
    });
    must(registration.status === 201, `the device's registration answered ${registration.status}`);
    const client = z.object({ client_id: z.string() }).parse(await registration.json()).client_id;
    const asked = await fetch(metadata.device_authorization_endpoint, {
      method: "POST",
      body: new URLSearchParams({
        client_id: client,
        scope: "iterate",
        resource: mindApiUrlOf(domain),
      }),
    });
    must(asked.ok, `the device's request answered ${asked.status}`);
    const codes = z
      .object({
        device_code: z.string(),
        user_code: z.string(),
        verification_uri_complete: z.string(),
      })
      .parse(await asked.json());
    const poll = async () =>
      z.object({ error: z.string().optional(), access_token: z.string().optional() }).parse(
        await (
          await fetch(metadata.token_endpoint, {
            method: "POST",
            body: new URLSearchParams({
              grant_type: DEVICE_GRANT,
              device_code: codes.device_code,
              client_id: client,
            }),
          })
        ).json(),
      );
    /** After Continue: the consent of the grant itself, then the device's token, revoked again. */
    const signedIn = async () => {
      await page.getByRole("button", { name: "Allow", exact: true }).click();
      await page.getByText("The device is signed in").waitFor();
      // a device polls every five seconds
      let token: string | undefined;
      for (let tries = 0; tries < 8 && !token; tries += 1) {
        await settled(5_500);
        token = (await poll()).access_token;
      }
      must(token, "the device got no token after Continue and the consent");
      if (metadata.revocation_endpoint)
        await fetch(metadata.revocation_endpoint, {
          method: "POST",
          body: new URLSearchParams({ token, client_id: client }),
        });
    };
    await page.goto(codes.verification_uri_complete);
    const press = page.getByRole("button", { name: "Continue with your passkey" });
    if (!(await press.count())) {
      // A mind whose config does not ask for it: the page and the flow are as they were, and
      // nothing of the press is proven here.
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await signedIn();
      return {
        detail:
          "this mind does not ask for the passkey (auth.devices.passkey is not set): a plain Continue and the consent signed the device in, as before (its token revoked again)",
      };
    }
    // The session alone: the page's own form, with no statement. A string, as this package's
    // types have no DOM.
    const bare = z
      .object({ status: z.number(), text: z.string() })
      .parse(
        await page.evaluate(
          `fetch(location.pathname, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ user_code: ${JSON.stringify(codes.user_code)}, action: "confirm" }) }).then(async (answer) => ({ status: answer.status, text: await answer.text() }))`,
        ),
      );
    must(
      bare.status === 403 && bare.text.includes("takes a press of your passkey"),
      `with no statement the page answered ${bare.status}`,
    );
    const waiting = await poll();
    must(waiting.error === "authorization_pending", `the device got ${JSON.stringify(waiting)}`);
    // the press, then the consent of the grant itself
    await press.click();
    await signedIn();
    return {
      detail:
        "with the session alone the page answered 403 and the device waited on; Continue asked for the passkey, the consent followed, and the device got its token (revoked again)",
    };
  },
);

await run(
  "loaded code writes no ingress row whose target is a built-in: such a row would answer the next visitor of the mind's hosts, as that visitor",
  async () => {
    const INGRESS = "events.iterate.com/itx/ingress-configured";
    const rows = async () => (await eventsOf("/")).filter((event) => event.type === INGRESS);
    const before = await rows();
    // a script is loaded code: it writes a row with `itx.append`
    const attempt = await root()
      .run(
        `async (itx) => itx.append({ type: "${INGRESS}", payload: { target: "itx.builtins.cd('/').secrets" } })`,
      )
      .then(
        (answer) => ({ answer: JSON.stringify(answer) }),
        (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
      );
    const after = await rows();
    if (after.length !== before.length) {
      // The row was written. The mind's hosts answer by it: put the row from before back at once,
      // as the member, and then say what happened.
      const was = before.at(-1);
      must(was, "an ingress row was written, and the mind had none before to put back");
      await root().append({ type: INGRESS, payload: was.payload });
    }
    must(
      after.length === before.length,
      "loaded code wrote an ingress row (the row from before is back)",
    );
    must(
      "refused" in attempt && attempt.refused.includes("is not a loaded worker's word"),
      `the append ended with ${JSON.stringify(attempt)}`,
    );
    return { detail: `no row was written: ${attempt.refused.slice(0, 130)}` };
  },
);

await run(
  "loaded code writes no row whose target carries a row: a subscription that would append a rule when it runs is refused, and no rule lands",
  async () => {
    const RULE = "events.iterate.com/itx/rewrite-rule-configured";
    // a context of the proof's own: what lands, lands there
    const at = `/proof/row-in-a-call-${marker}`;
    const name = `proof-row-in-a-call-${marker}`;
    const escape = `itx.proofEscape${marker}`;
    const opensTheRoot = "itx.builtins.cd('/')";
    // The row's target is a call of `append` with a rule in its arguments. A row runs as the
    // platform's delivery, which checks no row: so the rule would land when the event comes.
    const subscription = {
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name,
        consumes: [`proof/go-${marker}`],
        target: [
          "itx",
          ["append", { type: RULE, payload: { match: escape, target: opensTheRoot } }],
        ],
      },
    };
    const attempt = await root()
      .cd(at)
      .run(
        `async (itx) => { await itx.append(${JSON.stringify(subscription)}); await itx.append({ type: "proof/go-${marker}", payload: {} }); }`,
      )
      .then(
        (answer) => ({ answer: JSON.stringify(answer) }),
        (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
      );
    // a row that was written gets the time to run
    await settled(8_000);
    const landed = await root().cd(at).rewriteRules.get(escape);
    // whatever came of it, the proof's rows go, as the member
    await root()
      .cd(at)
      .subscribe({ name, target: null })
      .catch(() => undefined);
    if (landed)
      await root()
        .cd(at)
        .append({ type: RULE, payload: { match: escape, target: null, ifTarget: opensTheRoot } });
    must(!landed, `the rule landed in ${at}, and is taken out again: ${JSON.stringify(landed)}`);
    must(
      "refused" in attempt && attempt.refused.includes("is not a loaded worker's word"),
      `the append ended with ${JSON.stringify(attempt)}`,
    );
    return { detail: `no row was written: ${attempt.refused.slice(0, 130)}` };
  },
);

await run(
  "loaded code writes no row in two parts: a rule with a hole and a subscription whose call fills it are each written, and the row that they make is refused when the subscription's target is run",
  async () => {
    const RULE = "events.iterate.com/itx/rewrite-rule-configured";
    const at = `/proof/row-in-two-parts-${marker}`;
    const name = `proof-row-in-two-parts-${marker}`;
    const part = `proofPart${marker}`;
    const escape = `itx.proofEscapeInParts${marker}`;
    const opensTheRoot = "itx.builtins.cd('/')";
    // Neither row is a row with a built-in target, so the check on a row that loaded code writes
    // passes each. The rule's target appends whatever the call gives it, as a rule.
    const rows = [
      {
        type: RULE,
        payload: {
          match: `itx.${part}`,
          target: ["itx", ["append", { type: RULE, "...@": true }]],
        },
      },
      {
        type: "events.iterate.com/itx/subscription-configured",
        payload: {
          name,
          consumes: [`proof/go-${marker}`],
          target: ["itx", [part, { payload: { match: escape, target: opensTheRoot } }]],
        },
      },
    ];
    const attempt = await root()
      .cd(at)
      .run(
        `async (itx) => { await itx.append(...${JSON.stringify(rows)}); await itx.append({ type: "proof/go-${marker}", payload: {} }); return "written"; }`,
      )
      .then(
        (answer) => ({ answer: String(answer), refused: "" }),
        // no answer: the call was refused, with these words
        (error: unknown) => ({
          answer: "",
          refused: error instanceof Error ? error.message : String(error),
        }),
      );
    // the subscription gets the time to run; a rule that lands is seen at once
    let landed: unknown = null;
    for (let waited = 0; waited < 12 && !landed; waited += 2) {
      await settled(2_000);
      landed = await root().cd(at).rewriteRules.get(escape);
    }
    const halted = z
      .object({ halted: z.object({ error: z.string() }).optional() })
      .nullable()
      .parse(await root().cd(at).subscriptions.get(name));
    // whatever came of it, the proof's rows go, as the member
    await root()
      .cd(at)
      .subscribe({ name, target: null })
      .catch(() => undefined);
    await root()
      .cd(at)
      .append({ type: RULE, payload: { match: `itx.${part}`, target: null } });
    if (landed)
      await root()
        .cd(at)
        .append({ type: RULE, payload: { match: escape, target: null, ifTarget: opensTheRoot } });
    must(
      attempt.answer === "written",
      `loaded code's two rows were not written: ${JSON.stringify(attempt)}`,
    );
    must(!landed, `the rule landed in ${at}, and is taken out again: ${JSON.stringify(landed)}`);
    // The security fact is that no rule landed. Why the run stopped is the subscription's own
    // word, which the detail quotes.
    const why = halted?.halted?.error || "the subscription has not said why yet";
    return {
      detail: `both rows were written and no rule landed; the subscription's run stopped: ${why.slice(0, 130)}`,
    };
  },
);

await run(
  "the member removes the bridge's key on /keys with the passkey, and the bridge lends no more",
  async () => {
    await page.goto(`${issuer}/keys`);
    const row = page.locator("li", {
      has: page.locator(`input[name="key"][value="${bridgeKey}"]`),
    });
    const removes = page.locator("form[data-remove]");
    const before = await removes.count();
    await row.getByRole("button", { name: "Remove" }).click();
    await page
      .locator(`input[name="key"][value="${bridgeKey}"]`)
      .waitFor({ state: "detached", timeout: 15_000 });
    // A refusal's page has no such input either. So: the page that came back is the keys page,
    // and it offers one Remove fewer, which is this key's.
    await page
      .getByRole("heading", { name: /^Your keys for/ })
      .waitFor({ timeout: 15_000 })
      .catch(async () => {
        throw new Error(`the page says: ${(await page.locator("body").innerText()).slice(0, 200)}`);
      });
    const after = await removes.count();
    must(after === before - 1, `the keys page offered ${before} removals and now ${after}`);
    const overflow = z
      .number()
      .parse(await page.evaluate("document.documentElement.scrollWidth - window.innerWidth"));
    must(overflow <= 0, `the keys page is ${overflow} px wider than the phone`);
    bridgeKey = "";
    return {
      detail: `Remove asked for the passkey; the keys page came back with ${after} keys to remove, one fewer`,
    };
  },
);

await cleanUp();
await browser.close();
console.log(`proven: ${step} of ${step}`);
process.exit(0);
