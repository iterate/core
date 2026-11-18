import type { SecretDescription } from "iterate/workers";
import { expect, test } from "vitest";
import { listSetSecrets } from "./secret-list.ts";

test("a list asks only the secrets in the vault's set, and a row whose object says 'not set' is not listed and is corrected", async () => {
  const vault = pretendVault({
    set: ["/secrets/a", "/secrets/b"],
    // a row that a delete left: its object holds nothing
    listed: ["/secrets/a", "/secrets/b", "/secrets/gone"],
  });

  const listed = await listSetSecrets(vault.deps);

  expect(listed.map((secret) => secret.path)).toEqual(["/secrets/a", "/secrets/b"]);
  expect(vault).toMatchObject({
    asked: ["/secrets/a", "/secrets/b", "/secrets/gone"],
    corrected: ["/secrets/gone"],
  });
  expect(vault.listed()).toEqual(["/secrets/a", "/secrets/b"]);
});

test("many secrets are asked a few at a time", async () => {
  const paths = Array.from({ length: 40 }, (_, at) => `/secrets/s${String(at).padStart(2, "0")}`);
  const vault = pretendVault({ set: paths, listed: paths });
  expect(await listSetSecrets(vault.deps)).toHaveLength(40);
  expect(vault.mostAtOnce()).toBeLessThanOrEqual(16);
});

/** The vault's set of paths and its secrets' objects, each of which writes its own row. */
function pretendVault(input: { set: string[]; listed: string[] }) {
  const set = new Set(input.set);
  const listed = new Set(input.listed);
  const asked: string[] = [];
  const corrected: string[] = [];
  let open = 0;
  let most = 0;
  return {
    asked,
    corrected,
    listed: () => [...listed].sort(),
    mostAtOnce: () => most,
    deps: {
      list: { paths: async () => [...listed] },
      secretOf: () => ({
        describe: async (path: string): Promise<SecretDescription> => {
          open += 1;
          most = Math.max(most, open);
          await new Promise((resolve) => setTimeout(resolve, 1));
          open -= 1;
          asked.push(path);
          asked.sort();
          return { path, set: set.has(path) };
        },
        keepListed: async (path: string) => {
          corrected.push(path);
          if (set.has(path)) listed.add(path);
          else listed.delete(path);
        },
      }),
    },
  };
}
