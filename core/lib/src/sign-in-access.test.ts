import { expect, test, vi } from "vitest";
import {
  cloudflareSignInSecretOf,
  SIGN_IN_ACCESS_HEADER,
  type SignInAccess,
  takeSignInAccess,
  withSignInAccess,
} from "./sign-in-access.ts";

const access: SignInAccess = {
  path: cloudflareSignInSecretOf("user_1"),
  material: { accessToken: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET", note: "é" },
  urls: ["https://api.example.test"],
  refresh: {
    kind: "oauth-refresh-token",
    tokenEndpoint: "https://api.example.test/token",
    clientAuth: "client_secret_post",
  },
};

test("the access rides the answer's header, and the answer that goes on has no trace of it", () => {
  const carried = withSignInAccess(signedIn(), access);
  expect(carried.headers.get(SIGN_IN_ACCESS_HEADER)).not.toMatch(/ACCESS-SECRET|REFRESH-SECRET/);
  const { answer, access: taken } = takeSignInAccess(carried);
  expect(taken).toEqual(access);
  expect(taken?.path).toBe("/secrets/cloudflare-sign-in-user_1");
  expect([answer.status, answer.headers.get("location")]).toEqual([303, "/after"]);
  expect(answer.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  expect(answer.headers.has(SIGN_IN_ACCESS_HEADER)).toBe(false);
});

test("an answer with no access comes back as it is", () => {
  const plain = signedIn();
  expect(takeSignInAccess(plain)).toEqual({ answer: plain, access: null });
});

test("a header that names no secret is dropped and reported: nothing is stored", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const encoded = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "");
  for (const header of [
    "not base64url json",
    encoded({ ...access, path: "/agents/someone" }),
    encoded({ ...access, urls: [] }),
    encoded({ ...access, extra: true }),
  ]) {
    const { answer, access: taken } = takeSignInAccess(
      new Response(null, { status: 303, headers: { [SIGN_IN_ACCESS_HEADER]: header } }),
    );
    expect(taken).toBeNull();
    expect(answer.headers.has(SIGN_IN_ACCESS_HEADER)).toBe(false);
  }
});

/** The answer of a sign-in: where the browser goes, and its two cookies. */
function signedIn() {
  const headers = new Headers({ location: "/after" });
  headers.append("set-cookie", "a=1; Path=/");
  headers.append("set-cookie", "b=2; Path=/");
  return new Response(null, { status: 303, headers });
}
