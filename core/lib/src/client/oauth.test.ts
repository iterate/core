import { expect, test, vi } from "vitest";
import { discoverMind } from "./oauth.ts";

test("a mind's sign-in provider is the one its own metadata names: its control-plane hostname by convention, or another https host of its choosing", async () => {
  // the default mind: the issuer is the control-plane hostname
  expect(await discover("https://iterate.afoop.com")).toMatchObject({
    found: {
      address: "iterate.afoop.com",
      issuer: "https://iterate.afoop.com",
      endpoints: { authorization: "https://iterate.afoop.com/authorize" },
    },
  });
  // a mind that keeps its sign-in elsewhere: discovery follows what the mind says
  expect(await discover("https://login.afoop-identity.example")).toEqual({
    found: {
      address: "iterate.afoop.com",
      resource: "https://iterate.afoop.com/api",
      issuer: "https://login.afoop-identity.example",
      endpoints: {
        authorization: "https://login.afoop-identity.example/authorize",
        token: "https://login.afoop-identity.example/oauth2/token",
      },
      issParameter: false,
    },
    // the mind's metadata is read at the address the person named, then the issuer it names
    asked: [
      "https://iterate.afoop.com/.well-known/oauth-protected-resource/api",
      "https://login.afoop-identity.example/.well-known/oauth-authorization-server",
    ],
  });
});

test("an issuer that does not use https is refused, and never asked", async () => {
  for (const issuer of ["http://login.afoop-identity.example", "http://localhost:8788"])
    expect(await discover(issuer), issuer).toEqual({
      found: { error: "iterate.afoop.com names a sign-in provider that does not use https." },
      asked: ["https://iterate.afoop.com/.well-known/oauth-protected-resource/api"],
    });
});

/** `discoverMind("iterate.afoop.com")` against a fake of the two metadata documents, the mind
 *  naming `issuer` as its sign-in provider: what it found, and each URL it asked for. */
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
  return { found: await discoverMind("iterate.afoop.com"), asked };
}
