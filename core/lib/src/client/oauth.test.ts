import { expect, test, vi } from "vitest";
import { mindAddressOf } from "../mind-api.ts";
import { type DiscoveredMind, discoverMind, resolveMind } from "./oauth.ts";

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

test("a mind's sign-in provider is its own platform host: another https issuer in its metadata is refused, and never asked", async () => {
  expect(await discover("https://iterate.afoop.com")).toMatchObject({
    found: {
      address: "afoop.com",
      issuer: "https://iterate.afoop.com",
      endpoints: { authorization: "https://iterate.afoop.com/authorize" },
    },
  });
  for (const issuer of [
    "https://sign-in.attacker.example",
    "https://afoop.com",
    "https://iterate.afoop.com.attacker.example",
    "https://iterate.afoop.com/other",
  ])
    // refused, and only the mind's own metadata was read: the other issuer is never asked
    expect(await discover(issuer), issuer).toEqual({
      found: { error: "afoop.com names a sign-in provider that is not its own." },
      asked: ["https://iterate.afoop.com/.well-known/oauth-protected-resource/api"],
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

/** `discoverMind("afoop.com")` against a fake of the two metadata documents, the mind naming
 *  `issuer` as its sign-in provider: what it found, and each URL it asked for. */
async function discover(issuer: string) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);
    asked.push(url.href);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return Response.json({
        resource: "https://iterate.afoop.com/api",
        authorization_servers: [issuer],
      });
    return Response.json({
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/authorize`,
      token_endpoint: `${url.origin}/oauth2/token`,
      response_types_supported: ["code"],
    });
  });
  return { found: await discoverMind("afoop.com"), asked };
}
