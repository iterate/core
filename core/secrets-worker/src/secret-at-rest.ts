// The ciphertext is bound, as AES-GCM additional data, to the secret's path, pin, strategy, use,
// version and the write's nonce: a copy opens nowhere else. A secret by proxy seals its proxy as
// its material, and the mark `byProxy` is in the binding: a cell whose mark was taken off or put
// on opens nowhere, so no proxy is ever read from bytes that this stack did not seal.
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
  use: {
    placement: string;
    operations: readonly string[];
    lendTo: readonly string[] | null;
    statementPaths?: readonly string[];
    bodyFields?: readonly { method: string; url: string; field: string }[];
    byProxy?: true;
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

export async function decryptSecretMaterial(
  encrypted: EncryptedMaterial,
  binding: MaterialBinding,
  key: string,
): Promise<SecretMaterial> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesOf(encrypted.iv), additionalData: additionalDataOf(binding) },
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
        [
          binding.use.placement,
          [...new Set(binding.use.operations)].sort(),
          binding.use.lendTo && [...new Set(binding.use.lendTo)].sort(),
          // named, and only when the secret has them: absent is any path
          ...(binding.use.statementPaths
            ? [{ statementPaths: [...new Set(binding.use.statementPaths)].sort() }]
            : []),
          // named, and only when the secret has them: absent is no body. A cell that gets a body
          // field, or loses one, opens nowhere, so no field is added to a value that is stored.
          ...(binding.use.bodyFields
            ? [
                {
                  bodyFields: binding.use.bodyFields
                    .map(({ method, url, field }) => JSON.stringify([method, url, field]))
                    .sort(),
                },
              ]
            : []),
          // named, and only for a secret by proxy: a value's cell binds the same bytes as before
          ...(binding.use.byProxy ? [{ byProxy: true }] : []),
        ],
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
