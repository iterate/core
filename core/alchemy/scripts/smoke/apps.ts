// What a mind's apps stand on (tasks/full-stack-apps.md): a repo holds bytes, a published config
// imports its files, and the Agents app of the default config answers on agents.<domain>. A check
// that needs a signed-in person is not here: scripts/apps-browser-proof.ts runs those in a browser.
import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { RepoFileChange } from "iterate/api";
import { platformOriginOf } from "iterate/mind-api";
import { markedFile, withChange } from "./config-repo.ts";
import { attempt, type Check, mindRoot, mounts } from "./lib.ts";

/** One request by hand: Node's `fetch` sends no `Upgrade` and no `Sec-Fetch-*`. Answers what came
 *  back, and follows nothing. */
function ask(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; challenge: string; location: string }>((resolve, reject) => {
    const request = httpsRequest(url, { headers });
    const answered = (response: { statusCode?: number; headers: Record<string, unknown> }) => {
      resolve({
        status: response.statusCode || 0,
        challenge: String(response.headers["www-authenticate"] || ""),
        location: String(response.headers.location || ""),
      });
      request.destroy();
    };
    request.on("response", answered);
    request.on("upgrade", answered);
    request.on("error", reject);
    request.setTimeout(15_000, () => request.destroy(new Error(`${url} did not answer in 15 s`)));
    request.end();
  });
}

const handshake = (url: string, headers: Record<string, string> = {}) =>
  ask(url, {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": randomBytes(16).toString("base64"),
    ...headers,
  });

export async function appsChecks(domain: string): Promise<Check[]> {
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token)
    return [
      {
        check: "apps: bytes in a repo, files in a published config, the Agents app's host",
        pass: true,
        detail: "skipped: ITERATE_PROTOTYPE_TOKEN is not set",
      },
    ];
  const root = () => mindRoot(domain, token);
  const repo = () => root().repos.get("/repos/config");
  const marker = crypto.randomUUID().slice(0, 8);
  const published = async (commitOid: string) => {
    const outcome = (await root().waitForEvent({
      type: [
        "events.iterate.com/mind/worker-updated",
        "events.iterate.com/mind/worker-update-failed",
      ],
      payload: { commitOid },
      afterOffset: 0,
      timeoutMs: 120_000,
    })) as { type: string; payload: { error?: string } };
    if (outcome.type !== "events.iterate.com/mind/worker-updated")
      throw new Error(`commit ${commitOid} was not published: ${outcome.payload.error}`);
  };
  const land = async (message: string, changes: RepoFileChange[]) => {
    const parent = await repo().tip();
    const { commitOid } = await repo().commitFiles({ message, changes, parent });
    if (!commitOid) throw new Error(`${message}: the commit changed nothing`);
    return commitOid;
  };
  const files = await repo().listFiles();
  const hasAgentsApp = files.paths.includes("apps/agents/app.ts") && mounts("agents");
  const withoutApp = {
    pass: true,
    detail: "skipped: this mind's config does not mount apps/agents (an older or its own config)",
  };
  const app = `https://agents.${domain}`;
  const hasOnboardingApp = files.paths.includes("apps/onboarding/app.ts") && mounts("onboarding");
  const withoutOnboardingApp = {
    pass: true,
    detail:
      "skipped: this mind's config does not mount apps/onboarding (an older or its own config)",
  };

  return [
    await attempt(
      "repos: a file that is not text is committed and read back as it is",
      async () => {
        // not UTF-8, and with a NUL: bytes a text read would mangle
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 254]);
        const path = markedFile(marker);
        return withChange({
          land,
          published,
          change: {
            message: `smoke ${marker}: a file that is not text`,
            changes: [{ path, bytes }],
          },
          back: { message: `smoke ${marker}: remove the file`, changes: [{ path, delete: true }] },
          during: async (commitOid) => {
            const all = await repo().files({ commitOid });
            const text = await repo().modules({ commitOid });
            const kept = all[path];
            const refused = await repo()
              .readFile(path, { commitOid })
              .then(
                () => false,
                () => true,
              );
            const same =
              typeof kept === "object" && kept.base64 === Buffer.from(bytes).toString("base64");
            return {
              pass: same && !Object.hasOwn(text, path) && refused,
              detail: `bytes kept: ${same}; left out of the text files: ${!Object.hasOwn(text, path)}; readFile refuses it: ${refused}`,
            };
          },
        });
      },
    ),
    await attempt("hostnames: a signed-out page load of the Agents app signs in", async () => {
      if (!hasAgentsApp) return withoutApp;
      // the stand-in token is no bearer for a mind host: a member's page is the browser proof's
      const page = await ask(`${app}/`, {
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        accept: "text/html",
      });
      const file = await ask(`${app}/app.js`, { "sec-fetch-mode": "no-cors", accept: "*/*" });
      const toSignIn = page.location.startsWith(`${platformOriginOf(domain)}/oauth2/auth`);
      return {
        pass: page.status === 302 && toSignIn && file.status === 401,
        detail: `the page: ${page.status} to the issuer: ${toSignIn}; a file of it, signed out: ${file.status}`,
      };
    }),
    await attempt(
      "hostnames: a socket to the Agents app's /itx with no session is the challenge",
      async () => {
        if (!hasAgentsApp) return withoutApp;
        const answer = await handshake(`${app}/itx`, { origin: app });
        return {
          pass: answer.status === 401 && /realm="iterate"/.test(answer.challenge),
          detail: `${answer.status} ${answer.challenge}`,
        };
      },
    ),
    await attempt(
      "hostnames: a socket to the Agents app's /itx from another origin is refused",
      async () => {
        if (!hasAgentsApp) return withoutApp;
        const answer = await handshake(`${app}/itx`, { origin: `https://${domain}` });
        return { pass: answer.status === 403, detail: String(answer.status) };
      },
    ),
    await attempt("hostnames: a signed-out page load of the onboarding app signs in", async () => {
      if (!hasOnboardingApp) return withoutOnboardingApp;
      const page = await ask(`https://onboarding.${domain}/`, {
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        accept: "text/html",
      });
      const toSignIn = page.location.startsWith(`${platformOriginOf(domain)}/oauth2/auth`);
      return {
        pass: page.status === 302 && toSignIn,
        detail: `the page: ${page.status} to the issuer: ${toSignIn}`,
      };
    }),
    await attempt("hostnames: a signed-out page load of the docs app signs in", async () => {
      if (!files.paths.includes("apps/docs/app.ts") || !mounts("docs"))
        return {
          pass: true,
          detail:
            "skipped: this mind's config does not mount apps/docs (an older or its own config)",
        };
      const page = await ask(`https://docs.${domain}/`, {
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        accept: "text/html",
      });
      const toSignIn = page.location.startsWith(`${platformOriginOf(domain)}/oauth2/auth`);
      return {
        pass: page.status === 302 && toSignIn,
        detail: `the page: ${page.status} to the issuer: ${toSignIn}`,
      };
    }),
    await attempt("agents: the onboarding app's agent exists", async () => {
      if (!hasOnboardingApp) return withoutOnboardingApp;
      // the root's `itx.agents` is the rule the Agents app's install writes, untyped here
      const { agents } = root() as unknown as { agents: { list(): Promise<{ path: string }[]> } };
      const listed = (await agents.list()).some((agent) => agent.path === "/agents/onboarding");
      return { pass: listed, detail: `/agents/onboarding listed: ${listed}` };
    }),
    await attempt(
      "hostnames: no answer of the mind carries the platform's serve header",
      async () => {
        const answers = await Promise.all(
          [`https://${domain}/`, `${app}/itx`, `${app}/`].map(async (url) => {
            const response = await fetch(url, { redirect: "manual" });
            await response.body?.cancel();
            return response.headers.has("x-iterate-serve");
          }),
        );
        return { pass: !answers.includes(true), detail: `seen on: ${answers.join(", ")}` };
      },
    ),
  ];
}
