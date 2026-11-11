import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { platformOriginOf } from "iterate/mind-api";
import { base64url, fromBase64url, keyIdOf, signedP256, statementText } from "iterate/signed";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    paths: { type: "string", default: "/smoke/" },
    path: { type: "string", default: "/smoke/statement" },
    type: { type: "string", default: "events.iterate.com/test/statement-signed" },
    mind: { type: "string" },
    twice: { type: "boolean", default: false },
  },
});
const [command, file, domain] = positionals;

if (command === "keygen" && file) {
  const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
  const publicKey = base64url(
    new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
  );
  const privateKey = base64url(
    new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  );
  await writeFile(file, JSON.stringify({ publicKey, privateKey }), { mode: 0o600, flag: "wx" });
  console.log(
    `key ${await keyIdOf(publicKey)} kept in ${file}; its entry in the config's auth.keys:`,
  );
  const entry = {
    actor: "smoke",
    publicKey,
    label: "Smoke test key",
    paths: values.paths.split(","),
  };
  console.log(JSON.stringify(entry, null, 2));
} else if (command === "send" && file && domain) {
  const kept = JSON.parse(await readFile(file, "utf8")) as {
    publicKey: string;
    privateKey: string;
  };
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64url(kept.privateKey),
    P256,
    false,
    ["sign"],
  );
  const at = Date.now();
  const statement = statementText({
    mind: values.mind || domain,
    path: values.path,
    type: values.type,
    payload: { smoke: true },
    at,
    expires: at + 5 * 60 * 1000,
  });
  const envelope = await signedP256(statement, privateKey, await keyIdOf(kept.publicKey));
  for (let attempt = 0; attempt < (values.twice ? 2 : 1); attempt++) {
    const response = await fetch(`${platformOriginOf(domain)}/statements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    console.log(response.status, await response.text());
  }
} else {
  console.error(
    "usage: signed-statement.ts keygen <key-file> [--paths /a/,/b/]\n" +
      "       signed-statement.ts send <key-file> <domain> [--path p] [--type t] [--mind d] [--twice]",
  );
  process.exitCode = 2;
}
