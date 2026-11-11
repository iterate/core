import { expect, test } from "vitest";
import { mindAddressOf } from "../mind-api.ts";
import { type DiscoveredMind, resolveMind } from "./oauth.ts";

test.for([
  "afoop.com",
  "iterate.afoop.com",
  "https://iterate.afoop.com/",
  "  ITERATE.Afoop.COM.  ",
  "https://afoop.com/minds/x",
  "afoop.com/",
])("%s finds afoop.com", async (typed) => {
  expect(await resolve(typed, ["afoop.com"])).toMatchObject({ address: "afoop.com" });
});

test("the typed host is asked as the platform's hostname first, then as the domain", async () => {
  expect({
    platformHostname: await resolve("iterate.afoop.com", ["afoop.com"]),
    domainNamedIterate: await resolve("iterate.example.org", ["iterate.example.org"]),
    domain: await resolve("afoop.com", ["afoop.com"]),
  }).toEqual({
    platformHostname: { address: "afoop.com", asked: ["afoop.com"] },
    domainNamedIterate: {
      address: "iterate.example.org",
      asked: ["example.org", "iterate.example.org"],
    },
    domain: { address: "afoop.com", asked: ["afoop.com"] },
  });
});

test("neither answering names both platform hostnames that were asked", async () => {
  expect({
    both: await resolve("iterate.nowhere.com", []),
    one: await resolve("nowhere.com", []),
  }).toMatchObject({
    both: {
      error:
        "Neither iterate.nowhere.com nor iterate.iterate.nowhere.com answers as an iterate mind. Check the address.",
    },
    one: { error: "nowhere.com does not answer" },
  });
});

/** `typed` resolved with discovery faked: `live` are the addresses whose platform answers. */
async function resolve(typed: string, live: string[]) {
  const parsed = mindAddressOf(typed);
  if ("error" in parsed) return { error: parsed.error, asked: [] };
  const asked: string[] = [];
  const discover = async (address: string): Promise<DiscoveredMind | { error: string }> => {
    asked.push(address);
    if (!live.includes(address)) return { error: `${address} does not answer` };
    return {
      address,
      resource: `https://iterate.${address}/api`,
      issuer: `https://iterate.${address}`,
      endpoints: { authorization: "https://a", token: "https://t" },
      issParameter: true,
    };
  };
  const found = await resolveMind(parsed.address, discover);
  return { ...("error" in found ? { error: found.error } : { address: found.address }), asked };
}
