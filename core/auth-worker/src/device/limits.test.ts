// The limits on what a caller may make the stack store, counted per client: no caller is exempt,
// also one whose request names no address, and the mind's own requests count as one client.
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import type { Env } from "../env.ts";
import { admitted } from "./limits.ts";

test("a caller with no address is one client, held at 20 in the window, and leaves the stack's limit to others", async () => {
  const env = envWithAdmissions();
  const answers: boolean[] = [];
  for (let n = 0; n < 25; n += 1)
    answers.push(await admitted(env, "device", new Request("https://iterate.example.com/")));
  expect(answers.filter(Boolean)).toHaveLength(20);
  expect(answers.slice(20)).toEqual([false, false, false, false, false]);
  // a visitor with an address of their own still gets in
  expect(await admitted(env, "device", from("203.0.113.7"))).toBe(true);
});

test("the mind's own requests share the boundary's one address, and so one client's limit", async () => {
  const env = envWithAdmissions();
  const answers: boolean[] = [];
  for (let n = 0; n < 130; n += 1) answers.push(await admitted(env, "device", from("192.0.0.8")));
  // 20, not the stack's 120: the members' sign-ins keep the rest
  expect(answers.filter(Boolean)).toHaveLength(20);
  expect(await admitted(env, "device", from("203.0.113.7"))).toBe(true);
});

test("the stack's limit of 120 in the window still holds for many clients together", async () => {
  const env = envWithAdmissions();
  const answers: boolean[] = [];
  for (let n = 0; n < 125; n += 1)
    answers.push(await admitted(env, "registration", from(`198.51.100.${n}`)));
  expect(answers.filter(Boolean)).toHaveLength(120);
});

test("a host's client is asked for with no client, and the stack's limit alone holds it", async () => {
  const env = envWithAdmissions();
  const answers: boolean[] = [];
  for (let n = 0; n < 125; n += 1)
    answers.push(await admitted(env, "host-client", new Request("https://blog.example.com/")));
  expect(answers.filter(Boolean)).toHaveLength(120);
});

const from = (address: string) =>
  new Request("https://iterate.example.com/", { headers: { "cf-connecting-ip": address } });

/** An `Env` whose `DB` is SQLite in memory with the table of migrations/0005_admissions.sql, and
 *  of D1's surface the three members `admitted` uses. */
function envWithAdmissions() {
  const db = new DatabaseSync(":memory:");
  db.exec("create table admissions (kind text not null, client text, created_at integer not null)");
  const prepare = (sql: string) => ({
    bind: (...values: (string | number | null)[]) => ({
      run: () => ({ results: db.prepare(sql).all(...values) }),
    }),
  });
  const DB = {
    prepare,
    batch: async (statements: { run(): unknown }[]) => statements.map((one) => one.run()),
  };
  // the three members of D1 that the code under test calls, of the binding's many
  return { DB } as unknown as Env;
}
