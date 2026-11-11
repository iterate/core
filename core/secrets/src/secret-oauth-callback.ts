import { withFacts } from "iterate/facts";
import { SECRET_PATH } from "iterate/secret-placeholder";
import type { SecretAnswer } from "iterate/workers";
import { admitted, callbackPage, type PageCaller } from "./callback-page.ts";
import { parseSecretOAuthState } from "./secret-oauth.ts";
import { notStartedHere, startedHere, withStartCleared } from "./secret-oauth-start.ts";

type CompleteOAuth = (
  path: string,
  input: { code: string; nonce: string; by: PageCaller; cloudProof: string },
) => Promise<SecretAnswer<{ next: string | null; scopes: string[] }>>;

export async function secretOAuthCallback(
  request: Request,
  completeOAuth: CompleteOAuth,
  anyoneWithLinkOf: (path: string, nonce: string) => Promise<boolean>,
): Promise<Response> {
  const url = new URL(request.url);
  const state = parseSecretOAuthState(url.searchParams.get("state"));
  if (!state || !SECRET_PATH.test(state.path))
    return callbackPage(400, "This link is not one the platform issued, or it has expired.");
  const { start } = state;
  if (!start || !(await startedHere(request, start, state.path, state.nonce)))
    return notStartedHere();
  const admission = admitted(request, await anyoneWithLinkOf(state.path, state.nonce));
  if (admission instanceof Response) return admission;
  const denied = url.searchParams.get("error");
  if (denied) return callbackPage(400, `The provider declined: ${denied}`);
  const code = url.searchParams.get("code");
  if (!code) return callbackPage(400, "The provider sent no authorization code.");
  let answer: Awaited<ReturnType<CompleteOAuth>>;
  try {
    answer = await completeOAuth(state.path, {
      code,
      nonce: state.nonce,
      by: admission.by,
      cloudProof: url.searchParams.get("cloud_proof") || "",
    });
  } catch (error) {
    return callbackPage(
      400,
      `Storing the tokens for ${state.path} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // `next` was checked against the platform's and the project's origins when the attempt began.
  const page = answer.result.next
    ? new Response(null, {
        status: 303,
        headers: { location: answer.result.next, "cache-control": "no-store" },
      })
    : callbackPage(200, `Done: the secret ${state.path} holds the tokens. You can close this tab.`);
  return withFacts(
    await withStartCleared(page, { start, path: state.path, nonce: state.nonce }),
    answer.facts,
  );
}
