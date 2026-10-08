// secret-at-rest.ts — a project secret's material SEALED: AES-256-GCM under the deployment's key
// (`ITERATE__SECRETS_ENCRYPTION__KEY`, iterate-config.ts), the ciphertext BOUND to the one place it may be read
// back from — the secret's context (its Durable Object name: the project and the path), the pin it
// was sealed with, and a nonce minted for that one write (the additional authenticated data). The
// sealed cell rides the secret's facts (secret/contract.ts), so a backup of the log is the secret,
// and only a holder of the key reads it. A ciphertext copied into another context, under another
// pin, or presented as another write does not open. Rotation: `previous` opens what `current`
// cannot; the caller seals it again under `current` when told it happened, so a rotation completes
// one read at a time and the old key can be dropped once every live cell has been touched. Cells
// from before the facts carried them were bound to a write counter instead (`revision`); they open
// the same way, once, and are sealed again with a nonce.

import type { SecretMaterial } from "iterate/api";

/** What the facet stores in place of the material. */
export type EncryptedMaterial = {
  algorithm: "AES-256-GCM+SECRET-V1";
  /** base64, 12 bytes */
  iv: string;
  /** base64 */
  ciphertext: string;
};

/** Where a ciphertext is allowed to open: the secret's context (its Durable Object name), the pin,
 *  and the write — its nonce, or the counter a cell from before the facts carried them was bound
 *  to. */
export type MaterialBinding = { context: string; urls: string[] } & (
  | { nonce: string }
  | { revision: number }
);

/** The deployment's keys: any strings — the AES key is the SHA-256 of each. `previous` is set only
 *  while rotating. */
export type MaterialKeys = { current: string; previous?: string };

export async function encryptSecretMaterial(
  material: SecretMaterial,
  binding: MaterialBinding,
  keys: MaterialKeys,
): Promise<EncryptedMaterial> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalDataOf(binding) },
    await aesKeyOf(keys.current),
    new TextEncoder().encode(JSON.stringify(material)),
  );
  return {
    algorithm: "AES-256-GCM+SECRET-V1",
    iv: base64Of(iv),
    ciphertext: base64Of(new Uint8Array(ciphertext)),
  };
}

/** Open a ciphertext at its binding. `rotated` says the PREVIOUS key opened it — the caller writes it
 *  back under the current one. A ciphertext neither key opens, or one bound elsewhere, throws. */
export async function decryptSecretMaterial(
  encrypted: EncryptedMaterial,
  binding: MaterialBinding,
  keys: MaterialKeys,
): Promise<{ material: SecretMaterial; rotated: boolean }> {
  const open = async (key: string) =>
    crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytesOf(encrypted.iv),
        additionalData: additionalDataOf(binding),
      },
      await aesKeyOf(key),
      bytesOf(encrypted.ciphertext),
    );
  try {
    return {
      material: JSON.parse(new TextDecoder().decode(await open(keys.current))),
      rotated: false,
    };
  } catch (error) {
    if (!keys.previous) throw error;
    return {
      material: JSON.parse(new TextDecoder().decode(await open(keys.previous))),
      rotated: true,
    };
  }
}

/** The binding as bytes: a fixed tag and version, then the fields in one order (the pin sorted, so
 *  the same set of origins in any spelling is the same binding). Copied into a plain ArrayBuffer —
 *  what WebCrypto's BufferSource asks for. */
function additionalDataOf(binding: MaterialBinding): Uint8Array<ArrayBuffer> {
  const urls = [...new Set(binding.urls)].sort();
  return Uint8Array.from(
    new TextEncoder().encode(
      JSON.stringify(
        "nonce" in binding
          ? ["iterate-secret", 2, binding.context, urls, binding.nonce]
          : ["iterate-secret", 1, binding.context, urls, binding.revision],
      ),
    ),
  );
}

async function aesKeyOf(passphrase: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(passphrase));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
