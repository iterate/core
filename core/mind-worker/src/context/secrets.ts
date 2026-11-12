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
  SecretAnswer,
  SecretDescription,
  SecretRefusal,
  SecretVerb,
  SecretVerbs,
} from "iterate/workers";
import { hopCaller } from "./hop-caller.ts";

export const SECRETS_ROOT_DESCRIPTION =
  'the mind\'s secrets, kept in the secrets Worker: `secrets.set("/secrets/<name>", material, { urls, refresh?, public? })` · `delete(path)` · `describe(path)` → { set, urls, refresh, public } · `list()` · `collectFromUser({ path, egress: { urls }, description?, fields?, redirectUrl? })` → { url } a person opens to type the value · `beginOAuth(path, { authorizationEndpoint, tokenEndpoint, clientId, clientSecret?, scope?, urls?, next? })` → { authorizationUrl, nonce } · `oauthResult(path, { nonce })` · `oauthCallbackUrl()` · `signHmac(path, { payload, field?, encoding? })` · `verifyHmac(path, { payload, signature, field? })` · `verifyEquals(path, { value, field? })`; use one in `itx.fetch` as `getSecret("/secrets/<name>")` in a header (or the URL), sent only to its `urls`. Each fact lands on `/secrets/<name>`. What a secret may be used for is fixed when it is made (`set`, `collectFromUser`, `beginOAuth`) and shown to whoever gives it: `placement: "url"` lets its placeholder sit in a URL, else headers alone; `operations: ["signHmac", …]` names the operations it answers, else none, each limited per minute; `lendTo: ["/secrets/<name>", …]` names the secrets whose refresh may borrow it as a client secret or an App key, else none; `anyoneWithLink: true` lets anyone holding the link fill the form or consent, else a signed-in member alone';

/** How many of the vault's sessions `list()` has open at once, where it asks path by path. */
const DESCRIBED_AT_ONCE = 16;

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
    (verb: SecretOperation) =>
    (path: string, input: unknown): Promise<string | boolean> =>
      record<string | boolean>(call(verb, path, input));
  return {
    set: (
      path: string,
      material: unknown,
      options?: { urls?: string[]; refresh?: SecretRefresh; public?: string[] } & SecretUses,
    ) => record(call("set", path, { ...options, material })),
    delete: (path: string) => record(call("delete", path, undefined)),
    describe,
    // The secrets that are set, in one call of the vault. The paths that the mind's log names go
    // along as `known`: core/secrets-worker/src/secret-list.ts says what the vault does with them.
    list: async (): Promise<SecretDescription[]> => {
      const parent = context.context("/secrets");
      const paths = new Set<string>();
      for (let after = 0; ;) {
        const page = await parent.read(after, 500);
        for (const event of page.events) {
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
      const known = [...paths].sort();
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
    importSealed: (path: string, cell: string, proof: string) =>
      record(call("importSealed", path, { cell, proof })),
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
