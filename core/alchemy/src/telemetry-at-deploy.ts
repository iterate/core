// telemetry-at-deploy.ts — WHAT A DEPLOY DOES TO THE STACK'S TELEMETRY TABLES BEFORE AND AFTER
// ALCHEMY RUNS (scripts/deploy-stack.ts says why; src/telemetry-tables.ts is the step).

/** Runs `deploy` with the table step around it, and answers the deploy's exit code.
 *
 *  BEFORE, with telemetry on: the step drops a table that no sink writes. When the step's own
 *  bucket is still there after it (`bucketLeft`), or the step did not end, THE DEPLOY DOES NOT
 *  START: Alchemy would take that bucket as the stack's own, with the step's mark in it. Any
 *  other failure of the step is said, and the deploy goes on.
 *
 *  AFTER a deploy that turned telemetry off (the catalog was on before it, and the deploy ended
 *  well): the same step. It runs after Alchemy and never beside it: a sink that Alchemy is
 *  deleting is still listed, and its pipeline still writes. This step fails no deploy. */
export async function deployAroundTelemetry(input: {
  /** the config of this deploy asks for telemetry */
  telemetry: boolean;
  name: string;
  /** the stack's telemetry bucket, for the lines */
  bucket: string;
  /** the step of src/telemetry-tables.ts, `when: "deploying"` */
  drop: () => Promise<{ failed: boolean; lines: string[]; bucketLeft?: boolean }>;
  /** whether the stack's data catalog is on now: one read */
  catalogOn: () => Promise<boolean>;
  deploy: () => Promise<number>;
  say: (line: string) => void;
}) {
  const { say } = input;
  let wasOn = false;
  if (input.telemetry) {
    let before: Awaited<ReturnType<typeof input.drop>>;
    try {
      before = await input.drop();
    } catch (error) {
      // it may have made its bucket before it ended
      say(
        `Stopped before the deploy: the look at the stack's telemetry tables did not end (${error instanceof Error ? error.message : String(error)}), and the bucket ${input.bucket} that it makes to reach them may be there. Nothing of the stack was changed. Run the deploy again.`,
      );
      return 1;
    }
    for (const line of before.lines) say(line);
    if (before.bucketLeft) {
      say(
        `Stopped before the deploy: the bucket ${input.bucket}, which this step made to reach the stack's tables, is still there, and a deploy would take it as the stack's own. Nothing of the stack was changed. Run the deploy again: the step removes its bucket first.`,
      );
      return 1;
    }
    if (before.failed)
      say(
        'Note: the stack\'s telemetry tables could not be looked at. The deploy goes on. When a table is left from an earlier time telemetry was on, the deploy fails at its sink ("writing to existing Catalog tables is not yet supported"): run the deploy again then.',
      );
  } else {
    try {
      wasOn = await input.catalogOn();
    } catch {
      // a read that did not answer: the deploy goes on, and the next turn-on drops what is left
    }
  }

  const code = await input.deploy();

  if (code === 0 && wasOn) {
    say(
      `This deploy turned telemetry off for ${input.name}. Its tables in the data catalog go too, with the rows in them, so that telemetry can be turned on again.`,
    );
    let left = true;
    try {
      const after = await input.drop();
      for (const line of after.lines) say(line);
      left = after.failed;
    } catch (error) {
      say(`The step did not end: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (left)
      say(
        "Note: a telemetry table of the stack may be left. The stack is deployed and works. The next deploy with telemetry on drops the table first.",
      );
  }
  return code;
}
