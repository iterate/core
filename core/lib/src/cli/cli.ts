// cli.ts — THE `iterate` CLI: sign in to a mind by its address, run scripts in it, and lend it
// what runs on this machine (a file's functions, a local port, this computer). A profile
// (./config.ts) names one mind; `--config <name>`, a folder mapped to a profile, the default
// profile, or the only one picks it, and `--mind <address>` overrides it for one command. Every
// connection is the Node client's (../node.ts `connectMind`).
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import repl from "node:repl";
import { RpcTarget } from "capnweb";
import { createCli, os, yamlTableConsoleLogger } from "trpc-cli";
import { z } from "zod";
import { addressOf, connectMind, discoverAddress, openForSignIn, signInToMind } from "../node.ts";
import { mindApiUrlOf, mindMcpUrlOf, mindProvideUrlOf } from "../mind-api.ts";
import { connectChatgpt } from "./chatgpt.ts";
import { isCodingAgent } from "./coding-agent.ts";
import { runFs } from "./fs.ts";
import { loginFlowFor, unexpectedUser } from "./device-login/flow.ts";
import { revokeSession } from "./oauth.ts";
import { bridgeAppend, bridgeKeyOf, bridgeToken } from "./bridge-key.ts";
import { importProvidedFile, nameOfFile, runProvide } from "./provide.ts";
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

/** The mind a command talks to: `--mind` in either spelling, as discovery keeps it (as
 *  `login` stores the profile's), else the profile's. */
const resolveMind = async (given?: string): Promise<string> => {
  if (given) return (await discoverAddress(given)).address;
  const name = resolveConfigName(process.cwd());
  const config = readConfig(name);
  if (config instanceof Error) throw config;
  if (!config.mind)
    throw new Error(
      `Profile "${name}" names no mind. Run \`iterate login <address>\`, e.g. iterate login example.com.`,
    );
  return config.mind;
};

const connect = async (mind?: string) => connectMind({ address: await resolveMind(mind) });

/** `iterate login`: sign in to the mind at the typed address, check who that is, and make it the
 *  profile's mind. `chatgpt connect` signs in by this too. */
const login = async (input: { address: string; device?: boolean; expectUser?: string }) => {
  const mind = await discoverAddress(input.address);
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

const launcherProcedures = {
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
    .handler(async ({ input }) => login(input)),
  logout: os
    .input(z.object({ mind: mindOption }))
    .meta({
      description:
        "End this machine's sign-ins to the mind (its API and /provide) at its issuer, and forget them",
    })
    .handler(async ({ input }) => {
      const address = await resolveMind(input.mind);
      const ended: string[] = [];
      for (const resource of [mindApiUrlOf(address), mindProvideUrlOf(address)]) {
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
      using connection = await connect(input.mind);
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
      using connection = await connect(input.mind);
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
        using connection = await connect(input.mind);
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
            "The tunnel's name and routing slug: the tunnel is <name>.<address> (default: a random one)",
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
        mind: mindOption,
      }),
    )
    .meta({
      description:
        "Lend a local file's functions to a mind as itx.<name> until Ctrl-C; the file's folder installs its own dependencies",
    })
    .handler(async ({ input }) => {
      // the file first: a missing dependency is the answer before any sign-in
      const file = await importProvidedFile(input.file);
      const name = input.name || nameOfFile(input.file);
      const address = await resolveMind(input.mind);
      if (!input.key) {
        // runProvide owns the connection from here, and every one `reconnect` opens
        await runProvide({
          connection: await connect(address),
          reconnect: () => connect(address),
          file,
          name,
          // the stored sign-in's end; a token given in the environment has none known here
          endsAt: () => {
            if (process.env.ITERATE_MIND_TOKEN?.trim()) return undefined;
            const ends = Date.parse(readSession(mindApiUrlOf(address))?.expiresAt || "");
            return Number.isFinite(ends) ? ends : undefined;
          },
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
        const token = await bridgeToken({ address, name, key, paths, seconds, wait });
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
      });
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

export const runCli = async () => {
  // the machine's own files, no sign-in and no flags of ours (fs.ts); a sandbox runs the same file alone
  if (process.argv[2] === "fs") {
    process.exitCode = await runFs(process.argv.slice(3), process);
    return;
  }
  configFlagOverride = consumeCliStringFlag("--config");
  if (process.argv.length === 2) process.argv.push("--help");
  const cli = createCli({
    router: launcherProcedures,
    name: "iterate",
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
