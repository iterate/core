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
//   7. opening https://onboarding.<zone>/ in the browser to continue setup.
//
// It handles the expected way alone. A run that stops says why, changes nothing more, and can be
// run again on the same computer: every step reads the account's state first, and a deploy keeps
// what it made. Each choice has a flag, so a coding agent can run and supervise it with nobody at
// the terminal.
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual, promisify, styleText } from "node:util";
import * as p from "@clack/prompts";
import { z } from "zod";
import { mindAddressAsTyped } from "../mind-api.ts";
import {
  Hostname,
  MindConfig,
  zoneCoversControlPlaneHostname,
  zoneOfMailAddress,
} from "../mind-config.ts";
import { isCodingAgent } from "./coding-agent.ts";
import {
  type Answer,
  type Cloudflare,
  cloudflare,
  cloudflareAccess,
  DEPLOY_SCOPES,
  endAccess,
  SIGN_IN_ENDED_EXIT,
  SIGN_IN_FILE,
  SignInEnded,
  parsed,
  resultOf,
} from "./cloudflare-access.ts";
import { loginFlowFor } from "./device-login/flow.ts";
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
  egressGateway?: string;
  /** where each mail is forwarded as it arrived; `none` stops the forward (`deployConfigOf`) */
  mailForwardTo?: string;
  /** the share of requests whose trace is kept, 0 to 1; `default` is every one (`deployConfigOf`) */
  traceSampling?: string;
  yes?: boolean;
  buy?: boolean;
  eraseRecords?: boolean;
  source?: string;
  ref?: string;
  setup?: boolean;
  /** the stack's plan alone, over a mind that is there: nothing changes (`planArgsOf`) */
  plan?: boolean;
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
 *  what a flag said, and each replaces what the mind has. So does `mailForwardTo`, the config's
 *  `mail.forwardTo`, and `none` there removes it: with no flag the mind keeps its forward. So does
 *  `traceSampling`, the config's `telemetry.traceSampling` (a number from 0 to 1), and `default`
 *  there removes it, so that every trace is kept.
 *
 *  `mindId` is the deployed mind's own, and nothing here ever gives a mind that has an id
 *  another. A mind with none gets the hash of the genesis that the command signs right before
 *  the deploy (./identity.ts `newIdentity`), which names the hostname that this answers. */
export function deployConfigOf(answers: {
  accountId: string;
  domain: string;
  owner?: string;
  extraOwners?: readonly string[];
  controlPlaneHostname?: string;
  egressGateway?: string;
  mailForwardTo?: string;
  traceSampling?: string;
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
  const ownerEmails = [
    ...new Set([
      ...(answers.owner ? [answers.owner.toLowerCase()] : deployed?.ownerEmails || []),
      ...(answers.extraOwners || []).map((email) => email.trim().toLowerCase()).filter(Boolean),
    ]),
  ];
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
  const forwardTo = answers.mailForwardTo;
  if (forwardTo === "")
    throw new Error("--mail-forward-to is empty: give an address, or none to stop the forward.");
  if (
    forwardTo &&
    forwardTo !== "none" &&
    (!z.email().safeParse(forwardTo).success || zoneOfMailAddress({ zones }, forwardTo))
  )
    throw new Error(
      `The mail forward ${forwardTo} is no email address, or one at a domain of the mind, which takes that mail. Pass --mail-forward-to with an address elsewhere, or none.`,
    );
  const sampling = answers.traceSampling;
  const share = Number(sampling);
  // an empty flag is an error, never "back to the default" by accident
  if (
    sampling === "" ||
    (sampling && sampling !== "default" && !(sampling.trim() && share >= 0 && share <= 1))
  )
    throw new Error(
      `--trace-sampling ${sampling} is no share: give a number from 0 to 1 (1 keeps every trace), or default.`,
    );
  return {
    ...kept,
    mail: forwardTo === "none" ? undefined : forwardTo ? { forwardTo } : kept?.mail,
    // the trace sampling is what the flag says, else what the mind has; `default` keeps every trace
    ...(sampling && {
      telemetry: sampling === "default" ? undefined : { traceSampling: share },
    }),
    mindId: deployed?.mindId,
    controlPlaneHostname,
    ownerEmails,
    topology: deployed?.topology || ("full-cloudflare" as const),
    alchemy: { ...kept?.alchemy, stageName: deployed?.stageName || stageNameOf(answers.domain) },
    cloudflare: {
      ...kept?.cloudflare,
      accountId: answers.accountId,
      zones,
      // the egress gateway is what the flag says, else what the mind has; `none` takes it away
      ...(answers.egressGateway && {
        egressGatewayWorker: answers.egressGateway === "none" ? undefined : answers.egressGateway,
      }),
    },
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

/** WHAT THE BOUNDARY DOES NOT HOLD OF THE CONFIG THAT A DEPLOY GAVE IT, read from its settings
 *  after the deploy, or null when it holds all: the whole config as `DEPLOY_CONFIG`, which the
 *  next deploy starts from, and the mail forward as `MAIL_FORWARD_TO` exactly when the config
 *  names one. */
export function boundaryMisses(settings: unknown, deployed: Record<string, unknown>) {
  const text = (name: string) =>
    WorkerSettings.safeParse(settings).data?.bindings.find((binding) => binding.name === name)
      ?.text;
  const kept = parsed(z.unknown(), text("DEPLOY_CONFIG") || "");
  if (!isDeepStrictEqual(kept, JSON.parse(JSON.stringify(deployed))))
    return "its DEPLOY_CONFIG is not the config that this run deployed, so the next deploy would not start from the mind's own config";
  const forwardTo = MailForward.safeParse(deployed.mail).data?.forwardTo;
  if (text("MAIL_FORWARD_TO") !== forwardTo)
    return forwardTo
      ? `it has no MAIL_FORWARD_TO ${forwardTo}, so the mind keeps each mail and forwards none`
      : "it has a MAIL_FORWARD_TO that the config does not name, so the mind forwards its mail there";
  return null;
}
const MailForward = z.object({ forwardTo: z.string() });

/** The forward address that a config's `mail` names, or undefined. */
export const forwardOf = (mail: unknown) => MailForward.safeParse(mail).data?.forwardTo;

/** The longest wait for Cloudflare to show the boundary's new settings. A NEW WORKER'S SETTINGS
 *  LAG: for more than a minute after Alchemy made it, Cloudflare can answer "does not exist"
 *  (10007), or a 200 without the deployed config (most likely the empty script that Alchemy
 *  makes first). The slowest measured new Worker showed its config at 79 s; a Worker that exists
 *  shows its new settings at the first read. 3 min is more than twice 79 s. */
export const BOUNDARY_WAIT_MS = 3 * 60_000;

/** What each line the command says while it waits for the boundary holds, after the time. */
export const WAITING_FOR_BOUNDARY =
  "waiting for Cloudflare to show the boundary Worker's new settings";

/** One read of the boundary's settings as a line of the deploy's log: the status, Cloudflare's
 *  error, the bindings' names, and the keys at which DEPLOY_CONFIG differs. Never a value. */
export function boundaryRead(
  answer: { status: number; result?: unknown; error?: string },
  deployed: Record<string, unknown>,
) {
  if (answer.status !== 200) return `${answer.status} ${answer.error || ""}`.trim();
  const bindings = WorkerSettings.safeParse(answer.result).data?.bindings || [];
  const text = bindings.find((binding) => binding.name === "DEPLOY_CONFIG")?.text;
  const kept = parsed(z.record(z.string(), z.unknown()), text || "");
  const wanted: Record<string, unknown> = JSON.parse(JSON.stringify(deployed));
  const differs = kept
    ? [...new Set([...Object.keys(kept), ...Object.keys(wanted)])].filter(
        (key) => !isDeepStrictEqual(kept[key], wanted[key]),
      )
    : undefined;
  return `200 bindings ${bindings.map((binding) => binding.name).join(",") || "none"}; DEPLOY_CONFIG ${
    !kept ? "absent" : differs?.length ? `differs at ${differs.join(",")}` : "same"
  }`;
}

/** THE CHECK AFTER A DEPLOY: reads of the boundary's settings, 3 s apart, until one answers 200
 *  and holds all, for at most `BOUNDARY_WAIT_MS`. Each other read is "not yet": a new Worker's
 *  settings lag (`BOUNDARY_WAIT_MS`). It says a line when it begins to wait and each 30 s.
 *  `held`; else, at the bound, the last 200 read's miss or `unread` with the last status, and
 *  each read as a line of the deploy's log (`boundaryRead`). */
export async function boundaryCheck(
  read: () => Promise<{ status: number; result?: unknown; error?: string }>,
  deployed: Record<string, unknown>,
  { say = () => {}, pause = sleep, now = Date.now }: BoundaryWaitDeps = {},
): Promise<
  { held: true } | { miss: string; reads: string[] } | { unread: number; reads: string[] }
> {
  const began = now();
  const reads: string[] = [];
  let miss: string | null = null;
  let status = 0;
  let told = -1;
  for (;;) {
    const answer = await read();
    status = answer.status;
    if (status === 200) miss = boundaryMisses(answer.result, deployed);
    if (status === 200 && !miss) return { held: true };
    const waited = now() - began;
    reads.push(`${duration(waited)}: ${boundaryRead(answer, deployed)}`);
    if (waited >= BOUNDARY_WAIT_MS) return miss ? { miss, reads } : { unread: status, reads };
    if (Math.floor(waited / 30_000) > told) {
      told = Math.floor(waited / 30_000);
      say(
        told
          ? `${duration(waited)}: ${WAITING_FOR_BOUNDARY}`
          : `0 s: ${WAITING_FOR_BOUNDARY}, for at most ${duration(BOUNDARY_WAIT_MS)}`,
      );
    }
    await pause(3000);
  }
}

type BoundaryWaitDeps = {
  say?: (line: string) => void;
  pause?: (ms: number) => Promise<unknown>;
  now?: () => number;
};

/** How long one wait for the mind's first pages lasts (`firstPagesAnswer`). */
export const FIRST_PAGES_WAIT_MS = 10 * 60_000;

/** An address that a person's browser asks after a deploy, and the answer that says it works. */
type FirstPage = {
  address: string;
  works: (answer: { status: number; location: string | null }) => boolean;
};

/** THE PAGES THAT A PERSON'S BROWSER ASKS FIRST AFTER A DEPLOY. The command opens no page until
 *  each of them works from this computer, over HTTPS with no redirect followed:
 *   - `https://<controlPlaneHostname>/`, `/sign-in`, and `/.well-known/oauth-authorization-server`:
 *     proves `iterate.<domain>` (boundary + auth Worker + OAuth issuer metadata) is live;
 *   - the apex of the first zone answers below 400: the mind's own code (that request is also
 *     the one at which a new mind is born);
 *   - `https://onboarding.<zone>/` and `https://dash.<zone>/` (plus on a first deploy
 *     `https://onboarding.<zone>/.well-known/iterate-app` returning 200): proves the wildcard
 *     record, certificate, route, and config Worker apps are live. Node's fetch sends
 *     `sec-fetch-mode: cors`, so member apps answer 401 here (a browser redirects to sign-in);
 *     404 says the app is not live yet.
 *   - for a new mind, `/sign-in/access`, the one way in for an owner with no passkey yet
 *     (core/auth-worker/src/access-sign-in.ts): Cloudflare Access redirects it to the team's
 *     sign-in. Until the Access application is live at the edge, the auth Worker itself answers
 *     there, with a 403 that would end the first owner's sign-in. */
export function firstPagesOf(mind: {
  controlPlaneHostname: string;
  zone: string;
  firstDeploy: boolean;
}): FirstPage[] {
  const controlPlane = `https://${mind.controlPlaneHostname}`;
  const memberHostWorks = ({ status }: { status: number }) =>
    mind.firstDeploy ? status < 400 || status === 401 : status < 500;
  return [
    { address: `${controlPlane}/`, works: ({ status }) => status < 400 },
    { address: `${controlPlane}/sign-in`, works: ({ status }) => status === 200 },
    {
      address: `${controlPlane}/.well-known/oauth-authorization-server`,
      works: ({ status }) => status === 200,
    },
    { address: `https://${mind.zone}/`, works: ({ status }) => status < 400 },
    { address: onboardingUrlOf(mind.zone), works: memberHostWorks },
    { address: `https://dash.${mind.zone}/`, works: memberHostWorks },
    ...(mind.firstDeploy
      ? [
          {
            address: `https://onboarding.${mind.zone}/.well-known/iterate-app`,
            works: ({ status }: { status: number }) => status === 200,
          },
          {
            address: `${controlPlane}/sign-in/access`,
            works: ({ status, location }: { status: number; location: string | null }) =>
              status >= 300 &&
              status < 400 &&
              // Cloudflare's own absolute address; any other text is no proof
              /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\//.test(location || ""),
          },
        ]
      : []),
  ];
}

/** One read of a page: its status and where it redirects, or why no answer came (the name did
 *  not resolve, the certificate was refused, the edge did not connect, 10 s passed). */
async function readFirstPage(page: FirstPage) {
  try {
    const answer = await fetch(page.address, {
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    return { status: answer.status, location: answer.headers.get("location") };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    if (cause instanceof Error && "code" in cause && typeof cause.code === "string")
      return { error: cause.code };
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** THE WAIT FOR THE FIRST PAGES: every page is read each 3 s, and the mind answers when all of
 *  them worked five times in a row, since a new route reaches Cloudflare's edge within a minute
 *  or two and until then some answers are 522, 500 or 404. At most `FIRST_PAGES_WAIT_MS`; then
 *  `fault` says the first page that did not work at the last read, and its answer. It says the
 *  fault of the moment each 30 s. */
export async function firstPagesAnswer(
  pages: FirstPage[],
  {
    read = readFirstPage,
    say = () => {},
    pause = sleep,
    now = Date.now,
  }: BoundaryWaitDeps & {
    read?: (
      page: FirstPage,
    ) => Promise<{ status: number; location: string | null } | { error: string }>;
  } = {},
): Promise<{ answered: true } | { fault: string }> {
  const began = now();
  let good = 0;
  let told = 0;
  for (;;) {
    const answers = await Promise.all(pages.map((page) => read(page)));
    const fault = pages
      .map((page, index) => {
        const answer = answers[index]!;
        if ("error" in answer) return `${page.address} gave no answer (${answer.error})`;
        if (page.works(answer)) return undefined;
        return `${page.address} answered ${answer.status}${answer.location ? ` to ${new URL(answer.location, page.address).origin}` : ""}`;
      })
      .find(Boolean);
    good = fault ? 0 : good + 1;
    if (good >= 5) return { answered: true };
    const waited = now() - began;
    if (waited >= FIRST_PAGES_WAIT_MS)
      return { fault: fault || "its pages did not answer five times in a row" };
    if (Math.floor(waited / 30_000) > told) {
      told = Math.floor(waited / 30_000);
      if (fault) say(`${duration(waited)}: ${fault}`);
    }
    await pause(3000);
  }
}

/** WHETHER A PRODUCT OF THE ACCOUNT IS ON (Workers Paid, R2), by a read of one of its paths: 200
 *  is on, and Cloudflare's refusal (a 4xx but 429) is off. A READ THAT FAILED IS NOT A FACT: a
 *  429, a 5xx or anything else is read again, up to three reads with `pause` between them, and
 *  then the command stops and says so. `off` keeps Cloudflare's words, so the account's line can
 *  show them. */
export async function productRead(
  what: string,
  read: () => Promise<{ status: number; error: string }>,
  pause: () => Promise<unknown>,
): Promise<{ on: true } | { on: false; why: string }> {
  for (let attempt = 1; ; attempt++) {
    const answer = await read();
    if (answer.status === 200) return { on: true };
    const why = `${answer.status}: ${answer.error}`;
    if (answer.status >= 400 && answer.status < 500 && answer.status !== 429)
      return { on: false, why };
    if (attempt === 3)
      throw new Error(
        `Cloudflare did not answer whether ${what} is on (${why}), three times. A read that failed says nothing about the account. Nothing was changed. Run the command again.`,
      );
    await pause();
  }
}

/** Whether a line of a deploy's output says that the stack's state store refused a request, or
 *  that its workers.dev address answered 404. A store that the same run made does so while
 *  Cloudflare does not serve it yet, and nothing is made without state: the one failure after
 *  which the command waits for the store and deploys again by itself. */
export const saysTheStateStoreRefused = (line: string) =>
  /State store .*failed|StateStoreError|\(404 GET https:\/\/[^\s/]+-state\.[^\s/]+\.workers\.dev\//.test(
    line,
  );

/** The new state store's workers.dev address, where Alchemy reads it. */
export const stateStoreAddress = (stageName: string, workersSubdomain: string) =>
  `https://iterate-${stageName}-state.${workersSubdomain}.workers.dev`;

/** The longest wait for Cloudflare to serve a new state store, after Alchemy's own 2 minutes.
 *  Cloudflare's edge can answer 404 at a new script's workers.dev address for more than 5
 *  minutes after its upload and its subdomain both answered 200, though most stores answer
 *  within seconds: 6 minutes more covers about 8 minutes after the upload. */
export const STORE_WAIT_MS = 6 * 60_000;

/** How many 200 answers in a row, 2 seconds apart, say that Cloudflare serves the store: the
 *  edge may answer from one place before another. */
const STORE_ANSWERS_IN_A_ROW = 3;

/** What each line the command says while it waits for the store holds, after the time waited:
 *  the time comes first, so a spinner cut to the terminal's width still shows it move. */
export const WAITING_FOR_STORE = "waiting for Cloudflare to serve the mind's new state store";

/** Whether the store's address answers its `/version` (no token) with 200. */
const storeAnswers = async (address: string) => {
  const response = await fetch(`${address}/version`, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
  await response?.body?.cancel();
  return response?.status === 200;
};

/** Waits until the store's address answers 200 three times in a row, 2 seconds apart, for at
 *  most `STORE_WAIT_MS`. It says a line at the start and each 30 seconds. */
export async function waitForStore(
  address: string,
  say: (line: string) => void,
  { pause = sleep, now = Date.now, answers = storeAnswers }: StoreWaitDeps = {},
): Promise<boolean> {
  const began = now();
  say(`0 s: ${WAITING_FOR_STORE} at ${address}, for at most ${duration(STORE_WAIT_MS)}`);
  let told = 0;
  let inARow = 0;
  for (;;) {
    inARow = (await answers(address)) ? inARow + 1 : 0;
    if (inARow === STORE_ANSWERS_IN_A_ROW) return true;
    const waited = now() - began;
    if (waited >= STORE_WAIT_MS) return false;
    if (Math.floor(waited / 30_000) > told) {
      told = Math.floor(waited / 30_000);
      say(`${duration(waited)}: ${WAITING_FOR_STORE}`);
    }
    await pause(2000);
  }
}

type StoreWaitDeps = {
  pause?: (ms: number) => Promise<unknown>;
  now?: () => number;
  answers?: (address: string) => Promise<boolean>;
};

/** Whether a line of a deploy's output says that Alchemy did not see the event queue's new
 *  consumer bound to the boundary Worker: the other failure after which the command deploys again
 *  by itself. Alchemy 2.0.0-beta.87 reads a new consumer back for 60 seconds only; when
 *  Cloudflare's reads lag longer, the consumer is attached all the same, and the next run lists
 *  the queue's consumers and finds it. Remove when Alchemy's read-back waits longer or lists the
 *  consumers. */
export const saysTheConsumerIsNotSeenYet = (line: string) => /ConsumerScriptUnbound/.test(line);

/** The end of the line that says the command deploys again by itself. */
export const ONE_MORE_TRY = "one more try in";

/** Deep-clones a JSON-compatible config value, replacing any sensitive key's value with
 *  `"[redacted]"` so `MindConfig` can be printed safely to stdout. */
export function redactMindConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactMindConfig(item));
  if (typeof value !== "object" || !value) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    redacted[key] =
      /(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|authorization)/i.test(
        key,
      )
        ? "[redacted]"
        : redactMindConfig(entry);
  }
  return redacted;
}

/** Pretty-printed JSON of the deployed `MindConfig` with any sensitive values redacted. */
export const formatMindConfigForStdout = (config: Record<string, unknown>) =>
  JSON.stringify(redactMindConfig(config), null, 2);

/** Where setup continues in the browser once the mind is deployed and answering. */
export const onboardingUrlOf = (zone: string) => `https://onboarding.${zone}/`;

/** THE PAGE THE COMMAND OPENS AT THE END OF A DEPLOY, and the line printed right before
 *  "Press Enter to open in browser...".
 *  - On a first deploy, deep-links straight to `https://<controlPlaneHostname>/sign-in/access`
 *    (Cloudflare Access verifies the owner's email, sends them to add their first passkey, and
 *    `auth-worker` redirects to `onboarding.<zone>/` automatically — saving a click through `/sign-in`).
 *  - On a redeploy, opens `https://onboarding.<zone>/` directly (the owner already has a passkey,
 *    and `/sign-in/access` refuses owners who already have one).
 *  Always prints the owner email address to sign in with before the Enter prompt. */
export function setupDestinationOf(mind: {
  controlPlaneHostname: string;
  zone: string;
  ownerEmails: string[];
  firstDeploy: boolean;
}) {
  const url = mind.firstDeploy
    ? `https://${mind.controlPlaneHostname}/sign-in/access`
    : onboardingUrlOf(mind.zone);
  const emails = mind.ownerEmails.join(" or ");
  const prompt = emails
    ? `Continue setup in your browser (sign in with ${emails}):`
    : "Continue setup in your browser:";
  return { url, prompt };
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

/** Whether ANSI color styling should be emitted to stdout (respects NO_COLOR, FORCE_COLOR,
 *  TERM=dumb, and TTY). */
export function isColorEnabled(env: NodeJS.ProcessEnv, isTTY: boolean) {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return isTTY;
}

const styled = (format: Parameters<typeof styleText>[0], text: string, enabled: boolean) =>
  enabled ? styleText(format, text, { validateStream: false }) : text;

/** Tasteful ANSI palette for `iterate deploy`. Returns plain text when `enabled` is false. */
export function createPalette(enabled: boolean) {
  return {
    /** Iconic `𝑖` logo mark on the very first line. */
    mark: (text: string) => styled(["bold", "magenta"], text, enabled),
    /** Cloudflare account names — distinct warm yellow everywhere they appear. */
    account: (text: string) => styled(["bold", "yellow"], text, enabled),
    /** One-time Cloudflare device verification code. */
    code: (text: string) => styled(["bold", "magenta"], text, enabled),
    /** Domain names and mind hostnames. */
    domain: (text: string) => styled(["bold", "cyan"], text, enabled),
    /** Clickable Cloudflare dashboard and onboarding URLs. */
    url: (text: string) => styled(["underline", "blue"], text, enabled),
    /** Section headings inside the unified domain picker. */
    heading: (text: string) => styled("bold", text, enabled),
    /** Key callouts (titles, button names, bucket names). */
    callout: (text: string) => styled("bold", text, enabled),
  };
}

const palette = () => createPalette(isColorEnabled(process.env, Boolean(process.stdout.isTTY)));

/** Whether a person is at this terminal: requires a TTY, no CI flag, and no coding agent wrapper. */
export const isInteractiveEnv = (env: NodeJS.ProcessEnv, isTTY: boolean) => {
  const inCi = Boolean(env.CI && env.CI !== "0" && env.CI.toLowerCase() !== "false");
  return isTTY && !inCi && !isCodingAgent(env);
};

const interactive = () =>
  isInteractiveEnv(process.env, Boolean(process.stdin.isTTY && process.stdout.isTTY));

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

/** A page the person must act on: printed, and opened once they press Enter when a person is
 *  there, so browser focus is not yanked before they can read the instructions. */
async function page(text: string, url: string) {
  p.log.step(`${text}\n${palette().url(url)}`);
  if (!interactive() || process.env.ITERATE_SKIP_BROWSER_OPEN === "1") return;
  // a browser here is not the one the person looks at
  if (signInFlow() === "device") return;
  await ask<string>("", () =>
    p.text({ message: "Press Enter to open in browser...", defaultValue: "" }),
  );
  const { command, args } = openPageCommand(new URL(url), process.platform);
  execFile(command, args, () => {});
}

const duration = (ms: number) => {
  const all = Math.round(ms / 1000);
  if (all < 60) return `${all} s`;
  return all % 60 ? `${Math.floor(all / 60)} min ${all % 60} s` : `${all / 60} min`;
};
const seconds = (since: number) => duration(Date.now() - since);

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

/** Environment overrides for pnpm child processes so strict engine or packageManager checks do not
 *  block installs or deploys across Node and pnpm versions. */
export const PNPM_COMPAT_ENV = {
  npm_config_engine_strict: "false",
  npm_config_manage_package_manager_versions: "false",
  COREPACK_ENABLE_STRICT: "0",
} as const;

/** Child-process env for `pnpm` vs `npx`: npm/npx warns on unknown `manage-package-manager-versions`,
 *  so omit and strip that pnpm-only variable when invoking via `npx`. */
export function pnpmEnvFor(
  command: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (command === "npx") {
    const { npm_config_manage_package_manager_versions: _pnpmOnly, ...rest } = baseEnv;
    return {
      ...rest,
      npm_config_engine_strict: PNPM_COMPAT_ENV.npm_config_engine_strict,
      COREPACK_ENABLE_STRICT: PNPM_COMPAT_ENV.COREPACK_ENABLE_STRICT,
    };
  }
  return { ...baseEnv, ...PNPM_COMPAT_ENV };
}

/** Summarizes Alchemy's verbose log stream into a concise progress label (`12 of 48 resources`),
 *  ignoring noisy reconcile lines, plan preview lines, npm warnings, and raw stack output objects. */
export function createDeployProgress() {
  let planned = 0;
  let planEnded = false;
  const done = new Set<string>();
  /** resources that Alchemy said it is making and has not yet said made or failed */
  const working = new Set<string>();
  const count = () =>
    planned > 0
      ? `${Math.min(done.size, planned)} of ${planned} resources`
      : `${done.size} resource${done.size === 1 ? "" : "s"}`;
  return {
    /** A line for a long quiet stretch: the count, and what Alchemy is still making. Alchemy says
     *  nothing while it uploads a Worker, which can take minutes. */
    stillAt(): string | undefined {
      if (!planEnded || working.size === 0) return undefined;
      const names = [...working];
      const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
      return `${count()}; still making ${names.slice(0, 3).join(", ")}${more}`;
    },
    /** Feeds one Alchemy log line and returns a short status label when progress changes. */
    onLine(line: string): string | undefined {
      const planMatch = /\bPlan:\s+(.+)/.exec(line);
      if (planMatch) {
        planEnded = true;
        let total = 0;
        for (const count of planMatch[1]!.matchAll(
          /(\d+)\s+to\s+(?:create|update|adopted|replace|delete|orphaned)\b/g,
        )) {
          total += Number(count[1]);
        }
        if (total > 0) {
          planned = total;
          return `0 of ${planned} resources`;
        }
        return undefined;
      }
      const settled = /\bINFO:\s+\[([^\]]+)\]\s+(created|updated|deleted|replaced|adopted)\b/.exec(
        line,
      );
      if (settled && (settled[2] !== "adopted" || planEnded)) {
        done.add(settled[1]!);
        working.delete(settled[1]!);
        return count();
      }
      const busy = /\bINFO:\s+\[([^\]]+)\]\s+(creating|updating|deleting|replacing)\b/.exec(line);
      if (busy && planEnded) working.add(busy[1]!);
      const failed = /\bERROR:\s+\[([^\]]+)\]\s+fail\b/.exec(line);
      if (failed) working.delete(failed[1]!);
      if (/state store/i.test(line) && /(?:bootstrapping|updating|creating)/i.test(line)) {
        return "preparing state store";
      }
      return undefined;
    },
  };
}

/** How to run pnpm for `packageManager`: use local `pnpm` only when its major version matches
 *  `packageManager`; otherwise run `npx --yes <packageManager>`. */
export function pnpmCommandOf(
  packageManager: string,
  localVersion?: string,
): { command: string; first: string[] } {
  const expectedMajor = /^pnpm@(\d+)/.exec(packageManager.trim())?.[1];
  const localMajor = /^(\d+)/.exec(localVersion?.trim() || "")?.[1];
  if (expectedMajor && localMajor && expectedMajor === localMajor)
    return { command: "pnpm", first: [] };
  return { command: "npx", first: ["--yes", packageManager] };
}

/** THE REPOS A NEW MIND STARTS WITH beside its config, as the mind Worker's build reads them
 *  (core/mind-worker/scripts/build.ts): `ITERATE_SEED_REPOS`, a repo path of the mind to a
 *  folder of the source. A source that holds `core/repos/onboarding` seeds `/repos/onboarding`
 *  from it; an older source names nothing, and its build seeds no repo. */
export function seedReposEnvOf(sourceDir: string): { ITERATE_SEED_REPOS?: string } {
  const onboarding = join(sourceDir, "core/repos/onboarding");
  if (!existsSync(onboarding)) return {};
  return { ITERATE_SEED_REPOS: JSON.stringify({ "/repos/onboarding": onboarding }) };
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
  // use local pnpm only when its major version matches packageManager; otherwise run via npx
  const manager = z
    .object({ packageManager: z.string().default("pnpm@12") })
    .parse(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))).packageManager;
  const localPnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  const pnpm = pnpmCommandOf(manager, localPnpm.status === 0 ? localPnpm.stdout : undefined);
  // a checkout of one's own is installed once; the cache follows its lockfile at every run
  if (!own || !existsSync(join(dir, "core/alchemy/node_modules/alchemy/bin/cli.js")))
    await exec(pnpm.command, [...pnpm.first, "install", "--frozen-lockfile"], {
      cwd: dir,
      env: { ...pnpmEnvFor(pnpm.command), CI: "1" },
      maxBuffer: 64 << 20,
    });
  // pre-build core-mind-worker in the background while the person signs in and answers prompts
  // so `alchemy deploy` and `alchemy plan` do not have to rebuild it later
  await exec(pnpm.command, [...pnpm.first, "--filter", "core-mind-worker", "build"], {
    cwd: dir,
    env: { ...pnpmEnvFor(pnpm.command), CI: "1", ...seedReposEnvOf(dir) },
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
  log: string;
  children: Set<ChildProcess>;
  say?: (line: string) => void;
  /** a deploy that goes on with an earlier one whose config is here (`earlierDeployOf`) */
  adopt?: boolean;
};

/** THE ARGUMENTS OF `alchemy deploy` in core/alchemy (`sourceOf` already built `core-mind-worker`
 *  in the background, so deploys and retries skip redundant rebuilds). A deploy that stopped before
 *  its end can leave a resource that Cloudflare made and Alchemy's state does not hold, since its
 *  creation was under way at the stop: Alchemy then refuses it ("OwnedBySomeoneElse", for a
 *  Pipelines stream, which carries no owner's tag) unless `--adopt` takes it over. The stage's
 *  state store says that such a resource, under the stage's own name, is the stack's own: so a
 *  deploy that goes on adopts. So does a new mind beside a store that reads as a destroy's
 *  leftover: a stack that stopped before its first Worker and its first record reads the same from
 *  outside, with its bucket, tokens and streams there, and after a real destroy nothing is there to
 *  take over. No other deploy adopts. */
export const deployArgsOf = (stageName: string, adopt = false) => [
  "exec",
  "alchemy",
  "deploy",
  "alchemy.run.ts",
  "--stage",
  stageName,
  "--yes",
  ...(adopt ? ["--adopt"] : []),
];

/** THE COMMANDS OF A PLAN of core/alchemy, which changes nothing: Alchemy's plan of the stage
 *  (`sourceOf` already built `core-mind-worker`). Each resource gets one line, `[Name] noop`,
 *  `update`, `create`, `delete` and the like: what a caller with nobody at the terminal reads
 *  before it deploys. */
export const planArgsOf = (stageName: string) => [
  ["exec", "alchemy", "plan", "alchemy.run.ts", "--stage", stageName, "--no-input"],
];

/** One `pnpm run deploy` of core/alchemy (or other arguments of pnpm there): its exit code, and
 *  whether the state store refused it or Alchemy did not see the queue's consumer. Every line goes
 *  to the log file, with any token text replaced, and any inherited
 *  CLOUDFLARE_OAUTH_CLIENT_API_TOKEN stripped from the child env. */
function deployOnce(
  run: Run,
  args = deployArgsOf(run.stageName, run.adopt),
): Promise<{ code: number; storeRefused: boolean; consumerNotSeen: boolean }> {
  return new Promise((done, failed) => {
    const file = createWriteStream(run.log, { flags: "a" });
    const { command, first } = run.source.pnpm;
    // A source of an earlier version (`--ref`) still turns telemetry tables on with a token in
    // CLOUDFLARE_TELEMETRY_API_TOKEN: dropped, so a token of the shell never makes a mind's
    // tables beside the ones that the mind makes itself.
    const {
      CLOUDFLARE_OAUTH_CLIENT_API_TOKEN: _droppedOAuthToken,
      CLOUDFLARE_TELEMETRY_API_TOKEN: _droppedTelemetryToken,
      ...parentEnv
    } = process.env;
    const child = spawn(command, [...first, ...args], {
      cwd: join(run.source.dir, "core/alchemy"),
      env: {
        ...pnpmEnvFor(command, parentEnv),
        CI: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        CLOUDFLARE_API_TOKEN: run.token,
        ITERATE_MIND_CONFIG: run.config,
        // the deploy may build the mind Worker again: the same repos as `sourceOf`'s build
        ...seedReposEnvOf(run.source.dir),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    run.children.add(child);
    let storeRefused = false;
    let consumerNotSeen = false;
    let rest = "";
    const read = (chunk: Buffer) => {
      const lines = (rest + chunk.toString("utf8")).split("\n");
      rest = lines.pop() ?? "";
      for (const raw of lines) {
        const line = hidden(raw, run).trimEnd();
        file.write(`${line}\n`);
        if (saysTheStateStoreRefused(line)) storeRefused = true;
        if (saysTheConsumerIsNotSeenYet(line)) consumerNotSeen = true;
        if (line.trim()) run.say?.(line.trim());
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", failed);
    child.on("close", (code) => {
      run.children.delete(child);
      file.end(`${hidden(rest, run)}\n`);
      done({ code: code ?? 1, storeRefused, consumerNotSeen });
    });
  });
}

/** A line of the deploy's output with the text of any token replaced. */
const hidden = (line: string, run: Run) =>
  [run.token, process.env.CLOUDFLARE_OAUTH_CLIENT_API_TOKEN].reduce<string>(
    (text, token) => (token ? text.replaceAll(token, "[token]") : text),
    line,
  );

/** The deploy. When the state store refused it (`saysTheStateStoreRefused`), it waits until
 *  Cloudflare serves the store (`waitForStore`); when Alchemy did not yet see the queue's
 *  consumer (`saysTheConsumerIsNotSeenYet`), it waits a minute. Then it runs once more, and only
 *  once. The second run goes on with what the first made, as a person's run of the command does,
 *  so it adopts. `storeNotServed` is the store's address when the deploy failed because
 *  Cloudflare did not serve it. */
export async function deployStack<
  R extends { stageName: string; storeAddress: string; say?: (line: string) => void },
>(
  run: R,
  once: (run: R, args?: string[]) => ReturnType<typeof deployOnce>,
  deps: StoreWaitDeps = {},
): Promise<{ code: number; consumerNotSeen: boolean; storeNotServed?: string }> {
  const { pause = sleep } = deps;
  const first = await once(run);
  if (first.code === 0) return { code: 0, consumerNotSeen: false };
  if (first.storeRefused) {
    const say = (line: string) => run.say?.(line);
    say(
      `The new state store refused the deploy: ${ONE_MORE_TRY} at most ${duration(STORE_WAIT_MS)}, when Cloudflare serves it`,
    );
    if (!(await waitForStore(run.storeAddress, say, deps)))
      return { code: first.code, consumerNotSeen: false, storeNotServed: run.storeAddress };
    const second = await once(run);
    return {
      code: second.code,
      consumerNotSeen: false,
      ...(second.code !== 0 && second.storeRefused && { storeNotServed: run.storeAddress }),
    };
  }
  if (!first.consumerNotSeen) return { code: first.code, consumerNotSeen: false };
  run.say?.(
    `Cloudflare did not yet confirm the boundary Worker as the event queue's consumer: ${ONE_MORE_TRY} a minute`,
  );
  await pause(60_000);
  const second = await once(run, deployArgsOf(run.stageName, true));
  return { code: second.code, consumerNotSeen: second.code !== 0 && second.consumerNotSeen };
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
        `Cloudflare did not say whether this access covers the account ${palette().account(account.name)} (${read.status}: ${read.error}). Run the command again.`,
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

/** Sentinel option value for entering a brand new domain name to buy (or search keywords). */
export const ENTER_NEW_DOMAIN = "\0enter-new-domain";

export type DomainPickerOption = {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
};

/** Builds the single unified domain-picker list:
 *  1. "Buy a brand new domain" — available domains to buy, plus entering a brand new domain name
 *  2. "Use an existing cloudflare zone" — the account's existing Cloudflare zones */
export function domainPickerOptions(input: {
  offers: readonly Offer[];
  zones: readonly Zone[];
  maxOffers?: number;
  color?: boolean;
}): DomainPickerOption[] {
  const c = createPalette(input.color ?? false);
  const readableZones = input.zones.filter((zone) => !zone.unread);
  const shownOffers = input.offers.slice(0, input.maxOffers ?? 6);
  const options: DomainPickerOption[] = [
    { value: "\0heading-buy", label: c.heading("Buy a brand new domain"), disabled: true },
    ...shownOffers.map((offer) => ({
      value: offer.name,
      label: offer.name,
      hint: priceOf(offer),
    })),
    {
      value: ENTER_NEW_DOMAIN,
      label: "Enter a brand new domain name and buy that",
      hint: "type a domain to buy, or keywords for more names",
    },
    {
      value: "\0heading-zones",
      label: c.heading("Use an existing cloudflare zone"),
      disabled: true,
    },
  ];
  if (readableZones.length > 0) {
    for (const zone of readableZones) {
      options.push({
        value: zone.name,
        label: zone.name,
        hint: zone.stageName
          ? "a mind is here already: deploy over it"
          : zone.uses?.length
            ? "in this account, in use: its records would be erased"
            : "in this account, unused",
      });
    }
  } else {
    options.push({
      value: "\0no-zones",
      label: "No existing Cloudflare zones in this account",
      disabled: true,
    });
  }
  return options;
}

/** The domain, and how the account gets it: a new one to buy, a zone the account has, or one to
 *  add. With no `--domain`, the person picks from one unified list with "Buy a brand new domain"
 *  at the top (including entering a brand new domain name to buy) and "Use an existing cloudflare
 *  zone" below. `person` is the name the initial candidates are made from. */
async function pickDomain(
  cf: Cloudflare,
  account: string,
  input: DeployInput,
  zones: Zone[],
  person: string,
): Promise<Pick> {
  const free = async (words?: string) =>
    (await offersOf(cf, account, candidatesOf(person, words))).filter((offer) => offer.registrable);
  let offers = input.domain ? [] : await free();
  let maxOffers = 6;
  for (;;) {
    const options = domainPickerOptions({
      offers,
      zones,
      maxOffers,
      color: isColorEnabled(process.env, Boolean(process.stdout.isTTY)),
    });
    const firstSelectable = options.find((option) => !option.disabled)?.value;
    let domain =
      input.domain?.toLowerCase() ||
      (await ask<string>("pass --domain <domain>", () =>
        p.select({
          message:
            "Which domain does the mind live at? It takes the whole domain: its site, its mail and its sign-in.",
          maxItems: 16,
          initialValue: firstSelectable,
          options,
        }),
      ));
    if (domain === ENTER_NEW_DOMAIN) {
      const typed = (
        await ask<string>("pass --domain <domain>", () =>
          p.text({
            message:
              "Enter a brand new domain name to buy (e.g. ada-labs.com), or a few words for more ideas",
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
        maxOffers = 8;
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
    await page(
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
    await page(
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
      await page(
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
  const c = palette();
  chosen ||= await ask<string>("pass --account <id or name>, or --new-account", () =>
    p.select({
      message: "Which Cloudflare account does the mind live in?",
      options: [
        ...covered.map((account) => ({
          value: account.id,
          label: c.account(account.name),
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
      `You have no Cloudflare account ${JSON.stringify(chosen)}. This access covers: ${covered.map((a) => `${c.account(a.name)} (${a.id})`).join(", ") || "none"}.`,
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
  p.log.success(`Made the Cloudflare account ${c.account(fresh)}.`);
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

const UnfinishedDeploy = z.object({
  accountId: z.string(),
  stageName: z.string(),
  domain: z.string(),
  mindId: z.string(),
  firstDeploy: z.boolean(),
});

/** Reads `deploying.json` when this computer started a deploy of the same mind that stopped before
 *  finishing (including after the boundary Worker existed). Returns the marker when its account,
 *  stage, domain, and mind id match, otherwise `undefined`. */
export function unfinishedDeployIn(
  markerFile: string,
  expected: { accountId: string; stageName: string; domain: string; mindId?: string },
) {
  if (!expected.mindId || !existsSync(markerFile)) return undefined;
  const marker = parsed(UnfinishedDeploy, readFileSync(markerFile, "utf8"));
  if (
    marker &&
    marker.accountId === expected.accountId &&
    marker.stageName === expected.stageName &&
    marker.domain === expected.domain &&
    marker.mindId === expected.mindId
  )
    return marker;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The mind's identity.

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
  return `Its identity key: ${keyFile.replace(homedir(), "~")}  (not used right now — don't worry about it or if you lose it)`;
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

// ---------------------------------------------------------------------------------------------
// The command.

/** Minimum Node version for `iterate deploy`: Node 24.7+ (ML-DSA-65 identity keys + modern TLS/fetch
 *  so Cloudflare OAuth does not reject older runtimes with HTTP 403 / fetch failed). */
export const MIN_DEPLOY_NODE = [24, 7] as const;

/** Throws a clear upgrade error before opening a browser or calling Cloudflare when running on an
 *  unsupported Node version (< 24.7). */
export function assertSupportedNodeVersion(version = process.versions.node): void {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  const major = match ? Number(match[1]) : 0;
  const minor = match ? Number(match[2]) : 0;
  const [minMajor, minMinor] = MIN_DEPLOY_NODE;
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return;
  throw new Error(
    `iterate deploy requires Node ${minMajor}.${minMinor} or newer (you are running Node v${version}). Older Node versions can fail Cloudflare sign-in (HTTP 403 / fetch failed) and lack ML-DSA-65 key support. Upgrade Node (e.g. brew install node, nvm install 24, fnm install 24, or https://nodejs.org) and run again.`,
  );
}

/** Parses optional comma- or space-separated additional owner email addresses into a clean,
 *  deduplicated lowercase list. */
export function parseExtraOwnerEmails(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export async function deployMind(input: DeployInput) {
  const began = Date.now();
  const children = new Set<ChildProcess>();
  const c = palette();
  // 𝑖 is U+1D456, the letter of iterate's logo, printed alone on the very first line
  console.log(c.mark("𝑖"));
  p.intro(`${c.callout("iterate deploy")}: a mind in your own Cloudflare account`);

  try {
    if (process.platform === "win32")
      throw new Error("iterate deploy runs on macOS and Linux (on Windows: in WSL).");
    assertSupportedNodeVersion();
    // the source comes while the person signs in and chooses
    const sourceBegan = Date.now();
    const source = sourceOf(input);
    source.catch(() => {});
    const signIn = (fresh = false) =>
      cloudflareAccess(
        DEPLOY_SCOPES,
        async ({ url, code, minutes }) => {
          await page(
            `Sign in at Cloudflare and approve the access. Check that the page shows the code ${c.code(code)}. Select the account for the mind. The code works for ${minutes} minutes.`,
            url.href,
          );
        },
        fresh,
        // a kept sign-in (`iterate cloudflare sign-in`) is a sign-in too: the same checks
        process.env[SIGN_IN_FILE]?.trim() || undefined,
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
        throw new Stop(error instanceof Error ? error.message : String(error), { cause: error });
      });
      return cloudflare(access.token)(method, path, body);
    };

    // A sign-in that lacks a required scope cannot deploy: end the access and tell the user to
    // re-run and approve all requested permissions.
    if (access.lacks.length > 0) {
      const why = `The sign-in at Cloudflare did not grant ${access.lacks.join(", ")}, and a deploy needs it.`;
      await endAccess(access);
      if (access.keptIn)
        throw new SignInEnded(
          `${why} Nothing was changed. Sign out of the kept sign-in in ${access.keptIn} (iterate cloudflare sign-out), and sign in again.`,
        );
      throw new Error(
        `${why} Nothing was changed. Run the command again and grant all requested permissions.`,
      );
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
    // a refusal ends a kept sign-in; any other answer (an outage, a rate limit) leaves it as it is
    if ((user.status === 401 || user.status === 403) && access.keptIn)
      throw new SignInEnded(
        `Cloudflare refused the kept sign-in in ${access.keptIn} (${user.status}). Sign in again: iterate cloudflare sign-in.`,
      );
    if (user.status !== 200 && access.keptIn)
      throw new Error(
        `Cloudflare did not answer who the kept sign-in in ${access.keptIn} is (${user.status}: ${user.error}). The file is as it was. Run the command again later.`,
      );
    if (user.status !== 200 && access.from === "sign-in") {
      await endAccess(access);
      throw new Error(
        `Cloudflare refused the kept access (${user.status}). Run the command again to sign in.`,
      );
    }
    p.log.info(`Signed in to Cloudflare${login ? ` as ${login}` : ""}.`);
    // THE OWNER OF A NEW MIND: `--owner`, else the Cloudflare login, else a question. Asked for
    // only where it is needed: a mind that is there already keeps its owners.
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
          `The token in CLOUDFLARE_API_TOKEN does not reach the account ${c.account(account.name)} (${account.id}).`,
        );
      // nobody may be at Cloudflare's page: the kept sign-in is the whole approval
      if (access.keptIn)
        throw new SignInEnded(
          `The kept sign-in in ${access.keptIn} does not cover the account ${c.account(account.name)} (${account.id}). Sign in again and select that account on Cloudflare's page: iterate cloudflare sign-in.`,
        );
      await endAccess(access);
      p.log.info(
        `Cloudflare asks once more, for the account ${c.account(account.name)}: select it on its page.`,
      );
      access = await signIn(true);
      if ((await cf("GET", `/accounts/${account.id}`)).status !== 200)
        throw new Error(
          `The approval does not cover the account ${c.account(account.name)}. Run the command again and select it on Cloudflare's page.`,
        );
    }
    // `productRead`: on, off with Cloudflare's words, or a stop when the read itself failed
    const product = (what: string, path: string) =>
      productRead(
        what,
        () => cf("GET", `/accounts/${account.id}${path}`),
        () => sleep(2000),
      );
    const paidPath = "/containers/applications";
    const r2Path = "/r2/buckets?per_page=1";
    const zeroTrustPath = `/accounts/${account.id}/access/organizations`;
    const [paidRead, r2Read, zones, subdomain, zeroTrustRead] = await Promise.all([
      product("Workers Paid", paidPath),
      product("R2", r2Path),
      zonesOf(cf, account.id),
      cf("GET", `/accounts/${account.id}/workers/subdomain`),
      cf("GET", zeroTrustPath),
    ]);
    const { on: paid } = paidRead;
    const { on: r2 } = r2Read;
    let zeroTrust = zeroTrustStep(account.id, zeroTrustRead, false);
    if (zeroTrust.next === "stop") throw new Error(zeroTrust.words);
    const state = (read: typeof paidRead) => (read.on ? "on" : `off (Cloudflare: ${read.why})`);
    p.log.info(
      `Account ${c.account(account.name)}: Workers Paid ${state(paidRead)}, R2 ${state(r2Read)}, ${zones.length} domain${zones.length === 1 ? "" : "s"}.`,
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
    const markerFile = join(work, "deploying.json");
    const deployed = await deployedMind(cf, account.id, stageName);
    if (deployed && !deployed.zones.includes(domain))
      throw new Error(
        `The account has a mind at ${deployed.controlPlaneHostname} whose stack is named ${stageName}, the name that a mind at ${domain} gets, and ${domain} is none of its domains (${deployed.zones.join(", ")}). Choose another domain.`,
      );
    if (deployed && !deployed.deployConfig)
      throw new Error(
        `The mind at ${deployed.controlPlaneHostname} was deployed before its stack kept the deploy's whole config, so a deploy from here could drop what no Worker holds, such as its sandboxes' image. Nothing was changed. Deploy it once with its own config by core/alchemy's script (core/alchemy/README.md), then run the command again.`,
      );
    const resuming = deployed
      ? unfinishedDeployIn(markerFile, {
          accountId: account.id,
          stageName,
          domain,
          mindId: deployed.mindId,
        })
      : undefined;
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
    const primaryOwner = mind ? input.owner : await newOwner();
    const extraOwners =
      !mind && !input.owner && interactive() && primaryOwner
        ? parseExtraOwnerEmails(
            await ask<string>("", () =>
              p.text({
                message: `Add additional owner email addresses beside ${primaryOwner}? (comma-separated, or press Enter to skip)`,
                placeholder: "e.g. you@personal.com",
                defaultValue: "",
                validate: (value) => {
                  const trimmed = (value || "").trim();
                  if (!trimmed) return undefined;
                  const bad = parseExtraOwnerEmails(trimmed).find(
                    (email) => !/^\S+@\S+\.\S+$/.test(email),
                  );
                  return bad ? `${bad} is not a valid email address` : undefined;
                },
              }),
            ),
          )
        : [];
    const config = deployConfigOf({
      accountId: account.id,
      domain,
      owner: primaryOwner,
      extraOwners,
      controlPlaneHostname: input.controlPlaneHostname,
      egressGateway: input.egressGateway,
      mailForwardTo: input.mailForwardTo,
      traceSampling: input.traceSampling,
      deployed: mind,
    });
    const { controlPlaneHostname } = config;
    // A PLAN CHANGES NOTHING: only over a mind that is there, whose account needs no step that
    // writes (each one below is skipped when this holds), and that has its id
    if (input.plan) {
      const missing = [
        ...(deployed ? [] : [`no mind is at ${domain}`]),
        ...(config.mindId ? [] : ["the mind has no id"]),
        ...(paid ? [] : ["Workers Paid is off"]),
        ...(r2 ? [] : ["R2 is off"]),
        ...(zeroTrust.next === "go" ? [] : ["Zero Trust is not set up"]),
        ...(resultOf(z.object({ subdomain: z.string().min(1) }), subdomain)
          ? []
          : ["the account has no workers.dev name"]),
      ];
      if (missing.length > 0)
        throw new Error(
          `--plan reads a mind that is there and changes nothing, and here ${missing.join(", ")}. A deploy comes first. Nothing was changed.`,
        );
    }
    // A new mind needs an ML-DSA-65 identity key: check before mutating the account or buying a domain.
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
      const forwardBefore = forwardOf(deployed.deployConfig?.mail);
      const forwardAfter = forwardOf(config.mail);
      const forwardWords = forwardAfter
        ? `${forwardAfter === forwardBefore ? "keeps forwarding" : "forwards"} each mail to ${forwardAfter}`
        : forwardBefore && `stops forwarding mail (was ${forwardBefore})`;
      const how = `${
        changes.length > 0 ? `with ${changes.join(" and ")}` : "with the same owners and hostname"
      }${forwardWords ? `; it ${forwardWords}` : ""}`;
      if (resuming && changes.length === 0 && forwardAfter === forwardBefore) {
        p.log.info(`Resuming the unfinished deploy of ${domain} (${how}).`);
      } else {
        if (
          !input.yes &&
          !(await ask<boolean>(`a mind is at ${domain} already; pass --yes to deploy over it`, () =>
            p.confirm({ message: `Deploy over it, ${how}?` }),
          ))
        )
          throw new Error("Nothing was changed.");
        p.log.info(`Deploying over it, ${how}.`);
      }
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
    let workersSubdomain =
      resultOf(z.object({ subdomain: z.string().min(1) }), subdomain)?.subdomain ?? "";
    if (!workersSubdomain) {
      let refusal = "";
      for (const candidate of [
        `iterate-${stageName}`,
        `iterate-${stageName}-${Math.random().toString(36).slice(2, 6)}`,
      ]) {
        const put = await cf("PUT", `/accounts/${account.id}/workers/subdomain`, {
          subdomain: candidate,
        });
        refusal = put.status === 200 ? "" : `${put.status}: ${put.error}`;
        workersSubdomain = candidate;
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
    if (seedReposEnvOf(ready.dir).ITERATE_SEED_REPOS)
      p.log.info(
        "A new mind starts with the repo /repos/onboarding: its onboarding page, guides and cards.",
      );
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const log = join(work, "deploy.log");
    writeFileSync(log, "");
    if (!paid) {
      await page(
        "Turn on Workers Paid: 5 dollars a month. Cloudflare asks for a card there.",
        `https://dash.cloudflare.com/${account.id}/workers/plans`,
      );
      await until(
        "Waiting for Workers Paid",
        async () => (await product("Workers Paid", paidPath)).on,
      );
    }
    if (!r2) {
      await page(
        "Turn on R2: it is free at this size.",
        `https://dash.cloudflare.com/${account.id}/r2/overview`,
      );
      await until("Waiting for R2", async () => (await product("R2", r2Path)).on);
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
      await page(zeroTrust.words, zeroTrust.page);
      await until(
        "Waiting for Zero Trust",
        async () => zeroTrustStep(account.id, await cf("GET", zeroTrustPath), true).next === "go",
      );
    }
    const zone = await zoneOf(cf, account.id, pick);
    p.log.success(`${c.domain(zone.name)} is active in the account.`);
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

    // A NEW MIND'S IDENTITY (./identity.ts), made right before the deploy: its key and its signed
    // genesis are on this computer before the script gets the id. A mind that has an id keeps it,
    // and this run signs nothing.
    const mindId =
      config.mindId || (await identityOfNewMind(controlPlaneHostname, Boolean(earlier?.leftover)));
    const deployedConfig = { ...config, mindId };
    writeFileSync(configFile, `${JSON.stringify(deployedConfig, null, 2)}\n`);
    access = await renewed();
    if (input.plan) {
      const plan = join(work, "plan.log");
      writeFileSync(plan, "");
      const planning = wait(`Planning the deploy of the mind at ${c.domain(controlPlaneHostname)}`);
      const run = {
        source: ready,
        stageName,
        config: configFile,
        token: access.token,
        log: plan,
        children,
      };
      for (const args of planArgsOf(stageName)) {
        const { code } = await deployOnce(run, args);
        if (code !== 0) {
          planning.fail(`The plan failed (exit ${code}).`);
          throw new Error(
            `The plan failed (exit ${code}). Its whole log: ${plan}. Nothing was changed.`,
          );
        }
      }
      planning.done(`The plan: ${plan}`);
      p.outro(`Nothing was changed. Done in ${seconds(began)}.`);
      return;
    }
    if (holdings) {
      const erased = await eraseHoldings(cf, zone.id);
      p.log.success(
        `Erased ${erased.records} DNS records and ${erased.routes} Workers routes of ${domain}.`,
      );
    }
    const deployBegan = Date.now();
    const deploying = wait(`Deploying the mind at ${c.domain(controlPlaneHostname)}`);
    const progress = createDeployProgress();
    // Keep Alchemy's verbose log in `deploy.log` only: in interactive terminals update the
    // single spinner line with concise resource progress; in non-interactive runs stay quiet
    // except for retry notices and a line each 30 seconds that says what is still being made
    // (tail of `deploy.log` is still printed on failure).
    const onDeployLine = (line: string) => {
      if (line.includes(ONE_MORE_TRY) || line.includes(WAITING_FOR_STORE)) {
        deploying.say(line);
        return;
      }
      const status = progress.onLine(line);
      if (status && interactive()) deploying.say(status);
    };
    const stillAt = setInterval(() => {
      const line = progress.stillAt();
      if (line) deploying.say(`${seconds(deployBegan)}: ${line}`);
    }, 30_000);
    writeFileSync(
      markerFile,
      `${JSON.stringify(
        {
          accountId: account.id,
          stageName,
          domain,
          mindId,
          firstDeploy: !deployed || Boolean(resuming?.firstDeploy),
        },
        null,
        2,
      )}\n`,
    );
    const { code, consumerNotSeen, storeNotServed } = await deployStack(
      {
        source: ready,
        stageName,
        storeAddress: stateStoreAddress(stageName, workersSubdomain),
        config: configFile,
        token: access.token,
        log,
        children,
        say: onDeployLine,
        adopt: Boolean(earlier || resuming),
      },
      deployOnce,
    ).finally(() => clearInterval(stillAt));
    if (code !== 0) {
      deploying.fail(`The deploy failed (exit ${code}).`);
      if (storeNotServed)
        throw new Error(
          `The mind's new state store is at ${storeNotServed}, and Cloudflare does not serve this address yet; run the command again in a few minutes. It goes on with this deploy's config. The deploy's whole log: ${log}.`,
        );
      console.log(readFileSync(log, "utf8").trimEnd().split("\n").slice(-40).join("\n"));
      throw new Error(
        `The deploy failed (exit ${code}). Its whole log: ${log}. A deploy keeps what it made: run the command again on this computer, and it goes on with this deploy's config.${consumerNotSeen ? " The queue may already have its consumer: run the command again." : ""}`,
      );
    }
    rmSync(markerFile, { force: true });
    deploying.done(`Deployed (${seconds(deployBegan)}). Full log: ${log.replace(homedir(), "~")}`);
    const boundary = `/accounts/${account.id}/workers/scripts/iterate-${stageName}-boundary/settings`;
    const checking = wait("Checking that the boundary Worker holds this deploy's config");
    const check = await boundaryCheck(() => cf("GET", boundary), deployedConfig, {
      say: checking.say,
    });
    if ("reads" in check)
      appendFileSync(
        log,
        `\nThe check's reads of the boundary Worker's settings after the deploy:\n${check.reads.join("\n")}\n`,
      );
    // A miss after the whole wait: Cloudflare was slower still, or another deploy of the mind ran
    // in between. A next run starts from the config that the boundary holds then and checks
    // again, so it mends the one and keeps the other's config. The command still ends every later
    // step (the mind's identity, its first sign-in) and then fails.
    const missed =
      "miss" in check
        ? `The deploy finished and the mind runs. But after ${duration(BOUNDARY_WAIT_MS)} of reads, its boundary Worker does not hold what this run deployed: ${check.miss}. Cloudflare may show a new Worker's settings late, or another deploy of this mind may have run since this one began. Run the command again in a few minutes: it starts from the config that the boundary Worker holds then, and checks again. If this message comes again, please report it to iterate with this message. Each read is in the deploy's log: ${log}`
        : undefined;
    if (missed) checking.fail(missed);
    else if ("unread" in check)
      checking.fail(
        `Could not read the boundary Worker's settings in ${duration(BOUNDARY_WAIT_MS)} (the last status ${check.unread}), so this run did not check that it holds the deploy's config. The deploy itself succeeded. Each read is in the deploy's log: ${log}`,
      );
    else {
      const forwardTo = forwardOf(config.mail);
      checking.done(
        forwardTo
          ? `The boundary holds this deploy's config, and forwards each mail to ${forwardTo}.`
          : "The boundary holds this deploy's config (no mail forward).",
      );
    }

    // NO PAGE IS OPENED UNTIL THE PAGES THAT THE BROWSER ASKS FIRST WORK FROM THIS COMPUTER
    // (`firstPagesOf`). A person may wait again as often as they like; with nobody there, or
    // after their no, the command still ends every later step, opens nothing and then fails.
    const isFirstDeploy = !deployed || Boolean(resuming?.firstDeploy);
    const primaryZone = config.cloudflare.zones[0] || domain;
    const setup = setupDestinationOf({
      controlPlaneHostname,
      zone: primaryZone,
      ownerEmails: config.ownerEmails,
      firstDeploy: isFirstDeploy,
    });
    const firstPages = firstPagesOf({
      controlPlaneHostname,
      zone: primaryZone,
      firstDeploy: isFirstDeploy,
    });
    const answersBegan = Date.now();
    let unanswered: string | undefined;
    for (;;) {
      const answering = wait(`Waiting for ${c.domain(controlPlaneHostname)} to answer steadily`);
      const answer = await firstPagesAnswer(firstPages, { say: answering.say });
      if ("answered" in answer) {
        answering.done(`The mind answers (${seconds(answersBegan)}).`);
        unanswered = undefined;
        break;
      }
      unanswered = `The deploy finished, but after ${seconds(answersBegan)} ${answer.fault}. A new domain's DNS records, certificate and routes can reach a computer late. Setup was not opened: open ${setup.url} once it loads in your browser, or run the command again, which deploys over the mind and checks again.`;
      answering.fail(`After ${seconds(answersBegan)}: ${answer.fault}.`);
      if (!interactive()) break;
      const again = await ask<boolean>("", () =>
        p.confirm({ message: `Wait ${duration(FIRST_PAGES_WAIT_MS)} more for it?` }),
      );
      if (!again) break;
    }

    await endAccess(access);
    const posted = await identityPublished({ mindId, controlPlaneHostname });
    p.log.success(
      deployed && !resuming?.firstDeploy
        ? `Your mind at ${c.domain(controlPlaneHostname)} is updated.`
        : `Your mind is deployed at ${c.domain(controlPlaneHostname)}.`,
    );
    p.log.info(`${c.callout("MindConfig:")}\n${formatMindConfigForStdout(deployedConfig)}`);
    const keyLine = identityKeyLineOf(keyFileOf(IDENTITIES, mindId), {
      gaveTheId: !config.mindId,
      posted,
    });
    if (keyLine) p.log.info(keyLine);
    // the pages that did not answer end the command non-zero, with setup's address and no open
    if (unanswered) throw new Error(unanswered);
    if (input.setup !== false) await page(setup.prompt, setup.url);
    else p.log.step(`${setup.prompt}\n${c.url(setup.url)}`);
    // the check's miss, said above, ends the command non-zero once every step is done
    if (missed) throw new Error(missed);
    p.outro(`Done in ${seconds(began)}.`);
  } catch (error) {
    // a stop is an expected end: its one line, with no stack, and a failed exit code
    for (const child of children) child.kill();
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro(`Stopped after ${seconds(began)}.`);
    // a kept sign-in that no longer works needs a person: its own exit code says so
    const ended =
      error instanceof SignInEnded ||
      (error instanceof Error && error.cause instanceof SignInEnded);
    process.exit(ended ? SIGN_IN_ENDED_EXIT : 1);
  }
}
