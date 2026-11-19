import { stampCaller, type ItxHostRootContext } from "core-itx";
import { env, waitUntil } from "cloudflare:workers";
import type { SecretOperation, SecretRefresh, SecretUses, StackClientName } from "iterate/api";
import { codedError, releasedAnswer, reportIssue } from "iterate/lib";
import { recordFacts } from "iterate/facts";
import {
  assertSecretPath,
  SECRET_HELD_HEADER,
  SECRET_OAUTH_CALLBACK_PATH,
  secretPathsReferenced,
  VAULT_ANSWER_HEADER,
} from "iterate/secret-placeholder";
import type { ReachableContext } from "core-itx";
import { controlPlaneOriginOf } from "iterate/mind-config";
import type {
  Door,
  GrantRefreshed,
  SecretAnswer,
  SecretDescription,
  SecretRefusal,
  SecretVerb,
  SecretVerbs,
} from "iterate/workers";
import { mindWorkerConfigOf } from "../config.ts";
import { hopCaller } from "./hop-caller.ts";

export const SECRETS_ROOT_DESCRIPTION =
  'the mind\'s secrets, kept in the secrets Worker: `secrets.set("/secrets/<name>", material, { urls, refresh?, public? })` · `delete(path)` · `deleteIfProxy(path)` → { path, deleted }, a delete only while it goes by proxy with nothing in flight · `describe(path)` → { set, urls, refresh, public } · `list()` · `cloud(origin)` → { origin, clients }, the iterate Cloud at that origin (iterate\'s own is https://cloud.iterate.com) and the names of the clients it offers for `beginOAuth(path, { client: { cloud, origin } })` · `refreshGrants()` → [{ path, outcome }] refreshes each grant of a person that the iterate Cloud brokers (the schedule of the mind calls it once a day) · `collectFromUser({ path, egress: { urls }, description?, fields?, redirectUrl? })` → { url } a person opens to type the value · `beginOAuth(path, { authorizationEndpoint, tokenEndpoint, clientId, clientSecret?, scope?, urls?, next?, straightToProvider? })` → { authorizationUrl, nonce }, `straightToProvider: true` sends the start link straight to the provider\'s consent, with no page of the platform\'s before it · `oauthResult(path, { nonce })` → { status: "pending" | "complete" | "declined" | "failed" | "unavailable" }, "declined" with the provider\'s `error` once the person said no, "failed" with any other `error` the provider sent back · `oauthCallbackUrl()` · `signHmac(path, { payload, field?, encoding?, derive?: { info } })` · `verifyHmac(path, { payload, signature, field?, derive? })` · `verifyEquals(path, { value, field? })` · `generateSigningKey(path, { statementPaths? })` → { publicKey, keyId }, a P-256 key that never leaves · `signStatement(path, { mind, path, type, payload?, expiresInSeconds? })` → an envelope that a mind\'s /statements takes · `seal(path, { info, plaintext })` → "sealed.<iv>.<ciphertext>" · `unseal(path, { info, sealed })` → the plaintext, AES-256-GCM under a key HKDF derives for `info`, as `derive` does; use one in `itx.fetch` as `getSecret("/secrets/<name>")` in a header (or the URL), sent only to its `urls`, or `getSecret("/secrets/<name>", { appJwt: true })` in the Authorization header to https://api.github.com, a GitHub App JWT from its `appId` and `privateKey`. Each fact lands on `/secrets/<name>`. What a secret may be used for is fixed when it is made (`set`, `collectFromUser`, `beginOAuth`) and shown to whoever gives it: `placement: "url"` lets its placeholder sit in a URL, else headers alone; `operations: ["signHmac", …]` names the operations it answers, else none, each limited per minute; `statementPaths: ["/integrations/"]` limits the paths `signStatement` may name; `lendTo: ["/secrets/<name>", …]` names the secrets whose refresh may borrow it as a client secret or an App key, else none; `anyoneWithLink: true` lets anyone holding the link fill the form or consent, else a signed-in member alone';

/** How many calls of the vault one `refreshGrants()` makes: each refreshes twenty grants. */
const MOST_REFRESH_CALLS = 50;

export function secretsRoot(context: ItxHostRootContext, egress: Door) {
  const record = async <T>(answer: Promise<SecretAnswer<T> | SecretRefusal>): Promise<T> => {
    const answered = await answer;
    const stamped = hopCaller(context);
    for (const { path, events } of answered.facts)
      await context
        .context(path)
        .append(...events.map((event) => stampCaller(event, stamped, context.path)));
    if ("refused" in answered) throw codedError(answered.refused.code, answered.refused.message);
    return answered.result;
  };
  const call = <V extends SecretVerb>(verb: V, path: string, input: SecretVerbs[V]["input"]) =>
    releasedAnswer(egress.secret(assertSecretPath(path), verb, input));
  const operated =
    (verb: Exclude<SecretOperation, "signStatement">) =>
    (path: string, input: unknown): Promise<string | boolean> =>
      record<string | boolean>(call(verb, path, input));
  return {
    set: (
      path: string,
      material: unknown,
      options?: { urls?: string[]; refresh?: SecretRefresh; public?: string[] } & SecretUses,
    ) => record(call("set", path, { ...options, material })),
    delete: (path: string) => record(call("delete", path, undefined)),
    deleteIfProxy: (path: string) => record(call("deleteIfProxy", path, undefined)),
    describe: (path: string) => call("describe", path, undefined),
    // The secrets that are set, in one call of the vault, which keeps their paths
    // (core/secrets-worker/src/secret-list.ts).
    list: (): Promise<SecretDescription[]> => releasedAnswer(egress.listSecrets()),
    // The iterate Cloud at the origin that the caller names, and the clients it publishes.
    cloud: (origin: string) => releasedAnswer(egress.cloud(origin)),
    // Whether the stack has its own OAuth client at Cloudflare: never its id or its secret.
    hasStackClient: (name: StackClientName["stack"]) => egress.hasStackClient(name),
    // The persons' grants that the Cloud brokers, refreshed now: the mind's schedule calls it
    // once a day (core/secrets-worker/src/grant-refresh.ts says why). Each grant's outcome is a
    // fact on that secret's log.
    refreshGrants: async () => {
      const grants: GrantRefreshed[] = [];
      // The vault refreshes twenty at a time and says where it stopped: the mind goes on from
      // there, so every grant is reached, and each one's row is in the answer.
      for (let after: string | undefined, calls = 0; calls < MOST_REFRESH_CALLS; calls += 1) {
        const walked = await record(releasedAnswer(egress.refreshGrants(after)));
        grants.push(...walked.grants);
        if (!walked.next) return grants;
        after = walked.next;
      }
      throw codedError(
        "UNAVAILABLE",
        `secrets.refreshGrants: more grants than ${MOST_REFRESH_CALLS} calls of the vault reach; ${grants.length} were asked, the last at ${grants.at(-1)?.path}`,
      );
    },
    importSealed: (path: string, cell: string, proof: string) =>
      record(call("importSealed", path, { cell, proof })),
    exportSealed: (path: string, proof: string, until: number) =>
      record(call("exportSealed", path, { proof, until })),
    collectFromUser: (input: { path?: unknown } & Record<string, unknown>) => {
      const { path, ...rest } = input ?? {};
      return call("collectFromUser", String(path), rest);
    },
    beginOAuth: (path: string, options: unknown) => record(call("beginOAuth", path, options)),
    oauthResult: (path: string, input: { nonce: string }) => call("oauthResult", path, input),
    oauthCallbackUrl: async () =>
      `${controlPlaneOriginOf(mindWorkerConfigOf(env))}${SECRET_OAUTH_CALLBACK_PATH}`,
    signHmac: operated("signHmac"),
    verifyHmac: operated("verifyHmac"),
    verifyEquals: operated("verifyEquals"),
    deriveSharedSecret: operated("deriveSharedSecret"),
    publicKeyOf: operated("publicKeyOf"),
    signWithKey: operated("signWithKey"),
    signStatement: (path: string, input: unknown) => record(call("signStatement", path, input)),
    generateSigningKey: (path: string, options: unknown) =>
      record(call("generateSigningKey", path, options ?? {})),
    seal: operated("seal"),
    unseal: operated("unseal"),
  };
}

// A fact that does not land is reported and the Response still goes on: the request was sent, and
// the secrets Worker's own log holds the use. The answer goes back at once and the fact lands within
// one append after it, so code that reads the log right after its `fetch` may not see it yet. A held
// answer waits for its facts: a person reads them next.
export async function sendRecordingSecretFacts(
  request: Request,
  egress: Door,
  contextOf: (path: string) => ReachableContext,
  context: string,
): Promise<Response> {
  // the audit of a use: a fact that did not land names the secret and the calling context alone
  const recorded = async (response: Response, held: boolean) => {
    const { answer, recorded } = recordFacts(response, (secret, events) =>
      contextOf(secret)
        .append(...events)
        .catch((error: unknown) =>
          reportIssue("secret.fact-not-recorded", error, { secret, context }),
        ),
    );
    if (held) await recorded;
    else waitUntil(recorded);
    return answer;
  };
  const named = secretPathsReferenced(request).length > 0;
  const headers = new Headers(request.headers);
  const first = await egress.fetch(request);
  const held = named && first.headers.get(VAULT_ANSWER_HEADER) === "held";
  const answer = await recorded(first, held);
  if (!held) return answer;
  headers.set(SECRET_HELD_HEADER, ((await answer.json()) as { digest: string }).digest);
  headers.delete("content-length");
  return recorded(
    await egress.fetch(new Request(request.url, { method: request.method, headers })),
    true,
  );
}
