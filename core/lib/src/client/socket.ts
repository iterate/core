/** Open a WebSocket, trying again for a while when the connection fails: a phone waking up, a
 *  tunnel flapping, a cold edge — the things a first attempt trips over. Resolves with the socket
 *  once it is OPEN; rejects with the last failure after the last attempt. The delays are the
 *  waits BETWEEN attempts (the first is immediate).
 *
 *  Every failed attempt is explained, never swallowed (docs/engineering-invariants.md): the error
 *  names the close code and reason the socket closed with before it opened, and each attempt that
 *  is tried again logs a `client.platform-failure-socket-open` warn first. The upgrade's HTTP status
 *  is not among them: the WebSocket API never exposes the handshake's response (a refused upgrade
 *  is a close 1006, by design — https://websockets.spec.whatwg.org/#feedback-from-the-protocol),
 *  so a non-standard `ErrorEvent.error` (Node's undici names "non-101 status code" there) is added
 *  when the runtime gives one. */
const RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000, 8_000];

/** How long one attempt may take to open. A handshake that neither opens nor closes is a failed
 *  attempt too, closed and tried again like any other: without a bound the page waits on it for as
 *  long as the browser does, behind a spinner that never ends (a Dash spec sat 30 s after its
 *  sign-in's `POST /api` answered, with no `/api` upgrade ever reaching the Worker, 2026-09-24).
 *  A healthy upgrade opens in well under a second. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

export function openSocketWithRetry(
  url: string | URL,
  options: {
    delaysMs?: readonly number[];
    handshakeTimeoutMs?: number;
    /** the constructor to use — a test's fake, `WebSocket` otherwise */
    WebSocket?: typeof WebSocket;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<WebSocket> {
  const delays = options.delaysMs || RETRY_DELAYS_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const Socket = options.WebSocket || WebSocket;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const once = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new Socket(url);
      let cause = "";
      const timeout = setTimeout(() => {
        settle();
        socket.close();
        reject(new Error(`WebSocket did not open in ${handshakeTimeoutMs} ms`));
      }, handshakeTimeoutMs);
      function settle() {
        clearTimeout(timeout);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("close", failed);
        socket.removeEventListener("error", errored);
      }
      function errored(event: Event) {
        const error = (event as Partial<ErrorEvent>).error;
        if (error instanceof Error) cause = ` (${error.message})`;
      }
      function opened() {
        settle();
        resolve(socket);
      }
      function failed(event: CloseEvent) {
        settle();
        reject(
          new Error(
            `WebSocket connection failed: closed ${event.code}${event.reason ? ` "${event.reason}"` : ""} before it opened${cause}`,
          ),
        );
      }
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", errored);
      socket.addEventListener("close", failed, { once: true });
    });
  return (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await once();
      } catch (error) {
        const delay = delays[attempt - 1];
        if (delay === undefined) throw error;
        console.warn({
          event: "client.platform-failure-socket-open",
          url: String(url),
          attempt,
          attempts: delays.length + 1,
          retryInMs: delay,
          message: (error as Error).message,
        });
        await sleep(delay);
      }
    }
  })();
}

/** A socket that BECOMES the one `opening` resolves with (`openSocketWithRetry`): CONNECTING until
 *  that one opens, then a stand-in that passes on every message, close and error and sends through
 *  it. A capnweb session made on it queues its calls until the upgrade lands, so a page can hold its
 *  connection while the attempts are still running. Every attempt failing is an error, then a close
 *  (1006); a close asked for before the socket opened closes it on arrival. */
export function socketOnceOpen(opening: Promise<WebSocket>): WebSocket {
  const events = new EventTarget();
  let socket: WebSocket | undefined;
  let readyState: number = WebSocket.CONNECTING;
  let closing: [code?: number, reason?: string] | undefined;
  opening.then(
    (opened) => {
      if (closing) {
        opened.close(...closing);
        readyState = WebSocket.CLOSED;
        events.dispatchEvent(new CloseEvent("close", { code: closing[0] ?? 1000 }));
        return;
      }
      // it opened, and may have closed again before it got here (`opening` can be held a while)
      if (opened.readyState !== WebSocket.OPEN) {
        readyState = WebSocket.CLOSED;
        events.dispatchEvent(new CloseEvent("close", { code: 1006 }));
        return;
      }
      socket = opened;
      opened.binaryType = "arraybuffer";
      opened.addEventListener("message", (event) =>
        events.dispatchEvent(new MessageEvent("message", { data: event.data })),
      );
      opened.addEventListener("error", () => events.dispatchEvent(new Event("error")));
      opened.addEventListener("close", (event) => {
        readyState = WebSocket.CLOSED;
        events.dispatchEvent(new CloseEvent("close", { code: event.code, reason: event.reason }));
      });
      readyState = WebSocket.OPEN;
      events.dispatchEvent(new Event("open"));
    },
    () => {
      readyState = WebSocket.CLOSED;
      events.dispatchEvent(new Event("error"));
      events.dispatchEvent(new CloseEvent("close", { code: 1006 }));
    },
  );
  // the state is read live: `Object.assign` would copy a getter's value once
  Object.defineProperty(events, "readyState", { get: () => readyState });
  return Object.assign(events, {
    binaryType: "arraybuffer",
    send(data: Parameters<WebSocket["send"]>[0]) {
      if (!socket) throw new Error("The WebSocket is not open yet.");
      socket.send(data);
    },
    close(code?: number, reason?: string) {
      if (socket) return socket.close(code, reason);
      closing = [code, reason];
      readyState = WebSocket.CLOSING;
    },
  }) as unknown as WebSocket; // the members capnweb's WebSocket transport and `adopt` use, no more
}
