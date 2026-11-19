import * as workers from "cloudflare:workers";
import type { ReachableContext } from "core-itx";
import { withFacts } from "iterate/facts";
import { SECRET_HELD_HEADER, VAULT_ANSWER_HEADER } from "iterate/secret-placeholder";
import type { Door } from "iterate/workers";
import { expect, test, vi } from "vitest";
import { sendRecordingSecretFacts } from "./secrets.ts";

const USED = { type: "events.iterate.com/secret/used", payload: {} };
const SECRET = "/secrets/openai";

test("the answer of a use is back while its fact's append is still pending, and the append is kept alive", async () => {
  const kept = keptAlive();
  const log = pendingLog();
  const answer = await sendRecordingSecretFacts(
    used(),
    doorAnswering(() => withFacts(Response.json({ ok: true }), [{ path: SECRET, events: [USED] }])),
    log.contextOf,
    "/agents/caller",
  );

  expect(await answer.json()).toEqual({ ok: true });
  expect(log).toMatchObject({ appended: [[SECRET, [USED]]], stored: 0 });
  expect(kept).toHaveLength(1);
  log.store();
  await Promise.all(kept);
  expect(log).toMatchObject({ stored: 1 });
});

test("a 101 goes back with its WebSocket before the append ends", async () => {
  vi.stubGlobal("Response", WorkersResponse);
  const kept = keptAlive();
  const log = pendingLog();
  const socket = { accept() {} } as unknown as WebSocket;
  const answer = await sendRecordingSecretFacts(
    used(),
    doorAnswering(() =>
      withFacts(new Response(null, { status: 101, webSocket: socket }), [
        { path: SECRET, events: [USED] },
      ]),
    ),
    log.contextOf,
    "/agents/caller",
  );

  expect({ status: answer.status, socket: answer.webSocket === socket }).toEqual({
    status: 101,
    socket: true,
  });
  expect(log).toMatchObject({ stored: 0 });
  log.store();
  await Promise.all(kept);
});

test("a failed append is reported and the answer is unharmed", async () => {
  const kept = keptAlive();
  const reported = vi.spyOn(console, "error").mockImplementation(() => {});
  const answer = await sendRecordingSecretFacts(
    used(),
    doorAnswering(() => withFacts(Response.json({ ok: true }), [{ path: SECRET, events: [USED] }])),
    () => ({ append: () => Promise.reject(new Error("log away")) }) as unknown as ReachableContext,
    "/agents/caller",
  );

  expect(await answer.json()).toEqual({ ok: true });
  await Promise.all(kept);
  expect(reported).toHaveBeenCalledWith(
    expect.objectContaining({
      failureSite: "secret.fact-not-recorded",
      secret: SECRET,
      context: "/agents/caller",
    }),
  );
  // one line, and it holds no header of the request: the placeholder, let alone a value
  expect(reported).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(reported.mock.calls)).not.toContain("getSecret");
});

test("a held answer waits for its facts, then sends again with the digest and waits for those too", async () => {
  const kept = keptAlive();
  const log = pendingLog();
  const sent: Request[] = [];
  const door = doorAnswering((request) => {
    sent.push(request);
    return sent.length === 1
      ? withFacts(Response.json({ digest: "d1" }, { headers: { [VAULT_ANSWER_HEADER]: "held" } }), [
          { path: SECRET, events: [{ type: "events.iterate.com/secret/approval-requested" }] },
        ])
      : withFacts(Response.json({ ok: true }), [{ path: SECRET, events: [USED] }]);
  });

  let done = false;
  const answering = sendRecordingSecretFacts(used(), door, log.contextOf, "/agents/caller").then(
    (answer) => {
      done = true;
      return answer;
    },
  );
  await vi.waitFor(() => expect(log.appended).toHaveLength(1));
  expect({ done, sent: sent.length }).toEqual({ done: false, sent: 1 });
  log.store();
  await vi.waitFor(() => expect(log.appended).toHaveLength(2));
  expect(sent[1]!.headers.get(SECRET_HELD_HEADER)).toBe("d1");
  expect(done).toBe(false);
  log.store();
  expect(await (await answering).json()).toEqual({ ok: true });
  expect(kept).toHaveLength(0);
});

function used() {
  return new Request("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer getSecret("${SECRET}")` },
  });
}

function doorAnswering(answer: (request: Request) => Response): Door {
  return { fetch: async (request: Request) => answer(request) } as unknown as Door;
}

/** Each append waits until the test calls `store()`, which lets the oldest one land. */
function pendingLog() {
  const waiting: (() => void)[] = [];
  const log = {
    appended: [] as unknown[],
    stored: 0,
    store: () => waiting.shift()?.(),
    contextOf: () =>
      ({
        append: (...events: unknown[]) => {
          log.appended.push([SECRET, events]);
          return new Promise<void>((done) =>
            waiting.push(() => {
              log.stored++;
              done();
            }),
          );
        },
      }) as unknown as ReachableContext,
  };
  return log;
}

function keptAlive() {
  const kept: Promise<unknown>[] = [];
  // the Node shim's seam (core/lib/src/test-support/cloudflare-workers-shim.ts), which the Workers
  // types do not know
  const shim = workers.waitUntil as unknown as { hold: (promise: Promise<unknown>) => void };
  vi.spyOn(shim, "hold").mockImplementation((promise) => void kept.push(promise));
  return kept;
}

/** Node's Response refuses a 101; the Workers runtime's takes one with its WebSocket. */
class WorkersResponse extends Response {
  readonly #status: number;
  override readonly webSocket: WebSocket | null;
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    this.#status = init?.status ?? 200;
    this.webSocket = init?.webSocket || null;
  }
  override get status() {
    return this.#status;
  }
}
