// standing-instructions.ts — which of the config repo's Markdown files an agent is given as its
// standing instructions on every turn (processor.ts reads them fresh), by the agent's path.

/** The files, in the order the agent reads them. Every agent reads AGENTS.md. An agent at
 *  `/agents/<name>` also reads its own `<name>.md` (support.md for /agents/support). A file the
 *  repo does not have is left out. */
export function standingInstructionFiles(path: string): string[] {
  const name = /^\/agents\/([^/]+)$/.exec(path)?.[1];
  return name ? ["AGENTS.md", `${name}.md`] : ["AGENTS.md"];
}

/** The most of a standing file a request shows: every request carries the file, so one an agent
 *  grew past the model's window would fail every request, and no script could shorten it again.
 *  Role files in use stay well under it. */
export const STANDING_FILE_MAX_CHARS = 100_000;

/** A standing file as its section reads it: whole, or cut at the limit with a line saying so. */
export function standingFileSection(file: string, text: string): string {
  const shown =
    text.length <= STANDING_FILE_MAX_CHARS
      ? text
      : `${text.slice(0, STANDING_FILE_MAX_CHARS)}\n\n[${file} is cut here: it is ${String(text.length)} characters, and a request shows at most ${String(STANDING_FILE_MAX_CHARS)} of a standing file. The rest is not in force until the file is shortened.]`;
  return `${file} (/repos/config), as it is now:\n\n${shown}`;
}
