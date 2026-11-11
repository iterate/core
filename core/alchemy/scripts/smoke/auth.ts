import { get, request as httpsRequest } from "node:https";
import {
  platformOriginOf,
  projectApiUrlOf,
  projectMcpUrlOf,
  protectedResourceMetadataUrlOf,
} from "iterate/project-api";
import { z } from "zod";
import { signerOf } from "./approvals.ts";
import { attempt, type Check } from "./lib.ts";

/** core/auth/src/cookies.ts `SESSION_COOKIE`, which the package does not export. */
const ISSUER_SESSION_COOKIE = "__Host-iterate-auth-session";
const CHALLENGE_PATH = "/me";

// node:https, because Node's `fetch` writes `Sec-Fetch-Mode: cors` over the caller's own.
function navigation(url: string): Promise<{ status: number; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const headers = {
      accept: "text/html",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    get(url, { headers }, (response) => {
      response.resume();
      resolve({ status: response.statusCode || 0, location: response.headers.location });
    }).on("error", reject);
  });
}

// node:https, because Node's `fetch` refuses `upgrade`.
function upgradeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
        "base64",
      ),
    };
    httpsRequest(url, { headers })
      .on("response", (response) => {
        response.resume();
        resolve(response.statusCode || 0);
      })
      .on("upgrade", (_response, socket) => {
        socket.destroy();
        resolve(101);
      })
      .on("error", reject)
      .end();
  });
}

export async function authChecks(domain: string): Promise<Check[]> {
  const issuer = platformOriginOf(domain);
  const metadataUrl = `${issuer}/.well-known/oauth-authorization-server`;
  const metadataResponse = await fetch(metadataUrl);
  const metadata = (await metadataResponse.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const endpoints = ["authorization_endpoint", "token_endpoint", "registration_endpoint"].map(
    (key) => metadata?.[key],
  );
  const checks: Check[] = [
    {
      check: `GET ${metadataUrl}: issuer is ${issuer}`,
      pass: metadataResponse.ok && metadata?.issuer === issuer,
      detail: JSON.stringify(metadata?.issuer),
    },
    {
      check: "auth metadata: every endpoint is on the issuer's origin",
      pass: endpoints.every(
        (endpoint) => typeof endpoint === "string" && endpoint.startsWith(`${issuer}/`),
      ),
      detail: JSON.stringify(endpoints),
    },
  ];
  const redirectUri = "http://127.0.0.1:9/callback";
  const registration = registeredClient(metadata, redirectUri);
  registration.catch(() => undefined);
  checks.push(
    await attempt(
      "auth: an authorization with no session goes to the stack's sign-in",
      async () => {
        const client = await registration;
        const authorization = new URL(String(metadata?.authorization_endpoint));
        authorization.search = new URLSearchParams({
          response_type: "code",
          client_id: client,
          redirect_uri: redirectUri,
          state: crypto.randomUUID(),
          // allow-high-entropy-next-line: the example challenge of RFC 7636 appendix B
          code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
          code_challenge_method: "S256",
          resource: projectApiUrlOf(domain),
        }).toString();
        const first = await fetch(authorization, { redirect: "manual" });
        const signIn = first.headers.get("location") || "";
        const to = new URL(signIn || "about:blank");
        // the stack's own page on every stack: it is where a passkey signs in
        const listed = to.origin === issuer ? await fetch(signIn, { redirect: "manual" }) : null;
        const body = (await listed?.text()) || "";
        return {
          pass:
            first.status === 302 &&
            /^\/sign-in(\/email)?$/.test(to.pathname) &&
            listed?.status === 200 &&
            body.includes("Sign in with a passkey"),
          detail: `${first.status} to ${to.origin}${to.pathname}, which answers ${listed?.status}`,
        };
      },
    ),
    await attempt("auth: the token endpoint refuses a made-up code", async () => {
      const client = await registration;
      const response = await fetch(String(metadata?.token_endpoint), {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client,
          code: "user_made-up:made-up:made-up",
          redirect_uri: redirectUri,
          // allow-high-entropy-next-line: the example verifier of RFC 7636 appendix B
          code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      return {
        pass: response.status === 400 && body?.error === "invalid_grant",
        detail: `${response.status} ${JSON.stringify(body?.error)}`,
      };
    }),
    ...(await Promise.all(
      [projectApiUrlOf(domain), projectMcpUrlOf(domain)].map((resource) =>
        attempt(`boundary: ${resource}'s protected-resource document names ${issuer}`, async () => {
          const response = await fetch(protectedResourceMetadataUrlOf(resource));
          const document = (await response.json().catch(() => null)) as {
            resource?: unknown;
            authorization_servers?: unknown;
          } | null;
          const servedBy = response.headers.get("x-iterate-served-by");
          return {
            pass:
              response.ok &&
              servedBy === "boundary" &&
              document?.resource === resource &&
              JSON.stringify(document?.authorization_servers) === JSON.stringify([issuer]),
            detail: `${response.status}, served by ${servedBy}, ${JSON.stringify(document)}`,
          };
        }),
      ),
    )),
    await attempt(
      "boundary: a WebSocket to /api with no bearer is 401, before any socket",
      async () => {
        const status = await upgradeStatus(projectApiUrlOf(domain));
        return { pass: status === 401, detail: `${status}` };
      },
    ),
    await attempt("boundary: a made-up bearer on /api is 401, invalid_token", async () => {
      const response = await fetch(projectApiUrlOf(domain), {
        method: "POST",
        headers: { authorization: `Bearer made-up-${crypto.randomUUID()}` },
        body: "",
      });
      await response.body?.cancel();
      const challenge = response.headers.get("www-authenticate") || "";
      return {
        pass:
          response.status === 401 &&
          challenge.includes('error="invalid_token"') &&
          challenge.includes(protectedResourceMetadataUrlOf(projectApiUrlOf(domain))),
        detail: `${response.status} ${challenge}`,
      };
    }),
    await attempt("boundary: /api reaches the project without the issuer's cookie", async () => {
      const token = process.env.ITERATE_PROTOTYPE_TOKEN;
      if (!token) return { pass: true, detail: "skipped: ITERATE_PROTOTYPE_TOKEN is not set" };
      const response = await fetch(`${projectApiUrlOf(domain)}/_skeleton`, {
        headers: { cookie: `${ISSUER_SESSION_COOKIE}=smoke`, authorization: `Bearer ${token}` },
      });
      const body = z
        .object({ cookieReached: z.boolean() })
        .safeParse(await response.json().catch(() => null));
      return {
        pass: response.ok && body.success && !body.data.cookieReached,
        detail: `${response.status}, cookieReached ${body.success ? body.data.cookieReached : "absent"}`,
      };
    }),
    await attempt(
      `boundary: a page load of https://${domain}${CHALLENGE_PATH} signs in at the issuer for that host`,
      async () => {
        const response = await navigation(`https://${domain}${CHALLENGE_PATH}`);
        const location = new URL(response.location || "about:blank");
        const query = location.searchParams;
        return {
          pass:
            response.status === 302 &&
            `${location.origin}${location.pathname}` === `${issuer}/oauth2/auth` &&
            query.get("resource") === `https://${domain}` &&
            query.get("redirect_uri") === `https://${domain}/.iterate/callback` &&
            query.get("scope") === "identity" &&
            query.get("code_challenge_method") === "S256",
          detail: `${response.status} to ${location.origin}${location.pathname}, resource ${query.get("resource")}, scope ${query.get("scope")}`,
        };
      },
    ),
    await attempt(
      `boundary: a fetch of https://${domain}${CHALLENGE_PATH} stays a 401`,
      async () => {
        const response = await fetch(`https://${domain}${CHALLENGE_PATH}`, {
          redirect: "manual",
          headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
        });
        await response.body?.cancel();
        return {
          pass:
            response.status === 401 &&
            /realm="iterate"/.test(response.headers.get("www-authenticate") || ""),
          detail: `${response.status} ${response.headers.get("www-authenticate")}`,
        };
      },
    ),
  );
  checks.push(
    ...(await deviceChecks(domain, metadata)),
    ...(await limitChecks(domain, metadata)),
    ...(await emailChecks(domain)),
    ...(await passkeyChecks(domain)),
    ...(await membersChecks(domain)),
  );
  return checks;
}

async function deviceChecks(domain: string, metadata: Record<string, unknown> | null) {
  const issuer = platformOriginOf(domain);
  const endpoint = metadata?.device_authorization_endpoint;
  const checks: Check[] = [
    {
      check: "auth metadata: the device authorization endpoint is on the issuer's origin",
      pass: endpoint === `${issuer}/oauth2/device_authorization`,
      detail: JSON.stringify(endpoint),
    },
  ];
  const DeviceCodes = z.object({
    device_code: z.string(),
    user_code: z.string(),
    verification_uri: z.string(),
    verification_uri_complete: z.string(),
    expires_in: z.number(),
    interval: z.number(),
  });
  const started = (async () => {
    const registration = await fetch(String(metadata?.registration_endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "iterate smoke check",
        token_endpoint_auth_method: "none",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      }),
    });
    if (registration.status !== 201)
      throw new Error(`the device registration answered ${registration.status}`);
    const client = z.object({ client_id: z.string() }).parse(await registration.json()).client_id;
    const response = await fetch(String(endpoint), {
      method: "POST",
      body: new URLSearchParams({
        client_id: client,
        scope: "iterate",
        resource: projectApiUrlOf(domain),
      }),
    });
    if (!response.ok) throw new Error(`the device authorization answered ${response.status}`);
    return { client, codes: DeviceCodes.parse(await response.json()) };
  })();
  started.catch(() => undefined);
  const poll = async (client: string, deviceCode: string) => {
    const response = await fetch(String(metadata?.token_endpoint), {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: client,
      }),
    });
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    return { status: response.status, error: body?.error };
  };
  checks.push(
    await attempt("device: a device authorization answers RFC 8628's fields", async () => {
      const { codes } = await started;
      return {
        pass:
          codes.verification_uri === `${issuer}/oauth2/device` &&
          codes.verification_uri_complete.startsWith(`${codes.verification_uri}?user_code=`) &&
          codes.expires_in > 0 &&
          codes.interval >= 5,
        detail: `${codes.verification_uri}, expires in ${codes.expires_in} s, interval ${codes.interval} s`,
      };
    }),
    await attempt("device: a poll before approval is authorization_pending", async () => {
      const { client, codes } = await started;
      const answer = await poll(client, codes.device_code);
      return {
        pass: answer.status === 400 && answer.error === "authorization_pending",
        detail: `${answer.status} ${JSON.stringify(answer.error)}`,
      };
    }),
    await attempt("device: a second poll inside the interval is slow_down", async () => {
      const { client, codes } = await started;
      const answer = await poll(client, codes.device_code);
      return {
        pass: answer.status === 400 && answer.error === "slow_down",
        detail: `${answer.status} ${JSON.stringify(answer.error)}`,
      };
    }),
    await attempt("device: a made-up device code is refused", async () => {
      const { client } = await started;
      const answer = await poll(client, `made-up-${crypto.randomUUID()}`);
      return {
        pass:
          answer.status === 400 &&
          (answer.error === "invalid_grant" || answer.error === "expired_token"),
        detail: `${answer.status} ${JSON.stringify(answer.error)}`,
      };
    }),
    await attempt("device: the page answers, and names no secret", async () => {
      const { codes } = await started;
      const response = await fetch(codes.verification_uri_complete, { redirect: "manual" });
      const location = response.headers.get("location") || "";
      const body = await response.text();
      const toSignIn = response.status === 303 && /^\/sign-in(\/[a-z]+)?\?/.test(location);
      return {
        pass:
          (response.status === 200 || toSignIn) &&
          !body.includes(codes.device_code) &&
          !location.includes(codes.device_code),
        detail: `${response.status}${location ? ` to ${location.split("?")[0]}` : ""}`,
      };
    }),
  );
  return checks;
}

async function limitChecks(
  domain: string,
  metadata: Record<string, unknown> | null,
): Promise<Check[]> {
  const register = (body: Record<string, unknown>) =>
    fetch(String(metadata?.registration_endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const checks = [
    await attempt(
      "limits: a registration with 5,000 characters of metadata is refused",
      async () => {
        const response = await register({
          client_name: "x".repeat(5_000),
          redirect_uris: ["http://127.0.0.1:1/callback"],
          token_endpoint_auth_method: "none",
        });
        await response.body?.cancel();
        return { pass: response.status === 413, detail: `${response.status}` };
      },
    ),
  ];
  if (process.env.ITERATE_SMOKE_LIMITS !== "1")
    return [
      ...checks,
      {
        check: "limits: one address's device authorizations end in a 429",
        pass: true,
        detail: "skipped: ITERATE_SMOKE_LIMITS=1 spends this address's for ten minutes",
      },
    ];
  checks.push(
    await attempt(
      "limits: one address's device authorizations end in a 429 the client shows",
      async () => {
        const registration = await register({
          client_name: "iterate smoke check",
          token_endpoint_auth_method: "none",
          grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        });
        const client = z.object({ client_id: z.string() }).parse(await registration.json());
        // 20 an address: this run's device check spent one, and a run in the last ten minutes more
        for (let started = 1; started <= 21; started++) {
          const response = await fetch(String(metadata?.device_authorization_endpoint), {
            method: "POST",
            body: new URLSearchParams({
              client_id: client.client_id,
              scope: "iterate",
              resource: projectApiUrlOf(domain),
            }),
          });
          const body = z
            .object({ error: z.string().optional(), error_description: z.string().optional() })
            .parse(await response.json());
          if (response.status === 200) continue;
          return {
            pass:
              response.status === 429 &&
              body.error === "temporarily_unavailable" &&
              Boolean(body.error_description),
            detail: `${response.status} after ${started - 1} more: ${body.error}, ${JSON.stringify(body.error_description)}`,
          };
        }
        return { pass: false, detail: "21 device authorizations from one address were all let in" };
      },
    ),
  );
  return checks;
}

async function registeredClient(metadata: Record<string, unknown> | null, redirectUri: string) {
  const response = await fetch(String(metadata?.registration_endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "iterate smoke check",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) throw new Error(`registration answered ${response.status}`);
  return z.object({ client_id: z.string() }).parse(await response.json()).client_id;
}

async function emailChecks(domain: string): Promise<Check[]> {
  const issuer = platformOriginOf(domain);
  const offered = await fetch(`${issuer}/sign-in/email`);
  await offered.body?.cancel();
  if (offered.status === 404)
    return [{ check: "email sign-in", pass: true, detail: "skipped: the stack does not offer it" }];
  const post = (path: string, body: Record<string, string>, cookie = "") =>
    fetch(`${issuer}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: issuer, cookie },
      body: new URLSearchParams(body),
    });
  // At a reserved test domain (RFC 6761), which the auth Worker never mails.
  const challenge = async () => {
    const email = `smoke-${crypto.randomUUID()}@example.test`;
    const response = await post("/sign-in/email", { email, next: "/" });
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-iterate-auth-code="))
      ?.split(";")[0];
    return { response, cookie: cookie || "" };
  };
  const started = challenge();
  started.catch(() => undefined);
  const wrong = async (cookie: string) => {
    const response = await post("/sign-in/email/code", { code: "000000" }, cookie);
    return {
      status: response.status,
      location: response.headers.get("location"),
      body: await response.text(),
    };
  };
  return [
    await attempt("email: the sign-in offers the mailed code", async () => {
      const response = await fetch(`${issuer}/sign-in`, { redirect: "manual" });
      const body = await response.text();
      const location = response.headers.get("location") || "";
      return {
        pass: location.includes("/sign-in/email") || body.includes('action="/sign-in/email"'),
        detail: `${response.status}${location ? ` to ${new URL(location, issuer).pathname}` : ""}`,
      };
    }),
    await attempt(
      "email: an address answers the code page and sets the challenge's cookie",
      async () => {
        const { response, cookie } = await started;
        await response.body?.cancel();
        return {
          pass:
            response.status === 303 &&
            response.headers.get("location") === "/sign-in/email/code" &&
            Boolean(cookie),
          detail: `${response.status} to ${response.headers.get("location")}, cookie ${cookie ? "set" : "absent"}`,
        };
      },
    ),
    await attempt(
      "email: a wrong code is refused and counted; the fifth ends the challenge; a sixth finds none",
      async () => {
        const { cookie } = await started;
        const answers = [];
        for (let attempt = 0; attempt < 6; attempt++) answers.push(await wrong(cookie));
        const counted = answers
          .slice(0, 4)
          .every((answer, i) => answer.status === 400 && answer.body.includes(`${4 - i} tr`));
        const ended = answers[4]!.status === 400 && answers[4]!.body.includes("Too many tries");
        const gone =
          answers[5]!.status === 303 && (answers[5]!.location || "").startsWith("/sign-in/email?");
        return {
          pass: counted && ended && gone,
          detail: answers.map((answer) => answer.status).join(", "),
        };
      },
    ),
    await attempt(
      "email: six wrong codes at once end the challenge, and none of them signs in",
      async () => {
        const { response, cookie } = await challenge();
        await response.body?.cancel();
        if (!cookie) return { pass: false, detail: `${response.status}, no challenge's cookie` };
        const answers = await Promise.all(Array.from({ length: 6 }, () => wrong(cookie)));
        const tried = answers.filter((answer) => answer.status === 400).length;
        const ended = answers.filter((answer) => answer.body.includes("Too many tries")).length;
        const none = answers.filter(
          (answer) =>
            answer.status === 303 && (answer.location || "").startsWith("/sign-in/email?"),
        ).length;
        // Five tries are spent, whatever order the six arrive in: one answer says the challenge has
        // ended, and a wrong code whose page is drawn after that finds no challenge either.
        return {
          pass: ended === 1 && tried >= 1 && tried <= 5 && tried + none === 6,
          detail: `${tried} tried (${ended} ended it), ${none} found none`,
        };
      },
    ),
  ];
}

// Without a passkey or a session: what the endpoints refuse. scripts/passkey-sign-in-proof.ts signs
// in with a passkey; no smoke check holds a member's session, so none shows what one may do.
async function passkeyChecks(domain: string): Promise<Check[]> {
  const issuer = platformOriginOf(domain);
  const post = async (path: string, body: unknown, origin: string | null = issuer) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (origin) headers.set("origin", origin);
    const response = await fetch(`${issuer}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const answer = z
      .object({ statement: z.string(), error: z.string() })
      .partial()
      .safeParse(await response.json().catch(() => null));
    return { status: response.status, ...answer.data };
  };
  const firstOwner = await attempt(
    "first owner: a ticket nobody was given signs nobody in",
    async () => {
      const page = await fetch(`${issuer}/keys/first`);
      await page.body?.cancel();
      const answer = await post("/keys/first", { ticket: crypto.randomUUID() });
      return {
        pass: page.status === 200 && answer.status === 403,
        detail: `the page ${page.status}, the ticket ${answer.status}`,
      };
    },
  );
  const offered = await post("/sign-in/passkey/challenge", {});
  return [
    firstOwner,
    await attempt("passkey: every stack's sign-in page offers it", async () => {
      const page = await fetch(`${issuer}/sign-in`);
      const body = await page.text();
      return {
        pass: page.status === 200 && body.includes("Sign in with a passkey"),
        detail: `${new URL(page.url).pathname} ${page.status}, ${body.includes("Sign in with a passkey") ? "offered" : "not on the page"}`,
      };
    }),
    await attempt("passkey: a challenge goes to the site's own page alone", async () => {
      const elsewhere = await post("/sign-in/passkey/challenge", {}, "https://example.com");
      const none = await post("/sign-in/passkey/challenge", {}, null);
      return {
        pass: offered.status === 200 && elsewhere.status === 403 && none.status === 403,
        detail: `own page ${offered.status}, another origin ${elsewhere.status}, none ${none.status}`,
      };
    }),
    await attempt(
      "passkey: an answer from no passkey of the project is refused, and its challenge is spent",
      async () => {
        const answer = {
          statement: offered.statement,
          credentialId: "smoke",
          sig: "",
          authenticatorData: "",
          clientDataJSON: "",
        };
        const first = await post("/sign-in/passkey", answer);
        const second = await post("/sign-in/passkey", answer);
        return {
          pass:
            first.status === 403 &&
            Boolean(first.error?.includes("not one this project knows")) &&
            second.status === 403 &&
            Boolean(second.error?.includes("expired")),
          detail: `${first.status} ${first.error}; again ${second.status} ${second.error}`,
        };
      },
    ),
  ];
}

/** core/auth/src/signed-change.ts `MEMBER_ADDED`, which the package does not export. */
const MEMBER_ADDED = "events.iterate.com/account/member-added";

// To add a member takes a member's key: a token removes one and adds no one.
async function membersChecks(domain: string): Promise<Check[]> {
  const url = `${platformOriginOf(domain)}/members`;
  const signedOut = await attempt("members: signed out, the page sends to sign-in", async () => {
    const response = await fetch(url, { redirect: "manual" });
    await response.body?.cancel();
    const location = response.headers.get("location") || "";
    return {
      pass: response.status === 303 && new URL(location, url).pathname.startsWith("/sign-in"),
      detail: `${response.status} to ${location}`,
    };
  });
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token)
    return [
      signedOut,
      { check: "members: the JSON route", pass: true, detail: "skipped: no stand-in token" },
    ];
  const bearer = { authorization: `Bearer ${token}` };
  const Members = z.object({
    config: z.array(z.unknown()),
    added: z.array(z.object({ email: z.string(), addedBy: z.string(), addedAt: z.number() })),
  });
  const call = async (method: string, body?: unknown, headers: Record<string, string> = bearer) => {
    const response = await fetch(url, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const answer = (await response.json().catch(() => null)) as unknown;
    return {
      status: response.status,
      body: answer,
      error: z.object({ error: z.string() }).safeParse(answer).data?.error || "",
    };
  };
  const email = `smoke-${crypto.randomUUID()}@example.test`;
  const listed = (body: unknown) =>
    Members.safeParse(body).data?.added.some((row) => row.email === email) ?? false;
  const memberKey = process.env.ITERATE_SMOKE_APPROVER_KEY;
  const serviceKey = process.env.ITERATE_SMOKE_SERVICE_KEY;
  const member = memberKey ? await signerOf(domain, memberKey) : null;
  const service = serviceKey ? await signerOf(domain, serviceKey) : null;
  const added = (address: string) =>
    ({ path: "/", type: MEMBER_ADDED, payload: { email: address } }) as const;
  // a stack whose `auth.keys` does not name the smoke keys: the signed checks say so and pass
  const unknown = (error: string) => error.includes("not one this project knows");
  const skip = { pass: true, detail: "skipped: the stack's auth.keys does not name the smoke key" };
  const once = member ? await member.sign(added(email)) : null;
  return [
    signedOut,
    await attempt("members: the JSON route lists the config's members", async () => {
      const { status, body } = await call("GET");
      const members = Members.safeParse(body);
      return {
        pass: status === 200 && members.success && members.data.config.length > 0,
        detail: `${status}, ${members.success ? `${members.data.config.length} config rules, ${members.data.added.length} added` : "no list"}`,
      };
    }),
    await attempt("members: a member's token adds no one", async () => {
      const { status, error } = await call("POST", { email });
      const shown = listed((await call("GET")).body);
      return { pass: status === 403 && !shown, detail: `${status} ${error}; listed ${shown}` };
    }),
    await attempt("members: a service's key adds no one", async () => {
      if (!service) return { pass: true, detail: "skipped: no ITERATE_SMOKE_SERVICE_KEY" };
      const { status, error } = await call("POST", await service.sign(added(email)), {});
      if (unknown(error)) return skip;
      const shown = listed((await call("GET")).body);
      return { pass: status === 403 && !shown, detail: `${status} ${error}; listed ${shown}` };
    }),
    await attempt("members: a member's key adds an address, with no token", async () => {
      if (!once) return { pass: true, detail: "skipped: no ITERATE_SMOKE_APPROVER_KEY" };
      const { status, error } = await call("POST", once, {});
      if (unknown(error)) return skip;
      const shown = listed((await call("GET")).body);
      return { pass: status === 200 && shown, detail: `${status} ${error}; listed ${shown}` };
    }),
    await attempt("members: the same statement again adds no one", async () => {
      if (!once) return { pass: true, detail: "skipped: no ITERATE_SMOKE_APPROVER_KEY" };
      const { status, error } = await call("POST", once, {});
      if (unknown(error)) return skip;
      return {
        pass: status === 403 && error.includes("seen before"),
        detail: `${status} ${error}`,
      };
    }),
    await attempt("members: an address at the project's own domain is refused", async () => {
      if (!member) return { pass: true, detail: "skipped: no ITERATE_SMOKE_APPROVER_KEY" };
      const { status, error } = await call("POST", await member.sign(added(`smoke@${domain}`)), {});
      if (unknown(error)) return skip;
      return { pass: status === 400, detail: `${status} ${error}` };
    }),
    await attempt("members: a member's token removes the added address", async () => {
      const removed = await call("DELETE", { email });
      // 404: nothing was added, on a stack that does not name the smoke key
      return {
        pass:
          (removed.status === 200 && !listed(removed.body)) ||
          (removed.status === 404 && !listed((await call("GET")).body)),
        detail: `${removed.status}`,
      };
    }),
  ];
}
