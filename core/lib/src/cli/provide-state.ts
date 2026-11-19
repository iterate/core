// provide-state.ts — WHAT `iterate provide --json` PRINTS: one of these per line on stdout, at
// each change of state, so a program that keeps a lend (the Mac app) reads the state and not the
// human lines (those stay on stderr). The states, in order of a lend's life:
//
//   connecting    the process asks for its first connection
//   notAllowed    the mind refused the key: no member allowed it yet (waiting, with the link), or
//                 a member removed it
//   incompatible  this CLI and the mind disagree on the protocol: one of them is too old
//   live          the name is lent (`again` after a reconnect)
//   reconnecting  the connection closed: printed before each wait, by RECONNECT_DELAYS_MS
//   stopped       it ends: Ctrl-C, or every attempt failed, or another error
import { z } from "zod";

export const ProvideState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("connecting"), mind: z.string(), name: z.string() }),
  z.object({
    state: z.literal("live"),
    mind: z.string(),
    /** how the mind calls it: `itx.<name>`, or through a sandbox's context */
    name: z.string(),
    again: z.boolean(),
  }),
  z.object({
    state: z.literal("reconnecting"),
    /** this attempt, 1 to `of` */
    attempt: z.number().int(),
    of: z.number().int(),
    inMs: z.number().int(),
    lastFailure: z.string(),
  }),
  z.object({
    state: z.literal("notAllowed"),
    why: z.string(),
    /** where a member allows the key */
    link: z.string().optional(),
    /** true while the CLI waits for a member to allow it */
    waiting: z.boolean(),
  }),
  z.object({ state: z.literal("incompatible"), why: z.string() }),
  z.object({ state: z.literal("stopped"), why: z.string() }),
]);
export type ProvideState = z.infer<typeof ProvideState>;

/** A refusal that no retry changes: the mind's own answer about the key or the protocol. `provide`
 *  ends at once with it, and `--json` prints its state. */
export class ProvideRefusal extends Error {
  readonly state: Extract<ProvideState, { state: "notAllowed" | "incompatible" }>;
  constructor(message: string, state: ProvideRefusal["state"]) {
    super(message);
    this.state = state;
  }
}

/** The state that ends the process with `error`. */
export function finalStateOf(error: unknown): ProvideState {
  if (error instanceof ProvideRefusal) return error.state;
  return { state: "stopped", why: error instanceof Error ? error.message : String(error) };
}
