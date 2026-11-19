// cloud-accounts.ts — EVERY SECTION OF THE DASH'S INTEGRATIONS PAGE THAT THE MIND CAN WORK OUT BY
// ITSELF (worker.ts calls `cloudAccountsEvent` for every event). The name is from its first
// section; a mind's own worker.ts imports it by that name. Three sections, each a heading card
// with cards under it:
//
//   "iterate Cloud"      one card for each app that this mind's Cloud offers (Google, GitHub,
//                        Slack, X): what it is for, and a button that begins a connect ("Connect",
//                        then "Add account"; `connectCloudAccount`). A card has one row for
//                        each account that a member connected through that app: whose account it
//                        is, and the secret that holds it, with "Remove" (`removeCloudAccount`,
//                        which an agent calls too). An agent connects one the same way
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
// Cloud's name for the app that refreshes the secret, and `cloudOrigin` is that Cloud's address,
// which the secret has kept since it was made. A secret of iterate Cloud's (`ITERATE_CLOUD`)
// stands under its app. Any other secret is a key or a grant of the mind's own, and stands under
// "Keys and accounts", unless a package of the mind shows its account already
// (`keepKeysSection`).
//
// WHAT IS LENT, the root's rewrite rules say (`itx.rewriteRules.list()`): a lend is a rule whose
// target is the lent stub, `itx.builtins.rpcStubs.get('<match>')`. The platform's own names
// (`itx.secrets`, `itx.config`, …) point elsewhere.
//
// WHOSE ACCOUNT IT IS, for an account through the Cloud, the service is asked once, with the
// secret's placeholder (the token never comes here): when the secret is set, and when a publish
// finds a secret with no row. A service that refuses the token says so on the row; one that gives
// no answer leaves the row as it was. A person's grant always has "Connect again".
//
// WHICH CLOUD, this template says: `ITERATE_CLOUD` (./cloud-deliveries.ts), the one place that
// names it. WHICH APPS, the vault says for that Cloud (`itx.secrets.cloud(ITERATE_CLOUD)`): the
// clients it publishes. A Cloud that gave no list leaves the section as it stands. A section with
// no card has no heading either.
//
// THE NAMES `iterate-cloud`, `keys` AND `lent` (the headings), and every name that starts with one
// of them and a dash, are this file's: it replaces or removes any other card registered there.
import { jsonEqual } from "iterate/lib";
import { z } from "zod";
import { ITERATE_CLOUD } from "./cloud-deliveries.ts";
import { CLOUD_SCOPES } from "./cloud-scopes.ts";

/** The heading's name in the registry: the cards under it name it as their `section`, and their
 *  own names start with it. */
const SECTION = "iterate-cloud";

/** The "Keys and accounts" heading's name, and the start of its one card's name. */
const KEYS = "keys";

/** The "Lent by a computer" heading's name, and the start of each of its cards' names. */
const LENT = "lent";

type Json = Record<string, unknown>;

/** A request that says whose account a token is for: the name a person knows it by, and the id
 *  that iterate Cloud keys its deliveries by (`account`, the route's word in
 *  internal-packages/cloud-clients `reachedBy`), both from the one answer. */
type WhoAmI = { url: string; name: z.ZodType<string>; account?: z.ZodType<string> };

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
      // the Cloud keys a mailbox by its address in lower case
      account: z.object({ email: z.string().min(1) }).transform((body) => body.email.toLowerCase()),
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
      account: z.object({ team_id: z.string().min(1) }).transform((body) => body.team_id),
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
      account: z
        .object({ data: z.object({ id: z.string().min(1) }) })
        .transform((body) => body.data.id),
    },
  },
};

/** The registry's state, as far as this file reads it (iterate/integrations). */
const Registry = z.object({
  integrations: z.record(z.string(), z.unknown()).default({}),
  connections: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

type Secret = {
  path: string;
  urls: string[];
  refresh?: string;
  cloud?: string;
  cloudOrigin?: string;
};

/** Whether a secret is an account that a member connected through iterate Cloud's own app. */
const ofIterateCloud = (secret: Secret) => !!secret.cloud && secret.cloudOrigin === ITERATE_CLOUD;

/** The part of `itx` this file uses. */
export type CloudAccountsItx = {
  fetch(request: Request): Promise<Response>;
  url(): Promise<string>;
  secrets: {
    list(): Promise<Secret[]>;
    cloud(origin: string): Promise<{ origin: string; clients: string[] }>;
    delete(path: string): Promise<unknown>;
  };
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    list(prefix?: string): Promise<{ keys: string[] }>;
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

/** The part of `itx` that removing an account and finding a delivery's secret use. */
type AccountsItx = Pick<CloudAccountsItx, "fetch" | "secrets" | "kv">;

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
    // The Dash on the mind's first zone (`itx.url()` is that zone's apex): it serves each card's
    // mark, and each button of these cards leads to a page of it.
    const dash = `https://dash.${new URL(await itx.url()).hostname}`;
    await keepCloudSection(itx, registry, secrets, changed, dash);
    await keepKeysSection(registry, secrets, dash);
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
  dash: string,
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
      if (!ofIterateCloud(secret) || secret.cloud !== name) continue;
      const key = secret.path.split("/").at(-1)!;
      const before = registry.connections[`${integration}/${key}`];
      // a row that stands keeps what the service said (no service is asked), and takes today's
      // buttons: a row made by an older template differs once, and is appended once
      const row =
        before && secret.path !== changedSecret
          ? before
          : await rowOf(itx, name, app, secret, before);
      if (row) rows[key] = { ...row, actions: rowActionsOf(name, app, secret, row, dash) };
    }
    const connected = Object.keys(rows).length;
    // the card before its rows: a row stands under a card that exists
    await keepCard(registry, integration, {
      title: app.title,
      description: app.about,
      icon: `${dash}/brands/${name}.svg`,
      section: SECTION,
      ...(connected > 0 && {
        status: { kind: "ok", text: connected === 1 ? "Connected" : `${connected} accounts` },
      }),
      // the button begins a connect at the press (`connectCloudAccount`), and the page goes on
      // to the link it answers
      actions: [
        { label: connected ? "Add account" : "Connect", call: { name: CONNECT, args: [name] } },
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
 *  with a row for each secret that is no account of iterate Cloud's, in path order. The consent at Cloudflare
 *  (`/secrets/cloudflare`, cloudflare.md) has a card of its own, and is not here. This
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
async function keepKeysSection(registry: Registry, secrets: Secret[], dash: string): Promise<void> {
  const list = `${KEYS}-secrets`;
  const ours = [`${SECTION}-`, `${KEYS}-`, `${LENT}-`];
  const packaged = Object.keys(registry.connections)
    .filter((key) => !ours.some((prefix) => key.startsWith(prefix)))
    .map((key) => key.replace("/", "-"));
  const shown = secrets
    .filter((secret) => !ofIterateCloud(secret) && secret.path !== "/secrets/cloudflare")
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
      actions: [{ label: "Manage", url: `${dash}/?page=secrets` }],
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
    // a card's name is a DNS label that starts with a letter (iterate/integrations): parts of
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

/** iterate Cloud (`ITERATE_CLOUD`): its origin, and the apps that it offers and this file knows,
 *  in the Cloud's order. Null when the Cloud gave no list. */
async function cloudOf(
  itx: CloudAccountsItx,
): Promise<{ origin: string; apps: [string, CloudApp][] } | null> {
  const cloud = await itx.secrets.cloud(ITERATE_CLOUD);
  const apps = cloud.clients.flatMap((name): [string, CloudApp][] =>
    Object.hasOwn(APPS, name) ? [[name, APPS[name]!]] : [],
  );
  return apps.length ? { origin: cloud.origin, apps } : null;
}

/** One account's row: the service asked whose account the secret is for. `before` stands when
 *  the service gave no answer. The account's id is kept for the Cloud's deliveries
 *  (`cloudAccountSecret`), and an account that this mind let go of at the Cloud
 *  (`removeCloudAccount`) is taken back there: a member connected it again. */
async function rowOf(
  itx: CloudAccountsItx,
  client: string,
  app: CloudApp,
  secret: Secret,
  before: Json | undefined,
): Promise<Json | undefined> {
  const installation = secret.refresh === "github-app-installation";
  const answer = await whoIs(itx, app, secret);
  if (answer === "unanswered") return before;
  if (answer.account) await keepAccount(itx, client, answer.account, secret.path);
  return {
    account: answer.name ? answer.name.slice(0, 200) : `${app.title} account`,
    // a row that is well needs no words: the page shows its dot
    status: answer.name
      ? { kind: "ok" }
      : { kind: "attention", text: `${app.title} refused the token. Connect the account again.` },
    details: { ...(installation && { Kind: "App installation" }), Secret: secret.path },
  };
}

/** Whose account `secret` holds, in the service's own answer: the name a person knows, and the
 *  Cloud's id for it. Both are absent when the service refused the token; "unanswered" when it
 *  gave no answer (busy, or down). */
async function whoIs(
  itx: AccountsItx,
  app: CloudApp,
  secret: Secret,
): Promise<{ name?: string; account?: string } | "unanswered"> {
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
  if (!answer || answer.status === 429 || answer.status >= 500) return "unanswered";
  const body: unknown = answer.ok ? await answer.json().catch(() => null) : null;
  return {
    name: ask.name.safeParse(body).data,
    account: ask.account?.safeParse(body).data,
  };
}

/** WHERE THE MIND KEEPS WHAT IT KNOWS OF ONE CLOUD ACCOUNT, in kv, by the app and the Cloud's id:
 *  `cloud-account:<app>/<id>` names the secret that holds it, and `cloud-account-left:<app>/<id>`
 *  says that this mind let go of it at the Cloud. */
const ACCOUNT_KV = "cloud-account:";
const LEFT_KV = "cloud-account-left:";

/** The account `account` of `client` is in `secret`. An account that this mind let go of at the
 *  Cloud is asked for again there (`{ account, again: true }`): the Cloud keeps a let-go across every
 *  later connect until the mind says so. Its deliveries come back at the grant's next refresh,
 *  which is when the Cloud reads whom the grant reaches. A Cloud that did not take the word is
 *  asked again at the account's next row.
 *
 *  A secret holds one account: an earlier account's row that names `secret` goes ("Connect
 *  again" as another person), so that a delivery for that account is not answered as this one. */
async function keepAccount(
  itx: AccountsItx,
  client: string,
  account: string,
  secret: string,
): Promise<void> {
  const kept = `${ACCOUNT_KV}${client}/${account}`;
  await itx.kv.put(kept, secret);
  for (const key of (await itx.kv.list(`${ACCOUNT_KV}${client}/`)).keys)
    if (key !== kept && (await itx.kv.get(key)) === secret) await itx.kv.delete(key);
  if (!(await itx.kv.get(`${LEFT_KV}${client}/${account}`))) return;
  const taken = await askCloud(itx, client, secret, "release", { account, again: true });
  if (taken === "taken") await itx.kv.delete(`${LEFT_KV}${client}/${account}`);
  else console.warn({ event: "config.cloud-account-again-not-taken", client, answer: taken });
}

/** An ask of iterate Cloud for this mind (core/secrets-worker cloud-client.ts `askOf`), in the
 *  name of `secret`, an account connected through the Cloud's app `client`: "taken" when the
 *  Cloud answered 200, else what it answered. A rule that holds the request for a member answers
 *  202, and nothing has reached the Cloud then. */
async function askCloud(
  itx: AccountsItx,
  client: string,
  secret: string,
  verb: string,
  body: Json,
): Promise<"taken" | string> {
  const answer = await itx
    .fetch(
      new Request(`${ITERATE_CLOUD}/clients/${client}/ask/${verb}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "iterate-connection": `getSecret(${JSON.stringify(secret)})`,
        },
        body: JSON.stringify(body),
      }),
    )
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  if (typeof answer === "string") return answer;
  return answer.status === 200
    ? "taken"
    : `${answer.status} ${(await answer.text()).slice(0, 200)}`;
}

/** WHICH SECRET HOLDS THE CLOUD ACCOUNT `account` of the app `client` (an X user id, a Slack
 *  team id, a mailbox's address): for a delivery, whose context names the account and not the
 *  secret. The secret kept for it when its row was made, while the catalog still has it; else each
 *  secret of that app is asked whose account it holds, in the catalog's order, and the one that
 *  holds it is kept. Null when no secret of the mind holds it (it was removed): a delivery for it
 *  reaches no agent. When a service gave no answer for some secret and none matched, the first
 *  secret of the app: it cannot be told, and a delivery is not dropped for a busy service. */
export async function cloudAccountSecret(
  itx: AccountsItx,
  client: string,
  account: string,
): Promise<string | null> {
  const app = Object.hasOwn(APPS, client) ? APPS[client]! : undefined;
  const ofApp = (await itx.secrets.list()).filter(
    (secret) => ofIterateCloud(secret) && secret.cloud === client,
  );
  const kept = await itx.kv.get(`${ACCOUNT_KV}${client}/${account}`);
  if (kept && ofApp.some((secret) => secret.path === kept)) return kept;
  if (!app) return ofApp[0]?.path ?? null;
  let unanswered = false;
  for (const secret of ofApp) {
    const answer = await whoIs(itx, app, secret);
    if (answer === "unanswered") unanswered = true;
    else if (answer.account === account) {
      await itx.kv.put(`${ACCOUNT_KV}${client}/${account}`, secret.path);
      return secret.path;
    }
  }
  return unanswered ? (ofApp[0]?.path ?? null) : null;
}

/** What `removeCloudAccount` did: the secret is gone, and at iterate Cloud `cloud` says what
 *  happened to its deliveries. */
export type RemovedAccount = {
  secret: string;
  app: string;
  /** The Cloud's id for the account, when the service answered whose it is. */
  account?: string;
  cloud: "released" | "shared" | "not-offered" | { notReleased: string };
  /** What was done, in words: the Integrations page shows them under the row's buttons. */
  said: string;
};

/** REMOVE ONE ACCOUNT CONNECTED THROUGH iterate Cloud: the Integrations page's "Remove" (a call
 *  of `itx.config.removeCloudAccount(path)` after the member said yes) and an agent's. In this order:
 *
 *  1. Whose account the secret holds is asked, while the secret can still be used.
 *  2. The Cloud is asked to let go of the account for this mind (`ask/release`): its deliveries
 *     (X's messages, Gmail's and Calendar's pushes, Slack's events) stop, and a later connect of
 *     the same account does not bring them back until the mind says so (`keepAccount`). Not when
 *     another secret of the mind holds the same account: its deliveries are that secret's too
 *     ("shared"). Not for GitHub: its deliveries are the installations', which a person's grant and
 *     each installation's secret share, and the catalog does not name an installation
 *     ("not-offered").
 *  3. What the mind kept for the secret goes: the Gmail and Calendar rows that read through it
 *     (gmail.ts, calendar.ts) and the account's own row here. When another secret holds the same
 *     account, they read through that secret instead: they are kept by mailbox, one for each.
 *  4. The secret is deleted. Its row on the Integrations page goes at its `secret/deleted`.
 *
 *  The secret goes even when the Cloud did not take the release (it gave no answer): `cloud` says
 *  so, and a delivery for an account that no secret holds reaches no agent (`cloudAccountSecret`).
 *  Nothing changes, and the Remove throws its reason, when the service gave no answer, or refused
 *  the token, for another secret of the app: that secret may hold the same account, and a release
 *  would stop its deliveries. What the account's deliveries made stays: its context
 *  `/integrations/<app>/<id>`, its agent and their history. */
export async function removeCloudAccount(itx: AccountsItx, path: string): Promise<RemovedAccount> {
  const secrets = await itx.secrets.list();
  const secret = secrets.find((each) => each.path === path);
  if (!secret || !/^\/secrets\/[^/]+$/.test(path) || !ofIterateCloud(secret))
    throw new Error(
      `${path} is no account connected through iterate Cloud: delete a key on the Secrets page`,
    );
  const client = secret.cloud!;
  const app = Object.hasOwn(APPS, client) ? APPS[client]! : undefined;
  const asked = app?.whoami.account ? await whoIs(itx, app, secret) : "unanswered";
  const account = asked === "unanswered" ? undefined : asked.account;
  let cloud: RemovedAccount["cloud"] = "not-offered";
  const holder = app && account ? await otherHolder(itx, app, account, secret, secrets) : null;
  if (app?.whoami.account) {
    cloud = { notReleased: `${app.title} did not say whose account ${path} holds` };
    if (holder) cloud = "shared";
    else if (account) cloud = await releaseAt(itx, client, account, path);
  }
  if (account && holder) await itx.kv.put(`${ACCOUNT_KV}${client}/${account}`, holder);
  else if (account) await itx.kv.delete(`${ACCOUNT_KV}${client}/${account}`);
  for (const prefix of ["gmail:", "calendar:"]) {
    for (const key of (await itx.kv.list(prefix)).keys) {
      const value: unknown = JSON.parse((await itx.kv.get(key)) || "null");
      const row = z.looseObject({ secret: z.string() }).safeParse(value).data;
      if (row?.secret !== path) continue;
      if (holder) await itx.kv.put(key, JSON.stringify({ ...row, secret: holder }));
      else await itx.kv.delete(key);
    }
  }
  await itx.secrets.delete(path);
  return { secret: path, app: client, account, cloud, said: saidOfRemove(path, cloud) };
}

/** What a Remove did, in words, by what the Cloud did with the account's deliveries. */
function saidOfRemove(path: string, cloud: RemovedAccount["cloud"]): string {
  if (cloud === "released") return `Removed ${path}. iterate Cloud stopped its deliveries.`;
  if (cloud === "shared")
    return `Removed ${path}. Another secret holds the same account, and its deliveries go on.`;
  if (cloud === "not-offered")
    return `Removed ${path}. iterate Cloud keeps delivering the installations' events.`;
  return `Removed ${path}. iterate Cloud did not stop its deliveries: ${cloud.notReleased}`.slice(
    0,
    400,
  );
}

/** THE FUNCTIONS THIS CONFIG OFFERS TO A CARD'S BUTTON: worker.ts answers them as
 *  `itx.config.integrationCalls()`, and the Dash calls a button's function only when its name is
 *  among them (iterate/integrations `INTEGRATION_CALLS`). A card of your own whose button calls a
 *  function of this config names it here too. */
export const INTEGRATION_CALLABLE = [
  "cloudflareConnect",
  "connectCloudAccount",
  "removeCloudAccount",
] as const;

/** The config function that the cards' "Connect", "Add account" and "Connect again" call. */
const CONNECT = "connectCloudAccount";

/** The part of `itx` that a connect uses. */
type ConnectItx = {
  url(): Promise<string>;
  secrets: {
    list(): Promise<{ path: string }[]>;
    beginOAuth(
      path: string,
      options: {
        client: { cloud: string; origin: string };
        install?: boolean;
        scope?: string;
        next?: string;
      },
    ): Promise<{ authorizationUrl: string }>;
  };
};

/** BEGIN A CONNECT THROUGH ONE OF iterate Cloud's APPS: the Integrations page's "Connect", "Add
 *  account" and "Connect again" (each calls `itx.config.connectCloudAccount(app, again?)` at the
 *  press, as the member who pressed it), and an agent's. The answer's `link` is the secrets
 *  Worker's start page, which shows the secret and the hosts its tokens go to before anything
 *  leaves for the service. Nothing is stored until the member approves there, and then the
 *  member's browser comes back to the Dash's Integrations page.
 *
 *  `again` names a secret to connect again in place (its row's "Connect again"): only a secret
 *  that is set and is of this app's own family, `<app>` or `<app>-<anything>`, so a button never
 *  writes over another app's secret. With none, or another, the account gets the first free name:
 *  `/secrets/google`, then `/secrets/google-2`. The scopes are the mind's own choice for the app
 *  (cloud-scopes.ts), else the Cloud's defaults. For GitHub the member chooses the installation on
 *  the App's own install page. */
export async function connectCloudAccount(
  itx: ConnectItx,
  app: string,
  again?: string,
): Promise<{ secret: string; link: string }> {
  if (!/^[a-z0-9-]{1,40}$/.test(app))
    throw new Error(`connectCloudAccount: ${app} is no name of an app of iterate Cloud's`);
  const taken = new Set((await itx.secrets.list()).map((secret) => secret.path));
  let path = `/secrets/${app}`;
  for (let n = 2; taken.has(path); n += 1) path = `/secrets/${app}-${n}`;
  if (again && (again === app || again.startsWith(`${app}-`)) && taken.has(`/secrets/${again}`))
    path = `/secrets/${again}`;
  const dash = `https://dash.${new URL(await itx.url()).hostname}`;
  const { authorizationUrl } = await itx.secrets.beginOAuth(path, {
    client: { cloud: app, origin: ITERATE_CLOUD },
    install: app === "github",
    ...(Object.hasOwn(CLOUD_SCOPES, app) && CLOUD_SCOPES[app] && { scope: CLOUD_SCOPES[app] }),
    // back to the page whose button began it: the vault takes an absolute URL of the mind's
    next: `${dash}/?page=integrations`,
  });
  return { secret: path, link: authorizationUrl };
}

/** Another secret of the app that holds `account` too, else null. Throws, so that the Remove
 *  changes nothing, when the service gave no answer, or refused the token, for another secret:
 *  that secret may hold the account, and the Cloud cannot be told to let go of it on a guess. */
async function otherHolder(
  itx: AccountsItx,
  app: CloudApp,
  account: string,
  secret: Secret,
  secrets: Secret[],
): Promise<string | null> {
  const unknown: string[] = [];
  for (const other of secrets) {
    if (other.path === secret.path || !ofIterateCloud(other) || other.cloud !== secret.cloud)
      continue;
    const answer = await whoIs(itx, app, other);
    if (answer === "unanswered" || !answer.account) unknown.push(other.path);
    else if (answer.account === account) return other.path;
  }
  if (unknown.length)
    throw new Error(
      `${app.title} did not say whose account ${unknown.join(", ")} holds (it gave no answer, or refused the token), and it may be the same account as ${secret.path}. Nothing was removed. Try again in a minute, or connect ${unknown.join(", ")} again or remove it first.`,
    );
  return null;
}

/** Step 2 of `removeCloudAccount`, when no other secret holds `account`: the Cloud lets go of it.
 *  A let-go that the Cloud took is remembered, so that a later connect of the same account takes
 *  it back. */
async function releaseAt(
  itx: AccountsItx,
  client: string,
  account: string,
  path: string,
): Promise<RemovedAccount["cloud"]> {
  const taken = await askCloud(itx, client, path, "release", { account });
  if (taken !== "taken") return { notReleased: taken };
  await itx.kv.put(`${LEFT_KV}${client}/${account}`, new Date().toISOString());
  return "released";
}

/** A Cloud row's buttons, from the app, the secret and whose grant it is: for a new row and for
 *  one that stands, so that a row made by an older template gets today's. A PERSON'S GRANT can
 *  always be connected again: after a refusal, and to bring the scopes that cloud-scopes.ts names
 *  now into a secret made before. An installation's token is the App's own to mint: there is
 *  nothing to connect again. Every account can be removed (`removeCloudAccount`): the Dash asks
 *  first, in the row's own words. */
function rowActionsOf(
  client: string,
  app: CloudApp,
  secret: Secret,
  row: Json,
  dash: string,
): Json[] {
  const name = secret.path.split("/").at(-1);
  const account = typeof row.account === "string" ? row.account : secret.path;
  return [
    ...(secret.refresh === "github-app-installation"
      ? []
      : [{ label: "Connect again", call: { name: CONNECT, args: [client, name] } }]),
    { label: "Manage", url: `${dash}/?page=secrets` },
    {
      label: "Remove",
      call: { name: "removeCloudAccount", args: [secret.path] },
      confirm: `Remove ${account}? The mind deletes ${secret.path}${
        app.whoami.account
          ? ` and asks iterate Cloud to stop delivering for this ${app.title} account`
          : `. iterate Cloud keeps delivering the installations' events, which a GitHub grant shares`
      }. Its agents and their history stay. To use it again, connect it again.`.slice(0, 400),
    },
  ];
}
