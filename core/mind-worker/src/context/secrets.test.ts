import type { ItxHostRootContext } from "core-itx";
import type { Door } from "iterate/workers";
import { expect, test } from "vitest";
import { secretsRoot } from "./secrets.ts";

test("the vault's answer is released when the mind has read it, so its session does not stay open", async () => {
  const vault = pretendVault();
  const secrets = secretsRoot(mindOf(), vault.egress);

  expect(await secrets.describe("/secrets/a")).toEqual({ path: "/secrets/a", set: true });
  expect(vault.open()).toBe(0);
  // an answer with facts: read, its facts appended, and released all the same
  expect(await secrets.set("/secrets/b", "material", { urls: ["https://example.com/"] })).toBe(
    "/secrets/b",
  );
  expect(vault.open()).toBe(0);
  // a refusal is thrown, and its answer is released too
  await expect(secrets.delete("/secrets/refused")).rejects.toThrow("not this one");
  expect(vault.open()).toBe(0);
  expect(vault).toMatchObject({ asked: 3, released: 3 });
});

test("list() is one call of the vault, which keeps the paths of its own secrets, and its answer is released", async () => {
  const vault = pretendVault();
  const secrets = secretsRoot(mindOf(), vault.egress);

  expect((await secrets.list()).map((secret) => secret.path)).toEqual([
    "/secrets/github-jo",
    "/secrets/github-sam",
  ]);
  // one call, and no call for any one path
  expect(vault).toMatchObject({ lists: 1, asked: 0, released: 1 });
  expect(vault.open()).toBe(0);
});

test("a vault that has no such verb is an error of the stack, which list() and cloud() throw: nothing stands in for the answer", async () => {
  const vault = pretendVault({ hasNoListOrCloud: true });
  const secrets = secretsRoot(mindOf(), vault.egress);

  await expect(secrets.list()).rejects.toThrow("does not implement");
  await expect(secrets.cloud("https://cloud.example.com")).rejects.toThrow("does not implement");
  expect(vault.open()).toBe(0);
});

test("refreshGrants() goes on where the vault stopped until every grant is reached: the rows of all are the answer, each one's fact lands on its secret's log, and each answer is released", async () => {
  const vault = pretendVault();
  const mind = mindOf();
  const secrets = secretsRoot(mind, vault.egress);

  expect(await secrets.refreshGrants()).toEqual([
    { path: "/secrets/github-jo", outcome: "refreshed" },
    { path: "/secrets/github-sam", outcome: "refreshed" },
  ]);
  expect({ vault, appended: appends.get(mind) }).toMatchObject({
    vault: { asked: 2, released: 2 },
    appended: [
      { path: "/secrets/github-jo", types: ["proof/refreshed"] },
      { path: "/secrets/github-sam", types: ["proof/refreshed"] },
    ],
  });
  expect(vault.open()).toBe(0);
});

/** The boundary's `secret`, as Workers RPC answers it: an object that holds its call's session
 *  open until its disposer runs. It counts the sessions that are open. */
function pretendVault({ hasNoListOrCloud = false } = {}) {
  let open = 0;
  const counts = { asked: 0, released: 0, lists: 0 };
  const held = <T extends object>(answer: T): T =>
    Object.defineProperty(answer, Symbol.dispose, {
      value: () => {
        open -= 1;
        counts.released += 1;
      },
    });
  const secret = async (path: string, verb: string) => {
    counts.asked += 1;
    open += 1;
    if (verb === "describe") return held({ path, set: true });
    if (path === "/secrets/refused")
      return held({ refused: { code: "FORBIDDEN", message: "not this one" }, facts: [] });
    return held({ result: path, facts: [{ path, events: [{ type: "proof/fact" }] }] });
  };
  const grants = ["/secrets/github-jo", "/secrets/github-sam"];
  // The vault's own list: the secrets that are set.
  const listSecrets = async () => {
    counts.lists += 1;
    open += 1;
    return held(grants.map((path) => ({ path, set: true })));
  };
  // As Workers RPC answers a verb that the receiver has not: the call's promise rejects, and the
  // promise itself holds the call's session.
  const noSuchVerb = (verb: string) => () => {
    open += 1;
    return held(
      Promise.reject(new TypeError(`The RPC receiver does not implement the method "${verb}".`)),
    );
  };
  // The vault's refresh of the persons' grants, one grant in a call: it says where it stopped
  // until the last one.
  const refreshGrants = async (after?: string) => {
    counts.asked += 1;
    open += 1;
    const path = grants.find((grant) => grant > (after || ""))!;
    return held({
      result: {
        grants: [{ path, outcome: "refreshed" }],
        ...(path !== grants.at(-1) && { next: path }),
      },
      facts: [{ path, events: [{ type: "proof/refreshed" }] }],
    });
  };
  return {
    egress: (hasNoListOrCloud
      ? { secret, listSecrets: noSuchVerb("listSecrets"), cloud: noSuchVerb("cloud") }
      : { secret, listSecrets, refreshGrants }) as unknown as Door,
    open: () => open,
    get lists() {
      return counts.lists;
    },
    get asked() {
      return counts.asked;
    },
    get released() {
      return counts.released;
    },
  };
}

/** A mind that records what is appended to its contexts. */
function mindOf(): ItxHostRootContext {
  const mind = {
    path: "/",
    caller: () => ({ principal: null }),
    context: (path: string) => ({
      append: async (...appended: { type: string }[]) => {
        appends.get(mind)!.push({ path, types: appended.map((event) => event.type) });
        return [];
      },
    }),
  } as unknown as ItxHostRootContext;
  appends.set(mind, []);
  return mind;
}

/** What each stand-in mind was asked to append, and where. */
const appends = new WeakMap<ItxHostRootContext, { path: string; types: string[] }[]>();
