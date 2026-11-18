/** WHEN A SESSION'S PEER HAS GONE SILENT. A Worker cannot send a WebSocket ping, and capnweb has
 *  no keepalive, so a peer whose network vanished with no close (a laptop asleep, a dropped
 *  network) leaves the Worker a socket that never closes until TCP gives up, many minutes later.
 *  The Worker hears every frame the peer sends (`heard`), and a peer silent for `silentMs` is
 *  asked once (`probe`). A peer still silent `answerWithinMs` after the probe is gone (`end`).
 *
 *  The numbers: the clients that send by themselves beat every 30 s (`whoami()`: core/lib
 *  client/heartbeat.ts and packages/ui member-itx.ts). That is no bound on what the Worker hears
 *  from a page: a browser throttles the timers of a page in the background to one run a minute or
 *  less, and many capnweb clients send no beat at all. The probe is a frame the Worker sends, and
 *  a browser answers a socket's message also in a background tab. So the bound is the probe's, and
 *  20 s keeps it short: a gone peer is ended 30 to 40 s after its last frame (the checks run every
 *  10 s). A live peer that beats every 30 s is probed about once between two beats: one small
 *  frame each way, which the Worker sends and the peer's capnweb answers, with no Durable Object
 *  in the path. The two steps also keep an isolate that stalled from ending a live peer: a late
 *  check only probes, and the frames that waited arrive before the next check. */
export const SILENCE = { checkEveryMs: 10_000, silentMs: 20_000, answerWithinMs: 10_000 };

/** Starts the watch with the peer as heard now. `end` is called once at most, with how long the
 *  peer had been silent, and the watch stops itself before it. */
export function endWhenSilent(input: { probe: () => void; end: (silentForMs: number) => void }) {
  let heardAt = Date.now();
  let probedAt: number | undefined;
  const check = setInterval(() => {
    const now = Date.now();
    if (probedAt === undefined) {
      if (now - heardAt < SILENCE.silentMs) return;
      probedAt = now;
      input.probe();
      return;
    }
    if (now - probedAt < SILENCE.answerWithinMs) return;
    clearInterval(check);
    input.end(now - heardAt);
  }, SILENCE.checkEveryMs);
  return {
    /** A frame came from the peer: the silence starts again, and an open probe is answered. */
    heard() {
      heardAt = Date.now();
      probedAt = undefined;
    },
    /** No probe and no end from now on. */
    stop: () => clearInterval(check),
  };
}
