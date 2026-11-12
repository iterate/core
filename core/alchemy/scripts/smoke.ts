import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  platformOriginOf,
  mindApiUrlOf,
  mindMcpUrlOf,
  mindProvideUrlOf,
  protectedResourceMetadataUrlOf,
} from "iterate/mind-api";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { sandboxChecks } from "./smoke/sandboxes.ts";
import { cliChecks } from "./smoke/cli.ts";
import { integrationsChecks } from "./smoke/integrations.ts";
import { telemetryChecks } from "./smoke/telemetry.ts";
import { authChecks } from "./smoke/auth.ts";
import { homeLabChecks } from "./smoke/home-lab.ts";
import { approvalChecks } from "./smoke/approvals.ts";
import { cloudChecks } from "./smoke/cloud.ts";
import { secretChecks } from "./smoke/secrets.ts";
import { modelChecks } from "./smoke/model.ts";
import { appsChecks } from "./smoke/apps.ts";
import { HOMEPAGE, leftoverChanges, markedHomepage, withChange } from "./smoke/config-repo.ts";
import { templateFollowed } from "./smoke/template-follow.ts";
import { attempt, type Check, mindRoot, mindWorkerIs, ownsPlatformAlone } from "./smoke/lib.ts";

/** Checks the stack deployed on `domain`, the zone of its mind config. */
export default async function smoke(
  /** The mind's domain, e.g. example.com. */
  domain: string,
  /** `provided` for a stack whose mind runs elsewhere (core/home-lab); when not given, a stack
   *  whose `/provide` takes WebSockets (426 to a plain GET) is one. */
  mode?: "worker" | "provided",
  /** The config's `hostnames`: `platform` for a stack that owns `iterate.<domain>` alone. */
  hostnames?: "all" | "platform",
) {
  if (hostnames === "platform") ownsPlatformAlone();
  // Which site the mind serves is in its config repo: a check of the default config's site is
  // skipped on a mind whose worker.ts is its own (./smoke/lib.ts `DEFAULT_SITE`). A mind that does
  // not answer yet is checked as the default.
  const stackToken = process.env.ITERATE_PROTOTYPE_TOKEN;
  // first, since a homepage that still carries an earlier run's marker reads as a site of the
  // mind's own, and every check of the default site would then be skipped
  const left = stackToken ? [await nothingLeft(domain, stackToken)] : [];
  if (stackToken)
    await mindRoot(domain, stackToken)
      .repos.get("/repos/config")
      .readFile("worker.ts")
      .then(
        (source) => mindWorkerIs(String(source)),
        () => {},
      );
  const provided = mode
    ? mode === "provided"
    : (await fetch(mindProvideUrlOf(domain)).then(async (response) => {
        await response.body?.cancel();
        return response.status;
      })) === 426;
  if (provided) {
    const results = [
      ...left,
      await pageContains(`${platformOriginOf(domain)}/`, "Sign-in for"),
      await pageContains(`${platformOriginOf(domain)}/secrets/`, "secrets:"),
      ...(await homeLabChecks(domain)),
      ...(await authChecks(domain)),
      ...(await approvalChecks(domain)),
      ...(await cloudChecks(domain)),
      ...(await cliChecks(domain)),
      ...(await telemetryChecks(domain)),
      {
        check: "the mind Worker's checks (skeleton, loader, MCP, birth, files)",
        pass: true,
        detail: "skipped: the mind is provided, and has no mind Worker",
      },
    ];
    return report(results);
  }
  const results = [
    ...left,
    await pageContains(`${platformOriginOf(domain)}/`, "Sign-in for"),
    await pageContains(`${platformOriginOf(domain)}/secrets/`, "secrets:"),
    ...(await skeletonHops(`${mindApiUrlOf(domain)}/_skeleton`)),
    ...(process.env.ITERATE_PROTOTYPE_TOKEN
      ? await apiChecks(domain, process.env.ITERATE_PROTOTYPE_TOKEN)
      : [
          {
            check: "the mind's API (iterate.<domain>/api)",
            pass: true,
            detail: "skipped: ITERATE_PROTOTYPE_TOKEN is not set",
          },
        ]),
    ...(await loadedCodeAndMcpChecks(domain)),
    ...(await mindBirthChecks(domain)),
    ...(await authChecks(domain)),
    ...(await filesAndCallerChecks(domain)),
    ...(await secretChecks(domain)),
    ...(await modelChecks(domain)),
    ...(await approvalChecks(domain)),
    ...(await cloudChecks(domain)),
    ...(await sandboxChecks(domain)),
    ...(await cliChecks(domain)),
    ...(await integrationsChecks(domain)),
    ...(await appsChecks(domain)),
    ...(await telemetryChecks(domain)),
  ];
  report(results);
}

/**
 * Takes out of the mind's config repo what an earlier run of this smoke left in it
 * (./smoke/config-repo.ts `leftoverChanges`), in one commit, and waits for that commit's outcome so
 * that the checks after it read the published site. A repo that does not answer is left alone: a
 * mind not born yet has none. A leftover that cannot be taken out fails the check.
 */
async function nothingLeft(domain: string, token: string): Promise<Check> {
  const check = "repos: nothing of an earlier smoke run is left in /repos/config";
  const root = () => mindRoot(domain, token);
  const repo = () => root().repos.get("/repos/config");
  const said = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let changes;
  try {
    const { paths } = await repo().listFiles();
    const worker = paths.includes("worker.ts")
      ? String(await repo().readFile("worker.ts"))
      : undefined;
    changes = leftoverChanges({ paths, worker });
  } catch (error) {
    return {
      check,
      pass: true,
      detail: `skipped: the config repo did not answer (${said(error)})`,
    };
  }
  if (!changes.length) return { check, pass: true, detail: "nothing was left" };
  const paths = changes.map((change) => change.path).join(", ");
  try {
    const parent = await repo().tip();
    const { commitOid } = await repo().commitFiles({
      message: "smoke: take out what an earlier run left",
      changes,
      parent,
    });
    if (!commitOid) throw new Error("the commit that takes them out changed nothing");
    const outcome = await root()
      .waitForEvent({
        type: [
          "events.iterate.com/mind/worker-updated",
          "events.iterate.com/mind/worker-update-failed",
        ],
        payload: { commitOid },
        afterOffset: 0,
        timeoutMs: 120_000,
      })
      .then(
        (event) => String(event.type.split("/").pop()),
        () => "no outcome within 120 s",
      );
    return {
      check,
      pass: true,
      detail: `took out ${paths} in ${commitOid.slice(0, 12)} (${outcome})`,
    };
  } catch (error) {
    return { check, pass: false, detail: `${paths} left in the repo: ${said(error)}` };
  }
}

function report(results: { check: string; pass: boolean; detail: string }[]) {
  for (const { pass, check, detail } of results)
    console.log(`${pass ? "pass" : "FAIL"}  ${check}  (${detail})`);
  const failed = results.filter(({ pass }) => !pass).length;
  if (failed > 0) throw new Error(`${failed} of ${results.length} checks failed`);
}

const pageContains = async (url: string, text: string) => {
  const response = await fetch(url);
  const body = await response.text();
  return {
    check: `GET ${url} contains ${JSON.stringify(text)}`,
    pass: response.ok && body.includes(text),
    detail: `${response.status}`,
  };
};

const SkeletonChecks = z.object({
  principal: z.unknown(),
  egressFetchStatus: z.number(),
  authThroughEgressStatus: z.number(),
  secretsEventCount: z.number(),
  emailEventCount: z.number(),
});

const skeletonHops = async (url: string) => {
  const anonymous = await fetch(url);
  await anonymous.body?.cancel();
  const refused = {
    check: `GET ${url} without a token is refused`,
    pass: anonymous.status === 401,
    detail: `${anonymous.status}`,
  };
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token)
    return [
      refused,
      { check: `GET ${url}`, pass: true, detail: "skipped: ITERATE_PROTOTYPE_TOKEN is not set" },
    ];
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.text();
  if (!response.ok)
    return [
      refused,
      { check: `GET ${url}`, pass: false, detail: `${response.status}: ${body.slice(0, 500)}` },
    ];
  const hops = SkeletonChecks.parse(JSON.parse(body));
  return [
    refused,
    {
      check: "the boundary stamps the token's principal",
      pass: hops.principal !== null,
      detail: JSON.stringify(hops.principal),
    },
    {
      check: "mind → door → https://example.com/",
      pass: hops.egressFetchStatus === 200,
      detail: `${hops.egressFetchStatus}`,
    },
    {
      check: "mind → door → the issuer (iterate.<domain>), in the boundary",
      pass: hops.authThroughEgressStatus === 200,
      detail: `${hops.authThroughEgressStatus}`,
    },
    {
      check: "mind → door → secrets Worker: a verb answers for /secrets/skeleton",
      pass: hops.secretsEventCount >= 1,
      detail: `${hops.secretsEventCount}`,
    },
    {
      check: "mind reads its own /integrations/email",
      pass: true,
      detail: `${hops.emailEventCount} events`,
    },
  ];
};

const apiChecks = async (domain: string, token: string) => {
  const marker = crypto.randomUUID();
  const event = { type: "events.iterate.com/test/smoke-appended", payload: { marker } };
  const found = (page: { events: { payload?: unknown }[] }) =>
    page.events.some(
      (read) => (read.payload as { marker?: unknown } | undefined)?.marker === marker,
    );
  return [
    await attempt("api: stamped caller — whoami, append on /, read it back", async () => {
      const itx = mindRoot(domain, token);
      const [who, [root]] = await Promise.all([itx.whoami(), itx.append(event)]);
      const page = await mindRoot(domain, token).readEvents(root!.offset - 1, 10);
      return {
        pass: who.path === "/" && found(page),
        detail: `whoami ${JSON.stringify(who)}; / at ${root!.offset} read back ${found(page)}`,
      };
    }),
  ];
};

const loadedCodeAndMcpChecks = async (domain: string) => {
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token) return [];
  const root = () => mindRoot(domain, token);
  const marker = crypto.randomUUID();
  const RunAnswer = z.object({ marker: z.string(), offset: z.number() });
  const workerSource = {
    "package.json": '{"main":"worker.js"}',
    "worker.js": [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      "export default class extends WorkerEntrypoint {",
      "  fetch() {",
      `    return new Response(${JSON.stringify(`smoke-worker ${marker}`)});`,
      "  }",
      "}",
      "",
    ].join("\n"),
  };
  const mcpUrl = mindMcpUrlOf(domain);
  const metadataUrl = protectedResourceMetadataUrlOf(mcpUrl);
  const mcp = async (id: number, method: string, params: object, withToken: boolean) => {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(withToken && { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await response.text();
    const messages = text.trim().startsWith("{")
      ? [JSON.parse(text) as unknown]
      : text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)) as unknown);
    const answer = messages.find((message) => (message as { id?: unknown }).id === id) as
      | { result?: Record<string, unknown>; error?: unknown }
      | undefined;
    return { response, answer };
  };
  return [
    await attempt("loader: itx.run appends an event and returns a value", async () => {
      const value = RunAnswer.parse(
        await root().run(
          `async (itx) => { const [event] = await itx.append({ type: "events.iterate.com/test/smoke-run", payload: { marker: ${JSON.stringify(marker)} } }); return { marker: ${JSON.stringify(marker)}, offset: event.offset }; }`,
        ),
      );
      const page = await root().readEvents(value.offset - 1, 1);
      const logged = page.events[0]?.payload as { marker?: unknown } | undefined;
      return {
        pass: value.marker === marker && logged?.marker === marker,
        detail: `returned offset ${value.offset}; the log has it: ${logged?.marker === marker}`,
      };
    }),
    await attempt("loader: itx.workers.get with a literal source answers its fetch", async () => {
      const body = await root().run(
        `async (itx) => (await itx.workers.get({ source: ${JSON.stringify(workerSource)} }).fetch(new Request("https://smoke.invalid/"))).text()`,
      );
      return { pass: body === `smoke-worker ${marker}`, detail: JSON.stringify(body) };
    }),
    await attempt("host root: itx.kv put, then get", async () => {
      await root().kv.put("smoke", marker);
      const got = await root().kv.get("smoke");
      return { pass: got === marker, detail: `read back ${got === marker}` };
    }),
    await attempt("mcp: no token — 401 with the resource-metadata challenge", async () => {
      const { response } = await mcp(1, "initialize", {}, false);
      const challenge = response.headers.get("www-authenticate") || "";
      return {
        pass: response.status === 401 && challenge.includes(`resource_metadata="${metadataUrl}"`),
        detail: `${response.status} ${challenge}`,
      };
    }),
    await attempt("mcp: initialize, tools/list has run, tools/call run", async () => {
      const initialized = await mcp(
        1,
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "iterate-smoke", version: "0" },
        },
        true,
      );
      const listed = await mcp(2, "tools/list", {}, true);
      const tools = (listed.answer?.result?.tools as { name?: unknown }[] | undefined) || [];
      const called = await mcp(
        3,
        "tools/call",
        {
          name: "run",
          arguments: { script: `async () => ({ marker: ${JSON.stringify(marker)} })` },
        },
        true,
      );
      const result = called.answer?.result?.structuredContent as
        | { result?: { marker?: unknown } }
        | undefined;
      return {
        pass:
          !!initialized.answer?.result &&
          tools.some((tool) => tool.name === "run") &&
          result?.result?.marker === marker,
        detail: `initialize ${initialized.response.status}, tools ${JSON.stringify(tools.map((tool) => tool.name))}, run ${JSON.stringify(called.answer?.result || called.answer?.error || called.response.status)}`,
      };
    }),
  ];
};

/** Who an event names: its appender, or the person code wrote it for. */
type SaidSource = {
  principal?: { actor?: string };
  onBehalfOf?: { principal?: { actor?: string }; via?: unknown; call?: string };
};

const mindBirthChecks = async (domain: string) => {
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token) return [];
  const root = () => mindRoot(domain, token);
  const marker = crypto.randomUUID().slice(0, 8);
  let said: SaidSource | undefined;
  const outcomeOf = async (commitOid: string) =>
    (await root().waitForEvent({
      type: [
        "events.iterate.com/mind/worker-updated",
        "events.iterate.com/mind/worker-update-failed",
      ],
      payload: { commitOid },
      afterOffset: 0,
      timeoutMs: 120_000,
    })) as { type: string; payload: { error?: string } };
  const pageOnceItHas = async (url: string, text: string, withinMs: number) => {
    const until = Date.now() + withinMs;
    for (;;) {
      const response = await fetch(url);
      const body = await response.text();
      if (body.includes(text) || Date.now() >= until) return { status: response.status, body };
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  };
  return [
    await attempt("birth: the root has its certificate and a published config", async () => {
      const published = await root().waitForEvent({
        type: "events.iterate.com/mind/worker-updated",
        afterOffset: 0,
        timeoutMs: 120_000,
      });
      const created = await root().waitForEvent({
        type: "events.iterate.com/mind/created",
        afterOffset: 0,
        timeoutMs: 60_000,
      });
      const page = await root().readEvents(0, 1);
      return {
        pass: page.events[0]?.type === "events.iterate.com/itx/created" && created.offset > 0,
        detail: `worker-updated at ${published.offset}; mind/created at ${created.offset}`,
      };
    }),
    // The mind runs the commit that is published, and every other check here passes on that commit
    // when the config repo's tip does not load (core/mind-worker/src/mind/processor.ts says what
    // the platform records then). So this compares the two: every three seconds, for ninety at
    // most, since a deploy's template commit is published seconds after the root wakes.
    await attempt("birth: the config repo's tip is what the mind runs", async () => {
      let tip = "";
      let published: string | null = null;
      for (let tries = 0; tries < 30; tries += 1) {
        tip = (await root().repos.get("/repos/config").tip()) || "";
        // a capnweb stub erases the facet's type: the handle is cast
        const mind = root().facets.get("mind") as unknown as {
          snapshot(): Promise<{ state: { publishedCommit: string | null } }>;
        };
        published = (await mind.snapshot()).state.publishedCommit;
        if (tip && published === tip) break;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      if (tip && published === tip)
        return { pass: true, detail: `commit ${tip.slice(0, 10)} is published` };
      // why: the refusal of the tip, and whether the tip is the platform's own template commit
      const refusalOf = (type: string) =>
        root()
          .waitForEvent({ type, payload: { commitOid: tip }, afterOffset: 0, timeoutMs: 2_000 })
          .then(
            (event) => String(Object(event.payload).error || ""),
            () => undefined,
          );
      const template = await refusalOf("events.iterate.com/mind/template-not-published");
      const refused = await refusalOf("events.iterate.com/mind/worker-update-failed");
      return {
        pass: false,
        detail: `the config repo does not publish: its tip ${tip.slice(0, 10) || "(none)"} is not what the mind runs (${published?.slice(0, 10) || "nothing"})${template ? ", and the tip is the platform's own template commit" : ""}. ${template || refused || "No refusal of the tip is on the root's log yet."}`,
      };
    }),
    // Said, never failed: an app whose file its owner changed stays at its version by the
    // owner's choice (core/mind-worker/src/mind/template-update.ts), and this is where a deploy
    // names it. What is behind is read off the repo, laid beside this checkout's template
    // (./smoke/template-follow.ts); the mind compares at its root's first wake after a deploy, so
    // the check asks again for a minute while an app differs and nothing says why.
    await attempt("birth: what follows the template", async () => {
      const template = templateFiles();
      let said = { settled: false, detail: "" };
      for (let tries = 0; tries < 20 && !said.settled; tries += 1) {
        if (tries > 0) await new Promise((resolve) => setTimeout(resolve, 3_000));
        // one round trip: a capnweb HTTP batch takes every call made before its first await
        const repo = root().repos.get("/repos/config");
        const [manifest, ...texts] = await Promise.all(
          ["package.json", ...template.map(({ path }) => path)].map((path) =>
            repo.readFile(path).catch(() => undefined),
          ),
        );
        const files = template.map((file, index) => ({
          ...file,
          repo: typeof texts[index] === "string" ? texts[index] : undefined,
        }));
        said = templateFollowed(files, await newestTemplateFact(root), packagesOf(manifest));
      }
      return { pass: true, detail: said.detail };
    }),
    await attempt("hostnames: the apex answers the config worker's page", async () => {
      const { status, body } = await pageOnceItHas(`https://${domain}/`, HOMEPAGE, 10_000);
      return {
        pass: status === 200 && body.startsWith(HOMEPAGE),
        detail: `${status} ${body.trim().slice(0, 80)}`,
      };
    }),
    await attempt(
      "hostnames: a subdomain reaches the config worker with its routing key",
      async () => {
        const response = await fetch(`https://smoke-${marker}.${domain}/`);
        const body = await response.text();
        return {
          pass: response.status === 404 && body === "Not found\n",
          detail: `${response.status} ${JSON.stringify(body.slice(0, 80))}`,
        };
      },
    ),
    await attempt(
      "repos: a commit to /repos/config republishes the site, and is put back",
      async () => {
        const repo = () => root().repos.get("/repos/config");
        const files = await repo().listFiles();
        const original = (await repo().readFile("worker.ts")) as string;
        const changed = original.replace(HOMEPAGE, markedHomepage(marker));
        if (changed === original) throw new Error("worker.ts holds no homepage text to change");
        const page = await withChange({
          land: async (message, changes) => {
            const parent = await repo().tip();
            const { commitOid } = await repo().commitFiles({ message, changes, parent });
            if (!commitOid) throw new Error(`${message}: the commit changed nothing`);
            return commitOid;
          },
          published: async (commitOid) => {
            const outcome = await outcomeOf(commitOid);
            if (outcome.type !== "events.iterate.com/mind/worker-updated")
              throw new Error(`commit ${commitOid} was not published: ${outcome.payload.error}`);
          },
          change: {
            message: `smoke ${marker}: change the homepage`,
            changes: [{ path: "worker.ts", content: changed }],
          },
          back: {
            message: `smoke ${marker}: put the homepage back`,
            changes: [{ path: "worker.ts", content: original }],
          },
          during: async (commitOid) => ({
            commitOid,
            ...(await pageOnceItHas(`https://${domain}/`, `smoke ${marker}`, 10_000)),
          }),
        });
        return {
          pass: page.body.includes(`smoke ${marker}`),
          detail: `${JSON.stringify(files).slice(0, 80)}; ${page.commitOid.slice(0, 12)} served: ${page.body.includes(`smoke ${marker}`)}`,
        };
      },
    ),
    await attempt("agents: one answers a short message", async () => {
      const path = `/agents/smoke-${marker}`;
      // the install runs when the config's init case handles `worker-updated`: allowed a minute
      for (let tries = 0; ; tries += 1) {
        try {
          // `itx.agents` is the installed app's rule: a name the kernel's handle type does not know
          await root().invoke(["itx", "agents", ["create", path]]);
          break;
        } catch (error) {
          if (tries >= 12) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
      const sent = (await root().invoke([
        "itx",
        "agents",
        ["get", path],
        ["message", "Reply with the one word: pong"],
      ])) as { offset: number; source?: SaidSource };
      said = sent.source;
      const answer = (await root()
        .cd(path)
        .waitForEvent({
          type: [
            "events.iterate.com/agent/web-message-sent",
            "events.iterate.com/agent/llm-request-settled",
          ],
          afterOffset: sent.offset,
          timeoutMs: 120_000,
        })) as {
        type: string;
        payload: { message?: string; result?: { status: string; errorMessage?: string } };
      };
      if (answer.type === "events.iterate.com/agent/web-message-sent")
        return { pass: true, detail: (answer.payload.message || "").slice(0, 80) };
      return {
        pass: answer.payload.result?.status === "succeeded",
        detail: JSON.stringify(answer.payload.result).slice(0, 200),
      };
    }),
    await attempt("agents: the log says who said the message", async () => {
      // the agent's own facet appended the words, so the member is on `onBehalfOf`, never `principal`
      const who = (await root().whoami()) as { principal?: { actor?: string } };
      const asked = said?.onBehalfOf;
      return {
        pass:
          Boolean(who.principal?.actor) &&
          asked?.principal?.actor === who.principal?.actor &&
          asked?.call === "/agents#agents.get.message" &&
          !asked.via &&
          !said?.principal,
        detail: `the member ${who.principal?.actor}; the event's source ${JSON.stringify({ principal: said?.principal, onBehalfOf: asked })}`,
      };
    }),
  ];
};

const filesAndCallerChecks = async (domain: string) => {
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token) return [];
  const root = () => mindRoot(domain, token);
  const marker = crypto.randomUUID();
  const path = `/smoke/${marker}.txt`;
  const text = `smoke file ${marker}`;
  return [
    await attempt("files: a signed URL answers the file's bytes with no bearer", async () => {
      await root()
        .files.get(path)
        .put({ contentType: "text/plain", data: btoa(text) });
      const { url } = await root().files.get(path).url();
      const response = await fetch(url);
      const body = await response.text();
      return {
        pass: response.status === 200 && body === text,
        detail: `${response.status}, bytes equal ${body === text}`,
      };
    }),
    await attempt("files: a signature with one character changed is refused", async () => {
      const { url } = await root().files.get(path).url();
      const signed = new URL(url);
      const original = signed.searchParams.get("token") || "";
      const at = original.length - 5;
      const swapped = original[at] === "A" ? "B" : "A";
      signed.searchParams.set(
        "token",
        `${original.slice(0, at)}${swapped}${original.slice(at + 1)}`,
      );
      const response = await fetch(signed);
      await response.body?.cancel();
      return { pass: response.status === 403, detail: `${response.status}` };
    }),
    await attempt("whoami: the caller's principal", async () => {
      const who = (await root().whoami()) as { principal?: { actor?: string; email?: string } };
      return { pass: Boolean(who.principal?.actor), detail: JSON.stringify(who.principal) };
    }),
    await attempt("mail in: a platform fact appended through Mind.context lands", async () => {
      const response = await fetch(`${mindApiUrlOf(domain)}/_skeleton`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const hops = z
        .object({ platformFactOffset: z.number().int().positive().optional() })
        .parse(await response.json());
      return {
        pass: response.ok && hops.platformFactOffset !== undefined,
        detail: `${response.status}, offset ${hops.platformFactOffset}`,
      };
    }),
  ];
};

/** The newest `mind/template-applied` on the root, if any: the fact has no end marker, so each
 *  later one is asked for until none comes. */
async function newestTemplateFact(root: () => ReturnType<typeof mindRoot>) {
  let newest: { offset: number; payload?: unknown } | undefined;
  for (let after = 0; ;) {
    const next = await root()
      .waitForEvent({
        type: "events.iterate.com/mind/template-applied",
        afterOffset: after,
        timeoutMs: 1_500,
      })
      .catch(() => undefined);
    if (!next) break;
    newest = next;
    after = next.offset;
  }
  return newest && TemplateApplied.parse(newest.payload || {});
}
const TemplateApplied = z.object({
  appsLeftOld: z
    .array(
      z.object({
        app: z.string(),
        yours: z.array(z.string()),
        lacksPackages: z.array(z.string()),
        imports: z.array(z.string()).optional(),
        importedBy: z.array(z.string()).optional(),
        notWritten: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  leftAlone: z.array(z.object({ path: z.string(), lacks: z.array(z.string()) })).default([]),
  heldBack: z
    .array(
      z.object({
        path: z.string(),
        imports: z.array(z.string()),
        importedBy: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});

/** The names in the dependencies of a package.json's text; undefined when it cannot be read. */
function packagesOf(manifest: unknown): Set<string> | undefined {
  try {
    const { dependencies } = z
      .object({ dependencies: z.record(z.string(), z.string()).default({}) })
      .parse(JSON.parse(String(manifest)));
    return new Set(Object.keys(dependencies));
  } catch {
    return undefined;
  }
}

/** The default template's files that a mind's repo is laid beside: every text file of an app, and
 *  every code file outside the apps (worker.ts and what it imports), so that a file the mind held
 *  back for another file's sake can be checked against that other file. Read from this checkout,
 *  which is what a smoke after a deploy runs from. */
function templateFiles(): { path: string; template: string }[] {
  const folder = join(import.meta.dirname, "../../configs/default");
  return (
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
      .filter((path) => path.startsWith("apps/") || /\.(?:ts|tsx|js|jsx|mjs)$/.test(path))
      .filter((path) => !path.includes("node_modules/"))
      .map((path) => ({ path, template: readFileSync(join(folder, path), "utf8") }))
      // a file that is not text has no text to compare
      .filter((file) => !file.template.includes("\u0000"))
      .sort((a, b) => a.path.localeCompare(b.path))
  );
}

void createCli(import.meta).run();
