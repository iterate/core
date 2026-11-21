// THE DOOR (./rpc.ts): which of the mind's requests are its own, and which sender a mail may have.
import { MIND_FETCH_STATEMENT_TYPE, statementText } from "iterate/signed";
import type { AuthService, MindTarget } from "iterate/workers";
import { expect, test, vi } from "vitest";
import type { Env } from "./env.ts";
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
  // the mind Worker's `Mind` entrypoint, as the boundary's handler reaches it (./mind-transport.ts)
  const env = {
    ITERATE: JSON.stringify(config),
    AUTH: { whoIs: async () => null } as Partial<AuthService>,
    MIND: {
      fetch: async (request: Request) => {
        reachedMind.push(request);
        return new Response("the mind's own");
      },
    } as Partial<MindTarget>,
  } as Env;
  // The Workers shim's entrypoint has no constructor: the test gives it the env and a context.
  const door = Object.assign(new Door(undefined as never, undefined as never), {
    env,
    ctx: { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
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
  // nobody's request: no cookie rides in, and the address is the mind's own fixed one; the
  // boundary says it is the mind's own (iterate/lib `ITX_OWN_HEADER`)
  for (const request of reachedMind) {
    expect(request.headers.get("cookie")).toBeNull();
    expect(request.headers.get("cf-connecting-ip")).toBe("192.0.0.8");
    expect(request.headers.get("x-itx-own")).toBe("1");
  }
  expect(outside).toEqual(["https://example.net/"]);
  // A PROVIDED MIND'S DOOR (./provided-mind.ts): its own request goes in with no stamp, so the
  // mind that is reached resumes no cause of that session's
  reachedMind.length = 0;
  const provided = Object.assign(new Door(undefined as never, undefined as never), {
    env,
    ctx: {
      waitUntil() {},
      passThroughOnException() {},
      props: { provided: true },
    } as unknown as ExecutionContext,
  });
  await provided.fetch(new Request("https://app.example.org/"));
  expect(reachedMind.map((request) => request.headers.get("x-itx-own"))).toEqual([null]);
});

test("only fetchForMind signs: it uses the statement again while it lives and lets no answer give it back; a header that code writes signs nothing and does not leave", async () => {
  const signs: unknown[] = [];
  const sent: { url: string; redirect: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push({
      url: request.url,
      redirect: request.redirect,
      headers: Object.fromEntries(request.headers),
    });
    // an answer that echoes the statement
    return new Response("the other mind's", {
      headers: { "x-echo": request.headers.get("iterate-auth-statement") ?? "", "x-plain": "kept" },
    });
  });
  const statement = statementText({
    mind: "iterate.peer.net",
    from: config.controlPlaneHostname,
    path: "/",
    type: MIND_FETCH_STATEMENT_TYPE,
    payload: { method: "POST", url: "https://app.peer.net/v1" },
    at: Date.now(),
    expires: Date.now() + 300_000,
  });
  const door = Object.assign(new Door(undefined as never, undefined as never), {
    env: {
      ITERATE: JSON.stringify(config),
      AUTH: {
        sign: async (input: unknown) => {
          signs.push(input);
          return { statement, signature: { format: "ml-dsa-65", key: "k", sig: "s" } };
        },
        // the cast: a stand-in envelope, whose signature the Door never reads
      } as unknown as Partial<AuthService>,
    },
  });
  const request = (url: string, headers: Record<string, string> = {}) =>
    new Request(url, { method: "POST", body: "b", headers, redirect: "manual" });
  const answers = [];
  for (let call = 0; call < 2; call += 1)
    answers.push(
      await door.fetchForMind(
        "iterate.peer.net",
        request("https://app.peer.net/v1", {
          "iterate-auth-statement": "the code's own",
          host: "app.peer.net",
          "x-itx-principal": '{"actor":"user_1"}',
          "x-iterate-marker": "ours",
          // as the kernel's egress writes it (core/itx/src/cause.ts)
          "x-iterate-cause": JSON.stringify({
            chain: "2026-11-19T00:00:00.000Z with a request ~n1",
            depth: 3,
          }),
        }),
      ),
    );
  expect(signs).toMatchObject([
    {
      mind: "iterate.peer.net",
      path: "/",
      type: "events.iterate.com/mind/fetch-requested",
      payload: { method: "POST", url: "https://app.peer.net/v1" },
      expiresInSeconds: 300,
    },
  ]);
  expect(sent).toHaveLength(2);
  expect(sent[0]).toMatchObject({ url: "https://app.peer.net/v1", redirect: "manual" });
  for (const name of ["host", "x-itx-principal", "x-iterate-marker"])
    expect(sent[0]?.headers).not.toHaveProperty(name);
  // the cause leaves with the request, as `leavingTheStack` writes it
  expect(JSON.parse(sent[0]?.headers["x-iterate-cause"] ?? "")).toMatchObject({
    chain: "2026-11-19T00:00:00.000Z with another stack ~n1",
    depth: 3,
  });
  expect(sent[0]?.headers["iterate-auth-statement"]).toBe(
    sent[1]?.headers["iterate-auth-statement"],
  );
  expect(sent[0]?.headers["iterate-auth-statement"]).not.toBe("the code's own");
  for (const answer of answers) {
    expect(answer.headers.get("x-echo")).toBeNull();
    expect(answer.headers.get("x-plain")).toBe("kept");
  }
  // LOADED CODE (a jailed agent's itx.fetch) that writes a statement by hand: the request leaves
  // unsigned, with none
  await door.fetch(
    request("https://app.peer.net/v1", { "iterate-auth-statement": "the code's own" }),
  );
  expect(sent[2]?.headers).not.toHaveProperty("iterate-auth-statement");
  // the signer takes a fragment off, which never goes on the wire: the statement is for the URL
  // that arrives, and the one kept for it serves
  await door.fetchForMind("iterate.peer.net", request("https://app.peer.net/v1#frag"));
  expect(sent[3]?.url).toBe("https://app.peer.net/v1");
  // this mind, no hostname, http and an upgrade are refused, and nothing is signed or sent
  for (const [url, signFor, headers] of [
    ["https://app.peer.net/v1", "iterate.example.com", {}],
    ["https://app.peer.net/v1", "not a hostname", {}],
    ["http://app.peer.net/v1", "iterate.peer.net", {}],
    ["https://app.peer.net/v1", "iterate.peer.net", { upgrade: "websocket" }],
  ] as const)
    await expect(door.fetchForMind(signFor, request(url, headers))).rejects.toThrow(
      "fetch(request, { signFor })",
    );
  // a URL with userinfo is refused too: workerd's Request keeps one, and Node's refuses to make
  // one, so the URL is set on a Request made without it
  for (const url of ["https://user:pass@app.peer.net/v1", "https://user@app.peer.net/v1"]) {
    const withUserinfo = request("https://app.peer.net/v1");
    Object.defineProperty(withUserinfo, "url", { value: url });
    await expect(door.fetchForMind("iterate.peer.net", withUserinfo)).rejects.toThrow(
      "a request signed for another mind takes no credentials in its URL: send them in a header",
    );
  }
  expect({ signs: signs.length, sent: sent.length }).toEqual({ signs: 1, sent: 4 });
});

// ── THE DOOR'S LAST HOP, WITH AN EGRESS GATEWAY AND WITHOUT ONE (iterate/lib `fetchLeavingTheStack`) ──

test("a request with no secret to an outside host leaves through the gateway when the stack has one, and by the platform's fetch when it has none", async () => {
  const withGateway = stackOf({ gateway: true });
  const answer = await withGateway.door.fetch(
    new Request("https://example.net/a", { method: "POST", body: "b" }),
  );
  expect(await answer.text()).toBe("through the gateway");
  expect(withGateway).toMatchObject({
    carried: [{ url: "https://example.net/a", redirect: "manual" }],
    platform: [],
  });
  const without = stackOf({ gateway: false });
  expect(await (await without.door.fetch(new Request("https://example.net/a"))).text()).toBe(
    "by the platform's fetch",
  );
  expect(without).toMatchObject({ carried: [], platform: ["https://example.net/a"] });
});

test("a request signed for another mind leaves through the gateway with its statement", async () => {
  const stack = stackOf({ gateway: true });
  const answer = await stack.door.fetchForMind(
    "iterate.peer.net",
    new Request("https://app.peer.net/through-a-gateway", { method: "POST", body: "b" }),
  );
  expect(await answer.text()).toBe("through the gateway");
  expect(stack.carried).toMatchObject([
    { url: "https://app.peer.net/through-a-gateway", redirect: "manual" },
  ]);
  // the header is the signed envelope, as base64
  expect(atob(stack.carried[0]?.headers["iterate-auth-statement"] ?? "")).toContain(
    "iterate.peer.net",
  );
  expect(stack).toMatchObject({ platform: [] });
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

/** A Door of a stack, with a gateway that says what it was handed when `gateway` is true, and
 *  the platform's fetch, which says what it sent. */
function stackOf({ gateway }: { gateway: boolean }) {
  const platform: string[] = [];
  const carried: { url: string; redirect?: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    platform.push(request.url);
    return new Response("by the platform's fetch");
  });
  const env = {
    ITERATE: JSON.stringify(config),
    AUTH: {
      whoIs: async () => null,
      sign: async (input: { payload: { method: string; url: string } }) => {
        return {
          statement: statementText({
            mind: "iterate.peer.net",
            from: config.controlPlaneHostname,
            path: "/",
            type: MIND_FETCH_STATEMENT_TYPE,
            payload: input.payload,
            at: Date.now(),
            expires: Date.now() + 300_000,
          }),
          signature: { format: "ml-dsa-65", key: "k", sig: "s" },
        };
      },
      // the cast: a stand-in envelope, whose signature the Door never reads
    } as unknown as Partial<AuthService>,
    ...(gateway && {
      EGRESS_GATEWAY: {
        fetch: async (request: Request, init?: RequestInit) => {
          carried.push({
            url: request.url,
            redirect: init?.redirect,
            headers: Object.fromEntries(request.headers),
          });
          return new Response("through the gateway");
        },
      },
    }),
  } as Env;
  const door = Object.assign(new Door(undefined as never, undefined as never), {
    env,
    ctx: { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  });
  return { door, platform, carried };
}
