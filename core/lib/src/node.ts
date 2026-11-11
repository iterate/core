// node.ts — ONE NODE CLIENT FOR A PROJECT, addressed by its domain (iterate/project-api): what the
// `iterate` CLI and scripts use, and the token a home lab dials with (`projectToken`).
// `connectProject` answers the project's root `itx` over capnweb at `iterate.<address>/api`. A
// sign-in finds the project's issuer by discovery (iterate/oauth `discoverProject`), runs once (the
// loopback code flow with PKCE, or the device flow when the issuer offers it and there is no browser
// here), keeps the session per resource in the CLI's config directory (cli/config.ts, mode 600) and
// refreshes it. A token handed in, or ITERATE_PROJECT_TOKEN, replaces all of that and is used as it
// stands.
import { hostname } from "node:os";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { ResponseBodyError } from "oauth4webapi";
import WebSocket from "ws";
import type { IterateContextApi } from "./api.ts";
import { type DiscoveredProject, resolveProject } from "./client/oauth.ts";
import { startHeartbeat } from "./client/heartbeat.ts";
import { isCodingAgent } from "./cli/coding-agent.ts";
import { readSession, removeSession, writeSession, type StoredSession } from "./cli/config.ts";
import { loginFlowFor, type LoginFlow } from "./cli/device-login/flow.ts";
import { deviceLogin, showsColors } from "./cli/device-login/index.ts";
import { oauthLogin, refreshOAuthSession } from "./cli/oauth.ts";
import { withTimeout } from "./lib.ts";
import { projectAddressOf, projectApiUrlOf } from "./project-api.ts";

/** Where a line for the person goes: stderr, so stdout stays a command's answer. */
const printToStderr = (line: string) => console.error(line);

/** A TYPED ADDRESS AS A PROJECT'S (iterate/project-api `projectAddressOf`: lowercased, a scheme, a
 *  path and a trailing dot dropped), or an error that says why it is none. Every command and the
 *  home lab resolve an address here, so a session is stored and found under one spelling. */
export function addressOf(typed: string): string {
  const parsed = projectAddressOf(typed);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.address;
}

/** THE PROJECT AT A TYPED ADDRESS, `example.com` or `iterate.example.com` alike, as discovery
 *  finds it (iterate/oauth `resolveProject`). */
export async function discoverAddress(typed: string): Promise<DiscoveredProject> {
  const found = await resolveProject(addressOf(typed));
  if ("error" in found) throw new Error(found.error);
  return found;
}

/** How a sign-in reaches the person: the flow (cli/device-login/flow.ts `loginFlowFor` when not
 *  given), where its lines go, and how a browser opens the authorization URL. */
export type SignInOptions = {
  flow?: LoginFlow;
  print?: (line: string) => void;
  openBrowser?: (url: URL) => void | Promise<void>;
};

/** SIGN IN to `project`'s issuer for `resource` and store the session. The device flow when it is
 *  the flow for this process and the issuer offers it; else the loopback flow, whose URL is printed
 *  (an agent, or `ITERATE_SKIP_BROWSER_OPEN=1`, opens it itself). */
export async function signInToProject(
  project: DiscoveredProject,
  resource: string,
  options: SignInOptions = {},
): Promise<StoredSession> {
  const print = options.print || printToStderr;
  const flow = options.flow || loginFlowFor({ env: process.env, platform: process.platform });
  const device = flow === "device" && Boolean(project.endpoints.deviceAuthorization);
  print(`Signing in to ${project.address} at ${new URL(project.issuer).host}...`);
  const session = device
    ? await deviceLogin({
        project,
        resource,
        deviceName: `iterate CLI on ${hostname()}`,
        print,
        colors: showsColors(process.stderr.isTTY, process.env),
      })
    : await oauthLogin({
        project,
        resource,
        openBrowser: options.openBrowser || ((url) => openForSignIn(url, print)),
      });
  writeSession(resource, session);
  return session;
}

/** The authorization URL, printed, and opened in this computer's browser unless a coding agent
 *  runs this process or `ITERATE_SKIP_BROWSER_OPEN=1`. */
export async function openForSignIn(url: URL, print: (line: string) => void) {
  print(`\nOpen this page to sign in:\n\n  ${url.href}\n`);
  if (isCodingAgent(process.env) || process.env.ITERATE_SKIP_BROWSER_OPEN === "1") return;
  const { execFile } = await import("node:child_process");
  const { command, args } =
    process.platform === "darwin"
      ? { command: "open", args: [url.href] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url.href] }
        : { command: "xdg-open", args: [url.href] };
  execFile(command, args, (error) => {
    if (error) print(`Could not open a browser (${error.message}): open the URL above yourself.`);
  });
}

/** A LIVE BEARER FOR `resource` of the project at `address`: `token`, else ITERATE_PROJECT_TOKEN,
 *  else the stored session, refreshed when it ends within the minute. With none, or one the issuer
 *  refuses to refresh, a sign-in when `signIn` allows it; else an error that says how to sign in. */
export async function projectToken(input: {
  address: string;
  resource: string;
  token?: string;
  /** false: never sign in, fail instead (a script, the smoke check) */
  signIn?: SignInOptions | false;
}): Promise<string> {
  const fixed = input.token || process.env.ITERATE_PROJECT_TOKEN?.trim();
  if (fixed) return fixed;
  const { resource } = input;
  const stored = readSession(resource);
  if (stored && !endsWithinTheMinute(stored)) return stored.token;
  if (stored?.refreshToken) {
    try {
      const refreshed = await refreshOAuthSession({ resource, session: stored });
      writeSession(resource, refreshed);
      return refreshed.token;
    } catch (error) {
      // Only the issuer's `invalid_grant` says the grant ended, and then nothing is worth keeping
      // (cli/oauth.ts `tokenResponse` carries the issuer's error as the cause). A timeout or a 5xx
      // is passing: the session stays, and the caller hears of the failure.
      const refusal = error instanceof Error ? error.cause : undefined;
      const ended = refusal instanceof ResponseBodyError && refusal.error === "invalid_grant";
      if (!ended) throw error;
      removeSession(resource);
      if (input.signIn === false) throw error;
    }
  }
  if (input.signIn === false)
    throw new Error(`Not signed in to ${input.address}. Run \`iterate login ${input.address}\`.`);
  const project = await discoverAddress(input.address);
  return (await signInToProject(project, resource, input.signIn)).token;
}

const endsWithinTheMinute = (session: StoredSession) => {
  if (!session.expiresAt) return false;
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000;
};

/** The project's root context, as capnweb hands it: pipelined, and disposable. */
export type ProjectItx = RpcStub<IterateContextApi>;

/** One connection to a project's API. Dispose it to close every capability and its socket.
 *  Operations are never retried: replaying a script could duplicate its effects. */
export type ProjectConnection = Disposable & {
  /** the project's address */
  address: string;
  itx: ProjectItx;
  closed: Promise<{ code: number; reason: string }>;
};

/** CONNECT TO THE PROJECT AT `address`: a bearer for its API (`projectToken`), a WebSocket to
 *  `iterate.<address>/api` with the bearer on the upgrade request, where ingress checks it and
 *  stamps the caller, and the session's root, the project's `itx` as that caller. A refused bearer
 *  is a 401 on the upgrade, before any socket. A heartbeat ends a connection whose peer stopped
 *  answering. */
// Explicit return type keeps declaration emit from expanding capnweb's recursive mapped types.
export async function connectProject(input: {
  address: string;
  token?: string;
  signIn?: SignInOptions | false;
  /** the heartbeat's timing — a test's, client/heartbeat.ts `HEARTBEAT` otherwise */
  heartbeat?: { intervalMs: number; deadAfterMs: number };
}): Promise<ProjectConnection> {
  const address = addressOf(input.address);
  const resource = projectApiUrlOf(address);
  const token = await projectToken({ address, resource, token: input.token, signIn: input.signIn });
  const socket = new WebSocket(resource.replace(/^http/, "ws"), {
    handshakeTimeout: 15_000,
    headers: { authorization: `Bearer ${token}` },
  });
  // ws implements the DOM event/send/close interface consumed by capnweb.
  const itx = newWebSocketRpcSession<IterateContextApi>(socket as unknown as globalThis.WebSocket);
  let dead = "";
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: dead || reason.toString() }));
  });
  // The transport surfaces failures through RPC and `closed`; ws also emits an EventEmitter error.
  socket.on("error", () => {});
  try {
    // the first call proves the socket and the bearer
    await withTimeout(Promise.resolve(itx.whoami()), 20_000, `Connecting to ${address}`);
    const heartbeat = startHeartbeat({
      beat: () => itx.whoami(),
      onDead: (reason) => {
        dead = reason;
        socket.terminate();
      },
      timing: input.heartbeat,
    });
    void closed.then(() => heartbeat.stop());
    return {
      address,
      itx,
      closed,
      [Symbol.dispose]() {
        try {
          itx[Symbol.dispose]();
        } finally {
          socket.close();
        }
      },
    };
  } catch (error) {
    try {
      itx[Symbol.dispose]();
    } finally {
      socket.terminate();
    }
    throw error;
  }
}
