// config.ts — WHAT THE CLI KEEPS ON DISK, in its config directory (`$XDG_CONFIG_HOME/iterate`, else
// `~/.config/iterate`): `config.json`, the profiles, each naming one mind by its address
// (iterate/mind-api), the default profile and the folders mapped to one; and `sessions.json`,
// the sign-ins, one per OAuth resource a token is for (a mind's API, the right to hand in a mind
// that runs elsewhere). Both are written mode 600 in a folder of mode 700. The Node client
// (../node.ts) reads and refreshes the sessions.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

export const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config"),
  "iterate",
);

// A file of its own: `config.json` is the CLI's on `main`, whose profiles (a server URL and a
// session each) this shape would drop on its first write.
export const CONFIG_PATH = join(CONFIG_DIR, "minds.json");
const SESSIONS_PATH = join(CONFIG_DIR, "sessions.json");
/** The profile `iterate login` writes when none is named. */
export const DEFAULT_CONFIG_NAME = "default";

/** A named profile: the mind it talks to, by address. */
export const Config = z.object({ mind: z.string().optional() });
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

/** Point the profile `name` at `mind`. */
export function setConfigMind(name: string, mind: string) {
  const configFile = readConfigFile();
  configFile.configs ||= {};
  configFile.configs[name] = { ...configFile.configs[name], mind };
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

/** What the lock file holds, or "" when it is gone. */
const lockText = (lock: string) => {
  try {
    return readFileSync(lock, "utf8");
  } catch {
    return "";
  }
};

/** A renewal ends or fails within 30 seconds (oauth.ts `requestOptions`). A lock whose time is a
 *  minute from now, either way, is no renewal at work: its process stopped, or the clock moved. */
const SESSIONS_LOCK_STALE_MS = 60_000;

/** ONE PROCESS AT A TIME RENEWS A STORED SIGN-IN. The bridges on one computer share it, and a
 *  mind's issuer replaces the refresh token at each renewal. Two that renew at once each get one:
 *  the file keeps the one written last, the issuer the one it made last, and where those differ
 *  the next renewal is refused as `invalid_grant`, which signs every bridge out. The lock is
 *  `sessions.json.lock`, made only if it is not there; `work` reads the file again inside it.
 *  A stale lock is taken over, and at its end a process removes only its own. A process that has waited
 *  two stale times gives up, and its caller keeps the sign-in. A new sign-in, a sign-out and the
 *  removal of a refused sign-in write the file outside the lock. */
export async function withSessionsLock<T>(work: () => Promise<T>): Promise<T> {
  const lock = `${SESSIONS_PATH}.lock`;
  const mine = `${process.pid} ${randomUUID()}`;
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  for (const giveUpAt = Date.now() + 2 * SESSIONS_LOCK_STALE_MS; ; await sleep(50)) {
    try {
      writeFileSync(lock, mine, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const madeAt = statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
    if (madeAt !== undefined && Math.abs(Date.now() - madeAt) > SESSIONS_LOCK_STALE_MS)
      rmSync(lock, { force: true });
    else if (Date.now() > giveUpAt) throw new Error(`Could not take the lock ${lock}.`);
  }
  try {
    return await work();
  } finally {
    // not another process's, which took this one over as stale
    if (lockText(lock) === mine) rmSync(lock, { force: true });
  }
}
