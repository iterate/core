// cloud-accounts.ts — EVERY SECTION OF THE DASH'S INTEGRATIONS PAGE THAT THE MIND CAN WORK OUT BY
// ITSELF (worker.ts calls `cloudAccountsEvent` for every event). The name is from its first
// section; a mind's own worker.ts imports it by that name. Three sections, each a heading card
// with cards under it:
//
//   "iterate Cloud"      one card for each app that this mind's Cloud offers (Google, GitHub,
//                        Slack, X): what it is for, and a button that begins a connect ("Connect",
//                        then "Add account"; apps/dash/app.ts answers it). A card has one row for
//                        each account that a member connected through that app: whose account it
//                        is, and the secret that holds it. An agent connects one the same way
//                        (AGENTS.md, "Accounts through iterate Cloud"), and its row appears.
//   "Keys and accounts"  every other secret: a key, or a grant through an app of the mind's own.
//                        One list, the card "Secrets (12)", with a row for
//                        each secret: its path, its kind, the hosts it is pinned to. Only the
//                        catalog is read: no service is asked.
//   "Lent by a computer" one card for each live value that a program on someone's computer lends
//                        the mind (`iterate provide`: WhatsApp, a phone line). The card goes when
//                        the program stops.
//
// All of it is this file's word, kept by four events:
//
//   mind/worker-updated          on the root: every publish of this repo, the sections made true
//   secret/set                   on the secret's own log, `/secrets/<name>` (the secrets root
//                                records a secret's fact there alone): set, or set again, its row
//   secret/deleted               on the secret's own log: deleted, its row goes
//   itx/rewrite-rule-configured  on the root: a lend began or ended, its card
//
// WHICH SECRET IS AN ACCOUNT OF WHICH APP, the catalog says (`itx.secrets.list()`): `cloud` is the
// Cloud's name for the app that refreshes the secret. A secret with none is a key or a grant of
// the mind's own, and stands under "Keys and accounts", unless a package of the mind shows its
// account already (`keepKeysSection`).
//
// WHAT IS LENT, the root's rewrite rules say (`itx.rewriteRules.list()`): a lend is a rule whose
// target is the lent stub, `itx.builtins.rpcStubs.get('<match>')`. The platform's own names
// (`itx.secrets`, `itx.config`, …) point elsewhere.
//
// WHOSE ACCOUNT IT IS, for an account through the Cloud, the service is asked once, with the
// secret's placeholder (the token never comes here): when the secret is set, and when a publish
// finds a secret with no row. A service that refuses the token gets the row "Connect again"; one
// that gives no answer leaves the row as it was.
//
// WHICH CLOUD, AND WHICH APPS, the vault says (`itx.secrets.cloud()`): the Cloud that the stack's
// config names, and the clients it publishes. A mind whose stack names no Cloud has no "iterate
// Cloud" section. A section with no card has no heading either.
//
// THE NAMES `iterate-cloud`, `keys` AND `lent` (the headings), and every name that starts with one
// of them and a dash, are this file's: it replaces or removes any other card registered there.
import { jsonEqual } from "iterate/lib";
import { z } from "zod";

/** The heading's name in the registry: the cards under it name it as their `section`, and their
 *  own names start with it. */
const SECTION = "iterate-cloud";

/** The "Keys and accounts" heading's name, and the start of its one card's name. */
const KEYS = "keys";

/** The "Lent by a computer" heading's name, and the start of each of its cards' names. */
const LENT = "lent";

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
});

type Secret = { path: string; urls: string[]; refresh?: string; cloud?: string };

/** The part of `itx` this file uses. */
export type CloudAccountsItx = {
  fetch(request: Request): Promise<Response>;
  secrets: {
    list(): Promise<Secret[]>;
    cloud(): Promise<{ origin: string; clients: string[] } | null>;
  };
  rewriteRules: {
    list(): Promise<{ match: string; target: string | null; description?: string }[]>;
  };
  cd(path: string): {
    append(event: { type: string; payload: Json }): Promise<unknown>;
    facets: {
      get<T>(name: string): T;
    };
  };
};

export type CloudAccountsEvent = { type: string; path: string; payload?: unknown };

/** The registry as this file reads it, and its append. */
type Registry = z.output<typeof Registry> & {
  append(event: { type: string; payload: Json }): Promise<unknown>;
};

/** One of the four events above; any other event does nothing. */
export async function cloudAccountsEvent(
  itx: CloudAccountsItx,
  event: CloudAccountsEvent,
): Promise<void> {
  // a secret's fact is on the secret's own log, `/secrets/<name>`, and on no other
  const secretChanged =
    /^\/secrets\/[^/]+$/.test(event.path) &&
    (event.type === "events.iterate.com/secret/set" ||
      event.type === "events.iterate.com/secret/deleted");
  const lendChanged =
    event.path === "/" && event.type === "events.iterate.com/itx/rewrite-rule-configured";
  const published = event.path === "/" && event.type === "events.iterate.com/mind/worker-updated";
  if (!secretChanged && !lendChanged && !published) return;
  // a secret that was set again may be another account's now: its row is asked for again
  const changed = secretChanged ? event.path : undefined;
  const context = itx.cd("/integrations");
  const { state } = await context.facets
    .get<{ snapshot(): Promise<{ state: unknown }> }>("integration")
    .snapshot();
  // each section writes cards of its own names alone, so one read serves all three
  const registry: Registry = {
    ...Registry.parse(state),
    append: (append) => context.append(append),
  };
  // a lend's event needs no secret, and a secret's event no rule
  if (!lendChanged) {
    const secrets = await itx.secrets.list();
    await keepCloudSection(itx, registry, secrets, changed);
    await keepKeysSection(registry, secrets);
  }
  if (!secretChanged) await keepLentSection(registry, await itx.rewriteRules.list());
}

/** The "iterate Cloud" section, made true: its heading, a card for each app, a row for each
 *  account. Only what differs from the registry is appended (here and in the other section), so
 *  a publish that changes nothing adds nothing to the log. */
async function keepCloudSection(
  itx: CloudAccountsItx,
  registry: Registry,
  secrets: Secret[],
  changedSecret: string | undefined,
): Promise<void> {
  const cloud = await cloudOf(itx);
  // no Cloud, or one that did not answer: a section that stands is left as it is
  if (!cloud) return;

  // a card like any other: the cards below name it as their section, which makes it their heading
  await keepCard(registry, SECTION, {
    title: "iterate Cloud",
    description:
      "iterate runs its own app at each of these services, and every mind may use it. You register no app and paste no secret. The tokens are kept in this mind's secrets, and the Cloud never holds them. Connect an account here, or ask your agent to.",
    icon: `${cloud.origin}/iterate-logo.svg`,
    actions: [],
  });

  for (const [name, app] of cloud.apps) {
    const integration = `${SECTION}-${name}`;
    const rows: Record<string, Json> = {};
    for (const secret of secrets) {
      if (secret.cloud !== name) continue;
      const key = secret.path.split("/").at(-1)!;
      const before = registry.connections[`${integration}/${key}`];
      const row =
        before && secret.path !== changedSecret
          ? before
          : await rowOf(itx, name, app, secret, before);
      if (row) rows[key] = row;
    }
    const connected = Object.keys(rows).length;
    // the card before its rows: a row stands under a card that exists
    await keepCard(registry, integration, {
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
    });
    await keepRows(registry, integration, rows);
  }
  // the card of an app that this Cloud no longer offers goes, and its rows with it
  const offered = new Set(cloud.apps.map(([name]) => `${SECTION}-${name}`));
  for (const integration of Object.keys(registry.integrations))
    if (integration.startsWith(`${SECTION}-`) && !offered.has(integration))
      await keepCard(registry, integration, null);
}

/** THE "KEYS AND ACCOUNTS" SECTION, made true from the catalog alone: one card, "Secrets (<count>)",
 *  with a row for each secret that has no Cloud, in path order. The stack's own Cloudflare token
 *  (`/secrets/cloudflare`, AGENTS.md "Cloudflare") is the platform's, and is not here. This
 *  card is the one `keys-` card: any other goes, and its rows with it.
 *
 *  The registry keeps its state under a byte budget, and drops a card or row past it: that one
 *  would differ again at every event, and be appended again. So the first hundred secrets by path
 *  are shown. A row is well under a kilobyte, which keeps the section far below the budget and
 *  each event's appends bounded.
 *
 *  NO ACCOUNT TWICE: a package of the mind that shows an account keeps its row at
 *  `<integration>/<connection>`, and by the contract's convention its secret at
 *  `/secrets/<integration>-<connection>`, sometimes with a prefix (`own-google-042a1be3` for the
 *  row `google/042a1be3`). Such a secret is that row's, and is not here again. */
async function keepKeysSection(registry: Registry, secrets: Secret[]): Promise<void> {
  const list = `${KEYS}-secrets`;
  const ours = [`${SECTION}-`, `${KEYS}-`, `${LENT}-`];
  const packaged = Object.keys(registry.connections)
    .filter((key) => !ours.some((prefix) => key.startsWith(prefix)))
    .map((key) => key.replace("/", "-"));
  const shown = secrets
    .filter((secret) => !secret.cloud && secret.path !== "/secrets/cloudflare")
    .filter((secret) => {
      const name = secret.path.split("/").at(-1)!;
      return !packaged.some((account) => name === account || name.endsWith(`-${account}`));
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .slice(0, 100);
  // in path order: the registry keeps a new row at its end, and the page draws rows in the
  // registry's order, so a secret set later stands last until a new list is made
  const rows: Record<string, Json> = {};
  for (const secret of shown) {
    const name = secret.path.split("/").at(-1)!;
    // a connection's name has at most 64 characters, and a secret's may have more: such a secret
    // gets no row, rather than a cut name that another secret might share
    if (name.length > 64) continue;
    // a package pins a webhook's secret to a made-up `.invalid` host (RFC 2606), which says
    // nothing to a person
    const hosts = [
      ...new Set(secret.urls.flatMap((url) => (URL.canParse(url) ? [new URL(url).hostname] : []))),
    ].filter((host) => !host.endsWith(".invalid"));
    // a key has no refresh, and no kind
    const grant = secret.refresh === "oauth-refresh-token";
    const installation = secret.refresh === "github-app-installation";
    rows[name] = {
      // the path is the name an agent and the Secrets page use: no Secret detail repeats it
      account: secret.path,
      // a secret that is set is well: the row needs no words, the page shows its dot
      status: { kind: "ok" },
      details: {
        ...(grant && { Kind: "OAuth grant" }),
        ...(installation && { Kind: "App installation" }),
        ...(hosts.length > 0 && { Hosts: hosts.join(", ").slice(0, 200) }),
      },
      actions: [{ label: "Manage", routingSlug: "dash", path: "/?page=secrets" }],
    };
  }

  // any other `keys-` card goes, and its rows with it
  for (const integration of Object.keys(registry.integrations))
    if (integration.startsWith(`${KEYS}-`) && integration !== list)
      await keepCard(registry, integration, null);
  // the heading and the card stand while there is a row: a mind with no key shows no empty heading
  if (Object.keys(rows).length === 0) {
    await keepCard(registry, list, null);
    await keepCard(registry, KEYS, null);
    return;
  }
  await keepCard(registry, KEYS, {
    title: "Keys and accounts",
    description:
      "What your agents stored in this mind's secrets to reach other services: an API key, or an account connected through an app of the mind's own. To add one, ask your agent to connect to the service. The values never leave the secrets Worker.",
    actions: [],
  });
  // what the rows are, and how many: a title is required, and a blank one draws an empty mark and
  // an empty line. It starts with a letter, which the page draws as the card's mark
  await keepCard(registry, list, {
    title: `Secrets (${Object.keys(rows).length})`,
    section: KEYS,
    actions: [],
  });
  await keepRows(registry, list, rows);
}

/** THE "LENT BY A COMPUTER" SECTION, made true from the root's rewrite rules: a card for each
 *  lend, by its match. A bridge that signs in again sets the same rule again, and its card does
 *  not differ: nothing is appended. The first hundred lends by match are shown, as for the keys. */
async function keepLentSection(
  registry: Registry,
  rules: { match: string; target: string | null; description?: string }[],
): Promise<void> {
  const lends = new Map<string, Json>();
  const shown = rules
    .filter((rule) => rule.target?.includes("rpcStubs.get("))
    .sort((a, b) => (a.match < b.match ? -1 : 1))
    .slice(0, 100);
  for (const { match, description = "" } of shown) {
    const name = match.replace(/^itx\./, "").toLowerCase();
    const integration = `${LENT}-${name.replaceAll(".", "-")}`;
    // a card's name is a routing slug (core/lib/src/mind-ingress.ts `ROUTING_SLUG`): parts of
    // letters and digits joined by single dashes, at most 63 characters. A match with a call step
    // or other signs (`itx.ai.run('gpt-5')`, `itx.a_b`) makes none, and gets no card
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(name) || integration.length > 63) continue;
    // the lend's own words, to the end of the first sentence and 200 characters at most
    const sentence = /^.*?[.!?](?=\s|$)/s.exec(description)?.[0] || description;
    lends.set(integration, {
      title: match.slice(0, 80),
      description: sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence,
      section: LENT,
      status: { kind: "ok", text: "Connected" },
      actions: [],
    });
  }

  // the heading stands while it has a card
  if (lends.size)
    await keepCard(registry, LENT, {
      title: "Lent by a computer",
      description:
        "A program on someone's computer lends these to the mind while it runs, with iterate provide. When the program stops, its card goes.",
      actions: [],
    });
  for (const [integration, card] of lends) await keepCard(registry, integration, card);
  for (const integration of Object.keys(registry.integrations))
    if (integration.startsWith(`${LENT}-`) && !lends.has(integration))
      await keepCard(registry, integration, null);
  if (!lends.size) await keepCard(registry, LENT, null);
}

/** A card set to `card`, or taken away with null, when the registry holds something else. */
async function keepCard(registry: Registry, integration: string, card: Json | null) {
  const before = Object.hasOwn(registry.integrations, integration)
    ? registry.integrations[integration]
    : undefined;
  if (card ? jsonEqual(before, card) : !before) return;
  await registry.append({
    type: "events.iterate.com/integration/configured",
    payload: { integration, card },
  });
}

/** A card's rows made `rows`: every row that differs, and a null for each row that is gone. */
async function keepRows(registry: Registry, integration: string, rows: Record<string, Json>) {
  const gone = Object.keys(registry.connections)
    .filter((key) => key.startsWith(`${integration}/`))
    .map((key) => key.slice(integration.length + 1))
    .filter((connection) => !rows[connection]);
  const changes: [string, Json | null][] = [
    ...Object.entries(rows).filter(
      ([key, row]) => !jsonEqual(registry.connections[`${integration}/${key}`], row),
    ),
    ...gone.map((connection): [string, null] => [connection, null]),
  ];
  for (const [connection, row] of changes)
    await registry.append({
      type: "events.iterate.com/integration/connection-configured",
      payload: { integration, connection, row },
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
  const answer = await itx
    .fetch(
      new Request(ask.url, {
        headers: {
          // a person's grant and an installation's secret both keep the token as `accessToken`
          authorization: `Bearer getSecret(${JSON.stringify(secret.path)}, { field: "accessToken" })`,
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
