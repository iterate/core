import { mindApiUrlOf, mindProvideUrlOf, protectedResourceMetadataUrlOf } from "iterate/mind-api";
import { attempt, type Check, mindRoot } from "./lib.ts";

const ECHO = "https://httpbin.org";

const BIRTH_FACTS = [
  "events.iterate.com/repo/created",
  "events.iterate.com/repo/commit-completed",
  "events.iterate.com/mind/worker-updated",
  "events.iterate.com/mind/created",
];

export async function homeLabChecks(domain: string): Promise<Check[]> {
  const apex = `https://${domain}/`;
  const checks = [
    await attempt("home lab: /provide takes WebSockets alone (426 to a plain GET)", async () => {
      const response = await fetch(mindProvideUrlOf(domain));
      await response.body?.cancel();
      return { pass: response.status === 426, detail: `${response.status}` };
    }),
  ];
  // The boundary answers 503 for every mind hostname while nothing is provided.
  const document = await fetch(protectedResourceMetadataUrlOf(mindApiUrlOf(domain)));
  await document.body?.cancel();
  if (document.status === 503)
    return [
      ...checks,
      await attempt("home lab: with none connected, the apex is 503 and one sentence", async () => {
        const response = await fetch(apex);
        const body = await response.text();
        return {
          pass: response.status === 503 && body.trim().split(/(?<=\.)\s/).length === 1,
          detail: `${response.status} ${JSON.stringify(body.trim())}`,
        };
      }),
      { check: "home lab: the mind", pass: true, detail: "skipped: no home lab is connected" },
    ];
  checks.push(
    await attempt("home lab: the apex answers the config's page", async () => {
      const response = await fetch(apex);
      const body = (await response.text()).trim();
      return {
        pass: response.ok && body.length > 0,
        detail: `${response.status} ${JSON.stringify(body.slice(0, 120))}`,
      };
    }),
  );
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token)
    return [
      ...checks,
      {
        check: "home lab: the API (birth, repos, secrets, sandboxes)",
        pass: true,
        detail: "skipped: ITERATE_PROTOTYPE_TOKEN is not set",
      },
    ];
  const root = () => mindRoot(domain, token);
  const run = (script: string) => root().run(script) as Promise<unknown>;
  const marker = crypto.randomUUID().slice(0, 8);
  checks.push(
    await attempt("home lab: the API answers whoami with the token", async () => {
      const who = await root().whoami();
      return {
        pass: who.path === "/" && Boolean(who.principal?.actor),
        detail: `${who.path} as ${who.principal?.actor}`,
      };
    }),
    await attempt("home lab: the birth completed (repo, seed commit, publication)", async () => {
      const found = (await run(`async (itx) => {
        const found = new Set();
        for (let after = 0; ;) {
          const page = await itx.readEvents(after, 500);
          for (const event of page.events) found.add(event.type);
          if (page.atHead || page.scannedThroughOffset <= after) break;
          after = page.scannedThroughOffset;
        }
        return ${JSON.stringify(BIRTH_FACTS)}.filter((type) => found.has(type));
      }`)) as string[];
      return { pass: found.length === BIRTH_FACTS.length, detail: found.join(", ") };
    }),
    await attempt("home lab: a commit to /repos/config through itx.repos republishes", async () => {
      const outcome = (await run(`async (itx) => {
        const repo = itx.repos.get("/repos/config");
        const { commitOid } = await repo.commitFiles({
          message: "home lab smoke ${marker}",
          parent: await repo.tip(),
          changes: [{ path: "smoke/home-lab.txt", content: "${marker}\\n" }],
        });
        const outcome = await itx.waitForEvent({
          type: ["events.iterate.com/mind/worker-updated", "events.iterate.com/mind/worker-update-failed"],
          payload: { commitOid },
          afterOffset: 0,
          timeoutMs: 120000,
        });
        return { type: outcome.type, error: outcome.payload?.error };
      }`)) as { type: string; error?: string };
      return {
        pass: outcome.type === "events.iterate.com/mind/worker-updated",
        detail: outcome.error || outcome.type,
      };
    }),
    await attempt(
      "home lab: a secret set at home is used through the cloud's door, its facts at home and copied by a subscription",
      async () => {
        const path = `/secrets/home-lab-smoke-${marker}`;
        const watch = `/smoke/home-lab/secret-${marker}`;
        // The value never leaves this script's run: a random one, compared as a hash of the echo.
        const answer = (await run(`async (itx) => {
          const value = crypto.randomUUID();
          await itx.secrets.set(${JSON.stringify(path)}, value, { urls: [${JSON.stringify(ECHO)}] });
          // a home context subscribed to the secret's: each use copied onto its own log. Loaded
          // code writes the subscription's row itself (core-itx iterate-context.ts \`subscribe\`).
          await itx.cd(${JSON.stringify(path)}).append({
            type: "events.iterate.com/itx/subscription-configured",
            payload: {
              name: "home-lab-smoke",
              target: { path: ${JSON.stringify(watch)}, type: "events.iterate.com/test/secret-use-seen" },
              consumes: ["events.iterate.com/secret/used"],
            },
          });
          const response = await itx.fetch(new Request(${JSON.stringify(`${ECHO}/headers`)}, {
            headers: { "x-home-lab": 'getSecret("${path}")' },
          }));
          const echoed = (await response.json()).headers?.["X-Home-Lab"] === value;
          const types = (await itx.cd(${JSON.stringify(path)}).readEvents(0, 100)).events.map((event) => event.type);
          const seen = await itx.cd(${JSON.stringify(watch)}).waitForEvent({
            type: "events.iterate.com/test/secret-use-seen",
            afterOffset: 0,
            timeoutMs: 60000,
          });
          await itx.secrets.delete(${JSON.stringify(path)});
          return {
            status: response.status,
            echoed,
            set: types.includes("events.iterate.com/secret/set"),
            used: types.includes("events.iterate.com/secret/used"),
            copied: Boolean(seen),
          };
        }`)) as { status: number; echoed: boolean; set: boolean; used: boolean; copied: boolean };
        return {
          pass:
            answer.status === 200 && answer.echoed && answer.set && answer.used && answer.copied,
          detail: JSON.stringify(answer),
        };
      },
    ),
    await attempt(
      "home lab: a request out of loaded code that names no secret answers (it leaves from the home machine)",
      async () => {
        const status = await run('async () => (await fetch("https://example.com/")).status');
        return { pass: status === 200, detail: `example.com ${String(status)}` };
      },
    ),
    await attempt(
      "home lab: loaded code reaches no private address of the home machine or its network",
      async () => {
        // the launcher's own port by its address, by a public name that resolves to it, and a
        // usual address of a home router. workerd refuses the connection, and the code gets no
        // answer of the machine: a thrown error, or the kernel's own 500 for one.
        const tried = (await run(`async () => {
          const reached = {};
          for (const url of ["http://127.0.0.1:8789/", "http://localtest.me:8789/", "http://192.168.0.1/"])
            reached[url] = await fetch(url, { signal: AbortSignal.timeout(5000) }).then(
              async (answer) => answer.status + " " + (await answer.text()).slice(0, 60),
              (error) => "refused: " + String(error.message).slice(0, 60),
            );
          return reached;
        }`)) as Record<string, string>;
        return {
          pass: Object.values(tried).every(
            (answer) => answer.startsWith("refused") || answer.startsWith("500 "),
          ),
          detail: JSON.stringify(tried),
        };
      },
    ),
    await sandboxEcho(run, marker),
  );
  return checks;
}

// Skipped with the home lab's own refusal when it runs no container engine; a first start answers
// "still starting", and the script asks again.
function sandboxEcho(run: (script: string) => Promise<unknown>, marker: string) {
  const sandbox = JSON.stringify(`/sandboxes/home-lab-smoke-${marker}`);
  return attempt("home lab: a sandbox runs echo in the local container engine", async () => {
    const answer = (await run(`async (itx) => {
      await itx.sandboxes.create(${sandbox});
      const sandbox = itx.sandboxes.get(${sandbox});
      const deadline = Date.now() + 480000;
      try {
        for (;;) {
          try {
            const result = await sandbox.exec(["sh", "-c", "echo home-lab-${marker}"]);
            return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout).trim() };
          } catch (error) {
            const message = String(error?.message);
            if (/has no container/.test(message)) return { off: message };
            if (!/still starting/.test(message) || Date.now() > deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
      } finally {
        await itx.sandboxes.delete(${sandbox});
      }
    }`)) as { exitCode?: number; stdout?: string; off?: string };
    if (answer.off) return { pass: true, detail: `skipped: ${answer.off}` };
    return {
      pass: answer.exitCode === 0 && answer.stdout === `home-lab-${marker}`,
      detail: JSON.stringify(answer),
    };
  });
}
