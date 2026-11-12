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
import { platformOriginOf } from "iterate/mind-api";
import { keyIdOf } from "iterate/signed";
import { z } from "zod";
import { authenticator, lendPasskey } from "./proof-passkeys.ts";
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
}

console.log(`proving a mail that waits for approval on ${issuer}; screenshots in ${shots}`);

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

// ── a verb: a stand-in for a WhatsApp bridge, itx.proofWhatsapp.jonas.sendMessage(jid, { text }) ──

const SEND = "itx.proofWhatsapp.jonas.sendMessage";
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
  "the same function by the stub's own key is held too, and a rejection ends the call",
  async () => {
    const call = root()
      .run(
        `async (itx) => { const keys = await itx.cd("/").rpcStubs.list(); return itx.cd("/").rpcStubs.get(keys.at(-1)).sendMessage("jo@s.whatsapp.net", { text: "by its key ${marker}" }); }`,
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
  must(proposed.signAt === page_, `it says to sign at ${proposed.signAt}`);
  await page.goto(page_);
  await page.getByRole("button", { name: "Sign it into a rule" }).click();
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
  "a subscription does not deliver to the held verb: the bridge is not called for its event",
  async () => {
    // A row's delivery calls its target itself. No caller is there who could wait for a member.
    // Loaded code writes the row as an event: its `subscribe` lends a live callback only.
    // Three rows hear one event. One aims at a verb of the bridge that no rule names, one at the
    // bridge's held verb, and one at a held verb of the mind's own code.
    const own = "itx.config.slack";
    const rules = await root().approvals.setRules([{ verb: SEND }, { verb: own }]);
    must(rules.length === 2, `the rules are ${JSON.stringify(rules)}`);
    await settled(7_000);
    const type = `proof/said-${marker}`;
    const rows = {
      free: { name: `proof-free-verb-${marker}`, target: SEND.replace(/sendMessage$/, "heard") },
      lent: { name: `proof-held-verb-${marker}`, target: SEND },
      own: { name: `proof-held-own-verb-${marker}`, target: own },
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
      // The kernel walks the mind's own verb itself, so that row halts and says why.
      const halted = await until("the row to the mind's own held verb halts", 40, async () => {
        const read = JSON.stringify(await root().subscriptions.get(rows.own.name));
        return read.includes('"halted"') && read;
      });
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
        ...(called ? [`the bridge was called for the event: ${called.slice(0, 200)}`] : []),
      ];
      must(faults.length === 0, faults.join("; "));
    } finally {
      for (const { name } of Object.values(rows)) await root().subscribe({ name, target: null });
      await root().approvals.setRules([{ verb: SEND }]);
    }
    return {
      detail:
        "one event, three rows: the bridge heard it by the row no rule names; the row to the mind's own held verb halted and says why; 10 s later the bridge's held verb had no call",
    };
  },
);

if (env.ITERATE_PROOF_LATE !== "0")
  await run(
    "a call whose caller gave up after five minutes is approved later: the bridge gets it then, and a name re-pointed meanwhile is not run",
    async () => {
      const kept = `late ${marker}`;
      const moved = `late and re-pointed ${marker}`;
      // two calls wait at once: each is its own act
      const first = send(kept);
      const heldKept = await heldDigest(SEND);
      const second = send(moved);
      const heldMoved = await heldDigest(SEND);
      for (const ended of await Promise.all([first, second]))
        must(
          "refused" in ended && ended.refused.includes("can be approved for a day"),
          `a call ended with ${JSON.stringify(ended)}`,
        );
      must(!said.includes(kept), "the bridge was called with no approval");
      const approve = async (digest: string) => {
        await page.goto(`${page_}?digest=${digest}`);
        await checked(digest);
        await page
          .locator("[data-acts]")
          .getByRole("button", { name: "Approve the chosen" })
          .click();
      };
      // the member's API session called from the mind's root, so that is the caller's context
      const doneFact = (digest: string) =>
        until("the fact on the caller's context", 90, async () =>
          (await eventsOf("/")).findLast(
            (event) => event.type === TYPES.done && event.payload.digest === digest,
          ),
        );
      await approve(heldKept);
      const done = await doneFact(heldKept);
      must(done.payload.ok === true, `act-done says ${JSON.stringify(done.payload)}`);
      must(said.includes(kept), "act-done says ok, and the bridge printed no call");
      // The second act's name goes to another function of the bridge before the member approves.
      const row = { match: SEND, target: "itx.proofWhatsapp.jonas.chats" };
      const rule = "events.iterate.com/itx/rewrite-rule-configured";
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
        detail: `both calls threw after five minutes; approved later, the bridge got the first and / holds act-done { ok: true }; the second, re-pointed before its approval, was not run: ${String(notRun.payload.error).slice(0, 90)}`,
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
