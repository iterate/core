//   node --env-file-if-exists=.secrets scripts/bridge-key-proof.ts <domain>
// A stand-in bridge with a key of its own (`iterate provide --key`, core/lib/src/cli/bridge-key.ts)
// against a deployed stack: a member allows the key once, and the bridge then runs past two token
// lifetimes, through a restart, and until its key is removed. Its tokens live 60 seconds here, so
// nothing waits an hour.
// ITERATE_PROTOTYPE_TOKEN       the stand-in member token for the mind's API: the mind's side,
//                               which calls what the bridge lends
// ITERATE_PROOF_SESSION_COOKIE  a member's session cookie's value on iterate.<domain>: the person,
//                               who presses Allow and Remove
// ITERATE_PROOF_HOLD_SECONDS    watch the bridge for this long before the removal (default 0):
//                               redeploy the mind in that time, and read how it came back
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformOriginOf } from "iterate/mind-api";
import {
  KEY_TOKEN_PATH,
  KEY_TOKEN_STATEMENT_TYPE,
  keyIdOf,
  signedP256,
  statementText,
} from "iterate/signed";
import { z } from "zod";
import { mindRoot } from "./smoke/lib.ts";

/** core/auth-worker/src/cookies.ts `SESSION_COOKIE`, which the package does not export. */
const SESSION_COOKIE = "__Host-iterate-auth-session";
const TOKEN_SECONDS = 60;
const NAME = "proofBridge";

const domain = process.argv[2];
const token = process.env.ITERATE_PROTOTYPE_TOKEN;
const session = process.env.ITERATE_PROOF_SESSION_COOKIE;
if (!domain || process.argv.length > 3 || !token || !session) {
  console.error(
    "usage: bridge-key-proof.ts <domain>, with ITERATE_PROTOTYPE_TOKEN and ITERATE_PROOF_SESSION_COOKIE",
  );
  process.exit(2);
}
const issuer = platformOriginOf(domain);
const cookie = `${SESSION_COOKIE}=${session}`;
const folder = mkdtempSync(join(tmpdir(), "bridge-key-proof-"));
const keyFile = join(folder, "bridge.key");
const bridgeFile = join(folder, "proof-bridge.mjs");
writeFileSync(
  bridgeFile,
  `export const description = "A stand-in bridge of bridge-key-proof.ts: ping() answers pong.";
export default () => ({ ping: () => "pong" });
`,
);

let bridge: ChildProcess | undefined;
let said = "";
/** Starts `iterate provide --key` from this checkout. What it prints is kept in `said`. */
function start() {
  said = "";
  bridge = spawn(
    process.execPath,
    [
      join(import.meta.dirname, "../../lib/bin/iterate.js"),
      ...["provide", bridgeFile, "--name", NAME, "--key", keyFile, "--mind", domain!],
    ],
    {
      env: { ...process.env, ITERATE_KEY_TOKEN_SECONDS: String(TOKEN_SECONDS) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [bridge.stdout, bridge.stderr])
    stream?.on("data", (chunk: Buffer) => (said += chunk.toString()));
}
const stop = () => bridge?.kill("SIGINT");

const settled = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(what: string, seconds: number, read: () => T | Promise<T>): Promise<T> {
  for (const deadline = Date.now() + seconds * 1000; ; await settled(500)) {
    const got = await read();
    if (got) return got;
    if (Date.now() > deadline)
      throw new Error(`${what}: not within ${seconds} s. It said: ${said}`);
  }
}

/** The mind's side: a member's script calls what the bridge lends. */
const ping = () =>
  mindRoot(domain, token)
    .run(`async (itx) => itx.${NAME}.ping()`)
    .then(
      (answer) => answer === "pong",
      () => false,
    );

/** The person's side: a form's post from the page itself. */
const pressed = (path: string, fields: Record<string, string>) =>
  fetch(`${issuer}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: issuer, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

let step = 0;
async function run(title: string, body: () => Promise<string>) {
  step += 1;
  try {
    console.log(`pass  ${step}. ${title}  (${await body()})`);
  } catch (error) {
    console.log(
      `FAIL  ${step}. ${title}  (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
    );
    stop();
    process.exit(1);
  }
}
function must(condition: unknown, why: string): asserts condition {
  if (!condition) throw new Error(why);
}

console.log(`proving a bridge's key on ${issuer}; its tokens live ${TOKEN_SECONDS} s`);

const link = await (async () => {
  let found = "";
  await run("the first run makes a key and prints the link to allow it", async () => {
    start();
    found = await until(
      "the link",
      30,
      () => /https:\/\/\S+\/keys\/enrol\?\S+/.exec(said)?.[0] || "",
    );
    const others = statSync(keyFile).mode & 0o077;
    must(others === 0, "the key file is readable by others");
    must(!(await ping()), "the bridge is lent before anyone allowed its key");
    return "the key file is its owner's alone, and nothing is lent yet";
  });
  return new URL(found);
})();
const key = await keyIdOf(link.searchParams.get("publicKey") || "");

await run("a member reads what the key may do, and allows it", async () => {
  const page = await fetch(link, { headers: { cookie }, redirect: "manual" });
  const words = await page.text();
  must(page.status === 200, `the consent page answered ${page.status}`);
  must(words.includes(`itx.${NAME}`), "the page does not name the capability");
  const allowed = await pressed("/keys/enrol", {
    ...Object.fromEntries(link.searchParams),
    decision: "allow",
  });
  must(allowed.status === 200, `Allow answered ${allowed.status}`);
  return `the page names itx.${NAME}; Allow answered 200`;
});

await run(
  "the bridge connects with no further person, and the mind calls what it lends",
  async () => {
    await until("the lend", 60, () => said.includes(`itx.${NAME} is live`));
    must(await until("the first answer", 20, ping), "itx.proofBridge.ping() did not answer pong");
    return "itx.proofBridge.ping() answered pong";
  },
);

await run("it runs past two token lifetimes, with a new token each time", async () => {
  let answered = 0;
  let missed = 0;
  for (
    const end = Date.now() + (2 * TOKEN_SECONDS + 30) * 1000;
    Date.now() < end;
    await settled(5_000)
  )
    if (await ping()) answered += 1;
    else missed += 1;
  const reconnects = said.split("Reconnected").length - 1;
  must(reconnects >= 2, `it reconnected ${reconnects} times: ${said.slice(-400)}`);
  must(await until("an answer after the last reconnect", 20, ping), "no answer at the end");
  return `${reconnects} reconnects in ${2 * TOKEN_SECONDS + 30} s; ${answered} calls answered, ${missed} missed while it reconnected`;
});

await run(
  "the member's /keys page shows the key, what it may do and that it was used",
  async () => {
    const page = await (await fetch(`${issuer}/keys`, { headers: { cookie } })).text();
    const row = page.split("<li>").find((item) => item.includes(`itx.${NAME}`)) || "";
    must(row.includes("last used"), `the page says: ${row.replace(/<[^>]+>/g, " ").slice(0, 200)}`);
    return row
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  },
);

await run("stopped and started again, it connects with no link and no person", async () => {
  stop();
  await until("the lend to end", 30, async () => !(await ping()));
  start();
  await until("the lend", 60, () => said.includes(`itx.${NAME} is live`));
  must(!said.includes("keys/enrol"), "it asked for consent again");
  must(await until("an answer", 20, ping), "no answer after the restart");
  return "live again, with the same key file";
});

const hold = Number(process.env.ITERATE_PROOF_HOLD_SECONDS) || 0;
if (hold)
  await run(`held for ${hold} s: redeploy the mind now`, async () => {
    const gaps: number[] = [];
    let since = 0;
    for (const end = Date.now() + hold * 1000; Date.now() < end; await settled(3_000)) {
      const up = await ping();
      if (!up && !since) since = Date.now();
      if (up && since) {
        gaps.push(Math.round((Date.now() - since) / 1000));
        since = 0;
      }
    }
    must(await until("an answer at the end", 120, ping), "it did not come back");
    return gaps.length
      ? `it missed calls ${gaps.length} times, for ${gaps.join(", ")} s, and came back each time`
      : "it answered every call";
  });

await run(
  "removed on /keys, the key gets no new token, and the lend ends within a token's life",
  async () => {
    const removed = await pressed("/keys/remove", { key });
    must(removed.status === 303, `Remove answered ${removed.status}`);
    const at = Date.now();
    const curve = { name: "ECDSA", namedCurve: "P-256" } as const;
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(keyFile, "utf8"))),
      curve,
      false,
      ["sign"],
    );
    const statement = statementText({
      mind: domain,
      path: "/",
      type: KEY_TOKEN_STATEMENT_TYPE,
      at,
      expires: at + 60_000,
    });
    const asked = await fetch(`${issuer}${KEY_TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await signedP256(statement, privateKey, key)),
    });
    const { error } = z.object({ error: z.string().optional() }).parse(await asked.json());
    must(
      asked.status === 401 && error === "invalid_client",
      `a new token: ${asked.status} ${error}`,
    );
    await until("the lend to end", TOKEN_SECONDS + 30, async () => !(await ping()));
    const seconds = Math.round((Date.now() - at) / 1000);
    await settled(15_000);
    must(!(await ping()), "it was lent again after the removal");
    return `a new token is refused at once (401 invalid_client); the lend ended ${seconds} s after the removal and stayed ended`;
  },
);

stop();
console.log(`proven: ${step} of ${step}`);
process.exit(0);
