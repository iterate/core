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
type DeclineOAuth = (
  path: string,
  input: { nonce: string; error: string; by: PageCaller },
) => Promise<{ next: string | null }>;

export async function secretOAuthCallback(
  request: Request,
  completeOAuth: CompleteOAuth,
  anyoneWithLinkOf: (path: string, nonce: string) => Promise<boolean>,
  declineOAuth: DeclineOAuth,
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
  // Only `access_denied` is the person's no (RFC 6749 §4.1.2.1), which `declineOAuth` keeps; any
  // other error is the provider's or the client's fault, and records nothing.
  const denied = url.searchParams.get("error");
  if (denied && denied !== "access_denied")
    return callbackPage(400, `The provider could not authorize: ${denied}`);
  if (denied) {
    let declined: Awaited<ReturnType<DeclineOAuth>>;
    try {
      declined = await declineOAuth(state.path, {
        nonce: state.nonce,
        error: denied,
        by: admission.by,
      });
    } catch (error) {
      return callbackPage(400, error instanceof Error ? error.message : String(error));
    }
    return withStartCleared(
      declined.next
        ? seeOther(declined.next)
        : callbackPage(200, "You declined. You can close this tab."),
      { start, path: state.path, nonce: state.nonce },
    );
  }
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
  const page = answer.result.next
    ? seeOther(answer.result.next)
    : callbackPage(200, `Done: the secret ${state.path} holds the tokens. You can close this tab.`);
  return withFacts(
    await withStartCleared(page, { start, path: state.path, nonce: state.nonce }),
    answer.facts,
  );
}

// `next` was checked against the platform's and the mind's origins when the attempt began.
function seeOther(next: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: next, "cache-control": "no-store" },
  });
}
