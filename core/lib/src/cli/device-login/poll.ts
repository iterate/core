/** One poll of the token endpoint, as `pollUntilAnswered` reads it: the tokens; RFC 8628 §3.5's
 *  `authorization_pending` or `slow_down`; a failure worth trying again (no answer, or a 5xx); or
 *  any other OAuth error, which ends the sign-in. */
export type PollAnswer<T> =
  | { kind: "tokens"; value: T }
  | { kind: "pending" }
  | { kind: "slow-down" }
  | { kind: "transient"; reason: string }
  | { kind: "refused"; error: string; description?: string };

/** Poll at once, then every `intervalSeconds` (RFC 8628 §3.5: five seconds more after each
 *  `slow_down`), until the tokens or a refusal. A failure worth trying again waits its own backoff,
 *  from the interval doubling to 30 s, and is reported through `onRetry`. Ends with an error at
 *  `deadline` (epoch ms): the code's expiry, five minutes at most. */
export async function pollUntilAnswered<T>(input: {
  intervalSeconds: number;
  deadline: number;
  poll: () => Promise<PollAnswer<T>>;
  onRetry: (reason: string, waitMs: number) => void;
}): Promise<T> {
  let intervalMs = input.intervalSeconds * 1000;
  let backoffMs = intervalMs;
  for (;;) {
    const answer = await input.poll();
    if (answer.kind === "tokens") return answer.value;
    if (answer.kind === "refused")
      throw new Error(refusalMessage(answer.error, answer.description));
    if (answer.kind === "slow-down") intervalMs += 5_000;
    const waitMs = answer.kind === "transient" ? backoffMs : intervalMs;
    backoffMs = answer.kind === "transient" ? Math.min(backoffMs * 2, 30_000) : intervalMs;
    if (Date.now() + waitMs > input.deadline) throw new Error(refusalMessage("expired_token"));
    if (answer.kind === "transient") input.onRetry(answer.reason, waitMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function refusalMessage(error: string, description?: string) {
  if (error === "access_denied") return "Sign-in was declined.";
  if (error === "expired_token")
    return "The code expired before anyone approved it. Run `iterate login` again.";
  return `Sign-in failed (${error}${description ? `: ${description}` : ""}). Run \`iterate login\` again.`;
}
