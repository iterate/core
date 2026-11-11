import { z } from "zod";
import type { WaitForEventFilter } from "iterate/api";
import { codedError, errorCode, releaseRpcSessions, withTimeout } from "iterate/lib";
import type { StreamEvent } from "iterate/stream/processor";
import {
  RUN_DEADLINE_MS,
  RunFailure,
  type RunSettled,
  type RunSettlement,
} from "iterate/stream/run";
import type { LibraryItx } from "../host.ts";

export type WaitForEventAt = (
  path: string,
  filter: WaitForEventFilter,
  givenUp: AbortSignal,
) => Promise<StreamEvent>;

// The script is spliced verbatim into the module below: the caller's own code in its own confined
// isolate. The runner cannot cancel a Workers-RPC call, so the loaded `run()` gives up on its own.
function runScriptModule(script: string) {
  return {
    "package.json": '{"main":"worker.js"}',
    "worker.js": [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      // the script on lines of its own, ended by our `;`: its own trailing `;` or line comment is harmless
      `const script =\n${script}\n;`,
      "export default class extends WorkerEntrypoint {",
      "  async run() {",
      "    let deadline;",
      "    try {",
      "      using itx = this.getItx();",
      "      const value = await Promise.race([",
      "        script(itx),",
      "        new Promise((_, reject) => {",
      `          deadline = setTimeout(() => reject(new Error("itx.run: the script did not finish within ${RUN_DEADLINE_MS / 60_000} minutes")), ${RUN_DEADLINE_MS});`,
      "        }),",
      "      ]);",
      "      const json = JSON.stringify(value);",
      "      return json === undefined ? undefined : JSON.parse(json);",
      "    } finally {",
      "      clearTimeout(deadline);",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
  };
}

export async function executeScript(itx: LibraryItx, code: string): Promise<unknown> {
  // Two dotted calls, never one chain: in-process the record hands the worker's handle back as a
  // value, so `run` is its own dispatch on it, as a remote holder's would be.
  const worker = (await itx.builtins.workers.get({ source: runScriptModule(code) })) as unknown as {
    run(): Promise<unknown>;
  };
  return worker.run();
}

// A returned value is released once serialized: it holds its callee, or this context, open. The
// value only, never also its promise: they share one disposer, and a second call throws.
export async function runSettlementOf(execution: Promise<unknown>): Promise<RunSettlement> {
  const startedAt = Date.now();
  try {
    const json = await withTimeout(
      execution.then((value) => {
        try {
          return JSON.stringify(value);
        } finally {
          // a disposer that throws never fails the run: the release is housekeeping
          try {
            (value as Partial<Disposable> | null | undefined)?.[Symbol.dispose]?.();
          } catch {
            // already released or not ours
          }
        }
      }),
      RUN_DEADLINE_MS,
      "itx.run",
    );
    return { status: "succeeded", result: json ? JSON.parse(json) : undefined };
  } catch (error) {
    if (Date.now() - startedAt >= RUN_DEADLINE_MS)
      return {
        status: "failed",
        error: `itx.run: the script did not finish within ${RUN_DEADLINE_MS / 60_000} minutes; it may have partly run, and it is not run again`,
        failureKind: "deadline",
      };
    const redirected = RunFailure.safeParse(error);
    return {
      status: "failed",
      error: String(error instanceof Error ? error.message : error).slice(0, 8_000),
      failureKind: redirected.success ? redirected.data.failureKind : "runtime",
    };
  }
}

// Cloudflare replaces a Durable Object's instance under running calls, and a wait held there never
// sees what the new instance commits; a fresh stub reaches it, whose wake record settles the run.
const SCRIPT_RUN_WAIT_SLICE_MS = 5_000;
// A call whose instance was shut down mid-call can be left with no answer at all.
const SCRIPT_RUN_SLICE_ANSWER_MS = 4 * SCRIPT_RUN_WAIT_SLICE_MS;

// Plain data under one key, so it crosses every hop as it is.
const ScriptRunRequested = z.object({
  $itxScriptRunRequested: z.object({
    path: z.string().startsWith("/"),
    requestOffset: z.number().int().positive(),
  }),
});
type ScriptRunRequested = z.infer<typeof ScriptRunRequested>;

export async function requestScriptRun(
  itx: LibraryItx,
  path: string,
  script: unknown,
): Promise<ScriptRunRequested> {
  if (typeof script !== "string" || !script.trim())
    throw new Error("itx.run(script): script is the text of a function, `async (itx) => { … }`");
  // The kernel's own log traffic, at the fixed point: a jail's bare null must not wall the runner.
  const [requested] = await itx.builtins.append({
    type: "events.iterate.com/itx/run-requested",
    payload: { code: script },
  });
  return { $itxScriptRunRequested: { path, requestOffset: requested!.offset } };
}

async function settlementOfScriptRun(
  requested: ScriptRunRequested,
  waitForEventAt: WaitForEventAt,
): Promise<unknown> {
  const { path, requestOffset } = requested.$itxScriptRunRequested;
  const waitUntil = Date.now() + RUN_DEADLINE_MS + 60_000;
  let afterOffset = requestOffset;
  for (;;) {
    const remainingMs = waitUntil - Date.now();
    if (remainingMs <= 0)
      throw codedError(
        "WAIT_TIMEOUT",
        `itx.run: no settlement of run ${requestOffset} within ${(RUN_DEADLINE_MS + 60_000) / 60_000} minutes`,
      );
    let settled: StreamEvent;
    const sliceGivenUp = new AbortController();
    try {
      settled = await withTimeout(
        waitForEventAt(
          path,
          {
            type: "events.iterate.com/itx/run-settled",
            afterOffset,
            timeoutMs: Math.min(SCRIPT_RUN_WAIT_SLICE_MS, remainingMs),
          },
          sliceGivenUp.signal,
        ),
        SCRIPT_RUN_SLICE_ANSWER_MS,
        `itx.run: the wait for run ${requestOffset} on ${path}`,
      );
    } catch (error) {
      if (errorCode(error) === "WAIT_TIMEOUT") continue;
      if (errorCode(error) !== "TIMEOUT") throw error;
      sliceGivenUp.abort();
      console.warn({
        event: "itx-run.platform-failure-wait-unanswered",
        kind: "disconnected",
        message: "a wait for a run's settlement got no answer: asked again on a fresh stub",
        name: "waitForEvent",
        path,
        requestOffset,
      });
      continue;
    }
    afterOffset = settled.offset;
    const { requestOffset: settledOffset, settlement } = settled.payload as RunSettled;
    if (settledOffset !== requestOffset) continue;
    if (settlement.status === "succeeded") return settlement.result;
    throw Object.assign(new Error(settlement.error), { failureKind: settlement.failureKind });
  }
}

export function settlementOfRun(
  answer: unknown,
  waitForEventAt: WaitForEventAt,
): Promise<unknown> | undefined {
  const requested = ScriptRunRequested.safeParse(answer);
  if (!requested.success) return undefined;
  releaseRpcSessions([answer]); // parsed into a copy of its own
  return settlementOfScriptRun(requested.data, waitForEventAt);
}
