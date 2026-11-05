/** THE CONNECTION'S HEARTBEAT: a cheap call on the session every `intervalMs` — `whoami()`, which
 *  the stateless Worker answers itself — and a socket that leaves one unanswered for `deadAfterMs`
 *  is dead (`onDead`), so its owner can reconnect.
 *
 *  It does two jobs. Cloudflare sheds a stateless Worker's WebSocket that it counts as idle: the
 *  runtime holds a request "in use" while its code handles a message from the socket, and a
 *  WebSocket ping never reaches that code, nor does a Worker's own timer count
 *  (tasks/complete/2026-11-05-api-websockets-load-shed.md). And a network that vanishes without a
 *  close — a laptop asleep, a NAT mapping expired, a shed whose close never arrives — otherwise
 *  leaves a socket that never sends, never receives and never closes. The beats are also the
 *  traffic that keeps a NAT mapping from expiring. */
const HEARTBEAT = { intervalMs: 30_000, deadAfterMs: 15_000 };

export type Heartbeat = {
  /** A beat now, unless one is in flight: a page back from the background or a network that came
   *  back checks its socket before the person's next action hangs on a dead one. */
  beatNow(): void;
  stop(): void;
};

export function startHeartbeat(input: {
  beat: () => PromiseLike<unknown>;
  onDead: (reason: string) => void;
  timing?: { intervalMs: number; deadAfterMs: number };
}): Heartbeat {
  const timing = input.timing || HEARTBEAT;
  let stopped = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const beatNow = () => {
    if (stopped || deadline) return;
    deadline = setTimeout(() => {
      stop();
      input.onDead(`no answer to a heartbeat for ${timing.deadAfterMs / 1000} s`);
    }, timing.deadAfterMs);
    unref(deadline);
    // A refused beat is an answer: the socket carried it both ways.
    void Promise.resolve(input.beat())
      .catch(() => {})
      .then(() => {
        clearTimeout(deadline);
        deadline = undefined;
      });
  };
  const interval = setInterval(beatNow, timing.intervalMs);
  unref(interval);
  function stop() {
    stopped = true;
    clearInterval(interval);
    clearTimeout(deadline);
  }
  return { beatNow, stop };
}

/** The heartbeat never keeps a finished script's process alive (Node; a browser's timers have no
 *  `unref`). */
function unref(timer: unknown) {
  (timer as { unref?: () => void }).unref?.();
}
