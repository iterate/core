// THE ACCESS A SIGN-IN KEEPS, at the boundary (./http.ts `keepSignInAccess`): the auth Worker's
// answer names a secret, the boundary sets it through the secrets Worker, and the browser gets the
// answer without it.
import { SIGN_IN_ACCESS_HEADER, type SignInAccess, withSignInAccess } from "iterate/sign-in-access";
import type { AuthService, SecretsService } from "iterate/workers";
import { expect, test, vi } from "vitest";
import { boundaryResponse, type MindTransport } from "./http.ts";

const DOMAIN = "example.com";
const CALLBACK = `https://iterate.${DOMAIN}/sign-in/cloudflare/callback?code=c&state=s`;
const access: SignInAccess = {
  path: "/secrets/cloudflare-sign-in-user_1",
  material: { accessToken: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET" },
  urls: ["https://api.cloudflare.com", "https://dash.cloudflare.com"],
  refresh: {
    kind: "oauth-refresh-token",
    tokenEndpoint: "https://dash.cloudflare.com/oauth2/token",
    clientAuth: "client_secret_post",
  },
};

test("a sign-in's kept access becomes the secret the auth Worker names, and the browser never sees it", async () => {
  const { answered, sets, appended, fact } = stackOf(withSignInAccess(signedIn(), access));
  const answer = await answered();
  expect([answer.status, answer.headers.get("location")]).toEqual([303, "/after"]);
  expect(answer.headers.has(SIGN_IN_ACCESS_HEADER)).toBe(false);
  const { path, ...input } = access;
  expect(sets).toEqual([{ path, verb: "set", input }]);
  // the secret's own fact is in the mind's log
  expect(appended).toEqual([{ path, events: [fact] }]);
});

test("an answer of the auth Worker that keeps nothing sets no secret", async () => {
  const { answered, sets, appended } = stackOf(signedIn());
  expect(await answered()).toMatchObject({ status: 303 });
  expect([sets, appended]).toEqual([[], []]);
});

test("a secret that could not be set leaves the person signed in, and the failure is reported", async () => {
  const reported = vi.spyOn(console, "error").mockImplementation(() => {});
  const { answered, sets, appended } = stackOf(withSignInAccess(signedIn(), access), async () => {
    throw new Error("the secrets Worker did not answer");
  });
  const answer = await answered();
  expect([answer.status, answer.headers.get("location")]).toEqual([303, "/after"]);
  expect(answer.headers.has(SIGN_IN_ACCESS_HEADER)).toBe(false);
  expect(sets).toHaveLength(1);
  expect(appended).toEqual([]);
  expect(JSON.stringify(reported.mock.calls)).toContain("boundary.sign-in-access-not-stored");
  expect(JSON.stringify(reported.mock.calls)).not.toMatch(/ACCESS-SECRET|REFRESH-SECRET/);
});

/** The auth Worker's answer to a sign-in that worked. */
function signedIn() {
  return new Response(null, { status: 303, headers: { location: "/after" } });
}

/** A stack whose auth Worker answers `fromAuth`, and what its secrets Worker and its mind were
 *  told. `set`: what the secrets Worker's `set` does before it answers. */
function stackOf(fromAuth: Response, set?: () => Promise<never>) {
  const sets: { path: string; verb: string; input: unknown }[] = [];
  const appended: { path: string; events: unknown[] }[] = [];
  const waited: Promise<unknown>[] = [];
  const fact = { type: "events.iterate.com/secret/set", payload: { path: access.path } };
  const env = {
    DOMAIN,
    AUTH: { fetch: async () => fromAuth } as Partial<AuthService>,
    SECRETS: {
      secret: async (path: string, verb: string, input: unknown) => {
        sets.push({ path, verb, input });
        if (set) await set();
        return { result: { path }, facts: [{ path, events: [fact] }] };
      },
    } as Partial<SecretsService>,
  } as Parameters<typeof boundaryResponse>[1];
  const mind = {
    append: async (path: string, events: unknown[]) => void appended.push({ path, events }),
  } as Partial<MindTransport> as MindTransport;
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void waited.push(promise),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const answered = async () => {
    const answer = await boundaryResponse(new Request(CALLBACK), env, ctx, mind);
    await Promise.all(waited);
    return answer;
  };
  return { answered, sets, appended, fact };
}
