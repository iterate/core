// deploy-try.ts — ONE TRY OF A DEPLOY: a child process whose output is passed on and read for
// Cloudflare's words about a pipeline binding (scripts/deploy-stack.ts runs Alchemy's deploy with
// it; src/deploy-until-bound.ts decides about the next try).
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { NOT_BOUND } from "./deploy-until-bound.ts";

/** Runs `command` to its end. `piped: false` gives the child the terminal: its output is not read
 *  then, and `notBound` stays false.
 *
 *  A SIGNAL ENDS THE DEPLOY, NOT ONLY THIS TRY. While the child runs, SIGINT and SIGTERM to this
 *  process go on to the child, and this process waits for the child's end: Alchemy writes its
 *  state then. `stopped` says that such a signal came, or that a signal from elsewhere killed the
 *  child; the code is then 128 plus the signal's number, as a shell gives it, whatever the child
 *  answered. Outside a try this module listens to no signal. */
export function deployTry(input: {
  command: string;
  args: string[];
  cwd: string;
  piped: boolean;
  out: (piece: Buffer) => void;
  err: (piece: Buffer) => void;
}) {
  return new Promise<{ code: number; notBound: boolean; stopped: boolean }>((done) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: input.piped ? ["inherit", "pipe", "pipe"] : "inherit",
    });
    let notBound = false;
    // The words can come in two pieces: the end of each piece is kept for the next.
    const through = (to: (piece: Buffer) => void) => {
      let end = "";
      return (piece: Buffer) => {
        to(piece);
        const text = end + piece.toString();
        if (text.includes(NOT_BOUND)) notBound = true;
        end = text.slice(-NOT_BOUND.length);
      };
    };
    child.stdout?.on("data", through(input.out));
    child.stderr?.on("data", through(input.err));
    let got: NodeJS.Signals | undefined;
    const stop = (signal: NodeJS.Signals) => {
      got = signal;
      child.kill(signal);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    child.on("error", (error) => {
      console.error(`The deploy did not start: ${error.message}`);
      done({ code: 1, notBound: false, stopped: false });
    });
    child.on("close", (code, killedBy) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      const signal = got || killedBy;
      if (signal) done({ code: 128 + constants.signals[signal], notBound, stopped: true });
      else done({ code: code ?? 1, notBound, stopped: false });
    });
  });
}
