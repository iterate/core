import { expect, test } from "vitest";
import { isBlocked } from "./blocked.ts";
import type { Env } from "./env.ts";

test("a blocked address is blocked with any +tag too, and a block of one tag is of that tag alone", async () => {
  const env = stack(["abuser@example.net", "other+spam@example.net"]);
  // the same mailbox under another name: the block of the address holds
  expect(await isBlocked(env, "abuser@example.net")).toBe(true);
  expect(await isBlocked(env, "Abuser+1@Example.net ")).toBe(true);
  expect(await isBlocked(env, "abuser+anything.at-all@example.net")).toBe(true);
  // a block that names a tag is of that tag: the mailbox's plain address stays free
  expect(await isBlocked(env, "other+spam@example.net")).toBe(true);
  expect(await isBlocked(env, "other@example.net")).toBe(false);
  expect(await isBlocked(env, "other+else@example.net")).toBe(false);
  expect(await isBlocked(env, "someone@example.net")).toBe(false);
});

/** A stack whose block list holds `blocked`: the one statement `isBlocked` runs, and no more of D1. */
function stack(blocked: string[]) {
  const prepare = (sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => {
        if (!sql.startsWith("select 1 from blocked where")) throw new Error(`not expected: ${sql}`);
        return blocked.some((email) => values.includes(email)) ? { 1: 1 } : null;
      },
    }),
  });
  return { DB: { prepare } } as unknown as Env;
}
