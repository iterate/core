// cloud-accounts.ts — THE "iterate Cloud" SECTION of the Dash's Integrations page (worker.ts calls
// `cloudAccountsEvent` for every event). The section's heading says what iterate Cloud's own apps
// are and why to use them. Under it stands one card for each app that this mind's Cloud offers
// (Google, GitHub, Slack, X): what it is for, and a button that begins a connect ("Connect", then
// "Add account"; apps/dash/app.ts answers it). A card has one row for each account that a member
// connected through that app: whose account it is, and the secret that holds it. An agent
// connects one the same way (AGENTS.md, "Accounts through iterate Cloud"), and its row appears.
//
// All of it is this file's word, kept by three events:
//
//   mind/worker-updated        every publish of this repo: the section is made true
//   secret/set                 a member connected an account, or connected one again: its row
//   secret/deleted             an account was disconnected: its row goes
//
// WHICH SECRET IS AN ACCOUNT OF WHICH APP, the catalog says (`itx.secrets.list()`): `cloud` is the
// Cloud's name for the app that refreshes the secret. A secret of an app of the mind's own has
// none, and is not here.
//
// WHOSE ACCOUNT IT IS, the service is asked once, with the secret's placeholder (the token never
// comes here): when the secret is set, and when a publish finds a secret with no row. A service
// that refuses the token gets the row "Connect again"; one that gives no answer leaves the row
// as it was.
//
// WHICH CLOUD, AND WHICH APPS, the vault says (`itx.secrets.cloud()`): the Cloud that the stack's
// config names, and the clients it publishes. A mind whose stack names no Cloud has no section.
import { jsonEqual } from "iterate/lib";
import { z } from "zod";

/** The section's name in the registry, and the start of the name of each of its cards. */
const SECTION = "iterate-cloud";

type Json = Record<string, unknown>;

/** A request that says whose account a token is for, and the name in its answer. */
type WhoAmI = { url: string; name: z.ZodType<string> };

/** ONE APP OF THE CLOUD'S, by the name the Cloud gives its client: what a person calls the
 *  service, what the app is for, and the request that names a grant's account. Its mark is the Dash's own file, `apps/dash/public/brands/<name>.svg`. `installation`: the same for a GitHub App installation's token,
 *  which is an organisation's and no person's. */
type CloudApp = {
  title: string;
  about: string;
  whoami: WhoAmI;
  installation?: WhoAmI;
};

const APPS: Record<string, CloudApp> = {
  google: {
    title: "Google",
    about:
      "Gmail and Google Calendar as your own account: an agent reads and sends mail, and hears of new mail and events as they happen.",
    whoami: {
      url: "https://www.googleapis.com/oauth2/v3/userinfo",
      name: z.object({ email: z.string().min(1) }).transform((body) => body.email),
    },
  },
  github: {
    title: "GitHub",
    about:
      "The repositories, issues and pull requests of the accounts you choose, and their events as they happen.",
    whoami: {
      url: "https://api.github.com/user",
      name: z.object({ login: z.string().min(1) }).transform((body) => body.login),
    },
    installation: {
      url: "https://api.github.com/installation/repositories?per_page=1",
      name: z
        .object({
          repositories: z.array(z.object({ owner: z.object({ login: z.string().min(1) }) })).min(1),
        })
        .transform((body) => body.repositories[0]!.owner.login),
    },
  },
  slack: {
    title: "Slack",
    about: "A bot in your workspace: mention it or message it, and an agent answers in the thread.",
    whoami: {
      // Slack answers 200 with `ok: false` to a token it refuses: no `team` is no name
      url: "https://slack.com/api/auth.test",
      name: z.object({ team: z.string().min(1) }).transform((body) => body.team),
    },
  },
  x: {
    title: "X",
    about: "Message iterate's bot from your X account, and an agent answers.",
    whoami: {
      url: "https://api.x.com/2/users/me",
      name: z
        .object({ data: z.object({ username: z.string().min(1) }) })
        .transform((body) => `@${body.data.username}`),
    },
  },
};

/** The registry's state, as far as this file reads it (iterate/integrations). */
const Registry = z.object({
  integrations: z.record(z.string(), z.unknown()).default({}),
  connections: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  sections: z.record(z.string(), z.unknown()).default({}),
});

type Secret = { path: string; refresh?: string; cloud?: string };

/** The part of `itx` this file uses. */
export type CloudAccountsItx = {
  fetch(request: Request): Promise<Response>;
  secrets: {
    list(): Promise<Secret[]>;
    cloud(): Promise<{ origin: string; clients: string[] } | null>;
  };
  cd(path: string): {
    append(event: { type: string; payload: Json }): Promise<unknown>;
    facets: {
      get<T>(name: string): T;
    };
  };
};

export type CloudAccountsEvent = { type: string; path: string; payload?: unknown };

/** One of the three events above; any other event does nothing. */
export async function cloudAccountsEvent(
  itx: CloudAccountsItx,
  event: CloudAccountsEvent,
): Promise<void> {
  const secretChanged =
    event.path === "/" &&
    (event.type === "events.iterate.com/secret/set" ||
      event.type === "events.iterate.com/secret/deleted");
  const published = event.path === "/" && event.type === "events.iterate.com/mind/worker-updated";
  if (!secretChanged && !published) return;
  // a secret that was set again may be another account's now: its row is asked for again
  const changed = secretChanged
    ? z.object({ path: z.string() }).safeParse(event.payload).data?.path
    : undefined;
  await keepSection(itx, changed);
}

/** The section, made true: its heading, a card for each app, a row for each account. Only what
 *  differs from the registry is appended, so a publish that changes nothing adds nothing to the
 *  log. */
async function keepSection(
  itx: CloudAccountsItx,
  changedSecret: string | undefined,
): Promise<void> {
  const registry = itx.cd("/integrations");
  const { state } = await registry.facets
    .get<{ snapshot(): Promise<{ state: unknown }> }>("integration")
    .snapshot();
  const { integrations, connections, sections } = Registry.parse(state);
  const cloud = await cloudOf(itx);
  // no Cloud, or one that did not answer: a section that stands is left as it is
  if (!cloud) return;

  const heading = {
    title: "iterate Cloud",
    description:
      "iterate runs its own app at each of these services, and every mind may use it. You register no app and paste no secret. The tokens are kept in this mind's secrets, and the Cloud never holds them. Connect an account here, or ask your agent to.",
    icon: `${cloud.origin}/iterate-logo.svg`,
  };
  if (!jsonEqual(sections[SECTION], heading))
    await registry.append({
      type: "events.iterate.com/integration/section-configured",
      payload: { section: SECTION, heading },
    });

  const secrets = await itx.secrets.list();
  for (const [name, app] of cloud.apps) {
    const integration = `${SECTION}-${name}`;
    const rows: Record<string, Json> = {};
    for (const secret of secrets) {
      if (secret.cloud !== name) continue;
      const key = secret.path.split("/").at(-1)!;
      const before = connections[`${integration}/${key}`];
      const row =
        before && secret.path !== changedSecret
          ? before
          : await rowOf(itx, name, app, secret, before);
      if (row) rows[key] = row;
    }
    const connected = Object.keys(rows).length;
    const card = {
      title: app.title,
      description: app.about,
      icon: { routingSlug: "dash", path: `/brands/${name}.svg` },
      section: SECTION,
      ...(connected > 0 && {
        status: { kind: "ok", text: connected === 1 ? "Connected" : `${connected} accounts` },
      }),
      actions: [
        {
          label: connected ? "Add account" : "Connect",
          routingSlug: "dash",
          path: `/connect/${name}`,
        },
      ],
    };
    // the card before its rows: a row stands under a card that exists
    if (!jsonEqual(integrations[integration], card))
      await registry.append({
        type: "events.iterate.com/integration/configured",
        payload: { integration, card },
      });
    // every row that differs, and a null for each row whose secret is gone
    const gone = Object.keys(connections)
      .filter((key) => key.startsWith(`${integration}/`))
      .map((key) => key.slice(integration.length + 1))
      .filter((connection) => !rows[connection]);
    const changes: [string, Json | null][] = [
      ...Object.entries(rows).filter(
        ([key, row]) => !jsonEqual(connections[`${integration}/${key}`], row),
      ),
      ...gone.map((connection): [string, null] => [connection, null]),
    ];
    for (const [connection, row] of changes)
      await registry.append({
        type: "events.iterate.com/integration/connection-configured",
        payload: { integration, connection, row },
      });
  }
  // the card of an app that this Cloud no longer offers goes, and its rows with it
  const offered = new Set(cloud.apps.map(([name]) => `${SECTION}-${name}`));
  for (const integration of Object.keys(integrations))
    if (integration.startsWith(`${SECTION}-`) && !offered.has(integration))
      await registry.append({
        type: "events.iterate.com/integration/configured",
        payload: { integration, card: null },
      });
}

/** This mind's Cloud: its origin, and the apps that it offers and this file knows, in the Cloud's
 *  order. Null when the stack names no Cloud, or the Cloud gave no list. */
async function cloudOf(
  itx: CloudAccountsItx,
): Promise<{ origin: string; apps: [string, CloudApp][] } | null> {
  const cloud = await itx.secrets.cloud();
  const apps = (cloud?.clients || []).flatMap((name): [string, CloudApp][] =>
    Object.hasOwn(APPS, name) ? [[name, APPS[name]!]] : [],
  );
  return cloud && apps.length ? { origin: cloud.origin, apps } : null;
}

/** One account's row: the service asked whose account the secret is for. `before` stands when
 *  the service gave no answer. */
async function rowOf(
  itx: CloudAccountsItx,
  client: string,
  app: CloudApp,
  secret: Secret,
  before: Json | undefined,
): Promise<Json | undefined> {
  const installation = secret.refresh === "github-app-installation";
  const ask = (installation && app.installation) || app.whoami;
  const field = installation ? "token" : "accessToken";
  const answer = await itx
    .fetch(
      new Request(ask.url, {
        headers: {
          authorization: `Bearer getSecret(${JSON.stringify(secret.path)}, { field: "${field}" })`,
          accept: "application/json",
        },
      }),
    )
    .catch(() => null);
  if (!answer || answer.status === 429 || answer.status >= 500) return before;
  const name = ask.name.safeParse(answer.ok ? await answer.json().catch(() => null) : null).data;
  return {
    account: name ? name.slice(0, 200) : `${app.title} account`,
    // a row that is well needs no words: the page shows its dot
    status: name
      ? { kind: "ok" }
      : { kind: "attention", text: `${app.title} refused the token. Connect the account again.` },
    details: { ...(installation && { Kind: "App installation" }), Secret: secret.path },
    actions: [
      // an installation's token is the App's own to mint: there is nothing to connect again
      ...(name || installation
        ? []
        : [
            {
              label: "Connect again",
              routingSlug: "dash",
              path: `/connect/${client}?secret=${secret.path.split("/").at(-1)}`,
            },
          ]),
      { label: "Manage", routingSlug: "dash", path: "/?page=secrets" },
    ],
  };
}
