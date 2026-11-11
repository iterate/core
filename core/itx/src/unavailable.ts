import { codedError, errorCode, LOOP_LIMIT_HEADER, reportIssue } from "iterate/lib";
import {
  failureKind,
  isPlatformFailureKind,
  logPlatformFailure,
  RETRY_AFTER_MS,
  type PlatformFailureKind,
} from "iterate/platform-retry";

export const unavailableError = (kind: PlatformFailureKind, message: string) =>
  codedError("UNAVAILABLE", message, { kind, retryAfterMs: RETRY_AFTER_MS[kind] });

export function unavailable(error: unknown): unknown {
  const kind = failureKind(error);
  if (!isPlatformFailureKind(kind) || errorCode(error)) return error;
  return unavailableError(kind, error instanceof Error ? error.message : String(error));
}

function unavailableAnswer(
  error: unknown,
): { status: 502 | 503; headers: Record<string, string> } | undefined {
  if (errorCode(error) === "RPC_STUB_OFFLINE") return { status: 502, headers: {} };
  const kind = failureKind(error);
  if (!isPlatformFailureKind(kind)) return undefined;
  return {
    status: 503,
    headers: { "retry-after": String(RETRY_AFTER_MS[kind] / 1000), "cache-control": "no-store" },
  };
}

export function expressionFetchErrorAnswer(error: unknown, itxExpression: string): Response {
  const code = errorCode(error);
  const unavailable = unavailableAnswer(error);
  if (code === "LOOP_LIMIT")
    return new Response(`508: ${(error as Error).message}\n`, {
      status: 508,
      headers: { [LOOP_LIMIT_HEADER]: "recorded" },
    });
  const status =
    code === "NO_ITX_EXPRESSION_MATCH"
      ? 404
      : code === "FACET_NO_UPGRADE" || code === "INVALID_INPUT"
        ? 400
        : (unavailable?.status ?? 500);
  if (status === 500)
    reportIssue("iterate-context.expression-fetch", error, {
      itxExpression,
    });
  // The prd fault alarm (scripts/ci/prd-fault-alarm.ts) matches these events: an offline stub and
  // a deploy reset are expected and logged at info; any other platform failure is counted.
  const kind = failureKind(error);
  if (status === 502 || kind === "deploy-reset")
    console.info({
      event: status === 502 ? "expression-fetch.rpc-stub-offline" : "expression-fetch.deploy-reset",
      itxExpression,
    });
  else if (isPlatformFailureKind(kind))
    logPlatformFailure("expression-fetch", "answered", kind, {
      name: "expression-fetch",
      itxExpression,
      message: String(error),
    });
  const message = error instanceof Error ? error.message : String(error);
  return new Response(`expression fetch error: ${message}\n`, {
    status,
    headers: {
      ...unavailable?.headers,
      ...(status === 502 && { "x-iterate-rpc-stub-offline": itxExpression }),
    },
  });
}
