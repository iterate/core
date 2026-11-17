// sandbox-tools/session-key.ts — HOW A SESSION'S SANDBOX PROVES ITSELF to its kind's host on the
// mind (the socket, and the mind tools' `/mcp`), for every kind of sandbox session.
//
// The sandbox holds one header value of two parts, `<signature>.<placeholder>`:
//   - the SIGNATURE is the HMAC of the session's path under the kind's signing secret: which
//     session this is. Another session's sandbox does not have it.
//   - the PLACEHOLDER is `getSecret("<the kind's egress secret>")`. The sandbox never has that
//     secret's value. The mind's egress puts it in on the way out, and only toward the origin the
//     secret is pinned to, the kind's own host: the request came out of this mind's egress.
// The host wants both, and that the session's sandbox runs: only a host in it could be asking.
//
// WHAT THIS CLOSES: an agent that is talked into sending its environment out. What leaves is a
// signature and a placeholder, which open nothing from anywhere else, then or later.
// WHAT IT DOES NOT: the agent itself, inside its sandbox, can call what the key opens; that is the
// key's purpose. And the egress fills the placeholder for every sandbox of the mind, so a
// signature that leaked to ANOTHER sandbox of the same mind opens this session while its own
// sandbox runs. And while a session's sandbox runs, a stranger with its leaked signature can
// send wrong second parts: 20 in a minute shut the kind's sessions out for the rest of that minute
// (the vault's limit on wrong guesses, `isSessionKey`).
import type { IterateContextApi } from "iterate/api";

/** A kind's two secrets, by path. */
export type SessionKeys = {
  /** Signs each session's path, in the vault. */
  signing: string;
  /** What the egress adds. Another secret than `signing`: its value reaches the kind's host in a
   *  header, and whoever read it there could not sign a session with it. */
  egress: string;
};

/** What a session's sandbox is given as its key. */
export async function sessionKeyFor(
  itx: Pick<IterateContextApi, "secrets">,
  keys: SessionKeys,
  session: string,
) {
  return `${await itx.secrets.signHmac(keys.signing, { payload: session })}.getSecret(${JSON.stringify(keys.egress)})`;
}

/** Whether `presented` is `session`'s own key, come through this mind's egress, while the
 *  session's sandbox (`box`) runs. Nothing is started by asking. */
export async function isSessionKey(
  itx: Pick<IterateContextApi, "secrets" | "sandboxes">,
  keys: SessionKeys,
  { session, box, presented }: { session: string; box: string; presented: string | null },
) {
  const [signature, added] = splitOnce(presented || "");
  if (!signature || !added) return false;
  // A vault that does not answer, or refuses, is a no: the caller answers 401, not an error.
  const no = () => false;
  if (!(await itx.secrets.verifyHmac(keys.signing, { payload: session, signature }).catch(no)))
    return false;
  // A sandbox that is stopped, or deleted, has no host in it. Read BEFORE the equal check: the
  // vault shuts a secret's equal check for the rest of a minute after 20 wrong values, and the
  // egress secret is one for every session of the kind. So only a signature whose sandbox runs
  // now can spend those guesses, and a signature of a session that is over can spend none.
  if (!(await Promise.resolve(itx.sandboxes.get(box).container.running).catch(no))) return false;
  return await itx.secrets.verifyEquals(keys.egress, { value: added }).catch(no);
}

/** `value` at its first dot: a signature has none, and the secret's value may. */
function splitOnce(value: string): [string, string] {
  const at = value.indexOf(".");
  return at < 0 ? [value, ""] : [value.slice(0, at), value.slice(at + 1)];
}

/** Both secrets, each made once: random, and made for the operations asked of it. Neither value
 *  is ever read back. A secret answers only the operations it was made with, so one that was made
 *  without them is made again; that ends every key made under it. */
export async function ensureSecrets(
  itx: Pick<IterateContextApi, "secrets">,
  keys: SessionKeys,
  origin: string,
) {
  await ensure(
    itx,
    keys.signing,
    () => itx.secrets.verifyHmac(keys.signing, { payload: "", signature: "00" }),
    { urls: [origin], operations: ["signHmac", "verifyHmac"] },
  );
  // Described, not asked: an equal check that answers false is a wrong guess, and the vault shuts
  // the secret's equal check for the rest of a minute after 20 of them (`isSessionKey`). A publish
  // must spend none; `describe` is a read alone.
  await ensure(
    itx,
    keys.egress,
    async () => {
      // the vault's description of a secret that is set names its operations (iterate/workers
      // `SecretDescription`)
      const described: { set: boolean; operations?: string[] } = await itx.secrets.describe(
        keys.egress,
      );
      if (!described.set) throw Object.assign(new Error("not set"), { code: "SECRET_NOT_SET" });
      if (!described.operations?.includes("verifyEquals"))
        throw Object.assign(new Error("verifyEquals: was not made to answer it"), {
          code: "FORBIDDEN",
        });
    },
    { urls: [origin], operations: ["verifyEquals"] },
  );
}

async function ensure(
  itx: Pick<IterateContextApi, "secrets">,
  path: string,
  ask: () => Promise<unknown>,
  uses: { urls: string[]; operations: ("signHmac" | "verifyHmac" | "verifyEquals")[] },
) {
  // Asked, not read: the vault answers only for a secret that is set and was made for the
  // operation. Only those two refusals make a new secret. Any other (an error on the way) leaves
  // a working secret as it is: the next publish asks again.
  const refusal = await ask().then(
    () => undefined,
    (error: unknown) => error,
  );
  if (refusal === undefined) return;
  const said = refusal instanceof Error ? refusal.message : String(refusal);
  // the platform's error codes (core/lib `errorCode`), read here so this folder imports no code
  const code: unknown = Object(refusal).code;
  const absent =
    code === "SECRET_NOT_SET" || (code === "FORBIDDEN" && /was not made to answer/.test(said));
  if (!absent) {
    console.warn(`sandbox-tools: ${path} was not checked, and is kept: ${said}`);
    return;
  }
  const value = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  await itx.secrets.set(path, value, uses);
}
