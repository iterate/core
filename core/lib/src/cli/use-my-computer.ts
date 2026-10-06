// use-my-computer.ts — THIS COMPUTER AS A CAPABILITY. A provided file like any other: its default
// export is what `iterate provide` calls, so `iterate provide use-my-computer.ts --name jonasComputer`
// and `iterate use-my-computer` (share-my-computer.ts) lend the same object. It imports nothing but
// node and its siblings, so provide can load it alone. The Mac's native extras are under `.mac`.
//
// Files are `files` of fs.ts, the very code a sandbox runs in its container as `iterate fs`.
import { spawn } from "node:child_process";
import { files } from "./fs.ts";
import { run } from "./run-command.ts";

/** What agents read next to the name. */
export const description =
  "A live computer shared by its owner: run commands (exec), read and write files (files), and on a Mac a native dialog, notifications and Swift (mac). It acts with the owner's permissions.";

/** The most one command may print on each stream; more fails, since half an answer is worse than none. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** How long a command runs when its caller names no bound. */
const EXEC_TIMEOUT_MS = 10 * 60_000;

export type ComputerExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
};

/** Run `argv` (never a shell line) and wait for it: `{ exitCode, stdout, stderr }` as bytes, like a
 *  sandbox's `exec`. A nonzero exit is an answer, not a failure. */
function exec(argv: string[], options: ComputerExecOptions = {}) {
  return new Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>(
    (resolve, reject) => {
      const [command, ...args] = argv;
      if (!command) return reject(new Error("exec needs a command: exec([argv0, ...args])"));
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeoutMs ?? EXEC_TIMEOUT_MS,
      });
      const out: Buffer[][] = [[], []];
      const sizes = [0, 0];
      for (const [index, stream] of [child.stdout, child.stderr].entries())
        stream.on("data", (chunk: Buffer) => {
          sizes[index]! += chunk.length;
          if (sizes[index]! > MAX_OUTPUT_BYTES) {
            child.kill();
            reject(new Error(`a command printed more than ${MAX_OUTPUT_BYTES} bytes`));
          } else out[index]!.push(chunk);
        });
      child.on("error", reject);
      // a signal-killed child reports a null code: a failure, not 0
      child.on("close", (code) =>
        resolve({
          exitCode: code ?? 1,
          stdout: new Uint8Array(Buffer.concat(out[0]!)),
          stderr: new Uint8Array(Buffer.concat(out[1]!)),
        }),
      );
      // a command that ends without reading its stdin is the command's to explain: its exit says
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    },
  );
}

/** The Mac's own extras: what no other computer has. */
const mac = {
  /** Pop a native dialog on screen and return which button the human clicked. */
  async ask({ question, buttons = ["No", "Yes"] }: { question: string; buttons?: string[] }) {
    // AppleScript's `display dialog` supports one to three buttons.
    if (buttons.length < 1 || buttons.length > 3) {
      throw new Error("ask() needs 1–3 buttons (AppleScript dialogs cap at three).");
    }
    const buttonList = buttons.map((b) => `"${escapeForAppleScript(b)}"`).join(", ");
    const { stdout } = await osascript(
      `display dialog "${escapeForAppleScript(question)}" ` +
        // Default to the FIRST button (the caller's safe/decline option, "No" by
        // default): this can run arbitrary local Swift, so an accidental Return
        // must not confirm.
        `buttons {${buttonList}} default button "${escapeForAppleScript(buttons[0]!)}" ` +
        `with title "iterate · myComputer"`,
    );
    // osascript prints e.g. `button returned:Yes` — hand back just the choice.
    return { answer: stdout.trim().replace(/^button returned:/, "") };
  },
  /** Show a desktop notification. */
  async notify({ message, title = "iterate" }: { message: string; title?: string }) {
    await osascript(
      `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"`,
    );
    return { ok: true as const };
  },
  /** Run arbitrary Swift and return its output — full power, when an agent needs it. */
  runSwift({ code }: { code: string }) {
    // `swift -` reads a whole program from stdin and runs it.
    return run("swift", ["-"], code);
  },
};

/** THE PROVIDED OBJECT: what `iterate provide` lends. `mac` exists on a Mac alone. */
export default function computer() {
  const onMac = process.platform === "darwin";
  return {
    exec,
    files,
    ...(onMac && { mac }),
    __describe() {
      const types = `exec(argv: string[], options?: { cwd?: string; env?: Record<string, string>; stdin?: string | Uint8Array; timeoutMs?: number }): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>;
files.read(path: string): Promise<ReadableStream<Uint8Array>>; files.write(path: string, content: string | Uint8Array | ReadableStream<Uint8Array>): Promise<void>; files.stat(path: string) / files.lstat(path: string): Promise<{ type: "file" | "directory" | "symlink" | "other"; size: number; mode: number; mtimeMs: number }>; files.readDirectory(path: string): Promise<{ name: string; type: string }[]>; files.mkdir(path: string, options?: { recursive?: boolean }): Promise<void>; files.rename(from: string, to: string): Promise<void>; files.remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;`;
      return {
        instructions: `${description} Ask before destructive actions.${onMac ? " Swift has full local access." : ""}`,
        types:
          types +
          (onMac
            ? ` mac.ask(input: { question: string; buttons?: string[] }): Promise<{ answer: string }>; mac.notify(input: { message: string; title?: string }): Promise<{ ok: true }>; mac.runSwift(input: { code: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;`
            : ""),
      };
    },
  };
}

/** Run an AppleScript snippet, throwing if osascript reports failure (e.g. the human cancels). */
async function osascript(script: string) {
  const result = await run("osascript", ["-e", script]);
  if (result.exitCode !== 0) {
    throw new Error(
      `osascript failed (exit ${result.exitCode}): ${result.stderr.trim() || "no output"}`,
    );
  }
  return result;
}

/** Escape a string for embedding in an AppleScript double-quoted literal. */
const escapeForAppleScript = (text: string) =>
  text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
