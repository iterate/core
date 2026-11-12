import type { ItxHostRootContext } from "core-itx";
import type { Door } from "iterate/workers";
import { expect, test } from "vitest";
import { secretsRoot } from "./secrets.ts";

test("the vault's answer is released when the mind has read it, so its session does not stay open", async () => {
  const vault = pretendVault();
  const secrets = secretsRoot(mindWith([]), vault.egress);

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

test("list() describes a mind's many paths a few at a time, and leaves no session of the vault open", async () => {
  // a mind keeps the path of every secret it ever had: ten of these were deleted since
  const paths = Array.from({ length: 50 }, (_, at) => `/secrets/s${String(at).padStart(2, "0")}`);
  const vault = pretendVault(new Set(paths.slice(40)));
  const secrets = secretsRoot(mindWith(paths), vault.egress);

  const listed = await secrets.list();

  expect(listed.map((secret) => secret.path)).toEqual(paths.slice(0, 40));
  expect(vault).toMatchObject({ asked: 50, released: 50 });
  expect(vault.mostOpenAtOnce()).toBeLessThanOrEqual(16);
  expect(vault.open()).toBe(0);
});

/** The boundary's `secret`, as Workers RPC answers it: an object that holds its call's session
 *  open until its disposer runs. It counts the sessions that are open. */
function pretendVault(unset = new Set<string>()) {
  let open = 0;
  let most = 0;
  const counts = { asked: 0, released: 0 };
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
    most = Math.max(most, open);
    // the answer comes a moment later, as it does across Workers: calls made together overlap
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (verb === "describe") return held({ path, set: !unset.has(path) });
    if (path === "/secrets/refused")
      return held({ refused: { code: "FORBIDDEN", message: "not this one" }, facts: [] });
    return held({ result: path, facts: [{ path, events: [{ type: "proof/fact" }] }] });
  };
  return {
    egress: { secret } as unknown as Door,
    open: () => open,
    mostOpenAtOnce: () => most,
    get asked() {
      return counts.asked;
    },
    get released() {
      return counts.released;
    },
  };
}

/** A mind whose `/secrets` log names these paths, one `child-created` fact each. */
function mindWith(paths: string[]): ItxHostRootContext {
  const events = paths.map((childPath, offset) => ({
    offset: offset + 1,
    type: "events.iterate.com/itx/child-created",
    payload: { childPath },
  }));
  return {
    path: "/",
    caller: () => ({ principal: null }),
    context: () => ({
      read: async () => ({ events, atHead: true, scannedThroughOffset: events.length }),
      append: async () => [],
    }),
  } as unknown as ItxHostRootContext;
}
