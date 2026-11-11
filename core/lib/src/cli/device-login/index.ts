// THE DEVICE SIGN-IN (RFC 8628) on oauth4webapi, for an issuer that offers it
// (`device_authorization_endpoint` in its metadata): no listener, no browser on this computer.
import * as oauth from "oauth4webapi";
import { encode, renderUnicodeCompact } from "uqr";
import { authorizationServerOf, type DiscoveredMind } from "../../client/oauth.ts";
import type { StoredSession } from "../config.ts";
import { registerClient, requestOptions, sessionFromTokens } from "../oauth.ts";
import { pollUntilAnswered, type PollAnswer } from "./poll.ts";

/** Sign in to `mind`'s issuer from a browser on any device, for `resource`: the person opens the
 *  printed page, checks the code, and approves. `deviceName` is the registration's `client_name`,
 *  which that page shows. `print` writes a line for the person, or the agent that relays it;
 *  `colors` says whether the person sees its colors (`showsColors`). */
export async function deviceLogin(input: {
  mind: DiscoveredMind;
  resource: string;
  deviceName: string;
  print: (line: string) => void;
  colors: boolean;
}): Promise<StoredSession> {
  const { mind, resource } = input;
  const issuer = mind.issuer;
  if (!mind.endpoints.deviceAuthorization)
    throw new Error(`${new URL(issuer).host} does not offer the device sign-in.`);
  const as = authorizationServerOf(mind);
  const client = await registerClient(mind, {
    client_name: input.deviceName,
    token_endpoint_auth_method: "none",
    grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  });
  const device = await oauth.processDeviceAuthorizationResponse(
    as,
    client,
    await oauth.deviceAuthorizationRequest(
      as,
      client,
      oauth.None(),
      { scope: "iterate", resource },
      requestOptions(issuer),
    ),
  );
  const expiresInSeconds = Math.min(device.expires_in, 300);
  // the page and the link on lines of their own, so a terminal or an agent's transcript copies them
  input.print("\nTo sign in, open this page in a browser on any device:\n");
  input.print(`  ${device.verification_uri}\n`);
  input.print(`and enter the code:  ${device.user_code}\n`);
  if (device.verification_uri_complete) {
    input.print("Or scan this QR code, or open the link under it. Both fill in the code:\n");
    input.print(`${terminalQrCode(device.verification_uri_complete, input.colors)}\n`);
    input.print(`  ${device.verification_uri_complete}\n`);
  }
  input.print(
    `The code expires in ${Math.round(expiresInSeconds / 60)} minutes. Waiting for approval...`,
  );
  const answer = await pollUntilAnswered({
    intervalSeconds: device.interval || 5,
    deadline: Date.now() + expiresInSeconds * 1000,
    poll: () => pollOnce(as, client, issuer, device.device_code, resource),
    onRetry: (reason, waitMs) =>
      input.print(`Could not reach ${issuer} (${reason}); trying again in ${waitMs / 1000} s.`),
  });
  return sessionFromTokens(answer.tokens, mind, client.client_id, answer.started);
}

/** `text` as a QR code for a phone's camera (uqr, https://github.com/unjs/uqr, error correction L),
 *  indented two spaces.
 *
 *  With `colors`, as `qrencode -t ANSI` draws it: a module is two spaces on a background color,
 *  black (40) or bright white (107; 47 first, for a terminal without bright colors). So dark is
 *  dark and light is light in any theme, and the colors fill each line to the next, whatever the
 *  line height. The quiet zone is two modules: the spec's four would take 84 columns.
 *
 *  Without colors (a pipe, an agent's transcript): Unicode half blocks in the text color, two
 *  modules a character, with a four-module quiet zone. They scan in a dark terminal whose lines
 *  touch; space between lines cuts through them, so the link under the code is the fallback. */
function terminalQrCode(text: string, colors: boolean) {
  if (!colors)
    return renderUnicodeCompact(text, { ecc: "L", border: 4 })
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
  return encode(text, { ecc: "L", border: 2 })
    .data.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""))
    .map((row) => {
      const cells = row.replace(
        /1+|0+/g,
        (run) => `\u001b[${run[0] === "1" ? "40" : "47;107"}m${"  ".repeat(run.length)}`,
      );
      // a reset at the end of every line, so a line that wraps or is cut never colors the next
      return `  ${cells}\u001b[0m`;
    })
    .join("\n");
}

/** Whether the person sees the colors written to a stream: a terminal (`isTTY`) that is not
 *  `TERM=dumb`, and no `NO_COLOR` (https://no-color.org). `FORCE_COLOR` decides first, as in Node:
 *  `0` or `false` is no colors, any other value is colors. */
export function showsColors(isTTY: boolean | undefined, env: Record<string, string | undefined>) {
  if (env.FORCE_COLOR) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  return isTTY === true && !env.NO_COLOR && env.TERM !== "dumb";
}

/** One poll, read for `pollUntilAnswered`: no answer at all, or a 5xx, is worth trying again. */
async function pollOnce(
  as: oauth.AuthorizationServer,
  client: oauth.Client,
  issuer: string,
  deviceCode: string,
  resource: string,
): Promise<PollAnswer<{ tokens: oauth.TokenEndpointResponse; started: number }>> {
  const started = Date.now();
  try {
    const tokens = await oauth.processDeviceCodeResponse(
      as,
      client,
      await oauth.deviceCodeGrantRequest(as, client, oauth.None(), deviceCode, {
        ...requestOptions(issuer),
        additionalParameters: { resource },
      }),
    );
    return { kind: "tokens", value: { tokens, started } };
  } catch (error) {
    if (error instanceof oauth.ResponseBodyError) {
      if (error.status >= 500)
        return { kind: "transient", reason: `${error.status} ${error.error}` };
      if (error.error === "authorization_pending") return { kind: "pending" };
      if (error.error === "slow_down") return { kind: "slow-down" };
      return { kind: "refused", error: error.error, description: error.error_description };
    }
    // a 5xx whose body is no OAuth error (the edge's 503) is no conform answer to oauth4webapi
    if (
      error instanceof oauth.OperationProcessingError &&
      error.cause instanceof Response &&
      error.cause.status >= 500
    )
      return { kind: "transient", reason: String(error.cause.status) };
    // fetch's network failure (a TypeError; oauth4webapi's own TypeErrors carry a `code`), or the
    // request's own timeout (`requestOptions`)
    const networkFailure = error instanceof TypeError && !("code" in error);
    if (networkFailure || (error instanceof Error && error.name === "TimeoutError"))
      return { kind: "transient", reason: error.message };
    throw error;
  }
}
