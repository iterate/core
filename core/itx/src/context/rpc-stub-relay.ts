// The client's stub lives in this stateless relay, never in the Durable Object, or the DO could not
// hibernate while a client is connected. The DO pages the relay, which lends a fresh leg per page.
import { RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import { failureKind, RELAY_BURST, retryPlatformFailures } from "iterate/platform-retry";
import { codedError } from "iterate/lib";
import type { StreamEventInput } from "iterate/stream/processor";
import { type ItxExpression, walkStepsOnRpcStub } from "iterate/expression";
import type { IterateContextDurableObject } from "../iterate-context-durable-object.ts";
import { dialRpcStubFetch } from "./fetch-upgrade.ts";
import { redial } from "./redial.ts";
import {
  disposeRpcStub,
  encodeRpcStubPagerAttachRequest,
  RPC_STUB_PAGER_KEEPALIVE_REQUEST,
  RPC_STUB_PAGER_WEBSOCKET_HEADER,
} from "./rpc-stubs.ts";

/** All prd pager re-dials were answered within ~6 s; the tenfold headroom keeps a slow deploy's
 *  reset from ending a lend. */
const RPC_STUB_PAGER_REDIAL_DEADLINE_MS = 60_000;

export type IterateContextDurableObjectStub = DurableObjectStub<IterateContextDurableObject>;

// On the wire a callable stub Proxy (`typeof === "function"`): nothing structural can inspect it.
export type ClientRpcStub = { dup(): ClientRpcStub; [k: string]: unknown };

class LentRpcStub extends WorkersRpcTarget {
  #clientRpcStub: ClientRpcStub;
  #rpcStubKey: string;
  // Shared by every page of one pager, because capnweb has no `offRpcBroken`. Set before the dup is
  // disposed, and capnweb fires onRpcBroken before rejecting, so a caught call sees the reason.
  #lendEnded: { reason: string | null };
  // minted per dial: a stub that saw a reset replays it
  #durableObjectStub: () => IterateContextDurableObjectStub;
  constructor(
    clientRpcStub: ClientRpcStub,
    rpcStubKey: string,
    lendEnded: { reason: string | null },
    durableObjectStub: () => IterateContextDurableObjectStub,
  ) {
    super();
    this.#clientRpcStub = clientRpcStub;
    this.#rpcStubKey = rpcStubKey;
    this.#lendEnded = lendEnded;
    this.#durableObjectStub = durableObjectStub;
  }

  // capnweb throws a raw, uncoded error when the lend ended mid-call: re-coded here, where the break
  // is local, so the code crosses the Workers-RPC hop. A genuine app error propagates untouched.
  #recodeIfLendEnded(e: unknown, what: string): never {
    if (this.#lendEnded.reason)
      throw codedError("RPC_STUB_OFFLINE", `the lent rpc stub ${this.#lendEnded.reason} ${what}`);
    throw e;
  }

  async fetch(
    upgradeId: string,
    itxExpressionSteps: ItxExpression,
    request: Request,
  ): Promise<unknown> {
    try {
      return await whileClientAnswers(this.#clientRpcStub, this.#rpcStubKey, async () => {
        // the steps stop short of the terminal `fetch`: the receiver is what serves it
        const receiver = (await walkStepsOnRpcStub(this.#clientRpcStub, itxExpressionSteps)) as {
          fetch(r: Request): Promise<unknown>;
        };
        return await dialRpcStubFetch(
          (r) => receiver.fetch(r),
          request,
          upgradeId,
          this.#durableObjectStub,
        );
      });
    } catch (e) {
      this.#recodeIfLendEnded(e, "mid-fetch");
    }
  }

  async invoke(itxExpressionSteps: ItxExpression): Promise<unknown> {
    try {
      return await whileClientAnswers(this.#clientRpcStub, this.#rpcStubKey, () =>
        walkStepsOnRpcStub(this.#clientRpcStub, itxExpressionSteps),
      );
    } catch (e) {
      this.#recodeIfLendEnded(e, "mid-invoke");
    }
  }
}

// A client whose network vanished without a close would stay open at the edge until TCP gives up
// (12 to 16 minutes), so an unanswered call is followed by a probe; no answer to it fails the call.
async function whileClientAnswers(
  clientRpcStub: ClientRpcStub,
  rpcStubKey: string,
  makeCall: () => unknown,
): Promise<unknown> {
  const call = Promise.resolve().then(makeCall);
  const settled = call.then(
    () => "settled" as const,
    () => "settled" as const,
  );
  const within = <A>(answer: Promise<A>, ms: number): Promise<A | "silent"> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      answer,
      new Promise<"silent">((resolve) => (timer = setTimeout(() => resolve("silent"), ms))),
    ]).finally(() => clearTimeout(timer));
  };
  const startedAt = Date.now();
  while ((await within(settled, 10_000)) === "silent") {
    // a capnweb stub answers every member name as a remote callable: the rejection is the answer
    const probe = Promise.resolve()
      .then(() => (clientRpcStub.itxLivenessProbe as () => Promise<unknown>)())
      .then(disposeRpcStub, () => undefined)
      .then(() => "answered" as const);
    if ((await within(Promise.race([settled, probe]), 10_000)) !== "silent") continue;
    console.warn({
      event: "rpc-stub-client-unanswered",
      namespace: "rpc-stubs",
      message:
        "a lent stub's client answered neither a call nor a liveness probe; the call fails RPC_STUB_OFFLINE",
      rpcStubKey,
      waitedMs: Date.now() - startedAt,
    });
    throw codedError(
      "RPC_STUB_OFFLINE",
      `rpc stub ${JSON.stringify(rpcStubKey)}: its client stopped answering`,
    );
  }
  return await call;
}

// The lend is the session's, not the socket's: a pager that closes with neither side having ended
// the lend is re-dialed, and the DO's attach re-appends `appendEvents` as a reconnect.
export async function lendRpcStubOverPager(
  // Minted per use, never held: a DurableObjectStub that saw a reset replays it on every later call.
  durableObjectStub: () => IterateContextDurableObjectStub,
  clientRpcStub: ClientRpcStub,
  rpcStubKey: string,
  appendEvents: StreamEventInput[],
  waitUntil: (p: Promise<unknown>) => void,
): Promise<{ dispose(): void; lendEnded: Promise<string> }> {
  // dup first: a value that is not a stub fails here, before any socket
  const sessionRpcStub = clientRpcStub.dup();
  const lendEnded: { reason: string | null } = { reason: null };
  const dialPager = () =>
    durableObjectStub().fetch("https://rpc-stub-pager.internal/", {
      headers: {
        Upgrade: "websocket",
        [RPC_STUB_PAGER_WEBSOCKET_HEADER]: encodeRpcStubPagerAttachRequest({
          rpcStubKey,
          appendEvents,
        }),
      },
    });
  let response: Response;
  try {
    response = await dialPager();
  } catch (error) {
    disposeRpcStub(sessionRpcStub);
    throw error;
  }
  if (response.status !== 101 || !response.webSocket) {
    disposeRpcStub(sessionRpcStub);
    const refusal = (await response.json().catch(() => null)) as {
      code?: string | null;
      message?: string;
    } | null;
    throw Object.assign(
      new Error(
        refusal?.message ||
          `rpc stub pager upgrade returned ${response.status} without a WebSocket`,
      ),
      refusal?.code ? { code: refusal.code } : {},
    );
  }
  // The one place the session's dup is disposed; the reason is set first so a call walking it re-codes.
  let resolveLendEnded = (_reason: string) => {};
  const lendEndedPromise = new Promise<string>((resolve) => (resolveLendEnded = resolve));
  const disposeSessionRpcStub = (reason: string) => {
    lendEnded.reason ||= reason;
    disposeRpcStub(sessionRpcStub);
    resolveLendEnded(lendEnded.reason);
  };
  // A relay's connection to the DO can drop under a burst of lends, failing every lend in flight:
  // lent again on RELAY_BURST. Re-lending a key replaces its stub, so a repeat is harmless.
  const answerPage = async (): Promise<void> => {
    try {
      await retryPlatformFailures(
        async () => {
          if (lendEnded.reason) return;
          await durableObjectStub().lendRpcStub({
            rpcStubKey,
            stub: new LentRpcStub(sessionRpcStub, rpcStubKey, lendEnded, durableObjectStub),
          });
        },
        {
          area: "rpc-stubs",
          schedule: RELAY_BURST,
          idempotent: true,
          kind: (error) => (lendEnded.reason ? "failed" : failureKind(error)),
          describe: () => ({ name: "lendRpcStub", rpcStubKey }),
        },
      );
    } catch (error) {
      if (lendEnded.reason) return;
      console.warn({
        event: "rpc-stub-lend-failed",
        namespace: "rpc-stubs",
        message: "a page's lend failed: the DO's page times out, and a push waiting on it is lost",
        rpcStubKey,
        error: String(error),
      });
    }
  };
  let pagerWebSocket = response.webSocket;
  const attachPager = (ws: WebSocket): void => {
    pagerWebSocket = ws;
    let answeredAt = Date.now();
    let unanswered = 0;
    let retired = false;
    // A deploy resets the DO, but this end may hear no close for a minute. Counted in keepalives sent,
    // never wall time, so an isolate that stalls does not read its own stall as the DO's silence.
    const keepalive = setInterval(() => {
      if (unanswered >= 3) {
        retired = true;
        clearInterval(keepalive);
        // re-dial before closing: a DO that was only slow sees a swap, never a detach
        waitUntil(
          redialPager({
            code: 4000,
            reason: `${unanswered} keepalives unanswered`,
            answeredAt,
          }).finally(() => {
            try {
              ws.close(4000, "keepalive unanswered");
            } catch {
              // already closing
            }
          }),
        );
        return;
      }
      // counted before the send: a send that throws is a keepalive the DO never answers
      unanswered += 1;
      try {
        ws.send(RPC_STUB_PAGER_KEEPALIVE_REQUEST);
      } catch {
        // closing: its close event, or three unanswered keepalives, takes it out of service
      }
    }, 500);
    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      answeredAt = Date.now();
      unanswered = 0;
      let page: unknown;
      try {
        page = JSON.parse(event.data);
      } catch {
        return;
      }
      if ((page as { type?: string } | null)?.type !== "page") return;
      waitUntil(answerPage());
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      clearInterval(keepalive);
      if (retired) return;
      retired = true;
      // the lender ended it, or the DO replaced it with a newer pager: the lend is over
      if (lendEnded.reason || event.code === 1000) {
        disposeSessionRpcStub("was returned (its pager closed)");
        return;
      }
      waitUntil(redialPager({ code: event.code, reason: event.reason, answeredAt }));
    });
  };
  // A session that is ending often loses its pager a moment before its end reaches this lend, so a
  // drop is logged only once the session proved live. The failure is an error: prd's alarm pages.
  const redialPager = async (dropped: {
    code: number;
    reason: string;
    answeredAt: number;
  }): Promise<void> => {
    const redialed = await redial(
      dialPager,
      () => Boolean(lendEnded.reason),
      RPC_STUB_PAGER_REDIAL_DEADLINE_MS,
    );
    if (!redialed) return;
    const drop = {
      namespace: "rpc-stubs",
      rpcStubKey,
      code: dropped.code,
      reason: dropped.reason,
      downMs: Date.now() - dropped.answeredAt,
    };
    if ("socket" in redialed) {
      attachPager(redialed.socket);
      console.warn({
        event: "rpc-stub-pager-redialed",
        message:
          "a lent stub's pager dropped under a live session and is back in service; the DO re-appended what names the key",
        ...drop,
        attempt: redialed.dials,
      });
      return;
    }
    console.error({
      event: "rpc-stub-pager-redial-failed",
      message:
        "a lent stub's pager dropped under a live session and could not be re-dialed; the lend ends, and the DO un-sets what named it on the pager's close or, when the DO reset took the pager with no close run, on its next wake",
      ...drop,
      lastFailure: redialed.gaveUp,
    });
    disposeSessionRpcStub("went offline (its pager dropped and could not be re-dialed)");
  };
  pagerWebSocket.accept();
  attachPager(pagerWebSocket);
  // capnweb's death signal: close the pager now, or the presence list lies until a page times out.
  (sessionRpcStub as { onRpcBroken?: (cb: () => void) => void }).onRpcBroken?.(() => {
    lendEnded.reason = "went offline (its client session broke)";
    try {
      pagerWebSocket.close(1000, "client session broke");
    } catch {
      // already closing
    }
  });
  return {
    dispose: () => {
      disposeSessionRpcStub("was recalled by its lender");
      try {
        pagerWebSocket.close(1000, "pager disposed");
      } catch {
        // already closing
      }
    },
    lendEnded: lendEndedPromise,
  };
}
