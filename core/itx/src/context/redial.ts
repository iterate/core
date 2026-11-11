// Every deploy resets every Durable Object and cuts sockets to it; the invocation holding the other
// end outlives the reset. A throw or a 5xx means not ready yet; any other non-socket answer refuses.
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
    const tried = await dialOnce(dial, deadline, deadlineMs);
    if ("socket" in tried) {
      if (!unwanted()) return { ...tried, dials };
      closeAbandoned(tried.socket);
      return null;
    }
    if (tried.final || Date.now() + wait >= deadline)
      return unwanted() ? null : { gaveUp: tried.failure, dials };
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 2, 8_000);
  }
}

async function dialOnce<Answer extends DialAnswer>(
  dial: () => Promise<Answer>,
  deadline: number,
  deadlineMs: number,
): Promise<{ socket: WebSocket; answer: Answer } | { failure: string; final: boolean }> {
  const dialing = Promise.resolve().then(dial);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answer: Answer | null;
  try {
    answer = await Promise.race([
      dialing,
      new Promise<null>(
        (resolve) => (timer = setTimeout(() => resolve(null), deadline - Date.now())),
      ),
    ]);
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error), final: false };
  } finally {
    clearTimeout(timer);
  }
  if (!answer) {
    // never dial again beside a pending dial: a socket it brings late would replace a later one
    void dialing.then(
      (late) => late.webSocket && closeAbandoned(late.webSocket, true),
      () => {},
    );
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
