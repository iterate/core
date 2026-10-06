// Real PKCE/token code with an in-memory DurableObject store and a controlled OAuth token endpoint.
// Preview smoke verifies the same flow against the deployed issuer and actual DurableObjects.
import { expect, test, vi } from "vitest";
import { BrowserSession } from "./app-session.ts";

test("a device's client id is used at authorization, code exchange and refresh, and its branding survives activation", async () => {
  const { session } = fixture();
  const client = {
    id: "https://kit.example/devices/satellite1/clients/unit.json",
    name: "Satellite1",
    logoUri: "https://kit.example/vendors/futureproofhomes.png",
  };
  const authorize = new URL(
    await session.begin(
      {
        origin: "https://kit.example",
        issuer: "https://issuer.example",
        resource: "https://issuer.example/api",
        scopes: ["iterate", "account"],
        client,
      },
      "/devices/satellite1",
    ),
  );
  expect(authorize.searchParams.get("client_id")).toBe(client.id);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(await session.client()).toBeUndefined();
  const requests: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(new URLSearchParams(init.body as string));
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: requests.length === 1 ? 0 : 3600,
      });
    }),
  );
  const callback = new URLSearchParams({
    code: "code",
    state: authorize.searchParams.get("state")!,
    iss: "https://issuer.example",
  });
  expect(await session.complete(callback.toString())).toEqual({
    next: "/devices/satellite1",
  });
  expect(await session.client()).toEqual(client);
  expect(await session.bearer()).toBe("access");
  expect(requests.map((request) => [request.get("client_id"), request.get("grant_type")])).toEqual([
    [client.id, "authorization_code"],
    [client.id, "refresh_token"],
  ]);
  expect(await session.client()).toEqual(client);
  await session.discard();
  expect(await session.client()).toBeUndefined();
});

test("ordinary app sessions retain their existing origin client", async () => {
  const { session } = fixture();
  const url = new URL(
    await session.begin(
      {
        origin: "https://notes.example",
        issuer: "https://issuer.example",
        resource: "https://issuer.example/api",
        scopes: ["iterate"],
      },
      "/",
    ),
  );
  expect(url.searchParams.get("client_id")).toBe("https://notes.example/.auth/client.json");
});

test("an expiry that waited behind a sign-in keeps the session the sign-in made; an expired one ends", async () => {
  const { session } = fixture();
  const authorize = new URL(
    await session.begin(
      {
        origin: "https://notes.example",
        issuer: "https://issuer.example",
        resource: "https://issuer.example/api",
        scopes: ["iterate"],
      },
      "/",
    ),
  );
  let answer = (_response: Response) => {};
  const asked = new Promise<void>((resolve) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        resolve();
        return new Promise<Response>((settle) => (answer = settle));
      }),
    );
  });
  const callback = new URLSearchParams({
    code: "code",
    state: authorize.searchParams.get("state")!,
    iss: "https://issuer.example",
  });
  const completing = session.complete(callback.toString());
  await asked;
  // the pending flow's alarm fires while its code exchange is in flight
  const expiring = session.alarm();
  answer(
    Response.json({
      access_token: "access",
      refresh_token: "refresh",
      token_type: "Bearer",
      expires_in: 3600,
    }),
  );
  expect(await completing).toEqual({ next: "/" });
  await expiring;
  expect(await session.bearer()).toBe("access");

  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 24 * 3600_000);
  await session.alarm();
  expect(await session.bearer()).toBeNull();
  vi.restoreAllMocks();
});

function fixture() {
  const values = new Map<string, unknown>();
  const session = new BrowserSession(
    {
      storage: {
        get: async (key: string) => values.get(key),
        put: async (key: string, value: unknown) => {
          values.set(key, value);
        },
        setAlarm: async () => {},
        deleteAll: async () => {
          values.clear();
        },
        deleteAlarm: async () => {},
      },
    } as unknown as DurableObjectState,
    {},
  );
  return { session };
}
