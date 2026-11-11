import { connectProject } from "iterate/node";
import { createCli } from "trpc-cli";

/** Evaluates `expression` against the project deployed on `domain`. */
export default async function itx(
  /** The project's domain, e.g. example.com. */
  domain: string,
  /** A JavaScript expression with `itx` in scope, e.g. itx.whoami(). */
  expression: string,
) {
  using connection = await connectProject({ address: domain, signIn: false });
  // oxlint-disable-next-line no-new-func -- evaluating the caller's own expression is this script's whole purpose
  const evaluate = new Function("itx", `return (async () => (${expression}))();`);
  console.log(JSON.stringify(await evaluate(connection.itx), null, 2));
}

void createCli(import.meta).run();
