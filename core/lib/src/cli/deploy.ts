// deploy.ts — `iterate deploy`: A NEW MIND IN A PERSON'S OWN CLOUDFLARE ACCOUNT, by one program
// that asks as little as it can and waits for nothing it does not need. It does what iterate
// Cloud's installation chat does, with no model and no server of iterate's in between:
//
//   1. the stack's source (core/alchemy and the Workers), fetched and installed in the background
//      while the person signs in;
//   2. access to Cloudflare (./cloudflare-access.ts), and the account: one the person has, or a new one;
//   3. the domain: a zone of the account, a new one that Cloudflare's registrar sells, or one the
//      person brings;
//   4. what the account must have: a workers.dev name, Workers Paid and R2;
//   5. the stack's own deploy, `pnpm run deploy` of core/alchemy, with a config written here;
//   6. with a person there, the mind's first steps (`firstSteps` below): the passkey and the
//      first sign-in, a way to pay for the model, the onboarding agent's answer, and the mind's
//      MCP server in the coding agents of this computer.
//
// ONE DEPLOY, at the domain. A stack can also deploy before its domain, while the person turns on
// Workers Paid (core/alchemy README, "Before the domain and before Workers Paid"). That shortens
// the deploy at the domain by about a sixth (1 min 23 s against 1 min 38 s): too little for a
// second deploy and its code.
//
// It handles the expected way alone. A run that stops says why, changes nothing more, and can be
// run again: every step reads the account's state first, and a deploy keeps what it made. Each
// choice has a flag, so a coding agent can run and supervise it with nobody at the terminal.
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import { z } from "zod";
import { mindMcpNameOf, mindMcpUrlOf } from "../mind-api.ts";
import type { MindConnection, MindItx } from "../node.ts";
import { isCodingAgent } from "./coding-agent.ts";
import {
  type Cloudflare,
  cloudflare,
  cloudflareAccess,
  resultOf,
  endAccess,
} from "./cloudflare-access.ts";
import { openPageCommand } from "./open-page.ts";

const exec = promisify(execFile);
const CLOUD = "https://cloud.iterate.com";
const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "iterate");
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NAME = /^[a-z][a-z0-9-]{1,29}$/;

export type DeployInput = {
  domain?: string;
  account?: string;
  newAccount?: boolean;
  name?: string;
  owner?: string;
  buy?: boolean;
  yes?: boolean;
  source?: string;
  ref?: string;
  cloud?: boolean;
  setup?: boolean;
  apiTokens?: boolean;
  sandboxImage?: "managed" | "published";
};

// ---------------------------------------------------------------------------------------------
// What the program decides with no question. Pure, so that a test holds them.

/** The stack's name from the owner's address: every resource in the account is `iterate-<name>-…`. */
export function nameOf(email: string) {
  const slug = (email.toLowerCase().split("@")[0] ?? "").split("+")[0]!.replace(/[^a-z0-9]+/g, "-");
  const name = slug
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  return NAME.test(name) ? name : "mind";
}

/** A word made to end in "erate", as "iterate" does: one final a, e, i, o, u or y goes first,
 *  when more than that letter is there (misha gives misherate, jonas gives jonaserate). */
export const erateOf = (word: string) =>
  `${word.length > 1 ? word.replace(/[aeiouy]$/, "") : word}erate`;

/** Names a person might like, from their name and a few words, 20 at most: what one question to
 *  Cloudflare's registrar takes. The "erate" names of their first and last name come first, as
 *  .com and .dev; then the other names, .com first. */
export function candidatesOf(name: string, words = ""): string[] {
  const wordsOf = (text: string) =>
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9 ]/g, "")
      .split(/\s+/)
      .filter(Boolean);
  const parts = wordsOf(name);
  const first = parts[0];
  const last = parts.at(-1) === first ? undefined : parts.at(-1);
  const stems = new Set<string>();
  if (first && last) {
    stems.add(`${first}${last}`);
    stems.add(`${first}-${last}`);
    stems.add(`${first}${last.slice(0, 1)}`);
  }
  if (last) stems.add(last);
  if (first) for (const stem of [`${first}s`, `hey${first}`, `${first}hq`]) stems.add(stem);
  for (const word of wordsOf(words)) {
    stems.add(word);
    if (first) stems.add(`${first}${word}`);
  }
  const others = [...stems].flatMap((stem) =>
    ["com", "dev", "net", "xyz"].map((ending) => `${stem}.${ending}`),
  );
  const erate = [first, last].flatMap((word) => (word ? [erateOf(word)] : []));
  return [
    ...new Set([
      ...["com", "dev"].flatMap((ending) => erate.map((stem) => `${stem}.${ending}`)),
      ...others.filter((domain) => domain.endsWith(".com")),
      ...others.filter((domain) => !domain.endsWith(".com")),
    ]),
  ].slice(0, 20);
}

/** The stack's config (core/alchemy/src/config.ts): the owner as its only member, mail and the
 *  mailed sign-in code, and iterate Cloud's key when the Cloud is named. */
export function configOf(mind: {
  name: string;
  accountId: string;
  owner: string;
  domain: string;
  cloud?: { origin: string; publicKey: string };
  apiTokens?: boolean;
  sandboxImage?: "managed" | "published";
}) {
  const { cloud } = mind;
  return {
    name: mind.name,
    accountId: mind.accountId,
    domain: mind.domain,
    mail: true,
    mind: { sandboxImage: mind.sandboxImage || "managed" },
    auth: {
      login: { methods: { email: {} }, allow: [{ email: mind.owner }] },
      ...(cloud && {
        keys: [
          {
            actor: "iterate-cloud",
            publicKey: cloud.publicKey,
            label: "iterate Cloud",
            paths: ["/integrations/"],
          },
        ],
      }),
    },
    // both make API tokens of the account, which only some access may
    ...(mind.apiTokens && { cloudflareToken: true, telemetry: true }),
    ...(cloud && { cloud: { origin: cloud.origin } }),
  };
}

// ---------------------------------------------------------------------------------------------
// The terminal.

const interactive = () =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY) && !isCodingAgent(process.env);

/** A question for the person. With nobody there to answer, `flag` says what to pass instead. */
async function ask<T extends string | boolean | string[]>(
  flag: string,
  prompt: () => Promise<T | symbol>,
): Promise<T> {
  if (!interactive()) throw new Error(`Nobody is at this terminal to answer: ${flag}.`);
  const answer = await prompt();
  if (typeof answer === "symbol") {
    p.cancel("Stopped. Nothing more was changed.");
    process.exit(130);
  }
  return answer;
}

/** A line while something runs: a spinner for a person, plain lines for a log. */
function wait(title: string) {
  if (!interactive()) {
    p.log.step(title);
    return {
      say: (line: string) => console.log(`│  ${line}`),
      done: (line?: string) => line && p.log.success(line),
      fail: (line?: string) => line && p.log.error(line),
    };
  }
  const spinner = p.spinner();
  spinner.start(title);
  return {
    say: (line: string) =>
      spinner.message(
        `${title}: ${line}`.slice(0, Math.max(20, (process.stdout.columns || 80) - 6)),
      ),
    done: (line?: string) => spinner.stop(line || title),
    fail: (line?: string) => spinner.error(line || title),
  };
}

/** An end that no wait may try again: a sign-in at Cloudflare that was refused or ran out. */
class Stop extends Error {}

/** Asks `check` every few seconds until it answers something. A check that throws is asked
 *  again, and the end of the wait says the last such error. */
async function until<T>(
  title: string,
  check: () => Promise<T | undefined | false | null>,
  minutes = 30,
): Promise<T> {
  const waiting = wait(title);
  let failure = "";
  for (const end = Date.now() + minutes * 60_000; Date.now() < end; await sleep(3000)) {
    const got = await check().catch((error: unknown) => {
      if (error instanceof Stop) {
        waiting.fail();
        throw error;
      }
      failure = error instanceof Error ? error.message : String(error);
      return undefined;
    });
    if (got) {
      waiting.done();
      return got;
    }
  }
  waiting.fail();
  throw new Error(
    `${title}: not within ${minutes} minutes${failure && ` (the last check failed: ${failure})`}. Run the command again when it is done.`,
  );
}

/** A page the person must act on: printed, and opened when a person is there. */
function page(text: string, url: string) {
  p.log.step(`${text}\n${url}`);
  if (!interactive() || process.env.ITERATE_SKIP_BROWSER_OPEN === "1") return;
  const { command, args } = openPageCommand(new URL(url), process.platform);
  execFile(command, args, () => {});
}

const seconds = (since: number) => {
  const all = Math.round((Date.now() - since) / 1000);
  return all < 60 ? `${all} s` : `${Math.floor(all / 60)} min ${all % 60} s`;
};

// ---------------------------------------------------------------------------------------------
// The stack's source.

/** A checkout, and how pnpm is run in it: the command and its first arguments. */
type Source = { dir: string; pnpm: { command: string; first: string[] } };

function findUp(relative: string, from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, relative))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** A checkout that holds core/alchemy, with its dependencies installed: `--source`, else the
 *  checkout this command runs in, else iterate/core at `ref` in the cache folder. */
async function sourceOf(input: DeployInput): Promise<Source> {
  const marker = "core/alchemy/alchemy.run.ts";
  const own = input.source
    ? resolve(input.source)
    : input.ref
      ? undefined
      : findUp(marker, process.cwd());
  if (own && !existsSync(join(own, marker)))
    throw new Error(`${own} holds no ${marker}: not a checkout of iterate's core.`);
  const dir = own || join(CACHE, "core");
  if (!own) {
    if (spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0)
      throw new Error(
        "git is not installed: the deploy fetches iterate's source with it. Install git and run again.",
      );
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => exec("git", args, { cwd: dir });
    if (!existsSync(join(dir, ".git"))) {
      await git("init", "-q");
      await git("remote", "add", "origin", "https://github.com/iterate/core");
    }
    await git("fetch", "-q", "--depth", "1", "origin", input.ref || "main");
    await git("checkout", "-q", "--detach", "--force", "FETCH_HEAD");
  }
  // without pnpm on this computer, npx runs the version that the source names
  const manager = z
    .object({ packageManager: z.string().default("pnpm@12") })
    .parse(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))).packageManager;
  const pnpm =
    spawnSync("pnpm", ["--version"], { stdio: "ignore" }).status === 0
      ? { command: "pnpm", first: [] }
      : { command: "npx", first: ["--yes", manager] };
  // a checkout of one's own is installed once; the cache follows its lockfile at every run
  if (!own || !existsSync(join(dir, "core/alchemy/node_modules/alchemy/bin/cli.js")))
    await exec(pnpm.command, [...pnpm.first, "install", "--frozen-lockfile"], {
      cwd: dir,
      env: { ...process.env, CI: "1" },
      maxBuffer: 64 << 20,
    });
  return { dir, pnpm };
}

// ---------------------------------------------------------------------------------------------
// The deploy.

type Run = {
  source: Source;
  name: string;
  token: string;
  env: Record<string, string>;
  log: string;
  children: Set<ChildProcess>;
  say?: (line: string) => void;
};

/** One `pnpm run deploy` of core/alchemy: its exit code, and whether the state store refused it.
 *  Every line goes to the log file, with the token's text replaced. */
function deployOnce(run: Run): Promise<{ code: number; storeRefused: boolean }> {
  return new Promise((done, failed) => {
    const file = createWriteStream(run.log, { flags: "a" });
    const { command, first } = run.source.pnpm;
    const child = spawn(
      command,
      [...first, "run", "deploy", "--stage", run.name, "--yes", "--adopt"],
      {
        cwd: join(run.source.dir, "core/alchemy"),
        env: {
          ...process.env,
          CI: "1",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          CLOUDFLARE_API_TOKEN: run.token,
          ...run.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    run.children.add(child);
    let storeRefused = false;
    let rest = "";
    const read = (chunk: Buffer) => {
      const lines = (rest + chunk.toString("utf8")).split("\n");
      rest = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replaceAll(run.token, "[token]").trimEnd();
        file.write(`${line}\n`);
        if (/State store .*failed|StateStoreError/.test(line)) storeRefused = true;
        if (line.trim()) run.say?.(line.trim());
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", failed);
    child.on("close", (code) => {
      run.children.delete(child);
      file.end(`${rest.replaceAll(run.token, "[token]")}\n`);
      done({ code: code ?? 1, storeRefused });
    });
  });
}

/** The deploy. A new state store can refuse writes for its first seconds: the deploy is then
 *  tried once more. */
async function deployStack(run: Run): Promise<number> {
  const first = await deployOnce(run);
  if (first.code === 0 || !first.storeRefused) return first.code;
  run.say?.("The new state store refused the deploy: one more try in 15 seconds");
  await sleep(15_000);
  return (await deployOnce(run)).code;
}

// ---------------------------------------------------------------------------------------------
// Cloudflare: the account, the domain.

const Account = z.object({ id: z.string(), name: z.string() });
type Account = z.infer<typeof Account>;
const Membership = z.object({ status: z.string().optional(), account: Account.optional() });
const ZoneRow = z.object({ id: z.string(), name: z.string(), status: z.string() });
/** A zone, and the stack whose boundary Worker serves it, when one does. */
type Zone = z.infer<typeof ZoneRow> & {
  mind?: string;
  /** Its routes could not be read, so nothing says whether a mind lives there. */
  unread?: boolean;
};
// a route that turns Workers off has `script: null`
const Route = z.object({ script: z.string().nullish() });
const Offer = z.object({
  name: z.string(),
  registrable: z.boolean().optional(),
  pricing: z
    .object({ registration_cost: z.string().optional(), currency: z.string().optional() })
    .optional(),
});
type Offer = z.infer<typeof Offer>;

/** The accounts the access reaches. A person's OAuth access lists them as memberships;
 *  `GET /accounts` answers an empty list for it. */
async function accountsOf(cf: Cloudflare): Promise<Account[]> {
  const memberships =
    resultOf(z.array(Membership), await cf("GET", "/memberships?per_page=50")) ?? [];
  const mine = memberships.flatMap((membership) =>
    membership.account && (membership.status || "accepted") === "accepted"
      ? [membership.account]
      : [],
  );
  if (mine.length > 0) return mine;
  return resultOf(z.array(Account), await cf("GET", "/accounts?per_page=50")) ?? [];
}

/** The account's zones (its first 50, or the one named `domain`), each with its stack. */
async function zonesOf(cf: Cloudflare, account: string, domain?: string): Promise<Zone[]> {
  const which = domain ? `&name=${domain}` : "";
  const zones =
    resultOf(
      z.array(ZoneRow),
      await cf("GET", `/zones?account.id=${account}&per_page=50${which}`),
    ) ?? [];
  return Promise.all(
    zones.map(async ({ id, name, status }) => {
      const routes = resultOf(z.array(Route), await cf("GET", `/zones/${id}/workers/routes`));
      if (!routes) return { id, name, status, unread: true };
      const script = routes
        .map((route) => route.script || "")
        .find((worker) => /^iterate-.+-(boundary|ingress)$/.test(worker));
      return { id, name, status, mind: script?.replace(/^iterate-|-(boundary|ingress)$/g, "") };
    }),
  );
}

const priceOf = (offer: Offer) =>
  `${offer.pricing?.registration_cost || "?"} ${offer.pricing?.currency || "USD"} a year`;

/** What Cloudflare's registrar says of these names: which it sells, and for how much. */
async function offersOf(cf: Cloudflare, account: string, domains: string[]): Promise<Offer[]> {
  const answer = await cf("POST", `/accounts/${account}/registrar/domain-check`, { domains });
  return resultOf(z.object({ domains: z.array(Offer) }), answer)?.domains ?? [];
}

type Pick = { domain: string; zone?: Zone; buy?: Offer; bring?: boolean };

/** The domain, and how the account gets it: a zone it has, one to buy, or one to bring. With no
 *  `--domain`, the person picks from the account's zones and the free names of `candidatesOf`
 *  with their prices, and may type a domain, or a few words for more names: the question comes
 *  again until a domain is picked. `person` is the name the candidates are made from. */
async function pickDomain(
  cf: Cloudflare,
  account: string,
  input: DeployInput,
  name: string,
  zones: Zone[],
  person: string,
): Promise<Pick> {
  const OTHER = "\0other";
  const free = async (words?: string) =>
    (await offersOf(cf, account, candidatesOf(person, words))).filter((offer) => offer.registrable);
  let offers = input.domain ? [] : await free();
  for (;;) {
    let domain =
      input.domain?.toLowerCase() ||
      (await ask<string>("pass --domain <domain>", () =>
        p.select({
          message:
            "Which domain does the mind live at? It takes the whole domain: its site, its mail and its sign-in.",
          maxItems: 14,
          options: [
            ...zones
              .filter((zone) => !zone.unread && (!zone.mind || zone.mind === name))
              .map((zone) => ({
                value: zone.name,
                label: zone.name,
                hint: zone.mind ? "this mind is here already" : "in this account",
              })),
            ...offers.map((offer) => ({
              value: offer.name,
              label: offer.name,
              hint: `free to buy, ${priceOf(offer)}`,
            })),
            { value: OTHER, label: "Another domain, or more names", hint: "type it" },
          ],
        }),
      ));
    if (domain === OTHER) {
      const typed = (
        await ask<string>("pass --domain <domain>", () =>
          p.text({
            message: "A domain (ada-labs.com), or a few words to find more free names",
            validate: (value) => (value?.trim() ? undefined : "A domain, or a few words"),
          }),
        )
      )
        .trim()
        .toLowerCase();
      if (!DOMAIN.test(typed)) {
        const more = await free(typed);
        if (more.length === 0) p.log.warn(`No name from "${typed}" is free at Cloudflare.`);
        // the new names first, then the ones from before
        offers = [...more, ...offers.filter((old) => more.every((now) => now.name !== old.name))];
        continue;
      }
      domain = typed;
    }
    if (!DOMAIN.test(domain)) throw new Error(`${JSON.stringify(domain)} is no domain.`);
    const zone =
      zones.find((candidate) => candidate.name === domain) ||
      (await zonesOf(cf, account, domain))[0];
    if (zone) return { domain, zone };
    const offer =
      offers.find((candidate) => candidate.name === domain) ||
      (await offersOf(cf, account, [domain])).find((candidate) => candidate.name === domain);
    if (offer?.registrable) {
      const buy =
        input.buy ||
        (await ask<boolean>(`pass --buy to buy ${domain} for ${priceOf(offer)}`, () =>
          p.confirm({
            message: `Buy ${domain} for ${priceOf(offer)}? Cloudflare charges the card in your account.`,
          }),
        ));
      if (buy) return { domain, buy: offer };
    } else {
      const bring =
        input.yes ||
        (await ask<boolean>(
          `${domain} is not for sale at Cloudflare; pass --yes when it is yours at another registrar`,
          () =>
            p.confirm({
              message: `${domain} is not for sale at Cloudflare. Is it yours at another registrar? You then set its nameservers to Cloudflare's.`,
            }),
        ));
      if (bring) return { domain, bring: true };
    }
    // a no to a domain that a flag named has no other answer; a person picks again
    if (input.domain) throw new Error(`Run the command again with another domain than ${domain}.`);
  }
}

/** The zone of the picked domain, active: bought or added first when the account has none. */
async function zoneOf(cf: Cloudflare, account: string, pick: Pick): Promise<Zone> {
  const { domain } = pick;
  const found = async (): Promise<Zone | undefined> =>
    resultOf(z.array(ZoneRow), await cf("GET", `/zones?name=${domain}&account.id=${account}`))?.[0];
  const add = () => cf("POST", "/zones", { name: domain, account: { id: account }, type: "full" });
  let zone = pick.zone ?? (await found());
  if (!zone && pick.buy) {
    const card = async () =>
      resultOf(
        z.object({ has_default_payment_method: z.boolean() }),
        await cf("GET", `/accounts/${account}/ai-gateway/billing/credit-balance`),
      )?.has_default_payment_method === true;
    if (!(await card())) {
      page(
        `Add a payment card: Cloudflare charges it for ${domain}.`,
        `https://dash.cloudflare.com/${account}/billing/subscriptions?paymentMethod=add`,
      );
      await until("Waiting for the card", card);
    }
    // Cloudflare has the registrant's contact only after a first purchase in its own pages
    const contact =
      (await cf("GET", `/accounts/${account}/registrar/domains?per_page=1`)).total > 0;
    let bought = contact
      ? await cf("POST", `/accounts/${account}/registrar/registrations`, { domain_name: domain })
      : undefined;
    if (bought && bought.status >= 300 && /agreement/i.test(bought.error)) {
      page(
        "Accept Cloudflare's Domain Registration Agreement, then come back here.",
        `https://dash.cloudflare.com/${account}/domains/registrations`,
      );
      await ask<boolean>("accept the agreement on that page, then run the command again", () =>
        p.confirm({ message: "Accepted?" }),
      );
      bought = await cf("POST", `/accounts/${account}/registrar/registrations`, {
        domain_name: domain,
      });
    }
    if (bought && bought.status < 300) p.log.success(`Bought ${domain} for ${priceOf(pick.buy)}.`);
    else {
      if (bought)
        p.log.warn(
          `Cloudflare did not sell ${domain} by its API (${bought.status}: ${bought.error}).`,
        );
      page(
        `Buy ${domain} in Cloudflare's own pages (a first domain needs your contact details there).`,
        `https://dash.cloudflare.com/${account}/domains/register/${domain}`,
      );
    }
    zone = await until(`Waiting for ${domain} in the account`, async () => {
      const there = await found();
      if (there) return there;
      // a registration that ended with no zone yet: the zone is made here
      const status = await cf(
        "GET",
        `/accounts/${account}/registrar/registrations/${domain}/registration-status`,
      );
      const said = resultOf(z.object({ state: z.string() }), status)?.state ?? "";
      if (!/succeeded|registered|active/i.test(said)) return undefined;
      return resultOf(ZoneRow, await add());
    });
  }
  if (!zone) {
    const added = await add();
    zone = resultOf(ZoneRow, added);
    if (!zone)
      throw new Error(
        `Cloudflare did not add ${domain} to the account (${added.status}): ${added.error}`,
      );
    const servers =
      resultOf(z.object({ name_servers: z.array(z.string()) }), added)?.name_servers ?? [];
    p.log.step(
      `At the registrar of ${domain}, replace its nameservers with these two:\n${servers.join("\n")}`,
    );
  }
  if (zone.status === "active") return zone;
  const { id } = zone;
  let asked = 0;
  return until(
    `Waiting for Cloudflare to activate ${domain}`,
    async () => {
      // Cloudflare looks again by itself, slowly: ask it to, once a minute
      if (Date.now() - asked > 60_000) {
        asked = Date.now();
        await cf("PUT", `/zones/${id}/activation_check`);
      }
      const now = resultOf(ZoneRow, await cf("GET", `/zones/${id}`));
      if (now?.status === "active") return now;
      return undefined;
    },
    pick.bring ? 24 * 60 : 30,
  );
}

/** The account, by flag or by question; a new one is made in the person's name. */
async function pickAccount(
  cf: Cloudflare,
  input: DeployInput,
  name: string,
): Promise<{ account: Account; made: boolean }> {
  const NEW = "\0new";
  const accounts = await accountsOf(cf);
  const fresh = `iterate-${name}`;
  let chosen = input.newAccount ? NEW : input.account;
  if (!chosen && accounts.length === 0)
    throw new Error("This access to Cloudflare reaches no account.");
  chosen ||= await ask<string>("pass --account <id or name>, or --new-account", () =>
    p.select({
      message: "Which Cloudflare account does the mind live in?",
      options: [
        ...accounts.map((account) => ({
          value: account.id,
          label: account.name,
          hint: account.id.slice(0, 8),
        })),
        {
          value: NEW,
          label: "A new account for this mind",
          hint: "keeps it apart from what you have; Cloudflare allows five extra, and only you can delete one",
        },
      ],
    }),
  );
  if (chosen !== NEW) {
    // the list is the access's first 50 accounts: one named by its id is asked for directly
    const account =
      accounts.find((candidate) => candidate.id === chosen || candidate.name === chosen) ||
      (/^[0-9a-f]{32}$/.test(chosen)
        ? resultOf(Account, await cf("GET", `/accounts/${chosen}`))
        : undefined);
    if (!account)
      throw new Error(
        `This access to Cloudflare reaches no account ${JSON.stringify(chosen)}. It reaches: ${accounts.map((a) => `${a.name} (${a.id})`).join(", ")}.`,
      );
    return { account, made: false };
  }
  // an earlier run made it: a second run makes no second account
  const before = accounts.find((candidate) => candidate.name === fresh);
  if (before) return { account: before, made: false };
  const made = await cf("POST", "/accounts", { name: fresh, standalone: true });
  const account = resultOf(Account, made);
  if (!account)
    throw new Error(
      `Cloudflare made no new account (${made.status}): ${made.error}. Its rules: the login is at least seven days old, it is Super Administrator of an account, and it has fewer than five extra accounts. Run again with an account you have.`,
    );
  p.log.success(`Made the Cloudflare account ${fresh}.`);
  return { account, made: true };
}

// ---------------------------------------------------------------------------------------------
// The mind's first steps.

/** What the command needs of the rest of the CLI once the mind answers: cli.ts gives both. */
export type MindSteps = {
  /** `iterate login` by the browser, then a connection to the mind. `openBrowser` gets the
   *  authorization page in place of the CLI's own opener. */
  signIn: (address: string, openBrowser: (url: URL) => void) => Promise<MindConnection>;
  /** `iterate chatgpt connect` on that connection. */
  connectChatgpt: (connection: MindConnection, print: (line: string) => void) => Promise<unknown>;
};

/** The page that does the first owner's two things in one go: `/keys/first` spends the ticket
 *  and has the owner add a passkey, and its `next` then leads on to `authorize`, the CLI's own
 *  sign-in page (core/auth-worker first-owner.ts honours a `next` at the issuer's origin). The
 *  ticket is in the fragment, which no server sees. */
export function firstSignInPage(domain: string, ticket: string, authorize: URL): URL {
  const page = new URL(`https://iterate.${domain}/keys/first`);
  if (authorize.origin === page.origin)
    page.searchParams.set("next", `${authorize.pathname}${authorize.search}`);
  page.hash = ticket;
  return page;
}

/** ONE TURN OF THE ONBOARDING AGENT, as a script that runs in the mind: it says "hi" to
 *  `/agents/onboarding` (what a new owner writes there first, so the chat has its greeting when
 *  they open it), and answers how the model's request ended (`llm-request-settled`'s result), or
 *  `{ status: "timeout" }` after 50 seconds: a call must answer within the minute. A mind is born
 *  at its first request and publishes its config seconds later; until then it has no agents ("no
 *  rewrite rule matches itx.agents…"), and then for a moment no onboarding agent ("not created").
 *  The "hi" is tried again through both. */
export function onboardingTurnScript(): string {
  return `async (itx) => {
  const path = "/agents/onboarding";
  const end = Date.now() + 50_000;
  let sent;
  while (!sent) {
    try {
      sent = await itx.agents.get(path).message("hi");
    } catch (error) {
      // the platform's codes for the two; their words too, for a refusal whose code did not cross
      const notYet =
        error?.code === "NO_ITX_EXPRESSION_MATCH" ||
        error?.code === "NOT_CREATED" ||
        /no rewrite rule|not created/.test(String(error));
      if (Date.now() > end - 10_000 || !notYet) throw error;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  for (; Date.now() < end; await new Promise((r) => setTimeout(r, 1500))) {
    const { events } = await itx.cd(path).readEvents(sent.offset, 200);
    const settled = events.find((event) => event.type === "events.iterate.com/agent/llm-request-settled");
    if (settled) return settled.payload.result;
  }
  return { status: "timeout" };
}`;
}

const TurnResult = z.object({
  status: z.string(),
  text: z.string().optional(),
  errorMessage: z.string().optional(),
});

/** Why the onboarding agent gave no answer, or null when it answered. */
async function onboardingSilence(itx: MindItx): Promise<string | null> {
  let said: unknown;
  try {
    said = await itx.run(onboardingTurnScript());
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const turn = TurnResult.safeParse(said).data;
  if (turn?.status === "succeeded") return null;
  if (turn?.status === "timeout") return "no answer from the model within 50 seconds";
  return turn?.errorMessage || `the model's request ended as ${turn?.status || "nothing readable"}`;
}

/** How the mind's MCP server is added to each coding agent this command knows, by that agent's
 *  own CLI, for the whole user and not one folder; `then` is what signs the agent in. The server
 *  is named after the domain (`mindMcpNameOf`), so two minds sit side by side. */
export function mcpInstalls(domain: string) {
  const name = mindMcpNameOf(domain);
  const url = mindMcpUrlOf(domain);
  return [
    {
      command: "claude",
      label: "Claude Code",
      args: ["mcp", "add", "--transport", "http", "--scope", "user", name, url],
      then: "in Claude Code, run /mcp and sign in",
    },
    {
      command: "codex",
      label: "Codex",
      args: ["mcp", "add", name, "--url", url],
      then: `run: codex mcp login ${name}`,
    },
  ];
}

/** THE MIND'S FIRST STEPS, for a person at the terminal, in this order:
 *  1. the passkey and the first sign-in, in one browser page (`firstSignInPage`);
 *  2. a way to pay for the model: a ChatGPT plan, an OpenAI API key, or none;
 *  3. the onboarding agent's answer; with none, step 2 comes again, until it answers or the
 *     person chooses none;
 *  4. the offer to add the mind's MCP server to the coding agents installed here. */
async function firstSteps(domain: string, ticket: string, steps: MindSteps) {
  using connection = await steps.signIn(domain, (authorize) =>
    page(
      "Open your mind and make your passkey. The same page then signs this terminal in. The link works once, within 24 hours:",
      firstSignInPage(domain, ticket, authorize).href,
    ),
  );
  const { itx } = connection;
  p.log.success(`This terminal is signed in to ${domain}.`);

  for (;;) {
    const way = await ask<string>("", () =>
      p.select({
        message: "What pays for your mind's model?",
        options: [
          { value: "chatgpt", label: "A ChatGPT Plus or Pro plan", hint: "recommended" },
          { value: "openai", label: "An OpenAI API key" },
          { value: "none", label: "Nothing now", hint: "it has a model already, or later" },
        ],
      }),
    );
    if (way === "chatgpt") await steps.connectChatgpt(connection, (line) => p.log.message(line));
    if (way === "openai") {
      const form = z.object({ url: z.string() }).parse(
        await itx.run(`async (itx) => itx.secrets.collectFromUser({
  path: "/secrets/openai",
  egress: { urls: ["https://api.openai.com"] },
  description: "An OpenAI API key",
})`),
      );
      page("Paste the key on this page of your own mind. iterate never sees it.", form.url);
      await ask<boolean>("", () => p.confirm({ message: "Is the key saved?" }));
    }
    const asking = wait("Saying hi to your onboarding agent");
    const silence = await onboardingSilence(itx);
    if (!silence) {
      asking.done("Your onboarding agent answers.");
      break;
    }
    asking.fail(`Your onboarding agent gave no answer: ${silence}`);
    if (way === "none") break;
  }

  const installs = mcpInstalls(domain).filter(
    (install) => spawnSync(install.command, ["--version"], { stdio: "ignore" }).status === 0,
  );
  if (installs.length === 0) {
    p.log.info(`Your mind's MCP server, for a coding agent: ${mindMcpUrlOf(domain)}`);
    return;
  }
  const chosen = await ask<string[]>("", () =>
    p.multiselect({
      message: "Add your mind's MCP server to the coding agents on this computer?",
      options: installs.map((install) => ({ value: install.command, label: install.label })),
      initialValues: installs.map((install) => install.command),
      required: false,
    }),
  );
  for (const install of installs.filter((candidate) => chosen.includes(candidate.command))) {
    const added = spawnSync(install.command, install.args, { encoding: "utf8" });
    if (added.status === 0)
      p.log.success(`Added to ${install.label}. To sign in: ${install.then}.`);
    else
      p.log.warn(
        `${install.label} did not add it: ${(added.stderr || added.stdout || "").trim().slice(-300)}`,
      );
  }
}

// ---------------------------------------------------------------------------------------------
// The command.
// ---------------------------------------------------------------------------------------------
// The command.

export async function deployMind(input: DeployInput, steps: MindSteps) {
  const began = Date.now();
  const children = new Set<ChildProcess>();
  // 𝑖 is U+1D456, the letter of iterate's logo
  p.intro("𝑖  iterate deploy: a mind in your own Cloudflare account");

  try {
    if (process.platform === "win32")
      throw new Error("iterate deploy runs on macOS and Linux (on Windows: in WSL).");
    if (input.name && !NAME.test(input.name))
      throw new Error(
        "--name: lower case letters, digits and -, 2 to 30 characters, a letter first.",
      );
    // the source comes while the person signs in and chooses
    const sourceBegan = Date.now();
    const source = sourceOf(input);
    source.catch(() => {});
    const signIn = (fresh = false) =>
      cloudflareAccess(({ url, code, minutes }) => {
        page(
          `Sign in at Cloudflare and approve the access. Check that the page shows the code ${code}. Select the account for the mind. The code works for ${minutes} minutes.`,
          url.href,
        );
      }, fresh);
    let access = await signIn();
    // THE ACCESS ENDS WITHIN THE HOUR, and a wait for a card or a domain can be longer. So each
    // call takes the access anew: the kept one, or a new sign-in once it has too little left
    // (cloudflare-access.ts). One sign-in at a time, whatever calls wait for it.
    let renewing: Promise<typeof access> | undefined;
    const renewed = () =>
      (renewing ||= signIn().finally(() => {
        renewing = undefined;
      }));
    const cf: Cloudflare = async (method, path, body) => {
      access = await renewed().catch((error: unknown) => {
        throw new Stop(error instanceof Error ? error.message : String(error));
      });
      return cloudflare(access.token)(method, path, body);
    };
    const user = await cf("GET", "/user");
    const said = resultOf(
      z.object({
        email: z.string(),
        first_name: z.string().nullish(),
        last_name: z.string().nullish(),
      }),
      user,
    );
    const login = said?.email;
    // an account's own API token reads no user: the owner then comes by the flag
    if (user.status !== 200 && access.from === "sign-in") {
      await endAccess(access);
      throw new Error(
        `Cloudflare refused the kept access (${user.status}). Run the command again to sign in.`,
      );
    }
    const owner = (
      input.owner ||
      login ||
      (await ask<string>("pass --owner <email>", () =>
        p.text({
          message: "The owner's email address",
          validate: (value) =>
            /^\S+@\S+\.\S+$/.test(value || "") ? undefined : "An email address",
        }),
      ))
    ).toLowerCase();
    const name = input.name || nameOf(owner);
    p.log.info(
      `Signed in to Cloudflare${login ? ` as ${login}` : ""}. The mind's owner is ${owner}.`,
    );

    let { account, made } = await pickAccount(cf, input, name);
    // an access from before the account was made may not reach it: Cloudflare then asks once more
    if (made && (await cf("GET", `/accounts/${account.id}/workers/subdomain`)).status === 403) {
      if (access.from !== "sign-in")
        throw new Error(
          `The token in CLOUDFLARE_API_TOKEN does not reach the new account ${account.name} (${account.id}).`,
        );
      await endAccess(access);
      p.log.info(
        `Cloudflare asks once more, for the new account: select ${account.name} on its page.`,
      );
      access = await signIn(true);
    }
    const on = async (path: string) =>
      (await cf("GET", `/accounts/${account.id}${path}`)).status === 200;
    const paidPath = "/containers/applications";
    const r2Path = "/r2/buckets?per_page=1";
    const [paid, r2, zones, subdomain] = await Promise.all([
      on(paidPath),
      on(r2Path),
      zonesOf(cf, account.id),
      cf("GET", `/accounts/${account.id}/workers/subdomain`),
    ]);
    p.log.info(
      `Account ${account.name}: Workers Paid ${paid ? "on" : "off"}, R2 ${r2 ? "on" : "off"}, ${zones.length} domain${zones.length === 1 ? "" : "s"}.`,
    );

    // the names offered come from the person's name at Cloudflare, else from the owner's address
    const person =
      [said?.first_name, said?.last_name].filter(Boolean).join(" ") ||
      (owner.split("@")[0] || "").split("+")[0]!.replace(/[^a-z0-9]+/g, " ");
    const pick = await pickDomain(cf, account.id, input, name, zones, person);
    const { domain } = pick;
    if (owner.endsWith(`@${domain}`) || owner.endsWith(`.${domain}`))
      throw new Error(
        `The owner's address ${owner} is at ${domain}, and the mind takes that domain's mail. Pass --owner with an address elsewhere, or choose another domain.`,
      );
    if (pick.zone?.unread)
      throw new Error(
        `Cloudflare did not answer with the Workers routes of ${domain}, so nothing says whether a mind lives there already. Nothing was changed. Run the command again.`,
      );
    if (pick.zone?.mind && pick.zone.mind !== name)
      throw new Error(
        `Another mind lives at ${domain} already (its stack is ${pick.zone.mind}). Choose another domain.`,
      );
    const elsewhere = zones.find((zone) => zone.mind === name && zone.name !== domain);
    if (elsewhere)
      throw new Error(
        `A mind named ${name} lives at ${elsewhere.name} already. Pass --name with another name for this one.`,
      );
    const again = pick.zone?.mind === name;
    if (
      again &&
      !input.yes &&
      !(await ask<boolean>(`this mind is at ${domain} already; pass --yes to deploy over it`, () =>
        p.confirm({
          message: `This mind is at ${domain} already. Deploy over it? Its config is written again, with ${owner} as its only member.`,
        }),
      ))
    )
      throw new Error("Nothing was changed.");

    // the account's workers.dev name: a new account has none, and a Worker needs one
    if (!resultOf(z.object({ subdomain: z.string().min(1) }), subdomain)) {
      let refusal = "";
      for (const candidate of [
        `iterate-${name}`,
        `iterate-${name}-${Math.random().toString(36).slice(2, 6)}`,
      ]) {
        const put = await cf("PUT", `/accounts/${account.id}/workers/subdomain`, {
          subdomain: candidate,
        });
        refusal = put.status === 200 ? "" : `${put.status}: ${put.error}`;
        if (!refusal) break;
      }
      if (refusal)
        throw new Error(
          `Cloudflare gave the account no workers.dev name (${refusal}). Set one at https://dash.cloudflare.com/${account.id}/workers-and-pages and run the command again.`,
        );
    }

    const waiting = wait("Getting iterate's source");
    const ready = await source.catch((error: unknown) => {
      waiting.fail("iterate's source did not install");
      throw error;
    });
    waiting.done(`iterate's source is ready (${seconds(sourceBegan)}): ${ready.dir}`);
    const alchemy = join(ready.dir, "core/alchemy");
    const work = join(CACHE, "deploys", name);
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const log = join(work, "deploy.log");
    writeFileSync(log, "");
    const ticket = z
      .object({ ticket: z.string(), variable: z.string() })
      .parse(
        JSON.parse(
          (await exec(process.execPath, ["scripts/first-owner-ticket.ts", owner], { cwd: alchemy }))
            .stdout,
        ),
      );
    const cloud =
      input.cloud === false
        ? undefined
        : await fetch(`${CLOUD}/.well-known/iterate-cloud`)
            .then(async (answer) => ({
              origin: CLOUD,
              publicKey: z.object({ publicKey: z.string() }).parse(await answer.json()).publicKey,
            }))
            .catch(() => undefined);
    if (input.cloud !== false && !cloud)
      p.log.warn(`${CLOUD} did not answer: the mind is deployed without iterate Cloud's clients.`);
    if (!paid) {
      page(
        "Turn on Workers Paid: 5 dollars a month. Cloudflare asks for a card there.",
        `https://dash.cloudflare.com/${account.id}/workers/plans`,
      );
      await until("Waiting for Workers Paid", () => on(paidPath));
    }
    if (!r2) {
      page(
        "Turn on R2: it is free at this size.",
        `https://dash.cloudflare.com/${account.id}/r2/overview`,
      );
      await until("Waiting for R2", () => on(r2Path));
    }
    const zone = await zoneOf(cf, account.id, pick);
    p.log.success(`${zone.name} is active in the account.`);

    const config = join(work, "config.json");
    writeFileSync(
      config,
      JSON.stringify(
        configOf({
          name,
          accountId: account.id,
          owner,
          domain,
          cloud,
          apiTokens: input.apiTokens,
          sandboxImage: input.sandboxImage,
        }),
        null,
        2,
      ),
    );
    access = await renewed();
    const deployBegan = Date.now();
    const deploying = wait(`Deploying the mind at ${domain}`);
    const code = await deployStack({
      source: ready,
      name,
      token: access.token,
      log,
      children,
      say: deploying.say,
      env: {
        CLOUDFLARE_ACCOUNT_ID: account.id,
        ITERATE_MIND_CONFIG: config,
        ITERATE_FIRST_OWNER_TICKET: ticket.variable,
      },
    });
    if (code !== 0) {
      deploying.fail(`The deploy failed (exit ${code}).`);
      console.log(readFileSync(log, "utf8").trimEnd().split("\n").slice(-40).join("\n"));
      throw new Error(
        `The deploy failed (exit ${code}). Its whole log: ${log}. A deploy keeps what it made: run the command again.`,
      );
    }
    deploying.done(`Deployed (${seconds(deployBegan)}).`);

    const link = `https://iterate.${domain}/keys/first#${ticket.ticket}`;
    await until(
      `Waiting for iterate.${domain} to answer`,
      async () => {
        const answer = await fetch(
          `https://iterate.${domain}/.well-known/oauth-authorization-server`,
          { signal: AbortSignal.timeout(10_000) },
        );
        const issuer = z.object({ issuer: z.string() }).safeParse(await answer.json()).data;
        return answer.ok && issuer?.issuer === `https://iterate.${domain}`;
      },
      10,
    );
    await endAccess(access);
    // the mind is born at its first request: this one, so that it is ready when the person is
    void fetch(`https://${domain}/`).catch(() => {});
    // The mind is deployed: a fault in its first steps is a line, never a failed deploy. With
    // nobody at the terminal, the link is all there is to do here.
    if (input.setup !== false && interactive())
      await firstSteps(domain, ticket.ticket, steps).catch((error: unknown) =>
        p.log.warn(
          `The first steps did not end: ${error instanceof Error ? error.message : String(error)}. If your passkey is not made yet: ${link}`,
        ),
      );
    else page("Open your mind and make your passkey. This link works once, within 24 hours:", link);
    p.note(
      [
        `Talk to your mind:   https://dash.${domain}/?agent=/agents/onboarding`,
        `Give it a model:     npx iterate@latest chatgpt connect ${domain}`,
        `Its MCP server:      ${mindMcpUrlOf(domain)}`,
        `The deploy's log:    ${log}`,
      ].join("\n"),
      `Your mind is at ${domain}`,
    );
    p.outro(`Done in ${seconds(began)}.`);
  } catch (error) {
    // a stop is an expected end: its one line, with no stack, and a failed exit code
    for (const child of children) child.kill();
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro(`Stopped after ${seconds(began)}.`);
    process.exit(1);
  }
}
