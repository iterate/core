// WHAT A FAILED CHECK SAYS OF ITS ERROR. A request that finds no connection throws "fetch failed"
// and nothing more in its message: Node keeps why in the error's `cause` (no such name, a reset, a
// refusal). The smoke's line for a failed check is all that the stack gate keeps of it, so the
// cause is in the line.

/** `error`'s message, with its cause's code and message after it, and that cause's cause. */
export function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { cause } = error;
  if (cause === undefined) return error.message;
  const code = cause instanceof Error && "code" in cause ? `${String(cause.code)}: ` : "";
  return `${error.message} (${code}${reasonOf(cause)})`;
}
