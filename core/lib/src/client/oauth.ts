import * as oauth from "oauth4webapi";
import { OAuthScopes } from "../oauth-scopes.ts";
import { platformOriginOf, mindAddressCandidatesOf, mindApiUrlOf } from "../mind-api.ts";

/** The platform's issuer as oauth4webapi's authorization server: its endpoints under `/oauth2`, and
 *  the `iss` it adds to every authorization response (RFC 9207), which `validateAuthResponse` then
 *  requires. The CLI's description of the platform it signs in to. */
export function authorizationServer(issuer: string): oauth.AuthorizationServer {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/auth`,
    token_endpoint: `${issuer}/oauth2/token`,
    registration_endpoint: `${issuer}/oauth2/register`,
    authorization_response_iss_parameter_supported: true,
  };
}

/** The same code/PKCE parameters for browser login and a console-minted token. The authorization
 *  endpoint is the issuer's `/oauth2/auth` unless the caller discovered another. */
export async function authorizationCodeRequest(input: {
  issuer: string;
  authorizationEndpoint?: string;
  clientId: string;
  redirectUri: string;
  resources: string[];
  scopes?: string[];
}) {
  const verifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);
  const state = oauth.generateRandomState();
  const url = new URL(input.authorizationEndpoint || new URL("/oauth2/auth", input.issuer).href);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: OAuthScopes.parse(input.scopes || []).join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  for (const resource of input.resources) url.searchParams.append("resource", resource);
  return { url, state, verifier };
}

/** A MIND AS A CLIENT FINDS IT from its address (mind-api.ts): its API origin, which is the
 *  resource every token for it names, and the issuer its API trusts, with the endpoints that
 *  issuer publishes. Plain data, so a browser session can store it. */
export type DiscoveredMind = {
  address: string;
  resource: string;
  issuer: string;
  endpoints: {
    authorization: string;
    token: string;
    revocation?: string;
    registration?: string;
    /** RFC 8628's device authorization endpoint, when the issuer offers the device flow. */
    deviceAuthorization?: string;
  };
  /** The issuer adds `iss` to every authorization response (RFC 9207): the callback then requires
   *  it. */
  issParameter: boolean;
};

/** The discovered issuer as oauth4webapi's authorization server. */
export function authorizationServerOf(mind: DiscoveredMind): oauth.AuthorizationServer {
  return {
    issuer: mind.issuer,
    authorization_endpoint: mind.endpoints.authorization,
    token_endpoint: mind.endpoints.token,
    revocation_endpoint: mind.endpoints.revocation,
    registration_endpoint: mind.endpoints.registration,
    device_authorization_endpoint: mind.endpoints.deviceAuthorization,
    authorization_response_iss_parameter_supported: mind.issParameter,
  };
}

/** FIND A MIND'S ISSUER from its address, by standards alone:
 *   1. the API's protected-resource metadata (RFC 9728) for `https://iterate.<address>/api`, whose
 *      `resource` must be that URL exactly, and whose first `authorization_servers` entry is the
 *      issuer. A default mind's issuer is `https://iterate.<address>`: that is its convention, and
 *      no rule here. A mind names the issuer it chose, on any https host;
 *   2. that issuer's authorization-server metadata (RFC 8414), whose `issuer` must be the issuer
 *      exactly, and whose endpoints are the ones the sign-in uses.
 *  Every URL is https, except an issuer or endpoint on a local origin when `local` (an app in local
 *  development). An error is a sentence a person can act on. */
export async function discoverMind(
  address: string,
  options: { local?: boolean } = {},
): Promise<DiscoveredMind | { error: string }> {
  const resource = mindApiUrlOf(address);
  const allowed = (value: unknown): value is string => {
    if (typeof value !== "string" || !URL.canParse(value)) return false;
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    const loopback =
      ["localhost", "127.0.0.1"].includes(url.hostname) || url.hostname.endsWith(".localhost");
    return Boolean(options.local) && url.protocol === "http:" && loopback;
  };
  const http = (): oauth.HttpRequestOptions<"GET"> => ({
    signal: AbortSignal.timeout(10_000),
    [oauth.allowInsecureRequests]: Boolean(options.local),
  });

  let metadata: oauth.ResourceServer;
  try {
    const response = await oauth.resourceDiscoveryRequest(new URL(resource), http());
    metadata = await oauth.processResourceDiscoveryResponse(new URL(resource), response);
  } catch (error) {
    if (error instanceof oauth.OperationProcessingError)
      return { error: `${address} does not answer as an iterate mind. Check the address.` };
    return { error: `${new URL(resource).host} could not be reached. Check the address.` };
  }
  if (metadata.resource !== resource)
    return { error: `${address} does not answer as an iterate mind. Check the address.` };
  const issuer = metadata.authorization_servers?.[0];
  if (!issuer) return { error: `${address} does not name a sign-in provider.` };
  if (!allowed(issuer))
    return { error: `${address} names a sign-in provider that does not use https.` };

  const issuerHost = new URL(issuer).host;
  let as: oauth.AuthorizationServer;
  try {
    const response = await oauth.discoveryRequest(new URL(issuer), {
      ...http(),
      algorithm: "oauth2",
    });
    as = await oauth.processDiscoveryResponse(new URL(issuer), response);
  } catch (error) {
    if (error instanceof oauth.OperationProcessingError)
      return {
        error: `${issuerHost}, the sign-in provider of ${address}, does not answer as one.`,
      };
    return { error: `${issuerHost}, the sign-in provider of ${address}, could not be reached.` };
  }
  // oauth4webapi compares the two as URLs; the issuer identifier must be the same string
  if (as.issuer !== issuer)
    return { error: `${issuerHost}, the sign-in provider of ${address}, does not answer as one.` };
  const {
    authorization_endpoint,
    token_endpoint,
    revocation_endpoint,
    registration_endpoint,
    device_authorization_endpoint,
  } = as;
  if (!allowed(authorization_endpoint) || !allowed(token_endpoint))
    return {
      error: `${issuerHost}, the sign-in provider of ${address}, does not publish its sign-in endpoints.`,
    };
  return {
    address,
    resource,
    issuer,
    endpoints: {
      authorization: authorization_endpoint,
      token: token_endpoint,
      revocation: allowed(revocation_endpoint) ? revocation_endpoint : undefined,
      registration: allowed(registration_endpoint) ? registration_endpoint : undefined,
      deviceAuthorization: allowed(device_authorization_endpoint)
        ? device_authorization_endpoint
        : undefined,
    },
    issParameter: as.authorization_response_iss_parameter_supported === true,
  };
}

/** THE MIND A TYPED HOST NAMES: each of its candidates (iterate/mind-api
 *  `mindAddressCandidatesOf`) asked in turn, so `example.com` and `iterate.example.com` find one
 *  mind, kept under the address that answered. */
export async function resolveMind(
  host: string,
  discover: (address: string) => Promise<DiscoveredMind | { error: string }> = (address) =>
    discoverMind(address),
): Promise<DiscoveredMind | { error: string }> {
  const candidates = mindAddressCandidatesOf(host);
  const refusals: { error: string }[] = [];
  for (const address of candidates) {
    const found = await discover(address);
    if (!("error" in found)) return found;
    refusals.push(found);
  }
  const [a, b] = candidates.map((address) => new URL(platformOriginOf(address)).host);
  if (!b) return refusals[0] || { error: `${a} does not answer as an iterate mind.` };
  return { error: `Neither ${a} nor ${b} answers as an iterate mind. Check the address.` };
}
