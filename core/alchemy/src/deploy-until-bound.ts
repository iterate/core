// deploy-until-bound.ts — A DEPLOY THAT CLOUDFLARE REFUSED FOR A WHILE IS TRIED AGAIN
// (scripts/deploy-stack.ts runs it). Two such refusals are known, both of a stack with telemetry.
//
// A WORKER THAT CLOUDFLARE DID NOT BIND TO THE STACK'S LOG PIPELINES. A stack with telemetry binds
// its Workers to three pipeline streams (src/stack.ts `telemetryPart`), and Cloudflare can refuse
// the upload of such a Worker: "Pipeline binding error. Please try again later or contact
// support." ANY upload of a Worker with pipeline bindings can meet it: at a turn-on, seconds after
// the streams are made, and at an everyday deploy that uploads the Telemetry Worker with other
// code, on streams, sinks and pipelines that are hours old and unchanged. Cloudflare takes the
// same upload some minutes later.
//
// A NEW SINK WHOSE TABLE CLOUDFLARE COULD NOT READ. A turn-on makes the stack's catalog token and,
// seconds later, the three sinks that write with it. Cloudflare reads a new sink's table in the
// data catalog with that token, and the catalog can answer 403: "InvalidSinkConfig: failed to
// validate Basin Catalog table: Unexpected, context: { status: 403 Forbidden". The stack gate met
// it at one turn-on in nine. The likely cause, not proven: the catalog does not know the new token
// everywhere yet. Only the 403 is tried again: another answer to the same check is not known to
// end by itself.
//
// What the deploy made before the refusal stays in its state, so one more deploy makes only what
// did not go. A sink that Cloudflare refused is not made (shown for a token that the catalog does
// not know). Should the refused check leave a table, the next try fails on it with other words,
// and the table step before the next deploy with telemetry on (src/telemetry-at-deploy.ts) drops
// a table that no sink writes.

/** A refusal of Cloudflare's that ends by itself: how a deploy's output shows it, and the words
 *  for the line of each try. */
export type Refusal = {
  /** Matches one line of the deploy's output. */
  seen: RegExp;
  /** Cloudflare's words, as the line of a try quotes them. */
  words: string;
  /** What Cloudflare refused. */
  refused: string;
  /** When it does that. */
  when: string;
};

/** Cloudflare's words for a Worker that it could not bind to a pipeline stream. */
export const NOT_BOUND = "Pipeline binding error";
/** Cloudflare's words for a new sink whose table it could not read in the stack's data catalog. */
const TABLE_NOT_READ = "failed to validate Basin Catalog table";

const REFUSALS: readonly Refusal[] = [
  {
    seen: new RegExp(NOT_BOUND),
    words: `"${NOT_BOUND}"`,
    refused: "a Worker that binds to the stack's log pipelines",
    when: "It does that for some minutes at times, to a new pipeline and to an old one.",
  },
  {
    seen: new RegExp(`${TABLE_NOT_READ}[^\\n]{0,200}\\b403\\b`),
    words: `"${TABLE_NOT_READ}", with 403`,
    refused: "a new sink of the stack's log pipelines",
    when: "It does that at times in the seconds after a deploy made the token that the sink writes with.",
  },
];

/** The most text that one refusal's line takes: a reader of pieces keeps that much of the end. */
export const REFUSAL_LENGTH = 300;

/** The refusal that `text` shows, the first of them in `REFUSALS`. */
export const refusalIn = (text: string) => REFUSALS.find((refusal) => refusal.seen.test(text));

/** The waits between two tries, in seconds: seven tries at most, eight and a half minutes of
 *  waits. A refusal can last about five minutes. */
const WAITS = [20, 40, 60, 90, 120, 180];

/** Runs `deploy` until it succeeds, fails for another reason than a refusal of `REFUSALS`, a
 *  signal stopped it (`stopped`), or the tries are used: the exit code of the last one. The tries
 *  are counted together, whichever refusal each one met. `say` gets one line for each try after
 *  the first, before its wait. */
export async function deployUntilBound(input: {
  deploy: () => Promise<{ code: number; refused?: Refusal; stopped?: boolean }>;
  pause: (seconds: number) => Promise<void>;
  say: (line: string) => void;
  waits?: readonly number[];
}) {
  const waits = input.waits || WAITS;
  const most = waits.length + 1;
  for (let tries = 1; ; tries += 1) {
    const { code, refused, stopped } = await input.deploy();
    if (code === 0 || !refused || stopped) return code;
    const wait = waits[tries - 1];
    if (wait === undefined) {
      input.say(
        `Cloudflare refused the deploy in each of ${most} tries, the last time ${refused.refused} (${refused.words}). The deploy failed. What it made stays, and the next deploy goes on from there.`,
      );
      return code;
    }
    input.say(
      `Cloudflare refused ${refused.refused} (${refused.words}). ${refused.when} Try ${tries + 1} of ${most} starts in ${wait} seconds; it makes nothing again that is made.`,
    );
    await input.pause(wait);
  }
}
