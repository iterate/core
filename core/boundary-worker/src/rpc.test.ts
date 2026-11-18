// THE DOOR (./rpc.ts): which of the mind's requests are its own, and which sender a mail may have.
import type { AuthService } from "iterate/workers";
import { expect, test, vi } from "vitest";
import { boundaryResponse, type MindTransport } from "./http.ts";
import { Door, senderRefusal } from "./rpc.ts";

const config = {
  mindId: "a".repeat(64),
  controlPlaneHostname: "iterate.example.com",
  zones: ["example.com", "example.org"],
  ownerEmails: ["ada@elsewhere.example"],
  topology: "full-cloudflare",
};

test("the Door gives a mind no way to say which identity facts are stored, or to read which are owed: the boundary alone marks", () => {
  // The Door's methods are all that a mind's own Worker reaches of the stack, and all that a
  // mind that runs elsewhere is handed, a candidate that never becomes the mind too
  // (./provided-door.ts forwards the Door's methods by name). None of them is one of the auth
  // Worker's calls for the mind's identity.
  const methods = Object.getOwnPropertyNames(Door.prototype);
  expect(methods.filter((name) => /identity/i.test(name))).toEqual([]);
  // the Door is what this test thinks it is: a method that it does forward to the auth Worker
  expect(methods).toContain("isMember");
});

test("the mind's request to a hostname of its zones goes in through the boundary's own handler as nobody's, with a trailing dot too; any other leaves", async () => {
  const reachedMind: Request[] = [];
  const outside: string[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    outside.push(request.url);
    return new Response("the internet's");
  });
  const env = {
    ITERATE: JSON.stringify(config),
    AUTH: { whoIs: async () => null } as Partial<AuthService>,
  } as Parameters<typeof boundaryResponse>[1];
  const waiting = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const mind = {
    fetch: async (request: Request) => {
      reachedMind.push(request);
      return new Response("the mind's own");
    },
  } as Partial<MindTransport> as MindTransport;
  // The Workers shim's entrypoint has no constructor: the test gives it the env, and as
  // `ctx.exports.default` the Worker's real fetch handler (./worker.ts).
  const door = Object.assign(new Door(undefined as never, undefined as never), {
    env,
    ctx: {
      exports: {
        default: { fetch: (request: Request) => boundaryResponse(request, env, waiting, mind) },
      },
    },
  });
  const ask = (url: string) =>
    door.fetch(
      new Request(url, { headers: { cookie: "session=1", "cf-connecting-ip": "1.2.3.4" } }),
    );
  for (const url of [
    "https://app.example.org/",
    // the same DNS name: it is the mind's own, never leaves as a request to the internet, and
    // goes in without the dot, which the boundary's handler would refuse
    "https://app.example.org./",
  ])
    expect(await (await ask(url)).text(), url).toBe("the mind's own");
  expect(await (await ask("https://example.net/")).text()).toBe("the internet's");
  expect(reachedMind.map((request) => request.url)).toEqual([
    "https://app.example.org/",
    "https://app.example.org/",
  ]);
  // nobody's request: no cookie rides in, and the address is the mind's own fixed one
  for (const request of reachedMind) {
    expect(request.headers.get("cookie")).toBeNull();
    expect(request.headers.get("cf-connecting-ip")).toBe("192.0.0.8");
  }
  expect(outside).toEqual(["https://example.net/"]);
});

test.for([
  ["agent@example.com", true],
  ["Agent@Example.ORG", true],
  ["agent@sub.example.org", true],
  ["agent@elsewhere.example", false],
  // by its last `@` this one would be the mind's: it is no single mailbox
  ["a@outside.test@example.org", false],
  ["Ada <ada@example.com>", false],
  ["ada@example.com, eve@example.com", false],
  ["example.com", false],
  ["", false],
] as const)("a mail may leave from %s: %s", ([from, allowed]) => {
  expect(senderRefusal(from, config) === null).toBe(allowed);
});
