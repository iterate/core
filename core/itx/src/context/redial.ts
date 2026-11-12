// Every deploy resets every Durable Object and cuts sockets to it; the invocation holding the other
// end outlives the reset. A throw or a 5xx means not ready yet; any other non-socket answer refuses.
//
// A re-dial runs under `waitUntil`. When the session that wanted it ends, the invocation ends too,
// and the runtime gives what is left 30 seconds, then cuts it with a warning. So a re-dial that
// is `unwanted` stops at once: it is asked while a dial is pending and between two dials, never
// only when a wait has run out.
type DialAnswer = { status: number; webSocket?: WebSocket | null; body?: ReadableStream | null };

export async function redial<Answer extends DialAnswer>(
  dial: () => Promise<Answer>,
  unwanted: () => boolean,
  deadlineMs: number,
): Promise<
  { socket: WebSocket; answer: Answer; dials: number } | { gaveUp: string; dials: number } | null
> {
  const deadline = Date.now() + deadlineMs;
  let wait = 250;
  for (let dials = 1; ; dials += 1) {
    if (unwanted()) return null;
    const tried = await dialOnce(dial, unwanted, deadline, deadlineMs);
    if (!tried) return null;
    if ("socket" in tried) {
      if (!unwanted()) return { ...tried, dials };
      closeAbandoned(tried.socket);
      return null;
    }
    if (tried.final || Date.now() + wait >= deadline)
      return unwanted() ? null : { gaveUp: tried.failure, dials };
    await asked(unwanted, Date.now() + wait);
    wait = Math.min(wait * 2, 8_000);
  }
}

/** Resolves when `unwanted` says so or at `until` (epoch ms), whichever is first: true for unwanted. */
async function asked(unwanted: () => boolean, until: number): Promise<boolean> {
  while (!unwanted()) {
    const left = until - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, 100)));
  }
  return true;
}

/** One dial: its socket, why it brought none, or null when the re-dial became unwanted meanwhile. */
async function dialOnce<Answer extends DialAnswer>(
  dial: () => Promise<Answer>,
  unwanted: () => boolean,
  deadline: number,
  deadlineMs: number,
): Promise<{ socket: WebSocket; answer: Answer } | { failure: string; final: boolean } | null> {
  const dialing = Promise.resolve().then(dial);
  let answered = false;
  let answer: Answer | boolean;
  try {
    // `asked` stops asking once the dial answered: `true` unwanted, `false` out of time
    answer = await Promise.race([
      dialing.finally(() => (answered = true)),
      asked(() => answered || unwanted(), deadline),
    ]);
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error), final: false };
  }
  if (typeof answer === "boolean") {
    // never dial again beside a pending dial: a socket it brings late would replace a later one
    void dialing.then(
      (late) => late.webSocket && closeAbandoned(late.webSocket, true),
      () => {},
    );
    if (unwanted()) return null;
    return { failure: `no answer within ${deadlineMs / 1000} s of the drop`, final: true };
  }
  if (answer.status === 101 && answer.webSocket) {
    answer.webSocket.accept();
    return { socket: answer.webSocket, answer };
  }
  await answer.body?.cancel();
  return { failure: `the context answered ${answer.status}`, final: answer.status < 500 };
}

function closeAbandoned(socket: WebSocket, late = false): void {
  try {
    if (late) socket.accept();
    socket.close(1000, "re-dial abandoned");
  } catch {
    /* already closing */
  }
}
