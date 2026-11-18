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
// sign-in redirect for a page load (core/boundary-worker/src/mind-host-sign-in.ts), under any base path.
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

// A WebSocket handshake is a GET, but it is checked like a write: every `<routingSlug>--<mind>.iterate.app`
// host is same-site with every other, so a SameSite=Lax cookie rides a socket another mind opens.
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
  expect(auth.person(request)).toEqual({ ...stamp, name: "a" });
});

test("person reads the stamp; a person who is no member is not let through require", () => {
  const request = workerRequest("GET", person);
  expect(auth.person(request)).toEqual({ userId: "user_1", email: "a@example.com", name: "a" });
  expect(auth.person(workerRequest("GET", signedIn))).toBeNull();
  expect(auth.require(request)?.status).toBe(401);
});

// The guard's `methods`, as ./auth.ts "WAYS TO SIGN IN" says them.
test.for<{
  name: string;
  method?: string;
  methods?: ("passkey" | "email" | "google" | "cloudflare" | "guest")[];
  challenge: string | null;
}>([
  {
    name: "a guest, where the app names guests",
    method: "guest",
    methods: ["guest"],
    challenge: null,
  },
  {
    name: "a guest, where the app names guests beside its members' ways",
    method: "guest",
    methods: ["guest", "passkey", "email"],
    challenge: null,
  },
  {
    name: "a guest, where the app names other ways",
    method: "guest",
    methods: ["passkey", "email"],
    challenge:
      'Bearer realm="iterate", scope="identity", error="insufficient_user_authentication", acr_values="passkey email"',
  },
  {
    name: "a guest, where the app names no way",
    method: "guest",
    challenge: 'Bearer realm="iterate", scope="identity", error="insufficient_user_authentication"',
  },
  {
    name: "a mailed code's, where the app names guests alone",
    method: "email",
    methods: ["guest"],
    challenge:
      'Bearer realm="iterate", scope="identity", error="insufficient_user_authentication", acr_values="guest"',
  },
  {
    name: "Cloudflare's, where the app names it",
    method: "cloudflare",
    methods: ["cloudflare"],
    challenge: null,
  },
  {
    name: "a passkey's, where the app names Cloudflare alone",
    method: "passkey",
    methods: ["cloudflare"],
    challenge:
      'Bearer realm="iterate", scope="identity", error="insufficient_user_authentication", acr_values="cloudflare"',
  },
  {
    name: "an unknown way, where the app names ways",
    methods: ["passkey"],
    challenge:
      'Bearer realm="iterate", scope="identity", error="insufficient_user_authentication", acr_values="passkey"',
  },
  {
    name: "a way this SDK does not know",
    method: "carrier-pigeon",
    methods: ["passkey"],
    challenge:
      'Bearer realm="iterate", scope="identity", error="insufficient_user_authentication", acr_values="passkey"',
  },
  {
    name: "Cloudflare's, where the app names no way",
    method: "cloudflare",
    challenge: 'Bearer realm="iterate", scope="identity", error="insufficient_user_authentication"',
  },
  { name: "a mailed code's, where the app names no way", method: "email", challenge: null },
  { name: "an unknown way, where the app names no way", challenge: null },
])("requirePerson takes $name: $challenge", ({ method, methods, challenge }) => {
  const request = workerRequest("GET", stampedBy(method));
  const response = auth.requirePerson(request, { methods });
  expect(response?.headers.get("WWW-Authenticate") ?? null).toBe(challenge);
  // `person` is the same rule: a person the guard refuses is nobody to the app
  expect(Boolean(auth.person(request, { methods }))).toBe(!challenge);
});

test("signed out, a guard that names ways says them, in its order, with no error", () => {
  const response = auth.requirePerson(workerRequest("GET", {}), {
    methods: ["cloudflare", "google"],
  });
  expect(response?.headers.get("WWW-Authenticate")).toBe(
    'Bearer realm="iterate", scope="identity", acr_values="cloudflare google"',
  );
  expect(
    auth.person(workerRequest("GET", stampedBy("cloudflare")), { methods: ["cloudflare"] }),
  ).toMatchObject({ userId: "user_1", method: "cloudflare" });
});

// A guest is a person where an app names the way, with the name they typed and no address, and
// never a member: the member guard reads the principal, which a guest never has.
test("a guest is a person with a name and no address, and no member", () => {
  const stamp = { userId: "user_1", email: "", name: "Bob", method: "guest" };
  const request = workerRequest("GET", { "x-itx-person": JSON.stringify(stamp) });
  expect(auth.person(request, { methods: ["guest"] })).toEqual(stamp);
  expect(auth.person(request)).toBeNull();
  expect(auth.require(request)).toMatchObject({ status: 401 });
  expect(auth.itx(request)).toMatchObject({ status: 401 });
  expect(auth.personItx(request, "/agents/a")).toMatchObject({ status: 401 });
  // the one-context view is the platform's to serve only when the app's own guard names guests
  expect(
    auth.personItx(
      workerRequest("GET", { upgrade: "websocket", "x-itx-person": JSON.stringify(stamp) }),
      "/agents/a",
      { methods: ["guest"] },
    ),
  ).toMatchObject({ status: 426 });
});

// What a member's page of the UI kit asks of its app's host: its socket and the shell's three
// /.auth/ answers, for the mind this host is of. Any other path is the app's.
test("a member's page gets its socket, the mind's platform, one mind and the platform's sign-out", async () => {
  const ask = (path: string, headers: Record<string, string> = signedIn) =>
    auth.memberPage(new Request(`https://dash.example.com${path}`, { headers }));
  expect(ask("/itx")?.status).toBe(426);
  expect(ask("/itx", {})?.status).toBe(401);
  expect(await ask("/.auth/session.json")?.json()).toEqual({
    issuer: "https://iterate.example.com",
    defaultIssuer: "https://iterate.example.com",
  });
  expect(await ask("/.auth/minds.json")?.json()).toMatchObject({
    minds: [{ address: "example.com" }],
    lastUsed: "example.com",
  });
  expect(ask("/.auth/logout")?.headers.get("location")).toBe("/.iterate/sign-out");
  expect(ask("/app.js")).toBeNull();
});

// A person's view of one context: the app names the context, the platform serves the socket.
test("personItx asks the platform to serve a signed-in person's socket, rooted at the path", () => {
  const answer = auth.personItx(
    workerRequest("GET", { upgrade: "websocket", ...stampedBy("email") }),
    "/agents/a",
  );
  expect(answer).toMatchObject({ status: 426 });
  expect(answer.headers.get("x-iterate-serve")).toBe("person-itx");
  expect(answer.headers.get("x-iterate-serve-context")).toBe("/agents/a");
});

test.for<{ name: string; headers: Record<string, string>; methods?: "passkey"[]; status: number }>([
  { name: "signed out", headers: { upgrade: "websocket" }, status: 401 },
  {
    name: "a person from another origin",
    headers: { upgrade: "websocket", origin: "https://evil.example", ...stampedBy("email") },
    status: 403,
  },
  {
    name: "a person signed in by a way the app does not take",
    headers: { upgrade: "websocket", ...stampedBy("email") },
    methods: ["passkey"],
    status: 401,
  },
])(
  "personItx refuses $name → $status, and asks the platform for nothing",
  ({ headers, methods, status }) => {
    const answer = auth.personItx(workerRequest("GET", headers), "/agents/a", { methods });
    expect(answer).toMatchObject({ status });
    expect(answer.headers.has("x-iterate-serve")).toBe(false);
    expect(answer.headers.has("x-iterate-serve-context")).toBe(false);
  },
);

function workerRequest(method: string, headers: Record<string, string>) {
  return new Request("https://worker.example/x", { method, headers });
}

function stampedBy(method?: string) {
  return {
    "x-itx-person": JSON.stringify({ userId: "user_1", email: "a@example.com", method }),
  };
}
