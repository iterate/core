import { attempt, mindRoot, type Check } from "./lib.ts";

// The mind's catalog of its contexts (core/itx/src/context/context-catalog.ts): a context holds a
// socket into the mind while it has work, and sends what it says about itself down it.
export async function awakeChecks(domain: string): Promise<Check[]> {
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token)
    return [
      {
        check: "contexts: the mind lists its contexts",
        pass: true,
        detail: "skipped: ITERATE_PROTOTYPE_TOKEN is not set",
      },
    ];
  const marker = crypto.randomUUID().slice(0, 8);
  const path = `/smoke/awake-${marker}`;
  return [
    await attempt(
      "contexts: a context is listed as awake while it has work, and with what it said once it is quiet",
      async () => {
        // The script is a run on `/`, so `/` has work for as long as it runs. The other context
        // has work for two appends: its socket stays for about a second, then it sends its
        // summary and closes it.
        const answer = (await mindRoot(domain, token).run(`async (itx) => {
          const path = ${JSON.stringify(path)};
          const pathsOf = (rows) => rows.map((row) => row.path);
          await itx.cd(path).append(
            { type: "events.iterate.com/itx/described", payload: { description: "smoke ${marker}", metadata: { smoke: true } } },
            { type: "test/pinged", payload: {} },
          );
          let atWork = [];
          for (let read = 0; read < 8 && !atWork.includes(path); read += 1) {
            atWork = pathsOf(await itx.contexts.list({ awake: true }));
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          // outlasts the quiet second, and the summary and the close on their way to the catalog
          await new Promise((resolve) => setTimeout(resolve, 4000));
          return {
            atWork,
            quiet: pathsOf(await itx.contexts.list({ awake: true })),
            found: await itx.contexts.list({ search: "smoke ${marker}" }),
            under: pathsOf(await itx.contexts.list({ under: "/smoke", limit: 1000 })),
          };
        }`)) as {
          atWork: string[];
          quiet: string[];
          found: {
            path: string;
            awake?: object;
            description?: string;
            metadata?: Record<string, unknown>;
            eventTypes: Record<string, number>;
            recentTypes: string[];
            lastActivityAt?: string;
          }[];
          under: string[];
        };
        const [row] = answer.found;
        return {
          pass:
            answer.atWork.includes(path) &&
            answer.atWork.includes("/") &&
            answer.quiet.includes("/") &&
            !answer.quiet.includes(path) &&
            answer.found.length === 1 &&
            row?.path === path &&
            !row.awake &&
            row.description === `smoke ${marker}` &&
            row.metadata?.smoke === true &&
            row.eventTypes["test/pinged"] === 1 &&
            row.recentTypes.at(-1) === "test/pinged" &&
            Boolean(row.lastActivityAt) &&
            answer.under.includes(path) &&
            answer.under.every((each) => each.startsWith("/smoke")),
          detail: JSON.stringify(answer).slice(0, 1_500),
        };
      },
    ),
  ];
}
