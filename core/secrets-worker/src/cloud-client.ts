// cloud-client.ts — A CLIENT THAT IS ITERATE CLOUD'S: iterate's own app at a provider (GitHub,
// Google, X), which every deployment shares. The app exists once, so its client secret and a GitHub
// App's key stay at the Cloud (internal-packages/cloud-clients on `main`). The tokens are this deployment's
// and stay here, in the secret. This file is everything the vault knows of the Cloud:
//
//   cloudOriginOf   a Cloud's address as a caller named it: an exact `https:` origin, or refused
//                   (./secrets.ts, beside the pin's own parser)
//   cloudClientOf   the client's public facts, read from the Cloud at that origin
//   brokered        a request to the Cloud's broker, signed by the stack's own key
//   askOf           whether a mind's request is an ask of the Cloud, about a client it connected
//   cloudPinRefusal whether a secret that holds a token the Cloud mints is pinned within the
//                   client's hosts
//
// THE CLOUD ADDS THE CLIENT SECRET to a token request it is sent, and answers the provider's
// tokens: the access token as it came, the refresh token sealed so that only this deployment can
// spend it, there. It knows which deployment asks by the statement on the request, signed by the
// key the auth Worker keeps (`AuthService.sign`), whose public half the Cloud reads at
// `https://<controlPlaneHostname>/keys/stack.json`. No token of the Cloud's is held here, and none of ours there.
//
// WHICH CLOUD, THE SECRET SAYS. No config of the stack names one. The code that makes a secret
// names the Cloud's origin (`client: { cloud, origin }`, iterate/api `CloudClientName`), and the
// secret's record keeps it: every request of that secret through a Cloud goes to that origin
// alone (./secret/durable-object.ts). So a refresh token that one Cloud sealed is never sent to
// another address, whatever a later call names. Another origin is another secret.
import type { CloudClientName } from "iterate/api";
import { codedError, leavingTheStack } from "iterate/lib";
import { z } from "zod";
import { originsOf, sha256Hex } from "./secrets.ts";

/** The header a brokered request carries: base64url of the signed statement's JSON. */
const STATEMENT_HEADER = "iterate-statement";

/** What the Cloud publishes of one client (`GET <cloud>/.well-known/iterate-cloud`). */
const CloudClient = z.object({
  clientId: z.string().min(1),
  /** The provider's consent page. */
  authorizationEndpoint: z.url({ protocol: /^https$/ }),
  /** The Cloud's page a person confirms on before the provider's (secret-oauth-start.ts). */
  beginEndpoint: z.url().optional(),
  /** The Cloud's own callback: the one redirect URI the app has at the provider. */
  redirectUri: z.url(),
  /** The Cloud's broker for the code exchange and the refresh. */
  tokenEndpoint: z.url(),
  /** The provider's hosts: the pin of a secret that holds this client's tokens. */
  urls: z.array(z.url()).min(1),
  scopes: z.array(z.string()).optional(),
  /** A GitHub App's install page, and where the Cloud mints an installation's token. */
  installUrl: z.url({ protocol: /^https$/ }).optional(),
  installationTokenEndpoint: z.url().optional(),
});
export type CloudClient = z.infer<typeof CloudClient> & { name: string };

/** The Cloud's client `name`, as the Cloud at `origin` publishes it. Every address the Cloud names
 *  for itself must be on `origin`: the secret names that Cloud, and no other host gets a code or a
 *  sealed token. */
export async function cloudClientOf(origin: string, name: string): Promise<CloudClient> {
  // a redirect is no answer, and is refused below: workerd follows one or hands it back
  const answer = await fetch(`${origin}/.well-known/iterate-cloud`, { redirect: "manual" });
  const facts: unknown = answer.ok ? await answer.json().catch(() => null) : null;
  const parsed = z.object({ clients: z.record(z.string(), z.unknown()) }).safeParse(facts);
  const client = CloudClient.safeParse(parsed.data?.clients[name]);
  if (!client.success)
    throw codedError(
      "INVALID_INPUT",
      `secrets: the Cloud at ${origin} has no client ${JSON.stringify(name)}${parsed.success ? ` (it has ${Object.keys(parsed.data.clients).join(", ") || "none"})` : ""}`,
    );
  const { beginEndpoint, redirectUri, tokenEndpoint, installationTokenEndpoint } = client.data;
  const own = [beginEndpoint, redirectUri, tokenEndpoint, installationTokenEndpoint];
  if (own.some((url) => url && new URL(url).origin !== origin))
    throw codedError(
      "INVALID_INPUT",
      `secrets: the Cloud at ${origin} names another host as its own`,
    );
  return { ...client.data, name };
}

/** A TOKEN THE CLOUD MINTS GOES TO THE CLIENT'S HOSTS ALONE: the secret that holds it is pinned
 *  within the `urls` the Cloud publishes for the client, as a connect through the Cloud pins its
 *  grant (secret-oauth.ts). Answers why a pin is refused, or null for a pin within them. */
export function cloudPinRefusal(urls: readonly string[], client: CloudClient): string | null {
  const hosts = originsOf(client.urls);
  const outside = urls.filter((url) => !hosts.includes(url));
  if (!outside.length) return null;
  return `secrets: the Cloud's client ${client.name} mints this secret's token, which goes to ${hosts.join(", ")} alone, not ${outside.join(", ")}`;
}

/** The Cloud at `origin` and the names of the clients it publishes: none when the Cloud gave no
 *  list. */
export async function cloudOffered(origin: string): Promise<{ origin: string; clients: string[] }> {
  const answer = await fetch(`${origin}/.well-known/iterate-cloud`, { redirect: "manual" }).catch(
    () => null,
  );
  const parsed = z
    .object({ clients: z.record(z.string(), z.unknown()) })
    .safeParse(answer?.ok ? await answer.json().catch(() => null) : null);
  return { origin, clients: Object.keys(parsed.data?.clients || {}) };
}

/** What the vault asks of the auth Worker: a statement signed by the stack's own key. */
export type StatementSigner = (input: {
  path: string;
  type: string;
  payload: Record<string, unknown>;
  expiresInSeconds: number;
}) => Promise<{ statement: string; signature: unknown }>;

/** A FETCH TOWARD THE CLOUD'S BROKER for the client `name`: the request must be for `origin`, the
 *  Cloud the secret names, and goes with a statement over this very request (the client and the
 *  hash of the body), good for five minutes. `type` says what is asked: the event type the Cloud
 *  expects on that route. */
export function brokered(
  sign: StatementSigner,
  origin: string,
  name: string,
  type: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (new URL(request.url).origin !== origin)
      throw new Error(`the broker ${new URL(request.url).origin} is not this secret's Cloud`);
    const body = await request.clone().text();
    const signed = await sign({
      path: "/",
      type,
      // which Cloud, which client, which route and which body: a statement is for one request
      payload: {
        audience: origin,
        client: name,
        path: new URL(request.url).pathname,
        body: await sha256Hex(body),
      },
      expiresInSeconds: 300,
    });
    const headers = new Headers(request.headers);
    headers.set(STATEMENT_HEADER, Buffer.from(JSON.stringify(signed)).toString("base64url"));
    // never followed: the statement and a sealed token go to the Cloud's own host alone
    return fetch(leavingTheStack(new Request(request, { headers, redirect: "manual" })));
  };
}

/** AN ASK OF THE CLOUD: a request from the mind to `<cloud>/clients/<name>/ask/…`, naming a
 *  secret that was connected through that client of that Cloud (`client`, as the secret keeps
 *  it) (an answer to a message the Cloud's bot relayed,
 *  say). It uses no token: the placeholder only says which connection asks, so the request leaves
 *  with no header that names the secret, signed by the stack's key. The Cloud's other routes, where
 *  a code is exchanged and a token is minted, are the vault's own to call, never the mind's.
 *  Answers the client, or null for any other request: one to another Cloud's address too. */
export function askOf(request: Request, client: CloudClientName | undefined) {
  const url = new URL(request.url);
  return client &&
    url.origin === client.origin &&
    url.pathname.startsWith(`/clients/${client.cloud}/ask/`)
    ? client
    : null;
}
