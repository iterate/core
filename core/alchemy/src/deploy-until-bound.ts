// deploy-until-bound.ts — A DEPLOY THAT CLOUDFLARE DID NOT BIND TO THE STACK'S LOG PIPELINES IS
// TRIED AGAIN (scripts/deploy-stack.ts runs it).
//
// A stack with telemetry binds its Workers to three pipeline streams (src/stack.ts
// `telemetryPart`), and Cloudflare can refuse the upload of such a Worker: "Pipeline binding
// error. Please try again later or contact support." ANY upload of a Worker with pipeline
// bindings can meet it: at a turn-on, seconds after the streams are made, and at an everyday
// deploy that uploads the Telemetry Worker with other code, on streams, sinks and pipelines that
// are hours old and unchanged. Cloudflare takes the same upload some minutes later.
//
// What the deploy made before the refusal stays in its state, so one more deploy uploads only the
// Workers that did not go.

/** Cloudflare's words for a Worker that it could not bind to a pipeline stream. */
export const NOT_BOUND = "Pipeline binding error";

/** The waits between two tries, in seconds: seven tries at most, eight and a half minutes of
 *  waits. A refusal can last about five minutes. */
const WAITS = [20, 40, 60, 90, 120, 180];

/** Runs `deploy` until it succeeds, fails for another reason, or the tries are used: the exit code
 *  of the last one. `say` gets one line for each try after the first, before its wait. */
export async function deployUntilBound(input: {
  deploy: () => Promise<{ code: number; notBound: boolean }>;
  pause: (seconds: number) => Promise<void>;
  say: (line: string) => void;
  waits?: readonly number[];
}) {
  const waits = input.waits || WAITS;
  const most = waits.length + 1;
  for (let tries = 1; ; tries += 1) {
    const { code, notBound } = await input.deploy();
    if (code === 0 || !notBound) return code;
    const wait = waits[tries - 1];
    if (wait === undefined) {
      input.say(
        `Cloudflare refused a Worker that binds to the stack's log pipelines in each of ${most} tries ("${NOT_BOUND}"). The deploy failed. What it made stays, and the next deploy goes on from there.`,
      );
      return code;
    }
    input.say(
      `Cloudflare refused a Worker that binds to the stack's log pipelines ("${NOT_BOUND}"). It does that for some minutes at times, to a new pipeline and to an old one. Try ${tries + 1} of ${most} starts in ${wait} seconds; it makes nothing again that is made.`,
    );
    await input.pause(wait);
  }
}
