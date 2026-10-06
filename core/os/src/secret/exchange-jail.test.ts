// secret/exchange-jail.test.ts — the jail's isolate id names what the jail runs (exchange-jail.ts),
// over a fake Worker Loader; the jail itself runs in the Workers suite
// (test/vitest/os-workers/secret-exchange-code.test.ts).
import { expect, test } from "vitest";
import { runExchangeCode } from "./exchange-jail.ts";

test("one jail per secret, pin and source: the next refresh asks for the isolate it had, whatever its material, and a change to any of the three builds another", async () => {
  const ids: string[] = [];
  const built = new Set<string>();
  // like workerd: `getCode` runs once per new id, and the jail answers the next material
  const loader = {
    get: (id: string, getCode: () => unknown) => {
      ids.push(id);
      if (!built.has(id)) {
        built.add(id);
        getCode();
      }
      return {
        getEntrypoint: () => ({
          exchange: async (material: Record<string, unknown>) => ({
            material: { ...material, token: "t" },
          }),
        }),
      };
    },
  } as unknown as WorkerLoader;
  const refresh = (changed: Partial<Parameters<typeof runExchangeCode>[0]> = {}) =>
    runExchangeCode({
      loader,
      pinnedOutbound: {} as Fetcher,
      context: "prj_u.iterate/secrets/shop",
      urls: ["https://shop.test"],
      source: "export async function exchange(material) { return material; }",
      material: { password: "pw" },
      ...changed,
    });

  expect(await refresh()).toEqual({ password: "pw", token: "t" });
  // its next refresh: new material, the same jail
  await refresh({ material: { password: "pw", token: "t" } });
  expect({ ids: ids.length, built: built.size }).toEqual({ ids: 2, built: 1 });
  expect(ids[1]).toBe(ids[0]);
  await refresh({ source: "export async function exchange(material) { return { ...material }; }" });
  await refresh({ urls: ["https://shop.test", "https://login.shop.test"] });
  await refresh({ context: "prj_u.iterate/secrets/other-shop" });
  expect({ ids: ids.length, built: built.size }).toEqual({ ids: 5, built: 4 });
});
