// Needs ITERATE_PROTOTYPE_TOKEN and ITERATE_SMOKE_CLOUD_ORIGIN (the config's `cloud.origin`); the
// webhook check also needs the stack to trust the Cloud's key.
import { get } from "node:https";
import { z } from "zod";
import { attempt, mindRoot, type Check } from "./lib.ts";

const TOKENS = "/secrets/smoke-cloud-github";
const INSTALLATION = "/secrets/smoke-cloud-installation";
const X_TOKENS = "/secrets/smoke-cloud-x";
const GOOGLE_TOKENS = "/secrets/smoke-cloud-google";
const SLACK_TOKENS = "/secrets/smoke-cloud-slack";

const CloudFacts = z.object({
  clients: z.record(
    z.string(),
    z.object({
      authorizationEndpoint: z.string(),
      urls: z.array(z.string()),
      installUrl: z.string().optional(),
      bot: z.object({ id: z.string(), username: z.string() }).nullish(),
    }),
  ),
});

export async function cloudChecks(domain: string): Promise<Check[]> {
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  const cloud = process.env.ITERATE_SMOKE_CLOUD_ORIGIN;
  if (!token || !cloud)
    return [skipped("set ITERATE_PROTOTYPE_TOKEN and ITERATE_SMOKE_CLOUD_ORIGIN")];
  const facts = CloudFacts.safeParse(
    await (await fetch(`${cloud}/.well-known/iterate-cloud`)).json().catch(() => null),
  );
  const github = facts.data?.clients.github;
  const login = github && new URL(github.authorizationEndpoint).searchParams.get("login");
  if (!github?.installUrl || !login)
    return [skipped(`the Cloud at ${cloud} has no github client at the pet shop's fake`)];
  const root = () => mindRoot(domain, token);
  const [shop] = github.urls;
  const installationId = new URL(github.installUrl).searchParams.get("installation_id") || "";
  const withSecret = (url: string, path: string, method = "GET") =>
    root()
      .run(
        `async (itx) => { const response = await itx.fetch(new Request(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { authorization: 'Bearer getSecret("${path}", { field: "accessToken" })' } })); return { status: response.status, body: await response.json().catch(() => null) }; }`,
      )
      .then((answer) => z.object({ status: z.number(), body: z.unknown() }).parse(answer));

  const refreshed = async (path: string) =>
    (await root().cd(path).readEvents(0, 500)).events.filter(
      (event) =>
        event.type === "events.iterate.com/secret/refreshed" &&
        (event.payload as { ok?: unknown } | undefined)?.ok === true,
    ).length;
  const google = facts.data?.clients.google;
  const address = google && new URL(google.authorizationEndpoint).searchParams.get("email");
  // the Slack fake names its workspace in the authorize link, as the others name their person
  const slack = facts.data?.clients.slack;
  const team = slack && new URL(slack.authorizationEndpoint).searchParams.get("team");

  return [
    ...(await botChecks(cloud, facts.data?.clients.x, root)),
    ...(google && address
      ? [
          await attempt(
            "cloud: Gmail connects through the Cloud's Google client, and refreshes through it",
            async () => {
              const begun = z.object({ authorizationUrl: z.string() }).parse(
                await root().secrets.beginOAuth(GOOGLE_TOKENS, {
                  client: { cloud: "google" },
                  anyoneWithLink: true,
                }),
              );
              const done = await walked(begun.authorizationUrl, cloud);
              const profile = `${google.urls[0]}/gmail/v1/users/me/profile`;
              const first = await withSecret(profile, GOOGLE_TOKENS);
              const before = await refreshed(GOOGLE_TOKENS);
              await fetch(`${google.urls[0]}/__test-controls/expire-tokens`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ clientId: "petshop-default", account: address }),
              });
              const second = await withSecret(profile, GOOGLE_TOKENS);
              const after = await refreshed(GOOGLE_TOKENS);
              const named = (first.body as { emailAddress?: unknown } | null)?.emailAddress;
              return {
                pass:
                  done.includes("holds the tokens") &&
                  named === address &&
                  second.status === 200 &&
                  after > before,
                detail: `Gmail names ${String(named)}; after the token expired: ${second.status}, refreshes on the log ${before} then ${after}`,
              };
            },
          ),
        ]
      : []),
    ...(slack && team
      ? [
          await attempt(
            "cloud: a Slack workspace connects through the Cloud's client, and its bot token answers",
            async () => {
              const begun = z.object({ authorizationUrl: z.string() }).parse(
                await root().secrets.beginOAuth(SLACK_TOKENS, {
                  client: { cloud: "slack" },
                  anyoneWithLink: true,
                }),
              );
              const done = await walked(begun.authorizationUrl, cloud);
              const bot = await withSecret(`${slack.urls[0]}/api/auth.test`, SLACK_TOKENS, "POST");
              const pin =
                (await root().secrets.list()).find((entry) => entry.path === SLACK_TOKENS)?.urls ||
                [];
              const named = (bot.body as { team_id?: unknown } | null)?.team_id;
              return {
                pass: done.includes("holds the tokens") && named === team && !pin.includes(cloud),
                detail: `Slack names the workspace ${String(named)}; the pin is ${pin.join(", ")}`,
              };
            },
          ),
        ]
      : []),
    await attempt("cloud: a secret connects through the Cloud's GitHub client", async () => {
      const begun = z.object({ authorizationUrl: z.string() }).parse(
        await root().secrets.beginOAuth(TOKENS, {
          // the pet shop's installation is on this organization, which the fake's person owns
          // (internal-packages/cloud-clients scripts/dev-petshop.ts): a connect gets the installations of
          // the accounts it names, and no other
          client: { cloud: "github", accounts: [`${login}-org`] },
          anyoneWithLink: true,
        }),
      );
      const done = await walked(begun.authorizationUrl, cloud);
      const user = await withSecret(`${shop}/user`, TOKENS);
      // the pin is the provider's hosts alone: the Cloud's broker is no place a token may go
      const pin = (await root().secrets.list()).find((entry) => entry.path === TOKENS)?.urls || [];
      const named = (user.body as { login?: unknown } | null)?.login;
      return {
        pass: done.includes("holds the tokens") && named === login && !pin.includes(cloud),
        detail: `the stack's callback: ${done.slice(0, 60)}; the provider names ${String(named)}; the pin is ${pin.join(", ")}`,
      };
    }),
    await attempt("cloud: an expired access token is refreshed through the Cloud", async () => {
      const before = await refreshed(TOKENS);
      await fetch(`${shop}/__test-controls/expire-tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "petshop-default", account: login }),
      });
      const user = await withSecret(`${shop}/user`, TOKENS);
      const after = await refreshed(TOKENS);
      return {
        pass: user.status === 200 && after > before,
        detail: `${user.status}; refreshes on the secret's log: ${before} then ${after}`,
      };
    }),
    await attempt("cloud: the Cloud mints the App's installation token", async () => {
      await root().secrets.set(
        INSTALLATION,
        {},
        {
          urls: [shop!],
          refresh: {
            kind: "github-app-installation",
            apiOrigin: shop!,
            installationId,
            client: { cloud: "github" },
          },
        },
      );
      const repositories = await withSecret(`${shop}/installation/repositories`, INSTALLATION);
      return { pass: repositories.status === 200, detail: String(repositories.status) };
    }),
    await attempt(
      "cloud: a GitHub webhook lands as an event signed by the Cloud's key",
      async () => {
        const delivery = crypto.randomUUID();
        const fired = z.object({ status: z.number(), body: z.unknown() }).parse(
          await (
            await fetch(`${shop}/__test-controls/apps/fire-webhook`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                installationId,
                url: `${cloud}/clients/github/webhook`,
                eventName: "ping",
                deliveryId: delivery,
                event: { zen: "smoke", installation: { id: Number(installationId) } },
              }),
            })
          ).json(),
        );
        const path = `/integrations/github/${installationId}`;
        for (let tries = 0; tries < 20; tries += 1) {
          const landed = (await root().cd(path).readEvents(0, 500)).events.find(
            (event) =>
              event.type === "events.iterate.com/github/webhook-received" &&
              (event.payload as { delivery?: { id?: unknown } } | undefined)?.delivery?.id ===
                delivery,
          );
          if (landed) {
            const signer = (
              landed.source as { signer?: { principal?: { actor?: unknown } } } | undefined
            )?.signer?.principal?.actor;
            return {
              pass: signer === "iterate-cloud",
              detail: `on ${path}, signed by ${String(signer)}`,
            };
          }
          await new Promise((settle) => setTimeout(settle, 1000));
        }
        return {
          pass: false,
          detail: `the Cloud answered ${fired.status} ${JSON.stringify(fired.body)}, and nothing landed on ${path} in 20 s: does the stack trust the Cloud's key? (${cloud}/enrol?mind=${domain})`,
        };
      },
    ),
  ];
}

async function botChecks(
  cloud: string,
  x: z.infer<typeof CloudFacts>["clients"][string] | undefined,
  root: () => ReturnType<typeof mindRoot>,
): Promise<Check[]> {
  const person = x && new URL(x.authorizationEndpoint).searchParams.get("user");
  const bot = x?.bot;
  if (!x || !person || !bot) return [];
  const [fake] = x.urls;
  const said = `smoke ${crypto.randomUUID()}`;
  return [
    await attempt("cloud: an X account links through the Cloud's client", async () => {
      const begun = z.object({ authorizationUrl: z.string() }).parse(
        await root().secrets.beginOAuth(X_TOKENS, {
          client: { cloud: "x" },
          anyoneWithLink: true,
        }),
      );
      const done = await walked(begun.authorizationUrl, cloud);
      return { pass: done.includes("holds the tokens"), detail: done.slice(0, 70) };
    }),
    await attempt(
      "cloud: what the linked account says to the bot lands signed by the Cloud, and the mind answers as the bot",
      async () => {
        await fetch(`${fake}/__test-controls/dm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: person, to: bot.id, text: said }),
        });
        const path = `/integrations/x/${person}`;
        // the bot reads once a minute
        let heard: { payload?: unknown; source?: unknown } | undefined;
        for (let tries = 0; tries < 50 && !heard; tries += 1) {
          await new Promise((settle) => setTimeout(settle, 2000));
          // this stack's Cloud relayed it: another Cloud with the same key and the same bot
          // account relays the same message, and the vault answers no Cloud but its own
          heard = (await root().cd(path).readEvents(0, 500)).events.find((event) => {
            const payload = event.payload as { text?: unknown; reply?: unknown } | undefined;
            return (
              event.type === "events.iterate.com/x/message-received" &&
              payload?.text === said &&
              String(payload.reply).startsWith(`${cloud}/`)
            );
          });
        }
        if (!heard)
          return {
            pass: false,
            detail: `nothing landed on ${path} in 100 s: does the stack trust the Cloud's key?`,
          };
        const signer = (
          heard.source as { signer?: { principal?: { actor?: unknown } } } | undefined
        )?.signer?.principal?.actor;
        const { reply } = heard.payload as { reply: string };
        const answer = z
          .object({ status: z.number(), body: z.string() })
          .parse(
            await root().run(
              `async (itx) => { const response = await itx.fetch(new Request(${JSON.stringify(reply)}, { method: "POST", headers: { "content-type": "application/json", "iterate-connection": 'getSecret("${X_TOKENS}")' }, body: ${JSON.stringify(JSON.stringify({ kind: "dm", to: person, text: `re: ${said}` }))} })); return { status: response.status, body: (await response.text()).slice(0, 200) }; }`,
            ),
          );
        const answered = answer.status;
        const sent = z
          .array(z.object({ to: z.string(), text: z.string() }))
          .parse(await (await fetch(`${fake}/__test-controls/sent?by=${bot.id}`)).json());
        return {
          pass: signer === "iterate-cloud" && answered === 200 && sent[0]?.text === `re: ${said}`,
          detail: `on ${path}, signed by ${String(signer)}; the answer: ${answered}${answered === 200 ? "" : ` ${answer.body}`}; @${bot.username} sent ${sent[0]?.to === person ? "it to the person" : "nothing to the person"}`,
        };
      },
    ),
  ];
}

// A person's browser from a start link to the vault's own callback page: it keeps each origin's
// cookies, follows each redirect, and presses the one link of each page on the way. For a client
// of iterate Cloud's that is one page, the Cloud's, before the provider (internal-packages/cloud-clients
// `begin`); a Cloud that has no such page yet asks on its callback instead.
async function walked(startLink: string, cloud: string): Promise<string> {
  const jars = new Map<string, Map<string, string>>();
  const seen: string[] = [];
  let at = startLink;
  for (let step = 0; step < 12; step++) {
    const { origin, pathname } = new URL(at);
    const jar = jars.get(origin) || new Map<string, string>();
    jars.set(origin, jar);
    const loaded = await pageLoad(
      at,
      [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    );
    for (const cookie of loaded.cookies) {
      const [pair = ""] = cookie.split(";");
      jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
    }
    seen.push(`${origin}${pathname} ${loaded.status}`);
    const link = (/<a [^>]*href="([^"]+)"/.exec(loaded.body)?.[1] || "").replace(
      /&#(\d+);/g,
      (_all, code) => String.fromCharCode(Number(code)),
    );
    if (pathname === "/secrets/oauth/callback")
      return `${loaded.status} ${loaded.body
        .replace(/<(style|head)[\s\S]*?<\/\1>/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()}`;
    const next = loaded.location || link;
    if (!next) break;
    at = new URL(next, at).href;
  }
  throw new Error(
    `the browser never reached the vault's callback through ${cloud}: ${seen.join(", then ")}`,
  );
}

// node:https, because Node's `fetch` writes `Sec-Fetch-Mode: cors` over the caller's own, and the
// vault's pages answer a navigation alone.
function pageLoad(
  url: string,
  cookie = "",
): Promise<{ status: number; location: string; cookies: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      accept: "text/html",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    if (cookie) headers.cookie = cookie;
    get(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode || 0,
          location: response.headers.location || "",
          cookies: response.headers["set-cookie"] || [],
          body: Buffer.concat(chunks).toString(),
        }),
      );
    }).on("error", reject);
  });
}

function skipped(why: string): Check {
  return {
    check: "cloud: a client of iterate Cloud's, and its signed webhooks",
    pass: true,
    detail: `skipped: ${why}`,
  };
}
