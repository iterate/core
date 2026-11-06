import { expect, test } from "vitest";
import { auth } from "./auth.ts";

// An empty Origin is foreign, like any other that is not this one; only an absent Origin (a
// non-browser client) is trusted (lib.ts isSameOriginBrowserRequest).
test.for<{ headers: Record<string, string>; status: number }>([
  { headers: { origin: "" }, status: 403 },
  { headers: { origin: "https://evil.example" }, status: 403 },
  { headers: { origin: "null" }, status: 403 },
  { headers: {}, status: 401 },
  { headers: { origin: "https://worker.example" }, status: 401 },
])("a POST with $headers and no principal → $status", ({ headers, status }) => {
  expect(auth.require(workerRequest("POST", headers))?.status).toBe(status);
});

// Signed out, every method answers the platform's sign-in challenge; the edge turns it into the
// sign-in redirect for a page load (core/os project-host-sign-in.ts), under any base path.
test.for<{ method: string; headers: Record<string, string> }>([
  { method: "GET", headers: { origin: "" } },
  { method: "HEAD", headers: {} },
  { method: "OPTIONS", headers: {} },
  { method: "POST", headers: { origin: "https://worker.example" } },
])("a $method with no principal → 401 with the sign-in challenge", ({ method, headers }) => {
  const response = auth.require(workerRequest(method, headers));
  expect(response).toMatchObject({ status: 401 });
  expect(response!.headers.get("WWW-Authenticate")).toBe('Bearer realm="iterate"');
});

// A WebSocket handshake is a GET, but it is checked like a write: every `<routingSlug>--<project>.iterate.app`
// host is same-site with every other, so a SameSite=Lax cookie rides a socket another project opens.
const signedIn = { "x-itx-principal": JSON.stringify({ actor: "user:1" }) };
test.for<{ name: string; headers: Record<string, string>; status: number | null }>([
  { name: "cross-origin", headers: { origin: "https://evil.example", ...signedIn }, status: 403 },
  {
    name: "sibling-host",
    headers: { origin: "https://b--other.iterate.app", ...signedIn },
    status: 403,
  },
  {
    name: "same-origin signed in",
    headers: { origin: "https://worker.example", ...signedIn },
    status: null,
  },
  { name: "same-origin signed out", headers: { origin: "https://worker.example" }, status: 401 },
  { name: "absent-Origin signed in", headers: { ...signedIn }, status: null },
  { name: "absent-Origin signed out", headers: {}, status: 401 },
])("a WebSocket upgrade, $name → $status", ({ headers, status }) => {
  const request = workerRequest("GET", { upgrade: "WebSocket", ...headers });
  expect(auth.require(request)?.status ?? null).toBe(status);
});

test("a plain cross-origin GET with a principal still passes", () => {
  expect(
    auth.require(workerRequest("GET", { origin: "https://evil.example", ...signedIn })),
  ).toBeNull();
});

test("a same-origin POST with a principal still passes", () => {
  expect(
    auth.require(workerRequest("POST", { origin: "https://worker.example", ...signedIn })),
  ).toBeNull();
});

// A person who is no member is stamped `x-itx-person` alone; `auth.require` still asks for a member.
const person = { "x-itx-person": JSON.stringify({ userId: "user_1", email: "a@example.com" }) };
test.for<{ name: string; headers: Record<string, string>; method?: string; status: number | null }>(
  [
    { name: "a person", headers: person, status: null },
    { name: "a member, stamped both", headers: { ...person, ...signedIn }, status: null },
    { name: "signed out", headers: {}, status: 401 },
    {
      name: "a person's cross-site POST",
      headers: { origin: "https://evil.example", ...person },
      method: "POST",
      status: 403,
    },
    {
      name: "a person's same-origin POST",
      headers: { origin: "https://worker.example", ...person },
      method: "POST",
      status: null,
    },
  ],
)("requirePerson: $name → $status", ({ headers, method, status }) => {
  const response = auth.requirePerson(workerRequest(method || "GET", headers));
  expect(response?.status ?? null).toBe(status);
  if (status === 401)
    expect(response!.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="iterate", scope="identity"',
    );
});

test("person reads the platform admin signed in as the person, when the stamp names one", () => {
  const impersonatedBy = { actor: "user_2", email: "admin@example.com" };
  const stamp = { userId: "user_1", email: "a@example.com", impersonatedBy };
  const request = workerRequest("GET", { "x-itx-person": JSON.stringify(stamp) });
  expect(auth.person(request)).toEqual(stamp);
});

test("person reads the stamp; a person who is no member is not let through require", () => {
  const request = workerRequest("GET", person);
  expect(auth.person(request)).toEqual({ userId: "user_1", email: "a@example.com" });
  expect(auth.person(workerRequest("GET", signedIn))).toBeNull();
  expect(auth.require(request)?.status).toBe(401);
});

function workerRequest(method: string, headers: Record<string, string>) {
  return new Request("https://worker.example/x", { method, headers });
}
