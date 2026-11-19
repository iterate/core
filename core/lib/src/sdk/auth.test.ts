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

// A WebSocket handshake is a GET, but it is checked like a write: every hostname of a zone is
// same-site with every other, so a SameSite=Lax cookie rides a socket that another hostname's
// page opens.
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
const person = {
  "x-itx-person": JSON.stringify({
    userId: "user_1",
    email: "a@example.com",
    name: "a",
    method: "email",
  }),
};
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
  const stamp = {
    userId: "user_1",
    email: "a@example.com",
    name: "a",
    method: "passkey",
    impersonatedBy,
  };
  const request = workerRequest("GET", { "x-itx-person": JSON.stringify(stamp) });
  expect(auth.person(request)).toEqual({ ...stamp, name: "a" });
});

test("person reads the stamp, with how the person signed in; a person who is no member is not let through require", () => {
  const request = workerRequest("GET", person);
  expect(auth.person(request)).toEqual({
    userId: "user_1",
    email: "a@example.com",
    name: "a",
    method: "email",
  });
  expect(auth.person(workerRequest("GET", signedIn))).toBeNull();
  expect(auth.require(request)?.status).toBe(401);
});

test("signed out, requirePerson asks for the identity scope alone", () => {
  const response = auth.requirePerson(workerRequest("GET", {}));
  expect(response?.headers.get("WWW-Authenticate")).toBe(
    'Bearer realm="iterate", scope="identity"',
  );
});

// A guest is a person with the name they typed and no address, and never a member: the member
// guard reads the principal, which a guest never has. EVERY GUARD REFUSES A GUEST unless its call
// says `{ guests: true }`.
test("a guest passes no guard that did not ask for guests: a name, no address, no member", () => {
  const stamp = { userId: "user_1", email: "", name: "Bob", method: "guest" };
  const request = workerRequest("GET", { "x-itx-person": JSON.stringify(stamp) });
  expect(auth.person(request)).toBeNull();
  expect(auth.requirePerson(request)).toMatchObject({ status: 403 });
  expect(auth.personItx(request, "/agents/a")).toMatchObject({ status: 403 });
  expect(auth.require(request)).toMatchObject({ status: 401 });
  expect(auth.itx(request)).toMatchObject({ status: 401 });
  // a route that takes guests says so at its call
  expect(auth.person(request, { guests: true })).toEqual(stamp);
  expect(auth.requirePerson(request, { guests: true })).toBeNull();
  expect(
    auth.personItx(
      workerRequest("GET", { upgrade: "websocket", "x-itx-person": JSON.stringify(stamp) }),
      "/agents/a",
      { guests: true },
    ),
  ).toMatchObject({ status: 426 });
});

// A member's passkey session counts at every app: at a route that takes guests, a member is the
// member, with the address they proved.
test("a member at a route that takes guests is the member", () => {
  const member = { userId: "user_1", email: "ada@example.org", name: "ada", method: "passkey" };
  const request = workerRequest("GET", {
    ...signedIn,
    "x-itx-person": JSON.stringify(member),
  });
  expect(auth.requirePerson(request, { guests: true })).toBeNull();
  expect(auth.person(request, { guests: true })).toMatchObject({ method: "passkey" });
  expect(auth.require(request)).toBeNull();
});

// A guest's stamp says that it is a guest's and no other: one with an address is no stamp
test("a stamp of a guest with an address is a defect", () => {
  const stamp = { userId: "user_1", email: "a@example.org", name: "Bob", method: "guest" };
  expect(() =>
    auth.person(workerRequest("GET", { "x-itx-person": JSON.stringify(stamp) }), { guests: true }),
  ).toThrow();
});

// A member of another mind, which vouched for them: no address, no member here. EVERY GUARD
// REFUSES THEM unless its call says `{ minds: true }`; a guest's option does not take them, nor
// theirs a guest.
test("a member of another mind passes no guard that did not ask for minds", () => {
  const stamp = {
    userId: "user_1",
    email: "",
    name: "iterate.other.example",
    method: "mind",
    mind: { id: "b".repeat(64), hostname: "iterate.other.example", userId: "user_b" },
  };
  const request = workerRequest("GET", { "x-itx-person": JSON.stringify(stamp) });
  expect(auth.person(request)).toBeNull();
  expect(auth.person(request, { guests: true })).toBeNull();
  expect(auth.requirePerson(request)).toMatchObject({ status: 403 });
  expect(auth.requirePerson(request, { guests: true })).toMatchObject({ status: 403 });
  expect(auth.require(request)).toMatchObject({ status: 401 });
  expect(auth.principal(request)).toBeNull();
  expect(auth.person(request, { minds: true })).toEqual(stamp);
  expect(auth.requirePerson(request, { minds: true })).toBeNull();
  const guest = { userId: "user_2", email: "", name: "Bob", method: "guest" };
  const asGuest = workerRequest("GET", { "x-itx-person": JSON.stringify(guest) });
  expect(auth.person(asGuest, { minds: true })).toBeNull();
  // a stamp of the way mind with an address, or with no mind, is a defect
  for (const wrong of [
    { ...stamp, email: "a@example.org" },
    { ...stamp, mind: undefined },
  ])
    expect(() =>
      auth.person(workerRequest("GET", { "x-itx-person": JSON.stringify(wrong) }), { minds: true }),
    ).toThrow();
});

// The way to a person's own mind: to the issuer at the control-plane hostname, back to this URL
// without its `mind` parameter, where the route then answers the sign-in challenge.
test("mindSignIn sends the person to the issuer's way, and back to the page without mind=", () => {
  const request = new Request("https://cloud.example.com/mind?mind=x&tab=credit", {
    headers: { "x-iterate-control-plane-hostname": "iterate.example.com" },
  });
  const answer = auth.mindSignIn(request, " Iterate.Other.Example ");
  expect(answer).toMatchObject({ status: 302 });
  const to = new URL(answer.headers.get("location")!);
  expect([to.origin, to.pathname]).toEqual(["https://iterate.example.com", "/sign-in/mind"]);
  expect(Object.fromEntries(to.searchParams)).toEqual({
    mind: "iterate.other.example",
    next: "https://cloud.example.com/mind?tab=credit",
  });
  expect(auth.mindSignIn(request, "not a host")).toMatchObject({ status: 400 });
});

// What a member's page of the UI kit asks of its app's host: its socket and the shell's three
// /.auth/ answers, for the mind whose control-plane hostname the boundary stamped. Any other path is the
// app's. The app here is on a second zone of the mind: its issuer is still the control-plane hostname,
// and never a name made from the app's own.
test("a member's page gets its socket, the mind's issuer, one mind and the platform's sign-out", async () => {
  const stamped = { ...signedIn, "x-iterate-control-plane-hostname": "iterate.example.com" };
  const ask = (path: string, headers: Record<string, string> = stamped) =>
    auth.memberPage(new Request(`https://dash.example.org${path}`, { headers }));
  expect(ask("/itx")?.status).toBe(426);
  expect(ask("/itx", {})?.status).toBe(401);
  expect(await ask("/.auth/session.json")?.json()).toEqual({
    issuer: "https://iterate.example.com",
    defaultIssuer: "https://iterate.example.com",
  });
  expect(await ask("/.auth/minds.json")?.json()).toMatchObject({
    minds: [{ address: "iterate.example.com" }],
    lastUsed: "iterate.example.com",
  });
  // a request that did not come in through the boundary names no issuer
  expect(() => ask("/.auth/session.json", signedIn)).toThrow("x-iterate-control-plane-hostname");
  expect(ask("/.auth/logout")?.headers.get("location")).toBe("/.iterate/sign-out");
  expect(ask("/app.js")).toBeNull();
});

// A person's view of one context: the app names the context, the platform serves the socket.
test("personItx asks the platform to serve a signed-in person's socket, rooted at the path", () => {
  const answer = auth.personItx(
    workerRequest("GET", { upgrade: "websocket", ...person }),
    "/agents/a",
  );
  expect(answer).toMatchObject({ status: 426 });
  expect(answer.headers.get("x-iterate-serve")).toBe("person-itx");
  expect(answer.headers.get("x-iterate-serve-context")).toBe("/agents/a");
});

test.for<{ name: string; headers: Record<string, string>; status: number }>([
  { name: "signed out", headers: { upgrade: "websocket" }, status: 401 },
  {
    name: "a person from another origin",
    headers: { upgrade: "websocket", origin: "https://evil.example", ...person },
    status: 403,
  },
])(
  "personItx refuses $name → $status, and asks the platform for nothing",
  ({ headers, status }) => {
    const answer = auth.personItx(workerRequest("GET", headers), "/agents/a");
    expect(answer).toMatchObject({ status });
    expect(answer.headers.has("x-iterate-serve")).toBe(false);
    expect(answer.headers.has("x-iterate-serve-context")).toBe(false);
  },
);

// ANOTHER MIND IS NO MEMBER. Its stamp gets the answer that nobody gets, from the member guard
// and from the member's own `itx`; `auth.principal` names it, for an app that serves other minds.
const MIND = { actor: "ab".repeat(32), kind: "mind", hostname: "iterate.peer.example" };
const byMind = { "x-itx-mind": JSON.stringify(MIND) };

test.for(["GET", "POST"])("a %s stamped with a mind gets the 401 that nobody gets", (method) => {
  const mind = auth.require(workerRequest(method, byMind));
  const nobody = auth.require(workerRequest(method, {}));
  expect({
    status: mind?.status,
    challenge: mind?.headers.get("WWW-Authenticate"),
  }).toEqual({ status: nobody?.status, challenge: nobody?.headers.get("WWW-Authenticate") });
  expect(mind?.status).toBe(401);
});

test("a mind asking for the member's itx gets the refusal, not the socket", () => {
  const answer = auth.itx(workerRequest("GET", { upgrade: "websocket", ...byMind }));
  expect({ status: answer.status, serve: answer.headers.get("x-iterate-serve") }).toEqual({
    status: 401,
    serve: null,
  });
});

test("auth.principal answers a member, a mind, and nobody", () => {
  expect([
    auth.principal(workerRequest("GET", signedIn)),
    auth.principal(workerRequest("GET", byMind)),
    auth.principal(workerRequest("GET", {})),
  ]).toEqual([{ actor: "user:1" }, MIND, null]);
});

// THE POINT OF A HEADER OF ITS OWN: a reader from before `x-itx-mind`, which knows only
// `x-itx-principal`, sees nobody on a mind's request, and refuses as for nobody. This is the guard
// that the SDK's docs taught before (a raw read of the member's header), and the old `require`.
test("a request that carries only x-itx-mind is nobody to a reader that knows only x-itx-principal", () => {
  const request = workerRequest("GET", byMind);
  const oldGuard = (asked: Request) =>
    asked.headers.get("x-itx-principal")
      ? null
      : new Response("Sign in\n", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer realm="iterate"' },
        });
  expect({
    memberHeader: request.headers.get("x-itx-principal"),
    oldGuard: oldGuard(request)?.status,
    require: auth.require(request)?.status,
  }).toEqual({ memberHeader: null, oldGuard: 401, require: 401 });
});

function workerRequest(method: string, headers: Record<string, string>) {
  return new Request("https://worker.example/x", { method, headers });
}
