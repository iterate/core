import { withFacts } from "iterate/facts";
import { SECRET_PATH } from "iterate/secret-placeholder";
import type { SecretAnswer, SecretRefusal } from "iterate/workers";
import { admitted, callbackPage, escaped, plainPage, type PageCaller } from "./callback-page.ts";
import { parseSecretOAuthState } from "./secret-oauth.ts";
import {
  notStartedHere,
  startedHere,
  startLinkOf,
  withStartCleared,
} from "./secret-oauth-start.ts";

type CompleteOAuth = (
  path: string,
  input: { code: string; nonce: string; by: PageCaller; cloudProof: string },
) => Promise<SecretAnswer<{ next: string | null; scopes: string[] }> | SecretRefusal>;
type RecordOAuthError = (
  path: string,
  input: { nonce: string; error: string; by: PageCaller },
) => Promise<{ status: "declined" | "failed"; next: string | null }>;

export async function secretOAuthCallback(
  request: Request,
  completeOAuth: CompleteOAuth,
  anyoneWithLinkOf: (path: string, nonce: string) => Promise<boolean>,
  recordOAuthError: RecordOAuthError,
): Promise<Response> {
  const url = new URL(request.url);
  const state = parseSecretOAuthState(url.searchParams.get("state"));
  if (!state || !SECRET_PATH.test(state.path))
    return callbackPage(
      request,
      400,
      "This link is not one the platform issued, or it has expired.",
    );
  const { start } = state;
  if (!start || !(await startedHere(request, start, state.path, state.nonce)))
    return notStartedHere(request);
  const admission = admitted(request, await anyoneWithLinkOf(state.path, state.nonce));
  if (admission instanceof Response) return admission;
  const providerError = url.searchParams.get("error");
  if (providerError) {
    let ended: Awaited<ReturnType<RecordOAuthError>>;
    try {
      ended = await recordOAuthError(state.path, {
        nonce: state.nonce,
        error: providerError,
        by: admission.by,
      });
    } catch (error) {
      return callbackPage(request, 400, error instanceof Error ? error.message : String(error));
    }
    if (ended.status === "declined")
      return withStartCleared(
        ended.next
          ? seeOther(ended.next)
          : callbackPage(request, 200, "You declined. You can close this tab."),
        { start, path: state.path, nonce: state.nonce },
      );
    const again = new URL(startLinkOf(url.origin, state.path, state.nonce));
    return plainPage(
      request,
      400,
      `<p role="alert" data-type="error">${escaped(`The provider could not connect the account. It answered: ${providerError}`)}</p><p><a href="${escaped(again.pathname + again.search)}">Try again</a></p>`,
    );
  }
  const code = url.searchParams.get("code");
  if (!code) return callbackPage(request, 400, "The provider sent no authorization code.");
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
      request,
      400,
      `Storing the tokens for ${state.path} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // the vault refused the grant and kept nothing: its words, and its fact
  if ("refused" in answer)
    return withFacts(
      callbackPage(
        request,
        400,
        `Storing the tokens for ${state.path} failed: ${answer.refused.message}`,
      ),
      answer.facts,
    );
  const page = answer.result.next
    ? seeOther(answer.result.next)
    : callbackPage(
        request,
        200,
        `Done: the secret ${state.path} holds the tokens. You can close this tab.`,
      );
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
