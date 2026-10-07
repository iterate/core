import { isCodingAgent } from "../coding-agent.ts";

/** `browser`: the loopback login (oauth.ts `oauthLogin`); `device`: index.ts `deviceLogin`. */
export type LoginFlow = "browser" | "device";

/** The flow for this process (README "Login without a browser"). A coding agent gets the device
 *  flow because the person who opens its printed URL may be on another machine, where a redirect
 *  to this machine's localhost fails. A TTY says nothing: an agent has none, even on a laptop. */
export function loginFlowFor(input: {
  device?: boolean;
  env: Record<string, string | undefined>;
  platform: string;
}): LoginFlow {
  if (input.device !== undefined) return input.device ? "device" : "browser";
  const { env } = input;
  if (env.ITERATE_LOGIN_FLOW === "browser" || env.ITERATE_LOGIN_FLOW === "device")
    return env.ITERATE_LOGIN_FLOW;
  if (env.SSH_CONNECTION) return "device";
  if (input.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return "device";
  if (isCodingAgent(env)) return "device";
  return "browser";
}

/** Why a new session must not be kept, or null: it signed in someone else than `expected`
 *  (`--expect-user`). Emails compare as the platform stores them: trimmed and lower-cased. */
export function unexpectedUser(signedInAs: string | undefined, expected: string | undefined) {
  if (!expected) return null;
  const normalize = (email: string) => email.trim().toLowerCase();
  if (signedInAs && normalize(signedInAs) === normalize(expected)) return null;
  return `This sign-in is ${signedInAs || "an account with no email"}, not ${expected}. It was ended and not saved.`;
}
