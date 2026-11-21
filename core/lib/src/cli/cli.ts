// cli.ts — THE `iterate` CLI: sign in to a mind by its address, run scripts in it, and lend it
// what runs on this machine (a file's functions, a local port, this computer). A profile
// (./config.ts) names one mind; `--config <name>`, a folder mapped to a profile, the default
// profile, or the only one picks it, and `--mind <address>` overrides it for one command. Every
// connection is the Node client's (../node.ts `connectMind`).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { text as streamText } from "node:stream/consumers";
import { dirname, join } from "node:path";
import process from "node:process";
import repl from "node:repl";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RpcTarget } from "capnweb";
import { createCli, os, yamlTableConsoleLogger } from "trpc-cli";
import { z } from "zod";
import { addressOf, connectMind, discoveredMind, openForSignIn, signInToMind } from "../node.ts";
import { mindApiUrlOf, mindMcpUrlOf, mindProvideConnectResourceOf } from "../mind-api.ts";
import { connectChatgpt } from "./chatgpt.ts";
import { isCodingAgent } from "./coding-agent.ts";
import {
  endKeptSignIn,
  KeptSignIn,
  keptSignInOf,
  lockKept,
  parsed,
  SIGN_IN_FILE,
  tokensMadeThrough,
  writeKeptSignIn,
} from "./cloudflare-access.ts";
import { deployMind } from "./deploy.ts";
import { IDENTITIES, type IdentityIo, postIdentity, shownIdentity } from "./identity.ts";
import { recoverOwner } from "./recover.ts";
import { runFs } from "./fs.ts";
import { loginFlowFor, unexpectedUser } from "./device-login/flow.ts";
import { revokeSession } from "./oauth.ts";
import { bridgeAppend, bridgeKeyOf, bridgeToken } from "./bridge-key.ts";
import { importProvidedFile, nameOfFile, type ProvidedFile, runProvide } from "./provide.ts";
import { finalStateOf, type ProvideState } from "./provide-state.ts";
import { runTunnel } from "./tunnel.ts";
import { shareMyComputer } from "./share-my-computer.ts";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG_NAME,
  readConfig,
  readConfigFile,
  readSession,
  removeSession,
  setConfigMind,
  writeConfigFile,
} from "./config.ts";

const isAgent = isCodingAgent(process.env);
let configFlagOverride: string | undefined;
const consumeCliStringFlag = (flagName: string): string | undefined => {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf(flagName);
  if (flagIndex === -1) return undefined;
  const value = args[flagIndex + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flagName} requires a value`);
  process.argv.splice(flagIndex + 2, 2);
  return value;
};

/**
 * Which profile to use. Priority: --config flag > workspace match (walk up from cwd) > default >
 * the only profile > `default`.
 */
const resolveConfigName = (workspacePath: string): string => {
  const configFile = readConfigFile();
  const known = (name: string) =>
    name === DEFAULT_CONFIG_NAME || Boolean(configFile.configs?.[name]);
  const available = () => Object.keys(configFile.configs || {}).join(", ") || "(none)";
  if (configFlagOverride) {
    if (!known(configFlagOverride))
      throw new Error(`Profile "${configFlagOverride}" not found. Available: ${available()}`);
    return configFlagOverride;
  }
  for (let dir = workspacePath; dir && dir !== "/"; dir = dirname(dir)) {
    const match = configFile.workspaces?.[dir];
    if (!match) continue;
    if (!known(match))
      throw new Error(`Workspace "${dir}" maps to profile "${match}", which doesn't exist.`);
    return match;
  }
  if (configFile.default) {
    if (!known(configFile.default))
      throw new Error(
        `Default profile "${configFile.default}" doesn't exist. Available: ${available()}`,
      );
    return configFile.default;
  }
  const names = Object.keys(configFile.configs || {});
  return names.length === 1 ? names[0]! : DEFAULT_CONFIG_NAME;
};

/** THE MIND A COMMAND TALKS TO, AS ITS ADDRESS: `--mind` as a person typed it, read here once
 *  (node.ts `addressOf`) and as discovery keeps it; else the profile's, which `login` stored.
 *  What this answers is handed on as it is: a second reading would put `iterate.` before a
 *  control plane at a zone's apex. */
const resolveMind = async (given?: string): Promise<string> => {
  if (given) return (await discoveredMind(addressOf(given))).address;
  // In a sandbox the platform names the mind (iterate/mind-api `sandboxVariablesOf`): no profile
  // is needed there. `--config` still picks a profile.
  const told = process.env.ITERATE_SANDBOX?.trim() && process.env.ITERATE_MIND?.trim();
  if (told && !configFlagOverride) return addressOf(told);
  const name = resolveConfigName(process.cwd());
  const config = readConfig(name);
  if (config instanceof Error) throw config;
  if (!config.mind)
    throw new Error(
      `Profile "${name}" names no mind. Run \`iterate login <address>\`, e.g. iterate login example.com.`,
    );
  return config.mind;
};

/** A connection to the mind at `address`, as `resolveMind` answered it. */
const connect = (address: string) => connectMind({ address });

/** When the stored sign-in to the mind at `address` ends, as epoch ms: what a lend hands over
 *  before (provide.ts, THE HANDOVER). A token given in the environment has no end known here. */
function signInEndsAt(address: string): number | undefined {
  if (process.env.ITERATE_MIND_TOKEN?.trim()) return undefined;
  const ends = Date.parse(readSession(mindApiUrlOf(address))?.expiresAt || "");
  return Number.isFinite(ends) ? ends : undefined;
}

/** `iterate provide`'s lend, with a sign-in or (`key`) the bridge's own key, until Ctrl-C. */
async function provideWith(input: {
  address: string;
  file: ProvidedFile;
  name: string;
  key?: string;
  paths?: string;
  report?: (state: ProvideState) => void;
}) {
  const { address, file, name, report } = input;
  if (!input.key) {
    // runProvide owns the connection from here, and every one `reconnect` opens
    await runProvide({
      connection: await connect(address),
      reconnect: () => connect(address),
      file,
      name,
      endsAt: () => signInEndsAt(address),
      report,
    });
    return;
  }
  // THE BRIDGE'S OWN KEY (bridge-key.ts): each connection asks for a new token, which lives
  // an hour. The first waits for a member to allow the key. A later one does not: a key that
  // a member removed is refused, and the bridge says so and ends.
  const key = await bridgeKeyOf(input.key);
  const paths = input.paths?.split(",").map((path) => path.trim());
  // ITERATE_KEY_TOKEN_SECONDS: a test's, to see a token end without waiting an hour
  const seconds = Number(process.env.ITERATE_KEY_TOKEN_SECONDS) || undefined;
  let tokenEndsAt = 0;
  const connectWithKey = async (wait?: (line: string) => void) => {
    const token = await bridgeToken({ address, name, key, paths, seconds, wait, report });
    // a key's token lives the hour, or the seconds asked for
    tokenEndsAt = Date.now() + (seconds || 3600) * 1000;
    return connectMind({ address, token, signIn: false });
  };
  await runProvide({
    connection: await connectWithKey((line) => console.error(line)),
    reconnect: () => connectWithKey(),
    file,
    name,
    append: bridgeAppend(address, key),
    endsAt: () => tokenEndsAt,
    report,
  });
}

/** `iterate login`: sign in to the mind at `address` (as `addressOf` read it from what a person
 *  typed), check who that is, and make it the profile's mind. `chatgpt connect` signs in by this
 *  too. */
const login = async (input: { address: string; device?: boolean; expectUser?: string }) => {
  const mind = await discoveredMind(input.address);
  const resource = mindApiUrlOf(mind.address);
  const session = await signInToMind(mind, resource, {
    flow: loginFlowFor({ device: input.device, env: process.env, platform: process.platform }),
  });
  using connection = await connectMind({ address: mind.address, token: session.token });
  const who = await connection.itx.whoami();
  const unexpected = unexpectedUser(who.principal?.email, input.expectUser);
  if (unexpected) {
    removeSession(resource);
    await revokeSession(session).catch(() => {});
    throw new Error(unexpected);
  }
  const name = resolveConfigName(process.cwd());
  setConfigMind(name, mind.address);
  return {
    message: `Signed in to ${mind.address} as ${who.principal?.email || who.principal?.actor || "someone the mind does not name"}`,
    profile: name,
    expiresAt: session.expiresAt,
  };
};

const mindOption = z
  .string()
  .optional()
  .describe("The mind's address, e.g. example.com (default: the profile's)");

/** The same, as a command's one argument. */
const mindArgument = mindOption.meta({ positional: true });

/** THE ADDRESS THAT THE TWO `identity` COMMANDS ASK: `--mind` as a person typed it, read here
 *  alone, with no discovery (no other host is asked first), else the profile's. */
const identityAddressOf = async (given?: string) => (given ? addressOf(given) : resolveMind());

/** How the two `identity` commands talk with the mind (identity.ts). */
const identityIo: IdentityIo = {
  dir: IDENTITIES,
  fetcher: (request) => fetch(request),
  pause: (ms) => sleep(ms),
  say: (line) => console.error(line),
};

const launcherProcedures = {
  deploy: os
    .input(
      z.object({
        domain: z
          .string()
          .optional()
          .describe("The mind's domain: a zone of the account, or one to buy or bring"),
        account: z.string().optional().describe("The Cloudflare account, by id or name"),
        newAccount: z.boolean().optional().describe("Make a new Cloudflare account for the mind"),
        owner: z
          .string()
          .optional()
          .describe(
            "The owner's email address (default: the Cloudflare login's; for a mind that is there already: the owners it has)",
          ),
        controlPlaneHostname: z
          .string()
          .optional()
          .describe(
            "Where the mind's sign-in, API and MCP server answer: the domain itself, or one label under it (default: iterate.<domain>; for a mind that is there already: the one it has)",
          ),
        egressGateway: z
          .string()
          .optional()
          .describe(
            "The stack's egress gateway: a Worker of the account, by name, that carries what the mind's itx.fetch sends out of the stack, each request with its secret in. It is trusted as the vault is. `none` takes it away (default: none; for a mind that is there already: what it has)",
          ),
        mailForwardTo: z
          .string()
          .optional()
          .describe(
            "Forward each mail to the mind there as it arrived, a verified destination address of the account's Email Routing; none stops it (default: none; for a mind that is there already: the one it has)",
          ),
        buy: z
          .boolean()
          .optional()
          .describe("Buy the domain at Cloudflare's price without a question"),
        yes: z
          .boolean()
          .optional()
          .describe(
            "Answer yes to the other questions: a domain you bring, a deploy over a mind that is there already",
          ),
        eraseRecords: z
          .boolean()
          .optional()
          .describe(
            "A domain of the account that is in use: erase every DNS record and Workers route on it without a question",
          ),
        source: z
          .string()
          .optional()
          .describe(
            "A checkout of iterate's core to deploy from (default: the one this runs in, else iterate/core's main)",
          ),
        ref: z.string().optional().describe("A branch or commit of iterate/core to deploy"),
        plan: z
          .boolean()
          .optional()
          .describe(
            "Change nothing: over a mind that is there already, write the stack's plan (Alchemy's, of each resource: noop, update, create, delete) to plan.log beside the deploy's config, with the same sign-in, source and config as a deploy",
          ),
        setup: z
          .boolean()
          .default(true)
          .meta({ negatable: true })
          .describe(
            "With a person at the terminal, after the deploy: wait for Enter and open https://onboarding.<zone>/ in the browser to continue setup",
          ),
      }),
    )
    .meta({
      description:
        "Deploy a mind into your own Cloudflare account, at its own domain: sign in at Cloudflare, choose the account and the domain, and the stack is deployed from this computer. A mind that is there already is deployed over, with its own config",
    })
    .handler(async ({ input }) => deployMind(input)),
  recover: os
    .input(
      z.object({
        domain: z.string().describe("A domain of the mind"),
        owner: z.string().describe("The email address of the owner who has no passkey left"),
        yes: z.boolean().optional().describe("Revoke and make the link without a question"),
      }),
    )
    .meta({
      description:
        "For an owner with no passkey left, run by whoever holds the mind's Cloudflare account: sign in at Cloudflare, revoke that owner's passkeys, and print a link that signs the owner in once to add a new one",
    })
    .handler(async ({ input }) => recoverOwner(input)),
  // A KEPT SIGN-IN AT CLOUDFLARE (cloudflare-access.ts): `iterate deploy` with nobody at
  // Cloudflare's page, by the same sign-in as a person's. The sign-in goes to a file or to a secret
  // store through a pipe, never through a flag's value, which stays in the shell's history.
  cloudflare: {
    signIn: os
      .input(
        z.object({
          file: z.string().optional().describe("Keep the sign-in in this new file, mode 600"),
          print: z
            .boolean()
            .optional()
            .describe(
              "Print the sign-in as one JSON document on standard output, for a pipe into a secret store (e.g. | doppler secrets set NAME > /dev/null, since doppler prints the value it sets); the page and the code go to standard error",
            ),
        }),
      )
      .meta({
        description: `Sign in at Cloudflare for \`iterate deploy\` with nobody at Cloudflare's page: the deploy's scopes and offline_access. A deploy uses it with ${SIGN_IN_FILE}=<file>, and rewrites the file at each renewal`,
      })
      .handler(async ({ input }) => {
        if (Boolean(input.file) === Boolean(input.print))
          throw new Error("Say where the sign-in goes: --file <path>, or --print.");
        if (input.print && process.stdout.isTTY)
          throw new Error(
            "--print writes the sign-in's tokens to standard output: pipe it into a secret store, or use --file.",
          );
        if (input.file && existsSync(input.file))
          throw new Error(
            `${input.file} is there already. Sign out of the sign-in in it first (iterate cloudflare sign-out --file ${input.file}), or choose another path.`,
          );
        const kept = await keptSignInOf(({ url, code, minutes }) =>
          console.error(
            `Open this page, check that it shows the code ${code}, select ONLY the mind's account, and approve. The code works for ${minutes} minutes.\n\n  ${url.href}\n`,
          ),
        );
        if (!input.file) {
          process.stdout.write(`${JSON.stringify(kept)}\n`);
          return;
        }
        try {
          writeKeptSignIn(input.file, kept);
        } catch (error) {
          // a grant that nobody holds is ended
          await endKeptSignIn(kept);
          throw new Error(
            `The sign-in could not be written to ${input.file} (${error instanceof Error ? error.message : String(error)}), so it is revoked. Run the command again.`,
          );
        }
        return {
          message: `Kept in ${input.file} (mode 600). Deploy with ${SIGN_IN_FILE}=${input.file}. End it with iterate cloudflare sign-out --file ${input.file}.`,
        };
      }),
    signOut: os
      .input(
        z.object({
          file: z
            .string()
            .optional()
            .describe(
              "The file of the sign-in, deleted after the revocation (default: the sign-in's JSON on standard input)",
            ),
        }),
      )
      .meta({
        description:
          "Revoke a kept sign-in at Cloudflare (iterate cloudflare sign-in), and delete its file. A secret store's copy is yours to delete",
      })
      .handler(async ({ input }) => {
        if (!input.file && process.stdin.isTTY)
          throw new Error("Name the sign-in: --file <path>, or its JSON on standard input.");
        // a deploy that renews the sign-in while it is revoked would keep a live one in the file
        if (input.file) lockKept(input.file);
        const text = input.file
          ? readFileSync(input.file, "utf8")
          : await streamText(process.stdin);
        const kept = parsed(KeptSignIn, text);
        if (!kept)
          throw new Error(
            `${input.file || "Standard input"} holds no sign-in of iterate cloudflare sign-in.`,
          );
        // read before the revocation, while the access works: these tokens outlive it
        const made = await tokensMadeThrough(kept).catch(() => undefined);
        const refused = await endKeptSignIn(kept);
        if (refused.length > 0)
          throw new Error(
            `Cloudflare did not take the revocation (${refused.join("; ")}). Nothing is deleted. Run the command again.`,
          );
        if (input.file) rmSync(input.file, { force: true });
        const tokens = made
          ? made.length > 0
            ? `The API tokens that deploys made stay until you delete them: ${made.map((found) => `${found.tokens.join(", ")} in ${found.account} (${found.page})`).join("; ")}. Deleting them turns off the mind's telemetry until its next deploy.`
            : "Deploys made no API token in the accounts that it reached."
          : "Its access had ended, so the API tokens that deploys made were not listed: look for iterate-<stage>-telemetry-catalog and -analytics on each account's API tokens page. They stay until you delete them.";
        return {
          message: `Revoked at Cloudflare${input.file ? `, and ${input.file} is deleted` : ""}. ${tokens}`,
        };
      }),
  },
  identity: {
    show: os
      .input(z.object({ mind: mindArgument }))
      .meta({
        description:
          "The mind's id, the hostnames of its last identity record, how many records are on this computer and how many of them the mind publishes, and where its identity key is",
      })
      .handler(async ({ input }) => shownIdentity(await identityAddressOf(input.mind), identityIo)),
    post: os
      .input(z.object({ mind: mindArgument }))
      .meta({
        description:
          "Post the identity records on this computer that the mind does not publish yet, and the last one again, which makes the mind's stack deliver what it still owes its own log. Then, with the identity key on this computer, sign and post the record that lists the stack's key, when no record lists it yet: until then the mind signs nothing as itself. `iterate deploy` does this itself; this is for a post that failed",
      })
      .handler(async ({ input }) => {
        const address = await identityAddressOf(input.mind);
        const done = await postIdentity({ controlPlaneHostname: address }, identityIo);
        if (!done)
          return {
            message: `This computer holds no identity records of the mind at ${address}: the computer that first deployed it does.`,
          };
        const { mindId: mind, taken, here, published } = done;
        if (published === undefined)
          return {
            mind,
            message:
              "The mind publishes a record that is not on this computer, so nothing here continues its log. Nothing was posted.",
          };
        return {
          mind,
          message: [
            taken
              ? `The mind took ${taken} of the ${here} records on this computer.`
              : `The mind had the ${here} records on this computer, and took the last one again.`,
            published === here
              ? "Its published log shows them all."
              : `Its published log shows ${published} of them.`,
          ].join(" "),
        };
      }),
  },
  login: os
    .input(
      z.object({
        address: z
          .string()
          .meta({ positional: true })
          .describe("The mind's address, e.g. example.com"),
        device: z
          .boolean()
          .optional()
          .describe(
            "Approve from a browser on any device, when the mind's issuer offers it: the default over SSH, on Linux with no display, and under a coding agent",
          ),
        expectUser: z
          .string()
          .optional()
          .describe("Refuse and end a session for anyone but this email"),
      }),
    )
    .meta({ description: "Sign in to a mind and make it the profile's mind" })
    .handler(async ({ input }) => login({ ...input, address: addressOf(input.address) })),
  logout: os
    .input(z.object({ mind: mindOption }))
    .meta({
      description:
        "End this machine's sign-ins to the mind (for its API, and to hand in a mind that runs here) at its issuer, and forget them",
    })
    .handler(async ({ input }) => {
      const address = await resolveMind(input.mind);
      const ended: string[] = [];
      for (const resource of [mindApiUrlOf(address), mindProvideConnectResourceOf(address)]) {
        const session = readSession(resource);
        if (!session) continue;
        await revokeSession(session).catch((error: unknown) => {
          console.error(
            `Could not end the sign-in at the issuer (${error instanceof Error ? error.message : String(error)}); it is forgotten here.`,
          );
        });
        removeSession(resource);
        ended.push(resource);
      }
      return { message: ended.length ? `Signed out of ${address}` : `Not signed in to ${address}` };
    }),
  whoami: os
    .input(z.object({ mind: mindOption }))
    .meta({ description: "Who the mind says you are, and where" })
    .handler(async ({ input }) => {
      using connection = await connect(await resolveMind(input.mind));
      return { mind: connection.address, ...(await connection.itx.whoami()) };
    }),
  repl: os
    .input(
      z.object({
        mind: mindOption,
        context: z.string().default("/").describe("Context path within the mind"),
      }),
    )
    .meta({ description: "Open a local Node REPL with itx and RpcTarget in scope" })
    .handler(async ({ input }) => {
      using connection = await connect(await resolveMind(input.mind));
      using context = await connection.itx.cd(input.context);
      console.error(
        `Connected to ${connection.address}, context ${input.context}. Use .exit to quit.`,
      );
      // capnweb identifies built-ins by prototype. Evaluate in this process's
      // realm so objects and argument arrays use the transport's constructors.
      const server = repl.start({ prompt: "itx> ", useGlobal: true });
      const initialize = () => {
        server.context.itx = context;
        server.context.RpcTarget = RpcTarget;
      };
      initialize();
      server.on("reset", initialize);
      try {
        const outcome = await Promise.race([
          new Promise<"exit">((resolve) => server.once("exit", () => resolve("exit"))),
          connection.closed,
        ]);
        if (outcome !== "exit") {
          throw new Error(
            `REPL disconnected (${outcome.code}: ${outcome.reason || "connection closed"}). Start a new REPL to reconnect.`,
          );
        }
      } finally {
        server.close();
      }
    }),
  itx: {
    run: os
      .input(
        z
          .object({
            mind: mindOption,
            context: z.string().default("/").describe("Context path within the mind"),
            eval: z
              .string()
              .optional()
              .describe("Script body with itx in scope; use return for the result"),
            file: z
              .string()
              .optional()
              .describe("Read the script from a UTF-8 file; - reads stdin"),
          })
          .refine(
            (input) => Boolean(input.eval) !== Boolean(input.file),
            "Specify exactly one of --eval or --file",
          ),
      )
      .meta({ description: "Run an itx script once in the mind" })
      .handler(async ({ input }) => {
        let script = input.eval;
        if (input.file === "-") {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
          script = Buffer.concat(chunks).toString("utf8");
        } else if (input.file) script = await readFile(input.file, "utf8");
        using connection = await connect(await resolveMind(input.mind));
        using context = await connection.itx.cd(input.context);
        return await context.run(`async (itx) => {\n${script}\n}`);
      }),
  },
  mcp: {
    claude: os
      .input(
        z.object({
          mind: mindOption,
          exec: z.boolean().optional().describe("Run the command instead of printing it"),
        }),
      )
      .meta({
        description:
          "The command that adds the mind's MCP server to Claude Code: printed, or run with --exec. Claude Code then signs in with the mind's issuer (/mcp in Claude Code)",
      })
      .handler(async ({ input }) => {
        const argv = claudeMcpAddArgs(mindMcpUrlOf(await resolveMind(input.mind)));
        if (!input.exec) {
          // stdout carries the command alone, so `eval "$(iterate mcp claude)"` runs it
          console.log(shellCommand(["claude", ...argv]));
          return;
        }
        const claude = spawnSync("claude", argv, { stdio: "inherit" });
        if (claude.error)
          throw new Error(`Could not start claude: ${claude.error.message}`, {
            cause: claude.error,
          });
        process.exit(claude.status ?? 1);
      }),
  },
  chatgpt: {
    connect: os
      .input(
        z.object({
          address: z
            .string()
            .optional()
            .meta({ positional: true })
            .describe("The mind's address, e.g. example.com (default: the profile's)"),
          test: z
            .boolean()
            .default(true)
            .meta({ negatable: true })
            .describe("Send one Responses request on the plan after the sign-in"),
        }),
      )
      .meta({
        description:
          "Connect a personal ChatGPT Plus or Pro plan to the mind: sign in with ChatGPT in this computer's browser, on 127.0.0.1:1455; the mind gets the tokens and keeps them",
      })
      .handler(async ({ input }) => {
        const address = await resolveMind(input.address);
        // a first-time user runs this one command: no sign-in here is `iterate login` first
        if (!process.env.ITERATE_MIND_TOKEN?.trim() && !readSession(mindApiUrlOf(address)))
          console.error((await login({ address })).message);
        using connection = await connect(address);
        return await connectChatgpt({
          itx: connection.itx,
          address: connection.address,
          test: input.test,
          print: (line) => console.error(line),
          openBrowser: (url) => openForSignIn(url, (line) => console.error(line)),
        });
      }),
  },
  useMyComputer: os
    .input(
      z.object({
        mind: mindOption,
        name: z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9]*$/)
          .optional()
          .describe("Computer capability name, e.g. jonasComputer"),
      }),
    )
    .meta({
      description:
        "Share this computer with a mind until Ctrl-C: run commands and read and write files (on a Mac, native dialogs and Swift too). The same as `iterate provide` of use-my-computer.ts",
    })
    .handler(async ({ input }) => {
      const address = await resolveMind(input.mind);
      // shareMyComputer owns the connection from here, and every one `reconnect` opens
      await shareMyComputer({
        connection: await connect(address),
        reconnect: () => connect(address),
        endsAt: () => signInEndsAt(address),
        name: input.name,
      });
    }),
  tunnel: os
    .input(
      z.object({
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .meta({ positional: true })
          .describe("The local port to serve, e.g. Vite's 5173"),
        name: z
          .string()
          .optional()
          .describe(
            "The tunnel's name: the tunnel is at <name>.<the mind's first zone> (default: a random one)",
          ),
        hostname: z
          .string()
          .optional()
          .describe(
            "Serve on this hostname of the mind instead of the name's, e.g. hello.tunnels.example.com",
          ),
        public: z
          .boolean()
          .optional()
          .describe("Anyone may use it (default: signed-in visitors only)"),
        mind: mindOption,
      }),
    )
    .meta({
      description: "Serve a local port on a mind host until Ctrl-C, WebSockets included",
    })
    .handler(async ({ input }) => {
      const address = await resolveMind(input.mind);
      // runTunnel owns the connection from here, and every one `reconnect` opens
      await runTunnel({
        connection: await connect(address),
        reconnect: () => connect(address),
        port: input.port,
        tunnelName: input.name,
        hostname: input.hostname,
        public: input.public,
      });
    }),
  provide: os
    .input(
      z.object({
        file: z
          .string()
          .meta({ positional: true })
          .describe(
            "A .ts, .mjs or .js file whose default export, ({ itx }) => ({ someFunction() {} }), answers the functions to lend",
          ),
        name: z
          .string()
          .optional()
          .describe(
            "The capability's name, itx.<name> (default: the file's, whatsapp.ts → whatsapp)",
          ),
        key: z
          .string()
          .optional()
          .describe(
            "A file for this bridge's own key, made on the first run: a member allows it once at the link printed, and the bridge then connects with no sign-in, for as long as the key is allowed",
          ),
        paths: z
          .string()
          .optional()
          .describe(
            "With --key: where the key may also add events, comma-separated, under /integrations/ (e.g. /integrations/whatsapp/)",
          ),
        json: z
          .boolean()
          .optional()
          .describe(
            "Print one JSON object per line on stdout at each change of state (connecting, live, reconnecting, notAllowed, incompatible, stopped), for a program that keeps the lend; the human lines stay on stderr",
          ),
        mind: mindOption,
      }),
    )
    .meta({
      description:
        "Lend a local file's functions to a mind as itx.<name> until Ctrl-C; the file's folder installs its own dependencies",
    })
    .handler(async ({ input }) => {
      // --json: one state per line on stdout (provide-state.ts), the last one as it ends
      const report = input.json
        ? (state: ProvideState) => process.stdout.write(`${JSON.stringify(state)}\n`)
        : undefined;
      try {
        // the file first: a missing dependency is the answer before any sign-in
        const file = await importProvidedFile(input.file);
        const name = input.name || nameOfFile(input.file);
        const address = await resolveMind(input.mind);
        report?.({ state: "connecting", mind: address, name: `itx.${name}` });
        await provideWith({ address, file, name, key: input.key, paths: input.paths, report });
        report?.({ state: "stopped", why: "stopped by Ctrl-C or a signal" });
      } catch (error) {
        report?.(finalStateOf(error));
        throw error;
      }
    }),
  config: {
    get: os
      .input(z.object({}))
      .meta({ default: true, description: "Show the profile in use, its mind and its sign-in" })
      .handler(async () => {
        const name = resolveConfigName(process.cwd());
        const config = readConfig(name);
        if (config instanceof Error) return { configPath: CONFIG_PATH, error: config.message };
        const session = config.mind ? readSession(mindApiUrlOf(config.mind)) : null;
        return {
          configPath: CONFIG_PATH,
          profile: name,
          mind: config.mind,
          signedIn: session ? { issuer: session.issuer, expiresAt: session.expiresAt } : false,
        };
      }),
    list: os
      .input(z.object({}))
      .meta({ description: "List the profiles" })
      .handler(async () => {
        const configFile = readConfigFile();
        const current = resolveConfigName(process.cwd());
        return {
          profiles: Object.fromEntries(
            Object.entries(configFile.configs || {}).map(([name, config]) => [
              name,
              { mind: config.mind, active: name === current ? true : undefined },
            ]),
          ),
          default: configFile.default,
        };
      }),
    set: os
      .input(
        z.object({
          name: z.string().describe("Profile name"),
          mind: z.string().optional().describe("The mind's address, e.g. example.com"),
          setDefault: z.boolean().optional().describe("Make it the default profile"),
          setWorkspace: z.boolean().optional().describe("Map the current folder to this profile"),
        }),
      )
      .meta({ description: "Create or change a profile" })
      .handler(async ({ input }) => {
        const configFile = readConfigFile();
        configFile.configs ||= {};
        configFile.configs[input.name] ||= {};
        if (input.mind) configFile.configs[input.name]!.mind = addressOf(input.mind);
        if (input.setDefault) configFile.default = input.name;
        if (input.setWorkspace) {
          configFile.workspaces ||= {};
          configFile.workspaces[process.cwd()] = input.name;
        }
        writeConfigFile(configFile);
        return { configPath: CONFIG_PATH, profile: configFile.configs[input.name] };
      }),
    use: os
      .input(
        z.object({
          name: z.string().meta({ positional: true }).describe("Profile to make the default"),
        }),
      )
      .meta({ description: "Set the default profile" })
      .handler(async ({ input }) => {
        const configFile = readConfigFile();
        if (input.name !== DEFAULT_CONFIG_NAME && !configFile.configs?.[input.name])
          throw new Error(`Profile "${input.name}" not found.`);
        configFile.default = input.name;
        writeConfigFile(configFile);
        return { default: input.name };
      }),
  },
};

const PackageVersion = z.object({ version: z.string().min(1) });

/** Reads this CLI package's `version` from the nearest `package.json` above `fromUrl`
 *  (works identically from `src/cli/cli.ts` and the built `dist/cli.mjs`). */
export function packageVersionOf(fromUrl: string = import.meta.url): string {
  for (let dir = dirname(fileURLToPath(fromUrl)); ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const parsed = PackageVersion.safeParse(JSON.parse(readFileSync(manifest, "utf8")));
      if (parsed.success) return parsed.data.version;
    }
    const parent = dirname(dir);
    if (parent === dir) return "0.0.0";
  }
}

export const runCli = async () => {
  // the machine's own files, no sign-in and no flags of ours (fs.ts); a sandbox runs the same file alone
  if (process.argv[2] === "fs") {
    process.exitCode = await runFs(process.argv.slice(3), process);
    return;
  }
  configFlagOverride = consumeCliStringFlag("--config");
  if (process.argv.length === 2) process.argv.push("--help");
  if (process.argv.length === 3 && process.argv[2] === "-v") process.argv[2] = "--version";
  const cli = createCli({
    router: launcherProcedures,
    name: "iterate",
    version: packageVersionOf(),
    description:
      "The iterate CLI: sign in to a mind by its address, run itx scripts in it, and lend it what runs on this machine.",
  });
  // trpc-cli's built-in prompts ask for a missing input, but only a person at a terminal
  await cli.run({
    prompts: !isAgent && process.stdin.isTTY && process.stdout.isTTY,
    logger: yamlTableConsoleLogger,
  });
};

/** Claude Code's arguments that add one HTTP MCP server named `iterate` at `mcpUrl`
 *  (https://code.claude.com/docs/en/mcp). It signs in itself: the server's protected-resource
 *  metadata names the mind's issuer. */
export const claudeMcpAddArgs = (mcpUrl: string) => [
  "mcp",
  "add",
  "--transport",
  "http",
  "iterate",
  mcpUrl,
];

/** POSIX-shell-quoted: plain words bare, anything else single-quoted with `'` spelled `'\''`. */
export const shellCommand = (argv: string[]) =>
  argv
    .map((arg) => (/^[\w./:@%+=,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(" ");
