// bridge-key.ts — `iterate provide <file> --key <key file>`: A BRIDGE WITH A KEY OF ITS OWN. A
// person's sign-in acts as that person, and a bridge should lend one capability and nothing else.
// So the bridge makes a P-256 key pair once and keeps the private half in a file. A member of the
// mind allows the key once, on the mind's own page, for one capability name. From then on the key
// signs a statement and gets a token for the mind's API that lives an hour
// (core/auth-worker/src/key-tokens.ts), each time `provide` connects. The key has no end date: a
// member ends it on `iterate.<mind>/keys`.
//
// THE PRIVATE KEY IS A FILE (mode 600). Whoever can read the file is the bridge. `signer` below is
// the one place that touches it: a TPM, a Secure Enclave or the OS keychain would take its place
// there, with a key that never leaves the hardware, and nothing else here would change.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { platformOriginOf } from "../mind-api.ts";
import {
  base64url,
  type Envelope,
  KEY_TOKEN_PATH,
  KEY_TOKEN_STATEMENT_TYPE,
  keyIdOf,
  signedP256,
  type Statement,
  STATEMENTS_PATH,
  statementText,
} from "../signed.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
/** How long the first run waits for a member to allow the key. */
const APPROVAL_WAIT_MS = 15 * 60_000;

/** A bridge's key: its id and public half, and `sign`, which makes a statement's envelope. */
export type BridgeKey = {
  key: string;
  publicKey: string;
  sign(fields: Pick<Statement, "mind" | "path" | "type" | "payload">): Promise<Envelope>;
};

/** The key in `file`, made on the first run. The file holds the private key as a JWK. */
export async function bridgeKeyOf(file: string): Promise<BridgeKey> {
  const path = resolve(file);
  if (!existsSync(path)) {
    const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)), {
      mode: 0o600,
    });
    // `mode` above is cut by the umask on some systems: this is not
    chmodSync(path, 0o600);
  }
  return signer(JSON.parse(readFileSync(path, "utf8")) as JsonWebKey);
}

async function signer(jwk: JsonWebKey): Promise<BridgeKey> {
  const privateKey = await crypto.subtle.importKey("jwk", jwk, P256, false, ["sign"]);
  const { kty, crv, x, y } = jwk;
  const open = await crypto.subtle.importKey("jwk", { kty, crv, x, y }, P256, true, ["verify"]);
  const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey("spki", open)));
  const key = await keyIdOf(publicKey);
  return {
    key,
    publicKey,
    sign: (fields) => {
      const at = Date.now();
      // a minute: the mind takes a token's statement that ends within five
      const statement = statementText({ ...fields, at, expires: at + 60_000 });
      return signedP256(statement, privateKey, key);
    },
  };
}

/** The page where a member allows the key: it may lend `itx.<name>`, and add events under `paths`
 *  when it names some (under `/integrations/` alone: the mind's rule for a key allowed by a link). */
export function enrolUrlOf(input: {
  address: string;
  name: string;
  publicKey: string;
  paths?: string[];
}): string {
  const query = new URLSearchParams({
    // a service's name on the mind: lowercase letters, digits and hyphens
    actor: `bridge-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 63),
    label: `${input.name} on ${hostname()}`.slice(0, 100),
    publicKey: input.publicKey,
    provide: input.name,
    ...(input.paths?.length && { paths: input.paths.join(",") }),
  });
  return `${platformOriginOf(input.address)}/keys/enrol?${query}`;
}

/** One ask for a token. `seconds` asks for less than the hour (a test's). */
async function askForToken(input: {
  address: string;
  key: BridgeKey;
  seconds?: number;
}): Promise<{ token: string; provide: string } | { refused: string; why: string }> {
  const envelope = await input.key.sign({
    mind: input.address,
    path: "/",
    type: KEY_TOKEN_STATEMENT_TYPE,
    ...(input.seconds && { payload: { seconds: input.seconds } }),
  });
  const answer = await fetch(`${platformOriginOf(input.address)}${KEY_TOKEN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await answer.json().catch(() => ({}))) as {
    access_token?: string;
    provide?: string;
    error?: string;
    error_description?: string;
  };
  if (answer.ok && body.access_token && body.provide)
    return { token: body.access_token, provide: body.provide };
  return {
    refused: body.error || `HTTP ${answer.status}`,
    why: body.error_description || "the mind gave no reason",
  };
}

/** A TOKEN FOR THE BRIDGE at `address`, to lend `itx.<name>`. A key the mind does not know yet is
 *  not an error on the first run (`wait`): the link to allow it is printed once, and this asks
 *  again until a member has allowed it. Later a refusal is the answer: the key was removed. */
export async function bridgeToken(input: {
  address: string;
  name: string;
  key: BridgeKey;
  paths?: string[];
  seconds?: number;
  /** wait for a member to allow the key, and print the link with this */
  wait?: (line: string) => void;
  /** a test's timing */
  timing?: { waitMs: number; askEveryMs: number };
}): Promise<string> {
  const { waitMs, askEveryMs } = input.timing || { waitMs: APPROVAL_WAIT_MS, askEveryMs: 5_000 };
  const link = enrolUrlOf({ ...input, publicKey: input.key.publicKey });
  const waitUntil = Date.now() + waitMs;
  for (let asked = false; ; asked = true) {
    const answer = await askForToken(input);
    if ("token" in answer) {
      if (answer.provide !== input.name)
        throw new Error(
          `This key was allowed to lend itx.${answer.provide}, not itx.${input.name}. Use --name ${answer.provide}, or another key file.`,
        );
      return answer.token;
    }
    if (answer.refused !== "invalid_client" && answer.refused !== "invalid_scope")
      throw new Error(`The mind gave this bridge's key no token: ${answer.why}.`);
    if (!input.wait)
      throw new Error(
        `This bridge's key is not allowed on ${input.address}: ${answer.why}. A member allows it at ${link}`,
      );
    if (!asked)
      input.wait(
        `This bridge's key is not allowed on ${input.address} yet. A member of the mind opens this link and presses Allow:\n\n  ${link}\n\nWaiting for that...`,
      );
    if (Date.now() + askEveryMs > waitUntil)
      throw new Error(`Nobody allowed this bridge's key in time. Open ${link} and run this again.`);
    await new Promise((resolved) => setTimeout(resolved, askEveryMs));
  }
}

/** `append` for the bridge's file: one event at `path`, as a statement the key signs. It lands
 *  with the key as its signer, under the paths a member allowed the key and nowhere else. */
export const bridgeAppend =
  (address: string, key: BridgeKey) =>
  async (path: string, event: { type: string; payload?: Record<string, unknown> }) => {
    const envelope = await key.sign({ mind: address, path, ...event });
    const answer = await fetch(`${platformOriginOf(address)}${STATEMENTS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(20_000),
    });
    if (answer.ok) return;
    const { refused } = (await answer.json().catch(() => ({}))) as { refused?: string };
    throw new Error(`The mind did not take the event at ${path}: ${refused || answer.status}`);
  };
