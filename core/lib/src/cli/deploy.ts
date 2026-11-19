// deploy.ts — `iterate deploy`: A MIND IN A PERSON'S OWN CLOUDFLARE ACCOUNT, by one program that
// asks as little as it can and waits for nothing it does not need. No model and no server of
// iterate's is in between:
//
//   1. access to Cloudflare (./cloudflare-access.ts), and the account: one the person has, or a
//      new one;
//   2. the domain: a zone of the account, a new one that Cloudflare's registrar sells, or one the
//      person brings;
//   3. what the account must have: a workers.dev name, Workers Paid and R2;
//   4. the script's one input (core/alchemy/src/config.ts), written here: for a new mind from the
//      answers, for a mind that is there already from that mind's own config (`deployedMind`),
//      for an earlier deploy whose config is here, from that config (`earlierDeployOf`);
//      and for a new mind its identity (./identity.ts): one root key and the genesis that it
//      signed, in two files on this computer, before anything is deployed;
//   5. the stack's source (core/alchemy and the Workers), fetched and installed in the background
//      while the person signs in, and the stack's own deploy, `pnpm run deploy` of core/alchemy;
//   6. the post of the mind's identity records to the mind, when this computer holds them;
//   7. with a person there, the mind's first steps (`firstSteps` below): the first sign-in, a way
//      to pay for the model, the onboarding agent's answer, and the mind's MCP server in the
//      coding agents of this computer.
//
// It handles the expected way alone. A run that stops says why, changes nothing more, and can be
// run again on the same computer: every step reads the account's state first, and a deploy keeps
// what it made. Each choice has a flag, so a coding agent can run and supervise it with nobody at
// the terminal.
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import { z } from "zod";
import { mindAddressAsTyped, mindMcpNameOf, mindMcpUrlOf } from "../mind-api.ts";
import {
  Hostname,
  MindConfig,
  zoneCoversControlPlaneHostname,
  zoneOfMailAddress,
} from "../mind-config.ts";
import type { MindConnection, MindItx } from "../node.ts";
import { isCodingAgent } from "./coding-agent.ts";
import {
  type Answer,
  type Cloudflare,
  apiTokenPage,
  cloudflare,
  cloudflareAccess,
  DEPLOY_SCOPES,
  endAccess,
  MAKES_API_TOKENS,
  OAUTH_CLIENT_WRITE,
  parsed,
  resultOf,
} from "./cloudflare-access.ts";
import { type LoginFlow, loginFlowFor } from "./device-login/flow.ts";
import {
  IDENTITIES,
  identityMadeFor,
  keyFileOf,
  mlDsaRequired,
  newIdentity,
  postIdentity,
} from "./identity.ts";
import { openPageCommand } from "./open-page.ts";

const exec = promisify(execFile);
const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "iterate");

export type DeployInput = {
  domain?: string;
  account?: string;
  newAccount?: boolean;
  owner?: string;
  controlPlaneHostname?: string;
  yes?: boolean;
  buy?: boolean;
  eraseRecords?: boolean;
  source?: string;
  ref?: string;
  setup?: boolean;
};

// ---------------------------------------------------------------------------------------------
// What the program decides with no question. Pure, so that a test holds them.

/** THE STAGE OF A MIND, which is the middle of every name the stack gives a resource
 *  (`iterate-<stage>-auth`): inferred from the mind's first zone and never asked. The zone with
 *  `-` for each dot, cut to the 32 characters that the script takes (core/alchemy/src/config.ts),
 *  and with `z` first for a zone that starts with a digit, since a stage starts with a letter. */
export function stageNameOf(zone: string) {
  const name = zone.replaceAll(".", "-");
  return (/^[a-z]/.test(name) ? name : `z${name}`).slice(0, 32).replace(/-+$/, "");
}

/** A deployed mind's config as its Workers hold it. `mindId` may be absent: the Workers of a
 *  mind that was deployed before a mind had an id hold none. Every other rule of `MindConfig`
 *  holds, the control-plane hostname under one of the zones among them: `iterate recover`
 *  prints a sign-in link at that hostname, so a config that names a hostname outside the mind
 *  is no config of a mind. */
const DeployedConfig = z
  .object({ ...MindConfig.shape, mindId: MindConfig.shape.mindId.optional() })
  .refine(zoneCoversControlPlaneHostname, {
    path: ["controlPlaneHostname"],
    message:
      "the apex of one of zones, or one label under one: a zone's certificate covers no deeper name",
  });

/** THE WHOLE CONFIG OF THE DEPLOY THAT A MIND RUNS, as the stack keeps it in its boundary
 *  Worker's plain-text variable `DEPLOY_CONFIG` (core/alchemy/src/config.ts `MindConfig`). It holds
 *  what no Worker reads, such as `cloudflare.containerImage`, the sandboxes' image. Each field is
 *  kept as it is, those that this command does not know too: a deploy over the mind starts from
 *  it, and a field that it lost would plan as a change. */
const KeptDeployConfig = z.looseObject({
  alchemy: z.looseObject({ stageName: z.string() }),
  cloudflare: z.looseObject({ accountId: z.string(), zones: z.array(z.string()) }),
});

/** A mind that is deployed: its stage, its own config, and its deploy's whole config, which a
 *  mind deployed before the stack kept it lacks. */
type DeployedMind = z.infer<typeof DeployedConfig> & {
  stageName: string;
  deployConfig?: z.infer<typeof KeptDeployConfig>;
};

/** THE SCRIPT'S ONE INPUT (core/alchemy/src/config.ts `MindConfig`) BUT FOR A NEW MIND'S ID, or
 *  an error that says which answer it refuses. A new mind takes the zone `domain` whole, has
 *  `owner` as its one owner, and answers at `iterate.<domain>` unless `controlPlaneHostname`
 *  names the zone itself or another name one label under it. A mind that is `deployed` keeps its
 *  zones, its topology, its owners and its hostname: `owner` and `controlPlaneHostname` are then
 *  what a flag said, and each replaces what the mind has.
 *
 *  `mindId` is the deployed mind's own, and nothing here ever gives a mind that has an id
 *  another. A mind with none gets the hash of the genesis that the command signs right before
 *  the deploy (./identity.ts `newIdentity`), which names the hostname that this answers. */
export function deployConfigOf(answers: {
  accountId: string;
  domain: string;
  owner?: string;
  controlPlaneHostname?: string;
  deployed?: DeployedMind;
}) {
  const { deployed } = answers;
  const zones = deployed?.zones || [answers.domain];
  const controlPlaneHostname = (
    answers.controlPlaneHostname ||
    deployed?.controlPlaneHostname ||
    `iterate.${answers.domain}`
  ).toLowerCase();
  if (
    !Hostname.safeParse(controlPlaneHostname).success ||
    !zoneCoversControlPlaneHostname({ controlPlaneHostname, zones })
  )
    throw new Error(
      `The control plane cannot answer at ${controlPlaneHostname}: its hostname is ${zones.join(" or ")}, or one label under it. Cloudflare's certificate for a zone covers no deeper name.`,
    );
  const ownerEmails = answers.owner ? [answers.owner.toLowerCase()] : deployed?.ownerEmails || [];
  const atTheMind = ownerEmails.find((email) => zoneOfMailAddress({ zones }, email));
  if (atTheMind)
    throw new Error(
      `The owner's address ${atTheMind} is at a domain of the mind, and the mind takes that domain's mail. Pass --owner with an address elsewhere, or choose another domain.`,
    );
  if (!z.array(z.email()).min(1).safeParse(ownerEmails).success)
    throw new Error(
      `The owner is an email address, and ${ownerEmails.join(", ") || "none"} is not.`,
    );
  // a mind that is there starts from its deploy's whole config: only what a flag names changes
  const kept = deployed?.deployConfig;
  return {
    ...kept,
    mindId: deployed?.mindId,
    controlPlaneHostname,
    ownerEmails,
    topology: deployed?.topology || ("full-cloudflare" as const),
    alchemy: { ...kept?.alchemy, stageName: deployed?.stageName || stageNameOf(answers.domain) },
    cloudflare: { ...kept?.cloudflare, accountId: answers.accountId, zones },
  };
}

/** What Cloudflare answers for a Worker's settings: its bindings, a plain-text one with its text
 *  (https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/). */
const WorkerSettings = z.object({
  bindings: z.array(z.object({ type: z.string(), name: z.string(), text: z.string().optional() })),
});

/** A DEPLOYED MIND'S CONFIG OUT OF ITS BOUNDARY WORKER'S SETTINGS: the stack gives every Worker
 *  the same config as the plain-text variable `ITERATE` (iterate/mind-config), and Cloudflare
 *  lists a Worker's plain-text variables with their text. Undefined for settings that hold none. */
export function mindConfigIn(settings: unknown): Omit<DeployedMind, "stageName"> | undefined {
  const text = (name: string) =>
    WorkerSettings.safeParse(settings).data?.bindings.find(
      (binding) => binding.type === "plain_text" && binding.name === name,
    )?.text;
  const config = parsed(DeployedConfig, text("ITERATE") || "");
  const deployConfig = parsed(KeptDeployConfig, text("DEPLOY_CONFIG") || "");
  return config && { ...config, deployConfig };
}

/** Whether a line of a deploy's output says that the stack's state store refused a request. A
 *  store that the same run made does so in its first seconds, and nothing is made without state:
 *  the one failure after which the command deploys again by itself. */
export const saysTheStateStoreRefused = (line: string) =>
  /State store .*failed|StateStoreError/.test(line);

/** THE RUN'S LAST WORDS: the mind's sign-in, then its addresses and commands, one to a line.
 *  The words for a first passkey are for a new mind's owners, or for an owner that this run
 *  added to a mind that was there (`ownersBefore`). Every other owner is sent to the sign-in
 *  page, with one clause for an owner who never added a passkey. A mind that was there has its
 *  chat and its model, so its lines name neither. */
export function closingOf(mind: {
  controlPlaneHostname: string;
  zone: string;
  owners: string[];
  ownersBefore?: string[];
}) {
  const { controlPlaneHostname, ownersBefore } = mind;
  const address = mindAddressAsTyped(controlPlaneHostname);
  const updated = Boolean(ownersBefore);
  const newOwners = mind.owners.filter((owner) => !ownersBefore?.includes(owner));
  return {
    newOwners,
    signInWords:
      newOwners.length > 0
        ? `Open your mind's sign-in page. As an owner with no passkey yet (${newOwners.join(", ")}), choose "prove your email address with Cloudflare", enter the code that Cloudflare mails you, and add your passkey:`
        : `The mind at ${controlPlaneHostname} is updated. Its owners sign in with a passkey on its sign-in page; an owner with no passkey yet chooses "prove your email address with Cloudflare" there:`,
    title: updated
      ? `Your mind at ${controlPlaneHostname} is updated`
      : `Your mind is at ${controlPlaneHostname}`,
    lines: [
      ...(updated
        ? []
        : [`Talk to your mind:   https://dash.${mind.zone}/?agent=/agents/onboarding`]),
      `Sign in from here:   npx iterate@latest login ${address}`,
      ...(updated ? [] : [`Give it a model:     npx iterate@latest chatgpt connect ${address}`]),
      `Its MCP server:      ${mindMcpUrlOf(controlPlaneHostname)}`,
    ],
  };
}

/** WHAT THE COMMAND DOES NEXT FOR THE ACCOUNT'S ZERO TRUST ORGANIZATION, by Cloudflare's answer to
 *  `GET /accounts/<id>/access/organizations`, or, once `tried`, to the set-up after it. An owner
 *  proves their address through Cloudflare Access, which needs the organization
 *  (core/alchemy/src/access-team.ts). Cloudflare answers:
 *
 *  - 200 with the team's domain: there is one: go on;
 *  - 404, or 200 with no domain: there is none;
 *  - 403 "access.api.error.not_enabled: Access is not enabled" (code 9999): Zero Trust was never
 *    turned on.
 *
 *  For both of the last two the command first tries the set-up that the script would make, the
 *  same `POST` with no name, so Cloudflare picks the team's (`make`). Refused for Access or a plan,
 *  it is a gate that the person clears on Cloudflare's page; any other refusal, a missing
 *  permission say, stops the command with Cloudflare's words. Nobody has yet seen the set-up on
 *  an account that never had Zero Trust: whether Cloudflare allows it there is unknown. */
export function zeroTrustStep(account: string, answer: Answer, tried: boolean) {
  if (answer.status === 200 && resultOf(z.object({ auth_domain: z.string().min(1) }), answer))
    return { next: "go" } as const;
  const none = answer.status === 404 || answer.status === 200;
  const notEnabled = /not_enabled|not enabled|\bplans?\b|subscription/i.test(answer.error);
  if (!tried && (none || notEnabled)) return { next: "make" } as const;
  if (none || notEnabled)
    return {
      next: "gate",
      page: `https://one.dash.cloudflare.com/${account}/`,
      words:
        "Turn on Zero Trust: an owner of the mind proves their email address through Cloudflare Access, which is part of it.\nOn this page choose a team name and the Free plan. Cloudflare may ask for a payment method, and the Free plan charges nothing.",
    } as const;
  return {
    next: "stop",
    words: `Cloudflare refused ${tried ? "to set up" : "to read"} the account's Zero Trust organization (${answer.status}: ${answer.error}). The access needs "Access: Organizations, Identity Providers, and Groups Write". Nothing is deployed.`,
  } as const;
}

/** THE ENVIRONMENT VARIABLE OF AN API TOKEN THAT MAKES THE STACK'S OWN OAUTH CLIENT, and nothing
 *  else: the script's own name for it (core/alchemy src/cloudflare-oauth-client.ts). The command
 *  takes it from its own environment too, so an agent that supervises a run sets it and nobody
 *  pastes: one name in both places, as `CLOUDFLARE_API_TOKEN` is. It is a variable and no flag,
 *  since a flag's value stays in the shell's history and in the list of processes. */
export const OAUTH_CLIENT_TOKEN = "CLOUDFLARE_OAUTH_CLIENT_API_TOKEN";

/** WHETHER A DEPLOYED STACK HAS ITS OWN OAUTH CLIENT AT CLOUDFLARE, from its secrets Worker's
 *  settings: the stack gives that Worker the client's id as the plain-text variable
 *  `CLOUDFLARE_CLIENT_ID`, or `none` (core/alchemy src/stack.ts). The client's secret is in a
 *  secret variable, whose text no read shows, and which holds Cloudflare's refusal when there is
 *  no client: its existence says nothing. Settings with no such variable, and no secrets Worker
 *  at all, count as no client: the deploy asks for the token. */
export const stackHasOAuthClient = (settings: unknown) => {
  const id = WorkerSettings.safeParse(settings).data?.bindings.find(
    (binding) => binding.type === "plain_text" && binding.name === "CLOUDFLARE_CLIENT_ID",
  )?.text;
  return Boolean(id && id !== "none");
};

/** The words for a mind that is deployed with no OAuth client at Cloudflare: how to get it later. */
export const oauthClientLaterWords = (domain: string) =>
  `The mind has no OAuth client at Cloudflare yet, so it cannot read your Cloudflare account. To add it, run \`npx iterate deploy --domain ${domain}\` once more and paste one Cloudflare API token when it asks. An agent that runs the command sets ${OAUTH_CLIENT_TOKEN} to an API token of the account with "OAuth Client Write" instead.`;

/** WHAT THE COMMAND DOES FOR THE STACK'S OWN OAUTH CLIENT AT CLOUDFLARE (core/alchemy
 *  src/cloudflare-oauth-client.ts), before the deploy. The client needs the permission "OAuth
 *  Client Write", which no scope of Cloudflare's sign-in grants, and which a token made through a
 *  sign-in may not hold (Cloudflare refuses it: "The OAuth session does not include the scopes
 *  required"). So it comes by one API token that the person makes on Cloudflare's own page:
 *
 *  - `go`: nothing to do. The stack has its client, or the deploy's own credential may make it
 *    (an API token of the environment, or a pasted one, that holds the permission);
 *  - `given`: the environment has the token (`OAUTH_CLIENT_TOKEN`): checked, then used;
 *  - `later`: nobody at the terminal, or `--no-setup`: the deploy goes on without the client, and
 *    the words say how to get it;
 *  - `ask`: the page that makes the token with that one permission, and the words for it. */
export function oauthClientStep(state: {
  hasClient: boolean;
  credentialMay: boolean;
  given: boolean;
  person: boolean;
  account: { id: string; name: string };
  domain: string;
}) {
  if (state.hasClient || state.credentialMay) return { next: "go" } as const;
  if (state.given) return { next: "given" } as const;
  if (!state.person) return { next: "later", words: oauthClientLaterWords(state.domain) } as const;
  return {
    next: "ask",
    page: apiTokenPage([OAUTH_CLIENT_WRITE], "iterate: the mind's OAuth client").href,
    words: `One more permission: your mind gets its own OAuth client at Cloudflare, so that your mind can read your own Cloudflare account: its logs, usage and settings. It can change nothing there. Cloudflare's sign-in cannot grant the permission that makes the client, so make one API token with it on this page, where "OAuth Client Write" is filled in: choose the account ${state.account.name}, press "Continue to summary", then "Create Token", and copy the token. The deploy uses it only to make the client.`,
  } as const;
}

/** Whether `token` is an API token of `account` (or of a person) that may list the account's
 *  OAuth clients: the read of a token that holds "OAuth Client Write" (or Read). */
export async function oauthClientTokenWorks(token: string, account: string) {
  const call = cloudflare(token);
  const known =
    (await call("GET", `/accounts/${account}/tokens/verify`)).status === 200 ||
    (await call("GET", "/user/tokens/verify")).status === 200;
  return (
    known && (await call("GET", `/accounts/${account}/oauth_clients?per_page=1`)).status === 200
  );
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

// ---------------------------------------------------------------------------------------------
// The terminal.

const interactive = () =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY) && !isCodingAgent(process.env);

/** How the CLI's own sign-in reaches the person from this process (device-login/flow.ts).
 *  "device" says that the person's browser may be on another computer than this terminal (over
 *  SSH, on Linux with no display): no page is opened here then, and a step whose page comes back
 *  to this computer's own loopback address says where to run it instead. */
const signInFlow = () => loginFlowFor({ env: process.env, platform: process.platform });

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
  // a browser here is not the one the person looks at
  if (signInFlow() === "device") return;
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
 *  checkout this command runs in, else iterate/core at `ref` in the cache folder. A source whose
 *  core/alchemy is not the one script that this command writes the input of is refused. */
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
  // the script whose input this command writes names the control plane's hostname in its config
  const scriptConfig = join(dir, "core/alchemy/src/config.ts");
  if (
    !existsSync(scriptConfig) ||
    !readFileSync(scriptConfig, "utf8").includes("controlPlaneHostname")
  )
    throw new Error(
      `The source at ${dir} is a version of iterate before the one Alchemy script (its core/alchemy/src/config.ts names no controlPlaneHostname), and this command writes that script's input alone. Nothing was changed. Pass --source with a checkout that holds it.`,
    );
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
  stageName: string;
  /** the file that holds the script's one input */
  config: string;
  token: string;
  /** an API token for the stack's OAuth client alone (`OAUTH_CLIENT_TOKEN`), when there is one */
  clientToken?: string;
  log: string;
  children: Set<ChildProcess>;
  say?: (line: string) => void;
  /** a deploy that goes on with an earlier one whose config is here (`earlierDeployOf`) */
  adopt?: boolean;
};

/** THE ARGUMENTS OF `pnpm run deploy` of core/alchemy. A deploy that stopped before its end can
 *  leave a resource that Cloudflare made and Alchemy's state does not hold, since its creation was
 *  under way at the stop: Alchemy then refuses it ("OwnedBySomeoneElse", for a Pipelines stream,
 *  which carries no owner's tag) unless `--adopt` takes it over. The stage's state store says that
 *  such a resource, under the stage's own name, is the stack's own: so a deploy that goes on
 *  adopts. So does a new mind beside a store that reads as a destroy's leftover: a stack that
 *  stopped before its first Worker and its first record reads the same from outside, with its
 *  bucket, tokens and streams there, and after a real destroy nothing is there to take over. No
 *  other deploy adopts. */
export const deployArgsOf = (stageName: string, adopt = false) => [
  "run",
  "deploy",
  "--stage",
  stageName,
  "--yes",
  ...(adopt ? ["--adopt"] : []),
];

/** One `pnpm run deploy` of core/alchemy: its exit code, and whether the state store refused it.
 *  Every line goes to the log file, with the token's text replaced. */
function deployOnce(run: Run): Promise<{ code: number; storeRefused: boolean }> {
  return new Promise((done, failed) => {
    const file = createWriteStream(run.log, { flags: "a" });
    const { command, first } = run.source.pnpm;
    const child = spawn(command, [...first, ...deployArgsOf(run.stageName, run.adopt)], {
      cwd: join(run.source.dir, "core/alchemy"),
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        CLOUDFLARE_API_TOKEN: run.token,
        // only the token that this run checked, or none: an unset value is left out
        [OAUTH_CLIENT_TOKEN]: run.clientToken,
        ITERATE_MIND_CONFIG: run.config,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    run.children.add(child);
    let storeRefused = false;
    let rest = "";
    const read = (chunk: Buffer) => {
      const lines = (rest + chunk.toString("utf8")).split("\n");
      rest = lines.pop() ?? "";
      for (const raw of lines) {
        const line = hidden(raw, run).trimEnd();
        file.write(`${line}\n`);
        if (saysTheStateStoreRefused(line)) storeRefused = true;
        if (line.trim()) run.say?.(line.trim());
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", failed);
    child.on("close", (code) => {
      run.children.delete(child);
      file.end(`${hidden(rest, run)}\n`);
      done({ code: code ?? 1, storeRefused });
    });
  });
}

/** A line of the deploy's output with the text of each of its tokens replaced. */
const hidden = (line: string, run: Run) =>
  [run.token, run.clientToken].reduce<string>(
    (text, token) => (token ? text.replaceAll(token, "[token]") : text),
    line,
  );

/** The deploy. When the state store refused it (`saysTheStateStoreRefused`), it runs once more. */
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
/** A zone, and the stage of the mind whose boundary Worker its routes name, when one does. */
type Zone = z.infer<typeof ZoneRow> & {
  stageName?: string;
  /** Its routes or records could not be read, so nothing says what lives there. */
  unread?: boolean;
  /** What else uses the zone: a Worker's route, or a record that names a host or takes mail. */
  uses?: string[];
};
const DnsRecord = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string().nullish(),
});
// a route that turns Workers off has `script: null`
const Route = z.object({ id: z.string(), pattern: z.string(), script: z.string().nullish() });

/** WHAT A ZONE HOLDS THAT A MIND WOULD REPLACE: every DNS record (Cloudflare lists no NS or SOA of
 *  its own) and every Workers route. Undefined when Cloudflare did not answer with both. */
async function holdingsOf(cf: Cloudflare, zoneId: string) {
  const routes = resultOf(z.array(Route), await cf("GET", `/zones/${zoneId}/workers/routes`));
  const records: z.infer<typeof DnsRecord>[] = [];
  for (let page = 1; page <= 50; page++) {
    const listed = resultOf(
      z.array(DnsRecord),
      await cf("GET", `/zones/${zoneId}/dns_records?per_page=100&page=${page}`),
    );
    if (!listed) return undefined;
    records.push(...listed);
    if (listed.length < 100) break;
  }
  if (!routes) return undefined;
  return { routes, records };
}

/** Erases them, each by its id, and stops at the first that Cloudflare refuses: the deploy then
 *  does not start, and a second run erases what is left. */
async function eraseHoldings(cf: Cloudflare, zoneId: string) {
  const holdings = await holdingsOf(cf, zoneId);
  if (!holdings) throw new Error("Cloudflare did not answer with the zone's records and routes.");
  for (const route of holdings.routes) {
    const gone = await cf("DELETE", `/zones/${zoneId}/workers/routes/${route.id}`);
    if (gone.status >= 300)
      throw new Error(
        `Cloudflare did not delete the route ${route.pattern} (${gone.status}): ${gone.error}`,
      );
  }
  for (const record of holdings.records) {
    const gone = await cf("DELETE", `/zones/${zoneId}/dns_records/${record.id}`);
    if (gone.status >= 300)
      throw new Error(
        `Cloudflare did not delete the ${record.type} record ${record.name} (${gone.status}): ${gone.error}`,
      );
  }
  return { routes: holdings.routes.length, records: holdings.records.length };
}
const Offer = z.object({
  name: z.string(),
  registrable: z.boolean().optional(),
  pricing: z
    .object({ registration_cost: z.string().optional(), currency: z.string().optional() })
    .optional(),
});
type Offer = z.infer<typeof Offer>;

/** THE PERSON'S ACCOUNTS, AND WHICH OF THEM THIS ACCESS COVERS. A sign-in lists every account
 *  the person belongs to as a membership, also the ones they did not select on Cloudflare's
 *  page; a call to one of those answers 403. So each is asked for once: the account's own read
 *  answers 200 for a covered one and 403 for one that is not. Any other answer stops the run: it
 *  says nothing about the approval. An API token lists no membership, and `GET /accounts` then
 *  names exactly what it reaches. The first 50 accounts are read; `--account <id>` reaches one
 *  beyond them (`pickAccount`). */
async function accountsOf(cf: Cloudflare): Promise<{ all: Account[]; covered: Account[] }> {
  const memberships =
    resultOf(z.array(Membership), await cf("GET", "/memberships?per_page=50")) ?? [];
  const all = memberships.flatMap((membership) =>
    membership.account && (membership.status || "accepted") === "accepted"
      ? [membership.account]
      : [],
  );
  if (all.length === 0) {
    const reached = resultOf(z.array(Account), await cf("GET", "/accounts?per_page=50")) ?? [];
    return { all: reached, covered: reached };
  }
  const covered = await Promise.all(
    all.map(async (account) => {
      const read = await cf("GET", `/accounts/${account.id}`);
      if (read.status === 200) return [account];
      if (read.status === 403 || read.status === 404) return [];
      throw new Error(
        `Cloudflare did not say whether this access covers the account ${account.name} (${read.status}: ${read.error}). Run the command again.`,
      );
    }),
  );
  return { all, covered: covered.flat() };
}

/** The account's zones (its first 50, or the one named `domain`), each with its stack and with
 *  what else uses it. A MIND TAKES A WHOLE ZONE THAT NOTHING ELSE USES: its site, its mail and its
 *  sign-in are the zone's. So a route of another Worker, and a record that names a host or takes
 *  mail (A, AAAA, CNAME, MX), each make a zone one that the command deploys to only after the
 *  person agreed to erase what it holds. A stack's own records (AAAA 100::) and routes are not a
 *  use. */
async function zonesOf(cf: Cloudflare, account: string, domain?: string): Promise<Zone[]> {
  const which = domain ? `&name=${domain}` : "";
  const zones =
    resultOf(
      z.array(ZoneRow),
      await cf("GET", `/zones?account.id=${account}&per_page=50${which}`),
    ) ?? [];
  return Promise.all(
    zones.map(async ({ id, name, status }) => {
      const [routes, records] = await Promise.all([
        cf("GET", `/zones/${id}/workers/routes`).then((answer) => resultOf(z.array(Route), answer)),
        cf("GET", `/zones/${id}/dns_records?per_page=100`).then((answer) =>
          resultOf(z.array(DnsRecord), answer),
        ),
      ]);
      if (!routes || !records) return { id, name, status, unread: true };
      const stack = /^iterate-(.+)-boundary$/;
      const uses = [
        ...routes
          .filter((route) => !stack.test(route.script || ""))
          .map((route) => `the route ${route.pattern} of ${route.script || "no Worker"}`),
        ...records
          .filter((record) => ["A", "AAAA", "CNAME", "MX"].includes(record.type))
          .filter((record) => !(record.type === "AAAA" && record.content === "100::"))
          .map((record) => `the ${record.type} record ${record.name}`),
        // this list is the zone's first page: a zone that fills it is in use, whatever follows
        ...(records.length >= 100 ? ["100 or more DNS records"] : []),
      ];
      return {
        id,
        name,
        status,
        stageName: routes.map((route) => stack.exec(route.script || "")?.[1]).find(Boolean),
        uses,
      };
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

/** A domain and how the account gets it: `zone` when the account has it; else the command buys
 *  it (`offer`: Cloudflare's registrar sells it, and the person said yes to its price), or the
 *  person adds it on Cloudflare's own page (it is theirs at another registrar). */
type Pick = { domain: string; zone?: Zone; offer?: Offer };

/** The domain, and how the account gets it: a zone it has, one to buy, or one to add. With no
 *  `--domain`, the person picks from the account's zones and the free names of `candidatesOf`
 *  with their prices, and may type a domain, or a few words for more names: the question comes
 *  again until a domain is picked. `person` is the name the candidates are made from. */
async function pickDomain(
  cf: Cloudflare,
  account: string,
  input: DeployInput,
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
              .filter((zone) => !zone.unread)
              .map((zone) => ({
                value: zone.name,
                label: zone.name,
                hint: zone.stageName
                  ? "a mind is here already: deploy over it"
                  : zone.uses?.length
                    ? "in this account, in use: its records would be erased"
                    : "in this account, unused",
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
      if (!Hostname.safeParse(typed).success) {
        const more = await free(typed);
        if (more.length === 0) p.log.warn(`No name from "${typed}" is free at Cloudflare.`);
        // the new names first, then the ones from before
        offers = [...more, ...offers.filter((old) => more.every((now) => now.name !== old.name))];
        continue;
      }
      domain = typed;
    }
    if (!Hostname.safeParse(domain).success)
      throw new Error(`${JSON.stringify(domain)} is no domain.`);
    const zone =
      zones.find((candidate) => candidate.name === domain) ||
      (await zonesOf(cf, account, domain))[0];
    if (zone) return { domain, zone };
    const offer =
      offers.find((candidate) => candidate.name === domain) ||
      (await offersOf(cf, account, [domain])).find((candidate) => candidate.name === domain);
    if (offer?.registrable) {
      // THE YES TO SPEND MONEY, asked here, before anything changes. The purchase itself comes
      // after every other check, when the deploy needs the zone (`zoneOf`).
      const buy =
        input.buy ||
        (await ask<boolean>(`${domain} costs ${priceOf(offer)}; pass --buy to buy it`, () =>
          p.confirm({
            message: `Buy ${domain} at Cloudflare for ${priceOf(offer)}? Cloudflare charges the account's payment method, and a registration is not refunded.`,
          }),
        ));
      if (buy) return { domain, offer };
    } else {
      const theirs =
        input.yes ||
        (await ask<boolean>(
          `${domain} is not for sale at Cloudflare; pass --yes when it is yours at another registrar`,
          () =>
            p.confirm({
              message: `${domain} is not for sale at Cloudflare. Is it yours at another registrar? You then add it to this account and set its nameservers to Cloudflare's.`,
            }),
        ));
      if (theirs) return { domain };
    }
    // a no to a domain that a flag named has no other answer; a person picks again
    if (input.domain) throw new Error(`Run the command again with another domain than ${domain}.`);
  }
}

/** What Cloudflare says of one registration while it runs, and at its end. */
const Registration = z.object({
  state: z.string(),
  error: z.object({ message: z.string().optional() }).optional(),
  context: z.object({ action: z.unknown().optional() }).optional(),
});

/** BUYS THE DOMAIN at Cloudflare's registrar, for the price that the person said yes to
 *  (`pickDomain`). Cloudflare charges the account's default payment method and registers the
 *  domain to the account's default contact. Both are set on Cloudflare's own pages alone, and no
 *  call reads the contact. An account that has registered a domain has one, so a person whose
 *  account has none is sent to the page first. A purchase that Cloudflare refuses says why and
 *  opens the page where that is set. Cloudflare takes one registration for a domain, so a second
 *  try never buys twice. */
async function buyDomain(cf: Cloudflare, account: string, domain: string, offer: Offer) {
  const registrations = `/accounts/${account}/registrar/registrations`;
  const contactPage = `https://dash.cloudflare.com/${account}/domains/registrations`;
  const earlier = resultOf(z.array(z.unknown()), await cf("GET", `${registrations}?per_page=1`));
  if (earlier?.length === 0 && interactive()) {
    page(
      "Cloudflare has no contact details for this account yet, and a domain is registered to a person. Add yours and accept the registration agreement on this page.",
      contactPage,
    );
    const saved = await ask<boolean>("add your contact details on that page", () =>
      p.confirm({ message: "Are your contact details saved there?" }),
    );
    if (!saved)
      throw new Error(
        `Nothing was bought. Add your contact details at ${contactPage}, then run the command again.`,
      );
  }
  for (;;) {
    const buying = wait(`Buying ${domain} for ${priceOf(offer)}`);
    let answer = await cf("POST", registrations, { domain_name: domain });
    let registration = resultOf(Registration, answer);
    // Cloudflare answers 202 when the registry takes longer than its own wait: ask for five minutes
    for (
      let asked = 0;
      asked < 100 && ["pending", "in_progress", "blocked"].includes(registration?.state || "");
      asked++
    ) {
      await sleep(3000);
      answer = await cf("GET", `${registrations}/${domain}/registration-status`);
      registration = resultOf(Registration, answer) || registration;
    }
    // the registration itself is the proof, whatever the answers above said
    if (
      registration?.state === "succeeded" ||
      (await cf("GET", `${registrations}/${domain}`)).status === 200
    ) {
      buying.done(`Bought ${domain} for ${priceOf(offer)}.`);
      return;
    }
    // Cloudflare took the purchase and has not ended it: nothing here may call it failed, or
    // buy again. The wait for the domain in the account goes on.
    if (["pending", "in_progress", "blocked"].includes(registration?.state || "")) {
      buying.done(`Cloudflare took the purchase of ${domain} and still registers it.`);
      return;
    }
    const why =
      registration?.error?.message ||
      (registration?.context?.action
        ? `it needs an action of yours (${JSON.stringify(registration.context.action)})`
        : `${answer.status}: ${answer.error}`);
    buying.fail(`Cloudflare did not sell ${domain}: ${why}`);
    const fixPage = /payment|billing|card|quote/i.test(why)
      ? `https://dash.cloudflare.com/${account}/billing/payment-info`
      : contactPage;
    if (!interactive())
      throw new Error(
        `Cloudflare did not sell ${domain}: ${why}. Nothing was bought. A payment method is set at https://dash.cloudflare.com/${account}/billing/payment-info, and the registrant's contact and the registration agreement at ${contactPage}. Then run the command again.`,
      );
    page(
      "Set what Cloudflare asks for on this page: a payment method, your contact details, or the registration agreement.",
      fixPage,
    );
    const again = await ask<boolean>("run the command again", () =>
      p.confirm({ message: `Try to buy ${domain} again?` }),
    );
    if (!again) throw new Error("Nothing was bought. Run the command again with another domain.");
  }
}

/** The zone of the picked domain, active. When the account does not have it yet, the command buys
 *  it, or the person adds it on Cloudflare's own page (the command holds no right to add a zone),
 *  and this waits for it. A domain bought at Cloudflare becomes a zone of the account by
 *  itself. */
async function zoneOf(cf: Cloudflare, account: string, pick: Pick): Promise<Zone> {
  const { domain } = pick;
  const found = async (): Promise<Zone | undefined> =>
    resultOf(z.array(ZoneRow), await cf("GET", `/zones?name=${domain}&account.id=${account}`))?.[0];
  let zone = pick.zone ?? (await found());
  if (!zone) {
    if (pick.offer) await buyDomain(cf, account, domain, pick.offer);
    else
      page(
        `Add ${domain} to this account on Cloudflare's page, then set its nameservers at your registrar to the two that Cloudflare shows.`,
        `https://dash.cloudflare.com/${account}/add-site`,
      );
    // a purchase takes minutes; nameservers at another registrar can take a day
    zone = await until(`Waiting for ${domain} in the account`, found, pick.offer ? 60 : 24 * 60);
  }
  if (zone.status === "active") return zone;
  const { id } = zone;
  return until(
    `Waiting for Cloudflare to activate ${domain}`,
    async () => {
      const now = resultOf(ZoneRow, await cf("GET", `/zones/${id}`));
      if (now?.status === "active") return now;
      return undefined;
    },
    pick.offer ? 30 : 24 * 60,
  );
}

/** The account, by flag or by question. A new one is named after the owner's mailbox, which
 *  `owner` answers. `covered` says whether this access reaches the account: a sign-in's approval
 *  does not cover an account that was just made, or one of the person's that they did not select
 *  on Cloudflare's page, and each needs one more approval. */
async function pickAccount(
  cf: Cloudflare,
  input: DeployInput,
  owner: () => Promise<string>,
): Promise<{ account: Account; covered: boolean }> {
  const NEW = "\0new";
  const { all, covered } = await accountsOf(cf);
  let chosen = input.newAccount ? NEW : input.account;
  if (!chosen && covered.length === 0)
    throw new Error("This access to Cloudflare covers no account.");
  chosen ||= await ask<string>("pass --account <id or name>, or --new-account", () =>
    p.select({
      message: "Which Cloudflare account does the mind live in?",
      options: [
        ...covered.map((account) => ({
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
  const isCovered = (account: Account) => covered.some((candidate) => candidate.id === account.id);
  if (chosen !== NEW) {
    const account = all.find((candidate) => candidate.id === chosen || candidate.name === chosen);
    if (account) return { account, covered: isCovered(account) };
    // an account beyond the first 50 is not in the list: its id still names it
    const byId = /^[0-9a-f]{32}$/.test(chosen)
      ? resultOf(Account, await cf("GET", `/accounts/${chosen}`))
      : undefined;
    if (byId) return { account: byId, covered: true };
    throw new Error(
      `You have no Cloudflare account ${JSON.stringify(chosen)}. This access covers: ${covered.map((a) => `${a.name} (${a.id})`).join(", ") || "none"}.`,
    );
  }
  // an earlier run made it: a second run makes no second account
  const fresh = `iterate-${(await owner()).split("@")[0]!.replace(/[^a-z0-9]+/g, "-")}`;
  const before = all.find((candidate) => candidate.name === fresh);
  if (before) return { account: before, covered: isCovered(before) };
  const made = await cf("POST", "/accounts", { name: fresh, standalone: true });
  const account = resultOf(Account, made);
  if (!account)
    throw new Error(
      `Cloudflare made no new account (${made.status}): ${made.error}. Its rules: the login is at least seven days old, it is Super Administrator of an account, and it has fewer than five extra accounts. Run again with an account you have.`,
    );
  p.log.success(`Made the Cloudflare account ${fresh}.`);
  // a sign-in's approval names the accounts it covers, so not this one; a token for all of the
  // person's accounts reaches it at once
  return { account, covered: (await cf("GET", `/accounts/${account.id}`)).status === 200 };
}

/** THE MIND THAT IS DEPLOYED AS THE STAGE `stageName` OF THE ACCOUNT, with its own config, or
 *  undefined when the account has no such mind. The config is read from the boundary Worker's
 *  settings (`mindConfigIn`): a mind's account holds what the mind is, so no file of an earlier
 *  deploy is needed. `iterate recover` finds a mind the same way. */
export async function deployedMind(cf: Cloudflare, account: string, stageName: string) {
  const boundary = `iterate-${stageName}-boundary`;
  const settings = await cf("GET", `/accounts/${account}/workers/scripts/${boundary}/settings`);
  if (settings.status === 404) return undefined;
  // A boundary Worker with no variable `ITERATE` is one of iterate's earlier stack, which kept a
  // mind's config elsewhere: this command neither deploys over it nor erases its domain.
  if (
    settings.status === 200 &&
    !WorkerSettings.safeParse(settings.result).data?.bindings.some(
      (binding) => binding.name === "ITERATE",
    )
  )
    throw new Error(
      `The mind whose boundary Worker is ${boundary} runs iterate's earlier stack, and this command works on a mind of the new stack alone. It does not move a mind from the earlier stack yet: iterate moves it. Nothing was changed.`,
    );
  const config = mindConfigIn(settings.result);
  if (!config)
    throw new Error(
      `Cloudflare did not answer with the config of the mind whose boundary Worker is ${boundary} (${settings.status}: ${settings.error || "settings with no variable ITERATE"}). Nothing was changed.`,
    );
  return { ...config, stageName };
}

/** THE STACK'S OTHER WORKERS, by which a state store with no mind is told apart: the script makes
 *  the state store first, and a destroy erases every other Worker and leaves the store
 *  (core/alchemy/README.md, "What a destroy leaves"). The boundary is read before (`deployedMind`). */
const otherWorkersOf = (stageName: string) =>
  ["telemetry", "auth", "secrets", "mind"].map((part) => `iterate-${stageName}-${part}`);

/** AN EARLIER DEPLOY OF THE STAGE `stageName`, for an account where `deployedMind` found no mind:
 *
 *  - no state store of the stage (`iterate-<stage>-state`): undefined, a new mind;
 *  - the store, and this computer holds the config of that stage, account and domain, with a mind
 *    id, which this command wrote to `configFile` before it deployed: `mind`, which the run goes
 *    on with. That is a deploy that stopped before its end, or a mind destroyed and deployed again
 *    from here; either way that config is the mind's, and its id is kept;
 *  - the store and no such config, with nothing else of the stage (the zone is not in use, and the
 *    account holds none of the stack's other Workers): what a destroy leaves, `leftover`, a new mind
 *    with a new identity, since nothing of the old mind is left;
 *  - the store, no config, and more of the stage: a deploy that stopped, begun on another computer.
 *    It stops with nothing changed, whatever the flags: a second identity for the same mind is a
 *    fault, and the zone's records may be that deploy's own. */
export async function earlierDeployOf(
  cf: Cloudflare,
  account: string,
  stageName: string,
  zone: { domain: string; uses: string[] },
  configFile: string,
) {
  const { domain } = zone;
  const store = `iterate-${stageName}-state`;
  const workers = [store, ...otherWorkersOf(stageName)];
  const answers = await Promise.all(
    workers.map((name) => cf("GET", `/accounts/${account}/workers/scripts/${name}/settings`)),
  );
  const unread = answers.findIndex((answer) => answer.status !== 200 && answer.status !== 404);
  if (unread >= 0)
    throw new Error(
      `Cloudflare did not answer whether the account holds the Worker ${workers[unread]} (${answers[unread]!.status}: ${answers[unread]!.error}). Nothing was changed. Run the command again.`,
    );
  if (answers[0]!.status === 404) return undefined;
  const deployConfig = parsed(
    KeptDeployConfig,
    existsSync(configFile) ? readFileSync(configFile, "utf8") : "",
  );
  // the script's input holds the mind's own config, with its zones under `cloudflare`
  const config =
    deployConfig &&
    DeployedConfig.safeParse({ ...deployConfig, zones: deployConfig.cloudflare.zones }).data;
  if (
    config?.mindId &&
    config.zones.includes(domain) &&
    deployConfig?.cloudflare.accountId === account &&
    deployConfig.alchemy.stageName === stageName
  )
    return { mind: { ...config, stageName, deployConfig } };
  const more = [
    ...workers.slice(1).filter((_, index) => answers[index + 1]!.status === 200),
    ...zone.uses,
  ];
  if (more.length === 0) return { leftover: store };
  throw new Error(
    [
      `The account holds the state store of a mind's stack at ${domain}, the Worker ${store}, and more of that stack (${more.slice(0, 5).join(", ")}${more.length > 5 ? ", and more" : ""}), and no mind answers there yet: a deploy of it stopped before its end. The config that the deploy began with, with the mind's id, is on the computer that began it (${configFile.replace(homedir(), "~")}), and this computer has none for this account. Nothing was changed. Two ways on:`,
      "- Run the command on the computer that began the deploy: it goes on with it.",
      `- Or erase the half-made stack: \`pnpm run destroy --stage ${stageName} --yes\` in core/alchemy with a config of that stage and account (iterate deploy's README, "Erase a mind"). The command then deploys a new mind there. --erase-records erases no record of a half-made stack.`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------------------------
// The mind's first steps.

/** What the command needs of the rest of the CLI once the mind answers: cli.ts gives both. */
export type MindSteps = {
  /** `iterate login` by the browser, then a connection to the mind at `address`, taken as it is.
   *  `openBrowser` gets the authorization page in place of the CLI's own opener. */
  signIn: (address: string, openBrowser: (url: URL) => void) => Promise<MindConnection>;
  /** `iterate chatgpt connect` on that connection. */
  connectChatgpt: (connection: MindConnection, print: (line: string) => void) => Promise<unknown>;
};

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
 *  is named after the mind's control-plane hostname (`mindMcpNameOf`), so two minds sit side by
 *  side. */
export function mcpInstalls(controlPlaneHostname: string) {
  const name = mindMcpNameOf(controlPlaneHostname);
  const url = mindMcpUrlOf(controlPlaneHostname);
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

/** THE FIRST SIGN-IN, which is the owner's first passkey too. The command starts the CLI's own
 *  sign-in (`iterate login`) and opens its authorization page. The mind has no session for this
 *  browser, so it shows its sign-in page, and from there the owner goes the one way that a new
 *  mind has: Cloudflare Access proves the address (core/auth-worker access-sign-in.ts), the mind
 *  asks for a first passkey (enrolment.ts), and then goes on to the authorization that the page
 *  began with, which signs this terminal in. Each of those pages hands the next the address to go
 *  on to, as `next`. In the device flow the page that it began with is the mind's device page,
 *  which shows the terminal's code and takes a press of the new passkey, and then the same
 *  consent page as in the browser flow. */
async function firstSignIn(controlPlaneHostname: string, owners: string[], steps: MindSteps) {
  p.log.message(firstSignInWords(signInFlow(), owners).join("\n"));
  const connection = await steps.signIn(controlPlaneHostname, (authorize) =>
    page("Sign in to your mind:", authorize.href),
  );
  p.log.success(`This terminal is signed in to ${controlPlaneHostname}.`);
  return connection;
}

/** WHAT THE PERSON WILL MEET AT THE FIRST SIGN-IN, said before its page: the same pages in both
 *  flows, and in the device flow one more, which shows the code that the terminal shows. */
export const firstSignInWords = (flow: LoginFlow, owners: string[]) => [
  flow === "device"
    ? "Open the page below in your browser, on any computer. It is your mind's sign-in page."
    : "Your mind's sign-in page opens now.",
  `Your browser asks for a passkey there: you have none yet, so close that, and choose "prove your email address with Cloudflare".`,
  `Cloudflare mails a code to ${owners.join(" or ")}. Enter it and add your passkey.`,
  flow === "device"
    ? "Then a page shows the same code as this terminal and asks to sign this device in: continue with your new passkey, and allow it on the page after."
    : "The same page then signs this terminal in.",
];

/** THE CHATGPT PLAN AS A WAY TO PAY, by where the person's browser is. OpenAI's sign-in ends at
 *  `http://127.0.0.1:1455` on the computer that the BROWSER runs on (./chatgpt.ts), where this
 *  process must listen. With the browser elsewhere it cannot: the option says so, and `runThere`
 *  is what the person runs on that computer, which signs it in to the mind first. */
export const chatgptPlanWay = (flow: LoginFlow, address: string) =>
  flow === "device"
    ? {
        hint: "connected from the computer with your browser",
        runThere: [
          "OpenAI's sign-in comes back to the computer that your browser is on, so it cannot start from this terminal.",
          "On the computer with your browser, run this. It signs that computer in to your mind with your passkey, then opens OpenAI's page:",
          `  npx iterate@latest chatgpt connect ${mindAddressAsTyped(address)}`,
        ].join("\n"),
      }
    : { hint: "recommended", runThere: undefined };

/** A way to pay for the model (a ChatGPT plan, an OpenAI API key, or none), and then the
 *  onboarding agent's answer. With no answer the question comes again, until the agent answers
 *  or the person chooses none. */
async function aModelThatAnswers(connection: MindConnection, steps: MindSteps) {
  const { itx } = connection;
  const chatgpt = chatgptPlanWay(signInFlow(), connection.address);
  for (;;) {
    const way = await ask<string>("", () =>
      p.select({
        message: "What pays for your mind's model?",
        options: [
          { value: "chatgpt", label: "A ChatGPT Plus or Pro plan", hint: chatgpt.hint },
          { value: "openai", label: "An OpenAI API key" },
          { value: "none", label: "Nothing now", hint: "it has a model already, or later" },
        ],
      }),
    );
    if (way === "chatgpt" && chatgpt.runThere) {
      p.log.step(chatgpt.runThere);
      // the check below says whether a model answers, whatever the person says here
      await ask<boolean>("", () => p.confirm({ message: "Is the plan connected?" }));
    } else if (way === "chatgpt")
      await steps.connectChatgpt(connection, (line) => p.log.message(line));
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
    if (silence) asking.fail(`Your onboarding agent gave no answer: ${silence}`);
    else asking.done("Your onboarding agent answers.");
    if (!silence || way === "none") return;
  }
}

/** The offer to add the mind's MCP server to the coding agents installed on this computer. */
async function mcpServerInCodingAgents(connection: MindConnection) {
  const installs = mcpInstalls(connection.address).filter(
    (install) => spawnSync(install.command, ["--version"], { stdio: "ignore" }).status === 0,
  );
  if (installs.length === 0) {
    p.log.info(`Your mind's MCP server, for a coding agent: ${mindMcpUrlOf(connection.address)}`);
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
  // an agent's own sign-in to the server comes back to the computer that the agent runs on
  if (signInFlow() === "device")
    p.log.info(
      `These coding agents are on this computer. For the ones on the computer with your browser, run there:\n${mcpInstalls(
        connection.address,
      )
        .map((install) => `  ${[install.command, ...install.args].join(" ")}`)
        .join("\n")}`,
    );
}

/** THE LINE THAT NAMES THE MIND'S IDENTITY KEY, for a first deploy, or undefined. It is printed
 *  only when the key file is on this computer, and only when this run gave the mind its id, or
 *  the mind took a record now, or its log had no record before: so a first deploy whose
 *  summary was lost prints it at the next run. */
export function identityKeyLineOf(
  keyFile: string,
  run: { gaveTheId: boolean; posted?: { taken: number; emptyBefore: boolean } },
) {
  if (!existsSync(keyFile)) return undefined;
  if (!run.gaveTheId && !run.posted?.taken && !run.posted?.emptyBefore) return undefined;
  return `Its identity key: ${keyFile.replace(homedir(), "~")}  (keep a copy: it proves that the mind is yours)`;
}

/** THE IDENTITY OF A MIND THAT HAS NONE (./identity.ts): the one that an earlier run on this
 *  computer made for this control-plane hostname, when a first deploy stopped half way, so that
 *  the mind goes on with that id; else, and always where a destroy left the old mind's store
 *  alone (`fresh`), a new one. Its key is on this computer when this answers. */
async function identityOfNewMind(controlPlaneHostname: string, fresh: boolean) {
  const earlier = fresh ? undefined : await identityMadeFor(controlPlaneHostname, IDENTITIES);
  if (!earlier) return (await newIdentity([controlPlaneHostname], IDENTITIES)).mindId;
  p.log.info(
    `Using the identity made on ${earlier.madeAt.toISOString().slice(0, 16).replace("T", " ")} UTC for ${controlPlaneHostname}.`,
  );
  return earlier.mindId;
}

/** THE MIND'S IDENTITY IS PUBLISHED, when this computer holds its records (./identity.ts): a new
 *  mind's genesis, or what an earlier run did not post, and at every deploy the last record
 *  again, which makes the stack deliver what it still owes the mind's own log. With no records
 *  here it asks nothing and says nothing: another computer has the mind's key. Nothing else
 *  waits for the identity, so a post that fails is a line with the command that posts again,
 *  never a failed deploy. Answers what the post did, or undefined. */
async function identityPublished(mind: { mindId: string; controlPlaneHostname: string }) {
  try {
    const done = await postIdentity(mind, {
      dir: IDENTITIES,
      fetcher: (request) => fetch(request),
      pause: (ms) => sleep(ms),
      say: (line) => p.log.step(line),
    });
    if (done?.taken)
      p.log.success(
        done.published === done.here
          ? "The mind took its identity record and publishes it."
          : "The mind took its identity record. Its published log does not show it yet.",
      );
    return done;
  } catch (error) {
    p.log.warn(
      `The mind's identity is not published: ${error instanceof Error ? error.message : String(error)}. Nothing else waits for it. To post it again: npx iterate@latest identity post ${mindAddressAsTyped(mind.controlPlaneHostname)}`,
    );
    return undefined;
  }
}

/** THE MIND'S FIRST STEPS AFTER THE FIRST SIGN-IN, for a person at the terminal, in this order.
 *  Each is a function of the signed-in connection: one more step is one more entry. */
const firstSteps: ((connection: MindConnection, steps: MindSteps) => Promise<void>)[] = [
  aModelThatAnswers,
  mcpServerInCodingAgents,
];

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
    // the source comes while the person signs in and chooses
    const sourceBegan = Date.now();
    const source = sourceOf(input);
    source.catch(() => {});
    const signIn = (fresh = false) =>
      cloudflareAccess(
        DEPLOY_SCOPES,
        ({ url, code, minutes }) => {
          page(
            `Sign in at Cloudflare and approve the access. Tick "Account API Token Provisioning" on its page, which Cloudflare leaves unticked: the deploy makes two API tokens with which the mind reads its own logs, and they read nothing else and deploy nothing. Check that the page shows the code ${code}. Select the account for the mind. The code works for ${minutes} minutes.`,
            url.href,
          );
        },
        fresh,
      );
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

    // A SIGN-IN THAT LACKS A SCOPE CANNOT DEPLOY, and the command knows it from what the sign-in
    // granted, before it changes anything. The other way is an API token that the person makes
    // on Cloudflare's own page and pastes here: the deploy alone runs with it, and it is never
    // shown and never written to a file. The command's own steps keep the sign-in.
    let pasted: string | undefined;
    if (access.lacks.length > 0) {
      const why = `The sign-in at Cloudflare did not grant ${access.lacks.join(", ")}${access.lacks.includes(MAKES_API_TOKENS) ? ` ("Account API Token Provisioning" was not ticked)` : ""}, and a deploy needs it.`;
      const tokenPage = apiTokenPage().href;
      if (!interactive()) {
        await endAccess(access);
        throw new Error(
          `${why} Nothing was changed. Run the command again and tick it. Or make an API token of the account with the deploy's permissions at ${tokenPage} and run the command with it as CLOUDFLARE_API_TOKEN.`,
        );
      }
      p.log.warn(why);
      page(
        "The other way: make an API token yourself on this page of Cloudflare's, which has the deploy's permissions filled in. Choose the mind's account and press Create. If the page says that it does not know a permission, stop and run the command again with the box ticked.",
        tokenPage,
      );
      pasted = (
        await ask<string>("", () =>
          p.password({
            message: "Paste the API token here (it is not shown), or press Enter to stop",
          }),
        )
      )?.trim();
      if (!pasted) {
        await endAccess(access);
        throw new Error(
          'Nothing was changed. Run the command again and tick "Account API Token Provisioning".',
        );
      }
    }

    const user = await cf("GET", "/user");
    const said = resultOf(
      z.object({
        email: z.string(),
        first_name: z.string().nullish(),
        last_name: z.string().nullish(),
      }),
      user,
    );
    const login = said?.email.toLowerCase();
    // an account's own API token reads no user: the owner then comes by the flag
    if (user.status !== 200 && access.from === "sign-in") {
      await endAccess(access);
      throw new Error(
        `Cloudflare refused the kept access (${user.status}). Run the command again to sign in.`,
      );
    }
    p.log.info(`Signed in to Cloudflare${login ? ` as ${login}` : ""}.`);
    // THE OWNER OF A NEW MIND: `--owner`, else the Cloudflare login, else a question. Asked for
    // only where it is needed: a mind that is there already has its owners.
    let asked: string | undefined;
    const newOwner = async () =>
      input.owner?.toLowerCase() ||
      login ||
      (asked ||= (
        await ask<string>("pass --owner <email>", () =>
          p.text({
            message: "The owner's email address",
            validate: (value) =>
              /^\S+@\S+\.\S+$/.test(value || "") ? undefined : "An email address",
          }),
        )
      ).toLowerCase());

    const { account, covered } = await pickAccount(cf, input, newOwner);
    // An approval covers the accounts that the person selected on Cloudflare's page: a new
    // account, or one they did not select, takes one more approval.
    if (!covered) {
      if (access.from !== "sign-in")
        throw new Error(
          `The token in CLOUDFLARE_API_TOKEN does not reach the account ${account.name} (${account.id}).`,
        );
      await endAccess(access);
      p.log.info(
        `Cloudflare asks once more, for the account ${account.name}: select it on its page.`,
      );
      access = await signIn(true);
      if ((await cf("GET", `/accounts/${account.id}`)).status !== 200)
        throw new Error(
          `The approval does not cover the account ${account.name}. Run the command again and select it on Cloudflare's page.`,
        );
    }
    // a token of the account answers its own check; one of the person's answers the person's
    if (
      pasted &&
      (await cloudflare(pasted)("GET", `/accounts/${account.id}/tokens/verify`)).status !== 200 &&
      (await cloudflare(pasted)("GET", "/user/tokens/verify")).status !== 200
    )
      throw new Error(
        `Cloudflare does not know the pasted text as an API token of the account ${account.name}. Nothing was changed. Run the command again.`,
      );
    const on = async (path: string) =>
      (await cf("GET", `/accounts/${account.id}${path}`)).status === 200;
    const paidPath = "/containers/applications";
    const r2Path = "/r2/buckets?per_page=1";
    const zeroTrustPath = `/accounts/${account.id}/access/organizations`;
    const [paid, r2, zones, subdomain, zeroTrustRead] = await Promise.all([
      on(paidPath),
      on(r2Path),
      zonesOf(cf, account.id),
      cf("GET", `/accounts/${account.id}/workers/subdomain`),
      cf("GET", zeroTrustPath),
    ]);
    let zeroTrust = zeroTrustStep(account.id, zeroTrustRead, false);
    if (zeroTrust.next === "stop") throw new Error(zeroTrust.words);
    p.log.info(
      `Account ${account.name}: Workers Paid ${paid ? "on" : "off"}, R2 ${r2 ? "on" : "off"}, ${zones.length} domain${zones.length === 1 ? "" : "s"}.`,
    );

    // the names offered come from the person's name at Cloudflare, else from the owner's address
    const person = input.domain
      ? ""
      : [said?.first_name, said?.last_name].filter(Boolean).join(" ") ||
        (await newOwner())
          .split("@")[0]!
          .split("+")[0]!
          .replace(/[^a-z0-9]+/g, " ");
    const pick = await pickDomain(cf, account.id, input, zones, person);
    const { domain } = pick;
    if (pick.zone?.unread)
      throw new Error(
        `Cloudflare did not answer with the Workers routes and DNS records of ${domain}, so nothing says what lives there already. Nothing was changed. Run the command again.`,
      );
    // A MIND THAT IS THERE ALREADY: the zone's routes name its boundary Worker, and that Worker's
    // settings hold the mind's own config. The command deploys over it with what the mind has,
    // but for what a flag names.
    const stageName = pick.zone?.stageName || stageNameOf(domain);
    const work = join(CACHE, "deploys", stageName);
    const configFile = join(work, "config.json");
    const deployed = await deployedMind(cf, account.id, stageName);
    if (deployed && !deployed.zones.includes(domain))
      throw new Error(
        `The account has a mind at ${deployed.controlPlaneHostname} whose stack is named ${stageName}, the name that a mind at ${domain} gets, and ${domain} is none of its domains (${deployed.zones.join(", ")}). Choose another domain.`,
      );
    if (deployed && !deployed.deployConfig)
      throw new Error(
        `The mind at ${deployed.controlPlaneHostname} was deployed before its stack kept the deploy's whole config, so a deploy from here could drop what no Worker holds, such as its sandboxes' image. Nothing was changed. Deploy it once with its own config by core/alchemy's script (core/alchemy/README.md), then run the command again.`,
      );
    // AN EARLIER DEPLOY (`earlierDeployOf`): one whose config is here goes on with that config, its
    // mind's id among it, but for what a flag names; a destroy's leftover store is a new mind
    const earlier = deployed
      ? undefined
      : await earlierDeployOf(
          cf,
          account.id,
          stageName,
          { domain, uses: pick.zone?.uses || [] },
          configFile,
        );
    const unfinished = earlier?.mind;
    const mind = deployed || unfinished;
    const config = deployConfigOf({
      accountId: account.id,
      domain,
      owner: mind ? input.owner : await newOwner(),
      controlPlaneHostname: input.controlPlaneHostname,
      deployed: mind,
    });
    const { controlPlaneHostname } = config;
    // a mind with no id gets one, which this run makes or checks: asked before anything changes
    if (!config.mindId) await mlDsaRequired();
    if (deployed) {
      p.log.info(
        [
          `A mind is at ${domain} already. Its own config, from Cloudflare:`,
          `  control plane   ${deployed.controlPlaneHostname}`,
          `  owners          ${deployed.ownerEmails.join(", ")}`,
          `  domains         ${deployed.zones.join(", ")}`,
          `  the mind runs   ${deployed.topology === "full-cloudflare" ? "in Cloudflare" : "elsewhere, and connects in"}`,
        ].join("\n"),
      );
      const changes = [
        ...(controlPlaneHostname === deployed.controlPlaneHostname
          ? []
          : [`its control plane at ${controlPlaneHostname}`]),
        ...(config.ownerEmails.join() === deployed.ownerEmails.join()
          ? []
          : [`${config.ownerEmails.join(", ")} as its only owner`]),
      ];
      const how =
        changes.length > 0 ? `with ${changes.join(" and ")}` : "with the same owners and hostname";
      if (
        !input.yes &&
        !(await ask<boolean>(`a mind is at ${domain} already; pass --yes to deploy over it`, () =>
          p.confirm({ message: `Deploy over it, ${how}?` }),
        ))
      )
        throw new Error("Nothing was changed.");
      p.log.info(`Deploying over it, ${how}.`);
    } else if (unfinished)
      p.log.info(
        `This computer holds the config of an earlier deploy of this mind (${configFile.replace(homedir(), "~")}), and the account holds its stack's state store: going on with that config. Its owners: ${config.ownerEmails.join(", ")}; its control plane: ${controlPlaneHostname}.`,
      );
    else if (earlier?.leftover)
      p.log.info(
        `The account holds ${earlier.leftover}, the state store that a destroy of a mind at ${domain} leaves, and nothing else of that mind: deploying a new mind there, with a new identity. Its owner is ${config.ownerEmails.join(", ")}.`,
      );
    else p.log.info(`The mind's owner is ${config.ownerEmails.join(", ")}.`);
    // A ZONE IN USE: the person says yes to losing everything on it before anything changes. The
    // erase itself is the last thing before the deploy (below). Asked here for a zone that the
    // account has, and after the wait for a zone that arrives during the run: Cloudflare copies
    // the records it finds when a domain is added.
    // The domain of a mind, or of an earlier deploy whose config is here, is never erased.
    const holdingsToErase = async (uses: string[], zoneId: string) => {
      if (mind || uses.length === 0) return undefined;
      const holdings = await holdingsOf(cf, zoneId);
      if (!holdings)
        throw new Error(
          `Cloudflare did not answer with the records of ${domain}. Nothing was changed. Run the command again.`,
        );
      const what = `${holdings.records.length} DNS record${holdings.records.length === 1 ? "" : "s"} and ${holdings.routes.length} Workers route${holdings.routes.length === 1 ? "" : "s"}`;
      const some = `${uses.slice(0, 5).join(", ")}${uses.length > 5 ? ", and more" : ""}`;
      const erase =
        input.eraseRecords ||
        (await ask<boolean>(
          `${domain} is in use (${some}); pass --erase-records to erase its ${what}`,
          () =>
            p.confirm({
              message: `${domain} is in use: ${some}. A mind takes the whole domain. I will erase all ${what} there: its site and its mail stop working. Go on?`,
              initialValue: false,
            }),
        ));
      if (!erase)
        throw new Error("Nothing was changed. Run the command again with another domain.");
      return holdings;
    };
    let holdings = pick.zone
      ? await holdingsToErase(pick.zone.uses || [], pick.zone.id)
      : undefined;

    // the account's workers.dev name: a new account has none, and a Worker needs one
    if (!resultOf(z.object({ subdomain: z.string().min(1) }), subdomain)) {
      let refusal = "";
      for (const candidate of [
        `iterate-${stageName}`,
        `iterate-${stageName}-${Math.random().toString(36).slice(2, 6)}`,
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
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const log = join(work, "deploy.log");
    writeFileSync(log, "");
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
    // ZERO TRUST (`zeroTrustStep`): set up by the command where Cloudflare allows it, else a gate
    if (zeroTrust.next === "make") {
      const made = await cf("POST", zeroTrustPath, {});
      const after = await cf("GET", zeroTrustPath);
      const set = zeroTrustStep(account.id, after, true).next === "go";
      zeroTrust = zeroTrustStep(account.id, set ? after : made, true);
      if (set)
        p.log.success(
          "Zero Trust is set up in the account, with a team name that Cloudflare chose.",
        );
    }
    if (zeroTrust.next === "stop") throw new Error(zeroTrust.words);
    if (zeroTrust.next === "gate") {
      if (!interactive())
        throw new Error(
          `${zeroTrust.words}\n${zeroTrust.page}\nThen run the command again. Nothing is deployed.`,
        );
      page(zeroTrust.words, zeroTrust.page);
      await until(
        "Waiting for Zero Trust",
        async () => zeroTrustStep(account.id, await cf("GET", zeroTrustPath), true).next === "go",
      );
    }
    const zone = await zoneOf(cf, account.id, pick);
    p.log.success(`${zone.name} is active in the account.`);
    if (!pick.zone) {
      const [arrived] = await zonesOf(cf, account.id, domain);
      if (!arrived || arrived.unread)
        throw new Error(
          `Cloudflare did not answer with the Workers routes and DNS records of ${domain}, so nothing says what lives there. Nothing was changed. Run the command again.`,
        );
      // a route of a mind's boundary came with the domain: the run's checks of a mind come first
      if (arrived.stageName)
        throw new Error(
          `${domain} came with the route of a mind's boundary Worker, iterate-${arrived.stageName}-boundary. Nothing was changed. Run the command again.`,
        );
      holdings = await holdingsToErase(arrived.uses || [], zone.id);
    }

    // THE STACK'S OWN OAUTH CLIENT AT CLOUDFLARE (`oauthClientStep`): one API token with "OAuth
    // Client Write", which the deploy's credential lacks, for the client alone. It is never shown
    // and never written to a file; the deploy's log has "[token]" for its text.
    const secretsSettings = `/accounts/${account.id}/workers/scripts/iterate-${stageName}-secrets/settings`;
    const givenClientToken = process.env[OAUTH_CLIENT_TOKEN]?.trim();
    const clientStep = oauthClientStep({
      hasClient: stackHasOAuthClient((await cf("GET", secretsSettings)).result),
      credentialMay:
        (
          await cloudflare(pasted || access.token)(
            "GET",
            `/accounts/${account.id}/oauth_clients?per_page=1`,
          )
        ).status === 200,
      given: Boolean(givenClientToken),
      person: input.setup !== false && interactive(),
      account,
      domain,
    });
    let clientToken: string | undefined;
    if (clientStep.next === "given") {
      if (!givenClientToken || !(await oauthClientTokenWorks(givenClientToken, account.id)))
        throw new Error(
          `The token in ${OAUTH_CLIENT_TOKEN} is no API token of the account ${account.name} that may make OAuth clients ("OAuth Client Write"). Nothing was changed.`,
        );
      clientToken = givenClientToken;
    }
    if (clientStep.next === "ask") {
      page(clientStep.words, clientStep.page);
      for (;;) {
        const typed = (
          await ask<string>("", () =>
            p.password({
              message:
                "Paste the API token here (it is not shown), or press Enter to deploy without the client",
            }),
          )
        )?.trim();
        if (!typed) break;
        if (await oauthClientTokenWorks(typed, account.id)) {
          clientToken = typed;
          break;
        }
        p.log.warn(
          `Cloudflare does not know that text as an API token of the account ${account.name} with "OAuth Client Write". Paste the token again, or press Enter to deploy without the client.`,
        );
      }
    }
    // the deploy goes on without the client: said before it, so that a run that stops later said it
    if (clientStep.next === "later" || (clientStep.next === "ask" && !clientToken))
      p.log.warn(oauthClientLaterWords(domain));

    // A NEW MIND'S IDENTITY (./identity.ts), made after the person's last answer: its key and
    // its signed genesis are on this computer before the script gets the id. A mind that has an
    // id keeps it, and this run signs nothing. That holds for an id that is no genesis's hash
    // too: such a mind accepts no identity record, and the command does not mend it.
    const mindId =
      config.mindId || (await identityOfNewMind(controlPlaneHostname, Boolean(earlier?.leftover)));
    writeFileSync(configFile, `${JSON.stringify({ ...config, mindId }, null, 2)}\n`);
    access = await renewed();
    if (holdings) {
      const erased = await eraseHoldings(cf, zone.id);
      p.log.success(
        `Erased ${erased.records} DNS records and ${erased.routes} Workers routes of ${domain}.`,
      );
    }
    const deployBegan = Date.now();
    const deploying = wait(`Deploying the mind at ${controlPlaneHostname}`);
    const code = await deployStack({
      source: ready,
      stageName,
      config: configFile,
      token: pasted || access.token,
      clientToken,
      log,
      children,
      say: deploying.say,
      adopt: Boolean(earlier),
    });
    if (code !== 0) {
      deploying.fail(`The deploy failed (exit ${code}).`);
      console.log(readFileSync(log, "utf8").trimEnd().split("\n").slice(-40).join("\n"));
      throw new Error(
        `The deploy failed (exit ${code}). Its whole log: ${log}. A deploy keeps what it made: run the command again on this computer, and it goes on with this deploy's config.`,
      );
    }
    deploying.done(`Deployed (${seconds(deployBegan)}).`);

    // A NEW ROUTE REACHES CLOUDFLARE'S EDGE WITHIN A MINUTE OR TWO, and until then some answers
    // are 522, 500 or 404. So the mind answers when both of its addresses did, five times in a
    // row: the sign-in page, and the apex of its first zone, where the mind's own code answers
    // (that request is also the one at which a new mind is born).
    const answersBegan = Date.now();
    let good = 0;
    await until(
      `Waiting for ${controlPlaneHostname} to answer steadily`,
      async () => {
        const before = good;
        good = 0;
        const [signInPage, apex] = await Promise.all(
          [`https://${controlPlaneHostname}/sign-in`, `https://${config.cloudflare.zones[0]}/`].map(
            (address) =>
              fetch(address, { signal: AbortSignal.timeout(10_000), redirect: "manual" }),
          ),
        );
        if (signInPage?.status === 200 && apex && apex.status < 400) good = before + 1;
        return good >= 5;
      },
      10,
    );
    p.log.success(`The mind answers (${seconds(answersBegan)}).`);
    // the client that a given token was for: said in words, read from the stack and not assumed
    if (clientToken) {
      if (stackHasOAuthClient((await cf("GET", secretsSettings)).result))
        p.log.success(
          `The mind's OAuth client at Cloudflare is made: the mind can read its own Cloudflare account, and change nothing there. The token you gave for it is not needed any more: delete it at https://dash.cloudflare.com/${account.id}/api-tokens`,
        );
      else p.log.warn(oauthClientLaterWords(domain));
    }

    await endAccess(access);
    const posted = await identityPublished({ mindId, controlPlaneHostname });
    // The mind is deployed: a fault in its first steps is a line, never a failed deploy. With
    // nobody at the terminal, the sign-in page is all there is to do here.
    const signInPage = `https://${controlPlaneHostname}/sign-in`;
    const closing = closingOf({
      controlPlaneHostname,
      zone: config.cloudflare.zones[0] || domain,
      owners: config.ownerEmails,
      ownersBefore: deployed?.ownerEmails,
    });
    if (closing.newOwners.length === 0) p.log.step(`${closing.signInWords}\n${signInPage}`);
    else if (input.setup !== false && interactive())
      await (async () => {
        using connection = await firstSignIn(controlPlaneHostname, closing.newOwners, steps);
        for (const step of firstSteps) await step(connection, steps);
      })().catch((error: unknown) =>
        p.log.warn(
          `The first steps did not end: ${error instanceof Error ? error.message : String(error)}. Your mind's sign-in page: ${signInPage}`,
        ),
      );
    else page(closing.signInWords, signInPage);
    // plain lines, never wrapped by this program: a command copied from one is whole
    p.log.success(closing.title);
    for (const line of closing.lines) console.log(`│  ${line}`);
    const keyLine = identityKeyLineOf(keyFileOf(IDENTITIES, mindId), {
      gaveTheId: !config.mindId,
      posted,
    });
    if (keyLine) p.log.info(keyLine);
    p.log.info(`The deploy's config and its log: ${work}`);
    p.outro(`Done in ${seconds(began)}.`);
  } catch (error) {
    // a stop is an expected end: its one line, with no stack, and a failed exit code
    for (const child of children) child.kill();
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro(`Stopped after ${seconds(began)}.`);
    process.exit(1);
  }
}
