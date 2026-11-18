// identity-log.ts — A MIND'S IDENTITY FOR A TEST: a root key made as the test runs, and a log of
// records that the key truly signs, so that a test of a reader or of an intake meets the real
// check (../mind-identity.ts `nextIdentity`) and never a stand-in for it.
import {
  identityHashOf,
  identityKeyIdOf,
  type IdentityRecord,
  identityRecordText,
  signIdentityRecord,
  type SignedRecord,
} from "../mind-identity.ts";
import { base64url } from "../signed.ts";

/** An ML-DSA-65 key as a record lists it (`entry`), with its id and a `sign` for a record's
 *  text. */
export async function newRootKey(label: string) {
  // WebCrypto's types answer a key or a pair for an algorithm they do not know by name, and
  // list no `raw-public` format yet; a signature algorithm makes a pair.
  const pair = (await crypto.subtle.generateKey({ name: "ML-DSA-65" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  // The Workers' types answer bytes or a JSON Web Key for any format: this one is bytes.
  const exported = (await crypto.subtle.exportKey(
    "raw-public" as "raw",
    pair.publicKey,
  )) as ArrayBuffer;
  const publicKey = base64url(new Uint8Array(exported));
  const id = await identityKeyIdOf(publicKey);
  return {
    entry: { signs: "raw", algorithm: "ML-DSA-65", publicKey, label } as const,
    id,
    sign: (text: string) => signIdentityRecord(text, pair.privateKey, id),
  };
}

/** A NEW MIND: one root key, threshold 1, and its signed genesis, which lists `hostnames`.
 *  `mind` is the id. `next(after, change)` is the signed record that follows `after`: the same
 *  identity with `change`, signed by `keys` (the root key when none are given). */
export async function newIdentityLog(hostnames = ["iterate.example.com"]) {
  const root = await newRootKey("laptop");
  const signedBy = async (
    record: IdentityRecord,
    keys: Awaited<ReturnType<typeof newRootKey>>[],
  ): Promise<SignedRecord> => {
    const text = identityRecordText(record);
    return { record: text, signatures: await Promise.all(keys.map((key) => key.sign(text))) };
  };
  const genesis = await signedBy(
    {
      version: 1,
      prev: null,
      nonce: base64url(crypto.getRandomValues(new Uint8Array(16))),
      rootKeys: [root.entry],
      threshold: 1,
      workingKeys: [],
      hostnames,
      alsoKnownAs: [],
    },
    [root],
  );
  return {
    mind: await identityHashOf(genesis.record),
    root,
    genesis,
    next: async (after: SignedRecord, change: Partial<IdentityRecord> = {}, keys = [root]) =>
      signedBy(
        {
          // the cast: `after.record` is a text that `signedBy` wrote from a record
          ...(JSON.parse(after.record) as IdentityRecord),
          nonce: undefined,
          prev: await identityHashOf(after.record),
          ...change,
        },
        keys,
      ),
  };
}
