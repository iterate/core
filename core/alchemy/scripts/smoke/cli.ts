import { RpcTarget } from "capnweb";
import { connectProject, projectToken } from "iterate/node";
import { projectApiUrlOf } from "iterate/project-api";
import { attempt, type Check, projectRoot } from "./lib.ts";

async function smokeToken(domain: string): Promise<string | undefined> {
  if (process.env.ITERATE_PROTOTYPE_TOKEN) return process.env.ITERATE_PROTOTYPE_TOKEN;
  return await projectToken({
    address: domain,
    resource: projectApiUrlOf(domain),
    signIn: false,
  }).catch(() => undefined);
}

class Pong extends RpcTarget {
  ping() {
    return "pong";
  }
}

export async function cliChecks(domain: string): Promise<Check[]> {
  const token = await smokeToken(domain);
  if (!token)
    return [
      {
        check: "cli: connectProject and provide",
        pass: true,
        detail: "skipped: no token (ITERATE_PROTOTYPE_TOKEN, or `iterate login <domain>`)",
      },
    ];
  // a match no other run uses, so two checks at once never meet
  const match = `itx.smokeCli${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const callThroughProject = () => projectRoot(domain, token).invoke(`${match}.ping()`);
  return [
    await attempt("cli: connectProject and whoami", async () => {
      using connection = await connectProject({ address: domain, token, signIn: false });
      const who = await connection.itx.whoami();
      return { pass: who.path === "/", detail: `path ${who.path}` };
    }),
    await attempt(
      "cli: a provided stub answers through the project, and goes on dispose",
      async () => {
        using connection = await connectProject({ address: domain, token, signIn: false });
        const lend = await connection.itx.provide(match, new Pong());
        const answered = await callThroughProject();
        lend[Symbol.dispose]();
        // the rule goes with the stub's last pager, which the dispose closes: give it a moment
        let gone = "";
        for (let attempts = 0; attempts < 10 && !gone; attempts++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          gone = await callThroughProject().then(
            () => "",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          );
        }
        return {
          pass: answered === "pong" && Boolean(gone),
          detail: `answered ${JSON.stringify(answered)}; after dispose: ${gone || "still answers"}`,
        };
      },
    ),
  ];
}
