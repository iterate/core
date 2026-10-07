// `deviceLogin` against a local stand-in for the platform's endpoints: what it registers, asks
// for, prints and polls with. The waits between polls are poll.test.ts's; the platform's side is
// test/vitest/os-workers/oauth-device.test.ts.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import jsQR from "jsqr";
import { expect, test } from "vitest";
import { deviceLogin, showsColors, terminalQrCode } from "./index.ts";

test("registers the platform's device callback, asks for iterate on /api with PKCE, prints the page and the code, and redeems with the verifier", async () => {
  await using issuer = await startDeviceIssuer({ answers: ["tokens"] });
  const printed: string[] = [];
  const session = await deviceLogin({
    issuer: issuer.url,
    deviceName: "iterate CLI on test-host",
    print: (line) => void printed.push(line),
    colors: false,
  });
  expect(session).toMatchObject({ token: "access-1", refreshToken: "refresh-1", scope: "iterate" });
  expect(printed.join("\n")).toContain(`  ${issuer.url}/oauth2/device\n`);
  expect(printed.join("\n")).toContain("and enter the code:  WDJB-MJHT");
  expect(printed.join("\n")).toContain(`  ${issuer.url}/oauth2/device?user_code=WDJB-MJHT\n`);
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exact requests: nothing beyond RFC 7591, RFC 8628, PKCE and RFC 8707 goes out
  expect(issuer.seen).toEqual({
    registration: {
      client_name: "iterate CLI on test-host",
      redirect_uris: [`${issuer.url}/oauth2/device/callback`],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    deviceAuthorization: {
      client_id: "cli-client",
      scope: "iterate",
      resource: `${issuer.url}/api`,
      code_challenge: expect.any(String),
      code_challenge_method: "S256",
    },
    token: [
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "cli-client",
        device_code: "the-device-code",
        code_verifier: expect.any(String),
        resource: `${issuer.url}/api`,
      },
    ],
  });
});

test("stops at a declined sign-in", async () => {
  await using issuer = await startDeviceIssuer({ answers: ["access_denied"] });
  await expect(
    deviceLogin({ issuer: issuer.url, deviceName: "test-host", print: () => {}, colors: false }),
  ).rejects.toThrow("Sign-in was declined.");
});

const link = "https://os.iterate.com/oauth2/device?user_code=WDJB-MJHT";

test("in a terminal with colors, the QR code is black and white cells a phone reads, at any line height", () => {
  // the escape character shown as `^`, as `cat -v` does
  const lines = terminalQrCode(link, true).replaceAll("\u001b", "^").split("\n");
  // two spaces a module, on black or bright white, and every line reset at its end
  const cell = /\^\[(40|47;107)m((?: {2})+)/gu;
  expect(
    lines.filter((line) => !/^ {2}(?:\^\[(?:40|47;107)m(?: {2})+)+\^\[0m$/u.test(line)),
  ).toEqual([]);
  const modules = lines.map((line) =>
    [...line.matchAll(cell)].flatMap(([, color, spaces]) =>
      Array<boolean>(spaces!.length / 2).fill(color === "40"),
    ),
  );
  // version 4 (33 modules) and a two-module quiet zone: 76 columns, 37 rows
  expect({ rows: modules.length, columns: modules[0]!.length * 2 + 2 }).toEqual({
    rows: 37,
    columns: 76,
  });
  expect(scan(modules)).toBe(link);
  // the background color fills the line height too, so a module is just taller
  expect(scan(modules, 1.3)).toBe(link);
});

test("without colors, the QR code is half blocks and spaces a phone reads in a dark terminal", () => {
  const text = terminalQrCode(link, false);
  // no ANSI escape, nor any character but the blocks, spaces and line breaks
  expect(text).toMatch(/^[ █▀▄\n]+$/u);
  // a block is lit in the text color, light on a dark background: two modules a character
  const modules = text.split("\n").flatMap((line) => {
    const chars = [...line.slice(2)];
    return [
      chars.map((char) => char !== "█" && char !== "▀"),
      chars.map((char) => char !== "█" && char !== "▄"),
    ];
  });
  expect(scan(modules)).toBe(link);
});

test.for([
  { name: "a terminal", isTTY: true, env: {}, colors: true },
  { name: "a pipe", isTTY: false, env: {}, colors: false },
  { name: "NO_COLOR", isTTY: true, env: { NO_COLOR: "1" }, colors: false },
  { name: "TERM=dumb", isTTY: true, env: { TERM: "dumb" }, colors: false },
  { name: "FORCE_COLOR in a pipe", isTTY: false, env: { FORCE_COLOR: "1" }, colors: true },
  { name: "FORCE_COLOR=0 in a terminal", isTTY: true, env: { FORCE_COLOR: "0" }, colors: false },
])("colors for $name: $colors", ({ isTTY, env, colors }) => {
  expect(showsColors(isTTY, env)).toBe(colors);
});

/** What a camera that refuses an inverted code reads (jsQR, `dontInvert`) off `modules` (true for
 *  dark), each 8 pixels wide and `height` times as tall, inside a dark terminal's background. */
function scan(modules: boolean[][], height = 1) {
  const margin = 4;
  const width = (modules[0]!.length + 2 * margin) * 8;
  const rows = Math.round((modules.length + 2 * margin) * 8 * height);
  const rgba = new Uint8ClampedArray(width * rows * 4);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < width; x++) {
      const dark = modules[Math.floor(y / (8 * height)) - margin]?.[Math.floor(x / 8) - margin];
      rgba.fill(dark === false ? 230 : 25, (y * width + x) * 4, (y * width + x) * 4 + 3);
      rgba[(y * width + x) * 4 + 3] = 255;
    }
  return jsQR(rgba, width, rows, { inversionAttempts: "dontInvert" })?.data;
}

/** A local issuer with the device login's endpoints. Its token endpoint gives the polls `answers`
 *  in turn: an OAuth error code, or `tokens`, sent only for the verifier of the device
 *  authorization's PKCE challenge. */
async function startDeviceIssuer(options: { answers: string[] }) {
  const seen: {
    registration?: Record<string, unknown>;
    deviceAuthorization?: Record<string, string>;
    token: Record<string, string>[];
  } = { token: [] };
  let url = "";
  const server = createServer(async (request, response) => {
    const path = new URL(request.url || "/", url);
    const body = await readBody(request);
    const json = (status: number, value: unknown) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (path.pathname === "/oauth2/register") {
      seen.registration = JSON.parse(body);
      json(201, { client_id: "cli-client", redirect_uris: seen.registration?.redirect_uris });
    } else if (path.pathname === "/oauth2/device_authorization") {
      seen.deviceAuthorization = Object.fromEntries(new URLSearchParams(body));
      const page = `${url}/oauth2/device`;
      json(200, {
        device_code: "the-device-code",
        user_code: "WDJB-MJHT",
        verification_uri: page,
        verification_uri_complete: `${page}?user_code=WDJB-MJHT`,
        expires_in: 300,
        interval: 5,
      });
    } else if (path.pathname === "/oauth2/token") {
      const form = new URLSearchParams(body);
      seen.token.push(Object.fromEntries(form));
      const answer = options.answers[seen.token.length - 1] ?? "authorization_pending";
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") || "")
        .digest("base64url");
      if (answer === "tokens" && challenge === seen.deviceAuthorization?.code_challenge)
        json(200, {
          access_token: "access-1",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "refresh-1",
          scope: "iterate",
        });
      else json(400, { error: answer, error_description: "refused" });
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    seen,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
