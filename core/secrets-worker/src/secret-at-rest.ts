// The ciphertext is bound, as AES-GCM additional data, to the secret's path, pin, strategy, use,
// version and the write's nonce: a copy opens nowhere else.
import type { SecretMaterial, SecretRefresh } from "iterate/api";

export type EncryptedMaterial = {
  algorithm: "AES-256-GCM+SECRET-V1";
  iv: string;
  ciphertext: string;
};

type MaterialBinding = {
  context: string;
  urls: string[];
  refresh: SecretRefresh | null;
  version: number;
  nonce: string;
  use?: {
    placement: string;
    operations: readonly string[];
    lendTo?: readonly string[] | null;
    statementPaths?: readonly string[];
  };
};

export async function encryptSecretMaterial(
  material: SecretMaterial,
  binding: MaterialBinding,
  key: string,
): Promise<EncryptedMaterial> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalDataOf(binding) },
    await aesKeyOf(key),
    new TextEncoder().encode(JSON.stringify(material)),
  );
  return {
    algorithm: "AES-256-GCM+SECRET-V1",
    iv: base64Of(iv),
    ciphertext: base64Of(new Uint8Array(ciphertext)),
  };
}

export function decryptLegacySecretMaterial(
  encrypted: EncryptedMaterial,
  // `context` is the Durable Object name in the earlier platform (core/os, removed),
  // `<mindId>.iterate/secrets/<name>`
  binding: { context: string; urls: string[]; nonce: string },
  key: string,
): Promise<SecretMaterial> {
  // the bytes that platform sealed with: its `additionalDataOf`, version 2
  const urls = [...new Set(binding.urls)].sort();
  const additionalData = Uint8Array.from(
    new TextEncoder().encode(
      JSON.stringify(["iterate-secret", 2, binding.context, urls, binding.nonce]),
    ),
  );
  return decryptSecretMaterial(encrypted, additionalData, key);
}

/** `bound`: the cell's binding, or the exact bytes an older cell was sealed with. */
export async function decryptSecretMaterial(
  encrypted: EncryptedMaterial,
  bound: MaterialBinding | Uint8Array<ArrayBuffer>,
  key: string,
): Promise<SecretMaterial> {
  const additionalData = bound instanceof Uint8Array ? bound : additionalDataOf(bound);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesOf(encrypted.iv), additionalData },
    await aesKeyOf(key),
    bytesOf(encrypted.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// Every stored cell opens only with these exact bytes. Sets are sorted so that the same binding
// read back from storage gives the same bytes.
function additionalDataOf(binding: MaterialBinding): Uint8Array<ArrayBuffer> {
  const urls = [...new Set(binding.urls)].sort();
  // an undefined field is absent from a strategy that came through JSON
  const refresh = binding.refresh
    ? Object.entries(binding.refresh)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    : null;
  return Uint8Array.from(
    new TextEncoder().encode(
      JSON.stringify([
        "iterate-secret",
        4,
        binding.context,
        urls,
        refresh,
        binding.version,
        binding.nonce,
        // last, and only when bound: a cell sealed without it keeps its bytes
        ...(binding.use
          ? [
              [
                binding.use.placement,
                [...new Set(binding.use.operations)].sort(),
                // oxlint-disable-next-line iterate/simple-truthiness-check -- absent is a cell sealed before `lendTo` was bound; null (every path) is bound
                ...(binding.use.lendTo === undefined
                  ? []
                  : [binding.use.lendTo && [...new Set(binding.use.lendTo)].sort()]),
                // named, and only when bound: a cell sealed without it keeps its bytes
                ...(binding.use.statementPaths
                  ? [{ statementPaths: [...new Set(binding.use.statementPaths)].sort() }]
                  : []),
              ],
            ]
          : []),
      ]),
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
