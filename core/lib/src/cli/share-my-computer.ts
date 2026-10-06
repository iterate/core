// share-my-computer.ts — `iterate use-my-computer`: use-my-computer.ts lent as `itx.<name>` through
// `runProvide` (so it reconnects as `iterate provide` does), under a friendly default name.
import { hostname } from "node:os";
import { builtInPrompts } from "trpc-cli";
import type { connectIterate } from "../node.ts";
import { runProvide } from "./provide.ts";
import computer, { description } from "./use-my-computer.ts";

/** Lend this computer to `project` until Ctrl-C. */
export async function shareMyComputer(input: {
  connection: Awaited<ReturnType<typeof connectIterate>>;
  reconnect: () => Promise<Awaited<ReturnType<typeof connectIterate>>>;
  project: string;
  name?: string;
}) {
  await runProvide({
    connection: input.connection,
    reconnect: input.reconnect,
    project: input.project,
    name: input.name || (await askComputerName()),
    file: { provide: computer, description },
  });
}

async function askComputerName(): Promise<string> {
  const proposed = proposeComputerName();
  // Non-interactive (piped output, an agent): just take the proposal.
  if (!process.stdin.isTTY) return proposed;

  const answer = await builtInPrompts().input(
    {
      message:
        "What should agents call this computer? (camelCase — it becomes the itx.<name> path)",
      default: proposed,
      validate: (value) =>
        /^[a-zA-Z][a-zA-Z0-9]*$/.test(value.trim()) ||
        "Use a camelCase name: letters and digits, starting with a letter (e.g. jonasComputer).",
    },
    // the prompt reads only the streams; the command and inputs are for prompts inside trpc-cli
    {
      command: { name: () => "use-my-computer" },
      inputs: { argv: [], arguments: [], options: [] },
    },
  );
  return answer.trim();
}

/** "Jonas’s-MacBook-Pro.local" → "jonasComputer". A friendly default, always editable. */
function proposeComputerName(): string {
  const firstWord = hostname()
    .replace(/\.local$/i, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)[0];
  const cleaned = firstWord?.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned ? `${cleaned}Computer` : "myComputer";
}
