import { stampCaller, type ItxHostRootContext } from "core-itx";
import { env } from "cloudflare:workers";
import type { SecretOperation, SecretRefresh, SecretUses } from "iterate/api";
import { codedError, releasedAnswer } from "iterate/lib";
import { recordFacts } from "iterate/facts";
import {
  assertSecretPath,
  SECRET_HELD_HEADER,
  SECRET_OAUTH_CALLBACK_PATH,
  SECRET_PATH,
  secretPathsReferenced,
  VAULT_ANSWER_HEADER,
} from "iterate/secret-placeholder";
import type { ReachableContext } from "core-itx";
import { platformOriginOf } from "iterate/mind-api";
import type {
  Door,
  GrantRefreshed,
  SecretAnswer,
  SecretDescription,
  SecretRefusal,
  SecretVerb,
  SecretVerbs,
} from "iterate/workers";
import { keepCloudflareToken } from "./cloudflare-token.ts";
import { hopCaller } from "./hop-caller.ts";

export const SECRETS_ROOT_DESCRIPTION =
  'the mind\'s secrets, kept in the secrets Worker: `secrets.set("/secrets/<name>", material, { urls, refresh?, public? })` · `delete(path)` · `describe(path)` → { set, urls, refresh, public } · `list()` · `cloud()` → { origin, clients } | null, the stack\'s iterate Cloud and the names of the clients it offers for `beginOAuth(path, { client: { cloud } })` · `refreshGrants()` → [{ path, outcome }] refreshes each grant of a person that the iterate Cloud brokers (the schedule of the mind calls it once a day) · `collectFromUser({ path, egress: { urls }, description?, fields?, redirectUrl? })` → { url } a person opens to type the value · `beginOAuth(path, { authorizationEndpoint, tokenEndpoint, clientId, clientSecret?, scope?, urls?, next? })` → { authorizationUrl, nonce } · `oauthResult(path, { nonce })` · `oauthCallbackUrl()` · `signHmac(path, { payload, field?, encoding? })` · `verifyHmac(path, { payload, signature, field? })` · `verifyEquals(path, { value, field? })` · `generateSigningKey(path, { statementPaths? })` → { publicKey, keyId }, a P-256 key that never leaves · `signStatement(path, { mind, path, type, payload?, expiresInSeconds? })` → an envelope that a mind\'s /statements takes; use one in `itx.fetch` as `getSecret("/secrets/<name>")` in a header (or the URL), sent only to its `urls`. Each fact lands on `/secrets/<name>`. What a secret may be used for is fixed when it is made (`set`, `collectFromUser`, `beginOAuth`) and shown to whoever gives it: `placement: "url"` lets its placeholder sit in a URL, else headers alone; `operations: ["signHmac", …]` names the operations it answers, else none, each limited per minute; `statementPaths: ["/integrations/"]` limits the paths `signStatement` may name; `lendTo: ["/secrets/<name>", …]` names the secrets whose refresh may borrow it as a client secret or an App key, else none; `anyoneWithLink: true` lets anyone holding the link fill the form or consent, else a signed-in member alone';

/** How many of the vault's sessions `list()` has open at once, where it asks path by path. */
const DESCRIBED_AT_ONCE = 16;

/** How many calls of the vault one `refreshGrants()` makes: each refreshes twenty grants. */
const MOST_REFRESH_CALLS = 50;

/** Whether a call failed because its receiver has no such verb: a Worker from before the verb. */
const isNoSuchVerb = (error: unknown) =>
  error instanceof Error && /does not implement|is not a function/.test(error.message);

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
  const describe = (path: string) => call("describe", path, undefined);
  const operated =
    (verb: Exclude<SecretOperation, "signStatement">) =>
    (path: string, input: unknown): Promise<string | boolean> =>
      record<string | boolean>(call(verb, path, input));
  /** Every path of a secret that the mind's `/secrets` log names, a deleted secret's too. */
  const knownPaths = async (): Promise<string[]> => {
    const parent = context.context("/secrets");
    const paths = new Set<string>();
    for (let after = 0; ;) {
      const page = await parent.read(after, 500);
      for (const event of page.events) {
        // Read as a field that may be there: a `child-created` event has it, any other payload
        // has not, and the check below takes it only as a string.
        const childPath = (event.payload as { childPath?: unknown } | undefined)?.childPath;
        if (
          event.type === "events.iterate.com/itx/child-created" &&
          typeof childPath === "string" &&
          SECRET_PATH.test(childPath)
        )
          paths.add(childPath);
      }
      if (page.atHead || page.scannedThroughOffset <= after) break;
      after = page.scannedThroughOffset;
    }
    return [...paths].sort();
  };
  const set = (
    path: string,
    material: unknown,
    options?: { urls?: string[]; refresh?: SecretRefresh; public?: string[] } & SecretUses,
  ) => record(call("set", path, { ...options, material }));
  const remove = (path: string) => record(call("delete", path, undefined));
  return {
    set,
    delete: remove,
    describe,
    keepCloudflareToken: () =>
      keepCloudflareToken(
        { describe, set, delete: remove },
        env.CLOUDFLARE_TOKEN && env.CLOUDFLARE_TOKEN_ID
          ? { token: env.CLOUDFLARE_TOKEN, tokenId: env.CLOUDFLARE_TOKEN_ID }
          : undefined,
      ),
    // The secrets that are set, in one call of the vault. The paths that the mind's log names go
    // along as `known`: core/secrets-worker/src/secret-list.ts says what the vault does with them.
    list: async (): Promise<SecretDescription[]> => {
      const known = await knownPaths();
      try {
        return await releasedAnswer(egress.listSecrets(known));
      } catch (error) {
        if (!isNoSuchVerb(error)) throw error;
      }
      // A boundary from before the vault kept its list: a home lab's Workers deploy apart from
      // its mind, and a stack's deploy swaps its Workers one after another. Each path is asked,
      // a few at a time, since each is one call of the vault.
      const described: SecretDescription[] = [];
      for (let from = 0; from < known.length; from += DESCRIBED_AT_ONCE)
        described.push(
          ...(await Promise.all(known.slice(from, from + DESCRIBED_AT_ONCE).map(describe))),
        );
      return described.filter((secret) => secret.set);
    },
    // The stack's iterate Cloud and the clients it publishes. A boundary from before the verb
    // (a stack's deploy swaps its Workers one after another) answers as a stack with no Cloud.
    cloud: async () => {
      try {
        return await releasedAnswer(egress.cloud());
      } catch (error) {
        if (!isNoSuchVerb(error)) throw error;
        return null;
      }
    },
    // The persons' grants that the Cloud brokers, refreshed now: the mind's schedule calls it
    // once a day (core/secrets-worker/src/grant-refresh.ts says why). One call of the vault, and
    // each grant's outcome is a fact on that secret's log.
    refreshGrants: async () => {
      const known = await knownPaths();
      const grants: GrantRefreshed[] = [];
      // The vault refreshes twenty at a time and says where it stopped: the mind goes on from
      // there, so every grant is reached, and each one's row is in the answer.
      for (let after: string | undefined, calls = 0; calls < MOST_REFRESH_CALLS; calls += 1) {
        const walked = await record(releasedAnswer(egress.refreshGrants(known, after)));
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
    oauthCallbackUrl: async () => `${platformOriginOf(env.DOMAIN)}${SECRET_OAUTH_CALLBACK_PATH}`,
    signHmac: operated("signHmac"),
    verifyHmac: operated("verifyHmac"),
    verifyEquals: operated("verifyEquals"),
    deriveSharedSecret: operated("deriveSharedSecret"),
    publicKeyOf: operated("publicKeyOf"),
    signWithKey: operated("signWithKey"),
    signStatement: (path: string, input: unknown) => record(call("signStatement", path, input)),
    generateSigningKey: (path: string, options: unknown) =>
      record(call("generateSigningKey", path, options ?? {})),
  };
}

// A fact that does not land is reported and the Response still goes on: the request was sent, and
// the secrets Worker's own log holds the use.
export async function sendRecordingSecretFacts(
  request: Request,
  egress: Door,
  contextOf: (path: string) => ReachableContext,
): Promise<Response> {
  const recorded = async (response: Response) => {
    const { answer, recorded } = recordFacts(response, (path, events) =>
      contextOf(path).append(...events),
    );
    await recorded;
    return answer;
  };
  const named = secretPathsReferenced(request).length > 0;
  const headers = new Headers(request.headers);
  const answer = await recorded(await egress.fetch(request));
  if (!named || answer.headers.get(VAULT_ANSWER_HEADER) !== "held") return answer;
  headers.set(SECRET_HELD_HEADER, ((await answer.json()) as { digest: string }).digest);
  headers.delete("content-length");
  return recorded(
    await egress.fetch(new Request(request.url, { method: request.method, headers })),
  );
}
