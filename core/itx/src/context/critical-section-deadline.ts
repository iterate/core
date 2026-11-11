// A timer set inside `blockConcurrencyWhile` fires there even while an older timer waits for the
// input lock (cloudflare/workerd#7698); without that, workerd starves it until a 30 s reset.
export function criticalSectionDeadline(ms: number, done: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    done.addEventListener("abort", () => clearTimeout(timer));
  });
}
