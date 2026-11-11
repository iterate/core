import { readFile } from "node:fs/promises";
import { connectMind } from "iterate/node";
import { createCli } from "trpc-cli";
import { z } from "zod";

// A fact of the earlier platform (core/os, removed) that carried a cell, sealed for
// `<mindId>.iterate/secrets/<name>`.
const CellFact = z.object({
  type: z.enum([
    "events.iterate.com/secret/set",
    "events.iterate.com/secret/refreshed",
    "events.iterate.com/secret/resealed",
  ]),
  payload: z.object({ sealed: z.looseObject({ context: z.string() }) }),
});

const Deleted = z.object({
  type: z.literal("events.iterate.com/secret/deleted"),
  payload: z.object({ path: z.string() }),
});

/** Imports the secrets in `file` into the stack deployed on `domain`. */
export default async function importSecrets(
  /** The mind's domain, e.g. example.com. */
  domain: string,
  /** The exported secret facts: a JSON array, or one JSON event per line. */
  file: string,
) {
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token) throw new Error("ITERATE_PROTOTYPE_TOKEN is not set");
  const key = process.env.ITERATE_SECRETS_AT_REST_KEY;
  if (!key) throw new Error("ITERATE_SECRETS_AT_REST_KEY is not set");
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const proofOf = async (path: string, cell: string) =>
    Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        hmacKey,
        new TextEncoder().encode(JSON.stringify([path, cell])),
      ),
    ).toString("hex");
  const text = await readFile(file, "utf8");
  const parsed: unknown[] = text.trimStart().startsWith("[")
    ? z.array(z.unknown()).parse(JSON.parse(text))
    : text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as unknown);
  const latest = new Map<string, z.infer<typeof CellFact>["payload"]>();
  for (const event of parsed) {
    const deleted = Deleted.safeParse(event);
    if (deleted.success) latest.delete(deleted.data.payload.path);
    const fact = CellFact.safeParse(event);
    const { context } = fact.data?.payload.sealed || { context: "" };
    const at = context.indexOf(".iterate/secrets/");
    if (fact.success && at > 0)
      latest.set(context.slice(at + ".iterate".length), fact.data.payload);
  }
  // One WebSocket session for every secret. An HTTP batch ends at its first await, and the proof
  // below is awaited before the call: over a batch every import failed, with no word from the mind.
  using connection = await connectMind({ address: domain, token, signIn: false });
  // `importSealed` is the mind's own `itx.secrets` verb, which iterate/api's type does not name
  const secrets = connection.itx.secrets as unknown as {
    importSealed(path: string, cell: string, proof: string): Promise<unknown>;
  };
  let failed = 0;
  for (const [path, { sealed }] of [...latest].sort(([a], [b]) => (a < b ? -1 : 1))) {
    try {
      // the cell as text: the proof covers these bytes, whatever order a hop gives an object's keys
      const cell = JSON.stringify(sealed);
      await secrets.importSealed(path, cell, await proofOf(path, cell));
      console.log(`imported  ${path}`);
    } catch (error) {
      failed += 1;
      console.log(`FAILED    ${path}  (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  console.log(`${latest.size - failed} of ${latest.size} secrets imported`);
  if (failed > 0) process.exitCode = 1;
}

void createCli(import.meta).run();
