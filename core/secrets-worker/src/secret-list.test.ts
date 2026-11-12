import type { SecretDescription } from "iterate/workers";
import { expect, test } from "vitest";
import { listSetSecrets } from "./secret-list.ts";

test("a list asks only the secrets in the vault's set, and a row whose object says 'not set' is not listed and is corrected", async () => {
  const vault = pretendVault({
    set: ["/secrets/a", "/secrets/b"],
    // a row that a delete left: its object holds nothing
    listed: ["/secrets/a", "/secrets/b", "/secrets/gone"],
    complete: true,
  });

  const listed = await listSetSecrets(vault.deps, ["/secrets/dead-1", "/secrets/dead-2"]);

  expect(listed.map((secret) => secret.path)).toEqual(["/secrets/a", "/secrets/b"]);
  // the paths the mind names are not asked about: the set is complete
  expect(vault).toMatchObject({
    asked: ["/secrets/a", "/secrets/b", "/secrets/gone"],
    corrected: ["/secrets/gone"],
  });
});

test("the first list of a vault that had secrets before takes the paths the mind names, once", async () => {
  const vault = pretendVault({ set: ["/secrets/old", "/secrets/new"], listed: ["/secrets/new"] });
  const known = ["/secrets/old", "/secrets/deleted", "/agents/not-a-secret", "/secrets/new"];

  const first = await listSetSecrets(vault.deps, known);

  expect(first.map((secret) => secret.path)).toEqual(["/secrets/new", "/secrets/old"]);
  // What is no secret's path is never asked about. The object of a set secret that the set
  // lacked writes its own row.
  expect(vault).toMatchObject({
    asked: ["/secrets/deleted", "/secrets/new", "/secrets/old"],
    corrected: ["/secrets/old"],
  });
  expect(vault.listed()).toEqual(["/secrets/new", "/secrets/old"]);

  // from now on the set is the list: the mind's paths are ignored
  vault.asked.length = 0;
  const second = await listSetSecrets(vault.deps, [...known, "/secrets/never"]);
  expect(second).toEqual(first);
  expect(vault).toMatchObject({ asked: ["/secrets/new", "/secrets/old"] });
});

test("many secrets are asked a few at a time", async () => {
  const paths = Array.from({ length: 40 }, (_, at) => `/secrets/s${String(at).padStart(2, "0")}`);
  const vault = pretendVault({ set: paths, listed: paths, complete: true });
  expect(await listSetSecrets(vault.deps)).toHaveLength(40);
  expect(vault.mostAtOnce()).toBeLessThanOrEqual(16);
});

/** The vault's set of paths and its secrets' objects, each of which writes its own row. */
function pretendVault(input: { set: string[]; listed: string[]; complete?: boolean }) {
  const set = new Set(input.set);
  const listed = new Set(input.listed);
  let complete = input.complete ?? false;
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
      list: {
        paths: async () => [...listed],
        complete: async () => complete,
        markComplete: async () => void (complete = true),
      },
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
