// config.ts — WHAT THE CLI KEEPS ON DISK, in its config directory (`$XDG_CONFIG_HOME/iterate`, else
// `~/.config/iterate`): `config.json`, the profiles, each naming one project by its address
// (iterate/project-api), the default profile and the folders mapped to one; and `sessions.json`,
// the sign-ins, one per OAuth resource a token is for (a project's API, its `/provide`). Both are
// written mode 600 in a folder of mode 700. The Node client (../node.ts) reads and refreshes the
// sessions.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config"),
  "iterate",
);

// A file of its own: `config.json` is the CLI's on `main`, whose profiles (a server URL and a
// session each) this shape would drop on its first write.
export const CONFIG_PATH = join(CONFIG_DIR, "projects.json");
const SESSIONS_PATH = join(CONFIG_DIR, "sessions.json");
/** The profile `iterate login` writes when none is named. */
export const DEFAULT_CONFIG_NAME = "default";

/** A named profile: the project it talks to, by address. */
export const Config = z.object({ project: z.string().optional() });
export type Config = z.infer<typeof Config>;

/** The config file on disk. */
const ConfigFile = z.object({
  configs: z.record(z.string(), Config).optional(),
  default: z.string().optional(),
  /** Maps an absolute directory path to a profile name */
  workspaces: z.record(z.string(), z.string()).optional(),
});
type ConfigFile = z.infer<typeof ConfigFile>;

/** One sign-in: the issuer's token endpoint it refreshes at, the client it registered as, and its
 *  tokens. `expiresAt` is ISO. */
export const StoredSession = z.object({
  issuer: z.string(),
  tokenEndpoint: z.string(),
  revocationEndpoint: z.string().optional(),
  clientId: z.string(),
  token: z.string(),
  refreshToken: z.string().optional(),
  scope: z.string().optional(),
  expiresAt: z.string().optional(),
});
export type StoredSession = z.infer<typeof StoredSession>;

/** The sessions file: one session per resource URL. */
const SessionsFile = z.record(z.string(), StoredSession);

/** `path` as JSON of `schema`, or `{}` when there is none; a file that does not parse throws. */
function readJson<T>(path: string, schema: z.ZodType<T>): T | Record<string, never> {
  if (!existsSync(path)) return {};
  try {
    return schema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${path}: ${detail}`);
  }
}

/** Write `value` to `path`, mode 600 in a folder of mode 700. A file that existed keeps its mode
 *  through `writeFileSync`, so the mode is set again. */
function writeJson(path: string, value: unknown) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export const readConfigFile = (): ConfigFile => readJson(CONFIG_PATH, ConfigFile);

export const writeConfigFile = (configFile: ConfigFile): void => {
  const parsed = ConfigFile.safeParse(configFile);
  if (!parsed.success) throw new Error(`Invalid config file: ${z.prettifyError(parsed.error)}`);
  writeJson(CONFIG_PATH, parsed.data);
};

/** A named profile, or an Error naming what is wrong. The default profile exists empty. */
export function readConfig(name: string): Config | Error {
  const raw = readConfigFile().configs?.[name] ?? (name === DEFAULT_CONFIG_NAME ? {} : undefined);
  if (!raw) return new Error(`Profile "${name}" not found in ${CONFIG_PATH}`);
  return Config.parse(raw);
}

/** Point the profile `name` at `project`. */
export function setConfigProject(name: string, project: string) {
  const configFile = readConfigFile();
  configFile.configs ||= {};
  configFile.configs[name] = { ...configFile.configs[name], project };
  writeConfigFile(configFile);
}

/** The stored sign-in for `resource`, or null. */
export function readSession(resource: string): StoredSession | null {
  return readJson(SESSIONS_PATH, SessionsFile)[resource] ?? null;
}

export function writeSession(resource: string, session: StoredSession) {
  writeJson(SESSIONS_PATH, { ...readJson(SESSIONS_PATH, SessionsFile), [resource]: session });
}

export function removeSession(resource: string) {
  const sessions = readJson(SESSIONS_PATH, SessionsFile);
  if (!(resource in sessions)) return;
  delete sessions[resource];
  writeJson(SESSIONS_PATH, sessions);
}
