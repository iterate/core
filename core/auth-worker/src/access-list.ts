// access-list.ts — WHO HOLDS ACCESS AS A PERSON, DRAWN: the list of ./oauth.ts
// `sessionsByClientOf`, which says what the list is and which pages show it. Each client is one
// scannable row with its mark, name, reach and recency; a client with several sign-ins keeps its
// "all N" button on the row and tucks the single sign-ins inside a `<details>`.
//
// A CLIENT SAYS ITS OWN NAME AND LOGO (./client-mark.ts). So a client also says where the access
// went: that is the one thing here a client cannot claim for another.
import { mindMcpUrlOf, mindProvideConnectResourceOf } from "iterate/mind-api";
import { appTile } from "./asking-app.ts";
import { clientTile, shownLogoOf } from "./client-mark.ts";
import { configOf, type Env } from "./env.ts";
import { type ClientWithAccess, mindHostResourceOf, type SignIn } from "./oauth.ts";

/** A form's hidden fields that name what its button ends: one sign-in, or all of one client. */
export type Ends = { signIn: string } | { client: string };

/** The list. `end` makes the form that ends a sign-in or all of a client, with `button` as its
 *  visible words and `label` as its full accessible name; `whose` names the person on an owner's
 *  page. */
export function clientsWithAccess(
  env: Env,
  clients: ClientWithAccess[],
  end: (ends: Ends, button: string, label: string) => string,
  whose?: string,
): string {
  const now = Date.now();
  return clients.map((client) => clientRow(env, client, end, now, whose)).join("");
}

/** The origins that the list's pictures come from, for the page's `img-src`: each is a verified
 *  client's own logo on its own domain, or the icon of one of the mind's own apps on its own host. */
export function logoOriginsOf(clients: ClientWithAccess[]): string | undefined {
  const origins = new Set(
    clients.flatMap((client) => {
      if (client.host) return ownIconOf(client) ? [client.host] : [];
      const logo = shownLogoOf(client);
      return logo ? [logo.origin] : [];
    }),
  );
  return origins.size ? [...origins].join(" ") : undefined;
}

/** What a posted form names to end, or null when it names nothing. */
export function endsOf(form: FormData | null): Ends | null {
  const [signIn, client] = [form?.get("signIn"), form?.get("client")];
  if (typeof signIn === "string" && signIn) return { signIn };
  return typeof client === "string" && client ? { client } : null;
}

/** The hidden fields of a form that ends `ends`. */
export const endFields = (ends: Ends) =>
  "signIn" in ends
    ? `<input type="hidden" name="signIn" value="${text(ends.signIn)}">`
    : `<input type="hidden" name="client" value="${text(ends.client)}">`;

/** A `<time>` element with a compact label relative to `now` and the exact UTC minute in `title`. */
export function pastTimeTag(atMs: number, now: number): string {
  return timeTag(atMs, pastLabel(atMs, now));
}

function clientRow(
  env: Env,
  client: ClientWithAccess,
  end: (ends: Ends, button: string, label: string) => string,
  now: number,
  whose?: string,
): string {
  const name = nameOf(client);
  const word = client.host ? "Sign out" : "Revoke";
  const ofWhom = whose ? ` of ${whose}` : "";
  const origin = clientOriginWords(client);
  const summaries = client.signIns.map((signIn) => signInReachParts(env, client, signIn));
  const uniqueKeys = [...new Set(summaries.map((item) => item.key))];
  const sharedReach = uniqueKeys.length === 1 ? summaries[0]! : null;

  if (client.signIns.length === 1) {
    const [only] = client.signIns;
    const reach = summaries[0]!;
    return `<li class="access" data-client="${text(client.clientId)}" data-access="${text(only!.id)}">
      ${tileOf(client)}
      <div class="row-title"><strong>${text(name)}</strong>${whose ? ` <span class="muted">of ${text(whose)}</span>` : ""}</div>
      <div class="row-meta">
        <div class="meta-line"><div class="meta-track">${metaLine(reach.badges, [reach.target, origin])}</div></div>
        <div class="meta-line"><div class="meta-track">${metaItems(timesOf(only!, now))}</div></div>
      </div>
      ${end({ signIn: only!.id }, word, `${actionPhrase(word, name)}${ofWhom}`)}
    </li>`;
  }

  const latestMs = Math.max(
    ...client.signIns.map((signIn) => (signIn.renewedAt ?? signIn.createdAt) * 1000),
  );
  const summaryLine = sharedReach
    ? metaLine(sharedReach.badges, [
        sharedReach.target,
        origin,
        `Latest ${pastTimeTag(latestMs, now)}`,
      ])
    : metaItems([origin, `Latest ${pastTimeTag(latestMs, now)}`]);
  const items = client.signIns
    .map((signIn, index) => {
      const reach = summaries[index]!;
      const line = sharedReach
        ? metaItems(timesOf(signIn, now))
        : metaLine(reach.badges, [reach.target, ...timesOf(signIn, now)]);
      const started = pastLabel(signIn.createdAt * 1000, now);
      return `<li data-access="${text(signIn.id)}">
            <span class="meta-line"><span class="meta-track">${line}</span></span>
            ${end({ signIn: signIn.id }, word, `${actionPhrase(word, name)} sign-in from ${started}${ofWhom}`)}
          </li>`;
    })
    .join("");

  return `<li class="access" data-client="${text(client.clientId)}">
      ${tileOf(client)}
      <div class="row-title"><strong>${text(name)}</strong>${whose ? ` <span class="muted">of ${text(whose)}</span>` : ""}</div>
      <div class="row-meta">
        <div class="meta-line"><div class="meta-track">${summaryLine}</div></div>
      </div>
      ${end({ client: client.clientId }, `${word} all ${client.signIns.length}`, `${word} all ${client.signIns.length} sign-ins of ${name}${ofWhom}`)}
      <details class="access-details">
        <summary>${client.signIns.length} sign-ins</summary>
        <ul class="access-sessions">${items}</ul>
      </details>
    </li>`;
}

const metaItems = (parts: string[]) =>
  parts
    .filter(Boolean)
    .map((part) => `<span class="meta-item">${part}</span>`)
    .join(" ");

const metaLine = (badges: string, parts: string[]) =>
  [badges, metaItems(parts)].filter(Boolean).join(" ");

const actionPhrase = (word: "Sign out" | "Revoke", name: string) =>
  word === "Sign out" ? `Sign out of ${name}` : `Revoke ${name}`;

const text = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const nameOf = (client: ClientWithAccess) => client.name || "An app";

/** The icon of one of the mind's own apps: its client's logo, which counts from the app's own
 *  origin alone. */
const ownIconOf = (client: ClientWithAccess) =>
  client.host &&
  URL.canParse(client.logoUri || "") &&
  new URL(client.logoUri!).origin === client.host
    ? client.logoUri!
    : null;

/** The client's mark. One of the mind's own apps has its own icon or its initials, as on the
 *  sign-in pages (./asking-app.ts), and never a built-in brand mark. Any other client has the
 *  mark of ./client-mark.ts. */
const tileOf = (client: ClientWithAccess) =>
  client.host
    ? appTile({ name: nameOf(client), icon: ownIconOf(client) }, { small: true })
    : clientTile(
        {
          name: nameOf(client),
          redirectUri: client.redirectUri || "",
          redirectHost: client.goesTo || "",
          logoUri: client.logoUri,
          clientDomain: client.clientDomain,
        },
        { small: true },
      );

/** Where the client's access goes, or how it signed in. */
function clientOriginWords(client: ClientWithAccess): string {
  if (client.host) return "This mind&#39;s page";
  if (client.device) return "Device sign-in";
  return client.goesTo ? `goes to ${text(client.goesTo)}` : "";
}

const SCOPE_LABELS: Record<string, { label: string; strong: boolean }> = {
  iterate: { label: "Whole mind", strong: true },
  identity: { label: "Identity only", strong: false },
};

function signInReachParts(env: Env, client: ClientWithAccess, signIn: SignIn) {
  const badges = signIn.scopes
    .map((scope) => {
      const known = SCOPE_LABELS[scope];
      if (!known) return `<span class="badge">${text(scope)}</span>`;
      return `<span class="badge${known.strong ? " badge-strong" : ""}">${known.label}</span>`;
    })
    .join(" ");
  const rawTarget = reachTargetOf(env, signIn);
  // A host app whose title is already its hostname needs no second copy of that hostname.
  const target = client.host && rawTarget === nameOf(client) ? "" : text(rawTarget);
  return { key: `${signIn.scopes.join(",")}|${rawTarget}`, badges, target };
}

/** The resource a sign-in's tokens reach, in short form. */
function reachTargetOf(env: Env, signIn: SignIn): string {
  const config = configOf(env);
  const { resource } = signIn;
  if (!resource) return "Mind & pages";
  if (resource === mindMcpUrlOf(config.controlPlaneHostname)) return "MCP";
  if (resource === mindProvideConnectResourceOf(config.controlPlaneHostname))
    return "Hands in this mind";
  const host = mindHostResourceOf(config, resource);
  if (!host) return new URL(resource).pathname;
  const { pathname } = new URL(resource);
  return pathname.length > 1 ? `${new URL(host).host}${pathname}` : new URL(host).host;
}

/** Compact lifecycle timestamps of one sign-in: most recent use first, creation, and expiry. */
function timesOf(signIn: SignIn, now: number): string[] {
  const createdMs = signIn.createdAt * 1000;
  if (signIn.until) {
    return [
      `Since ${pastTimeTag(createdMs, now)}`,
      `until ${untilTimeTag(signIn.until, now)}`,
      "no renewal",
    ];
  }
  if (!signIn.endsAt) return [`Since ${pastTimeTag(createdMs, now)}`];
  const endsMs = signIn.endsAt * 1000;
  if (!signIn.renews) {
    return [`Signed in ${pastTimeTag(createdMs, now)}`, `ends ${futureTimeTag(endsMs, now)}`];
  }
  const parts = signIn.renewedAt
    ? [`Used ${pastTimeTag(signIn.renewedAt * 1000, now)}`, `since ${pastTimeTag(createdMs, now)}`]
    : [`Since ${pastTimeTag(createdMs, now)}`];
  parts.push(`ends ${futureTimeTag(endsMs, now)} if idle`);
  return parts;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(atMs: number, now: number): string {
  const date = new Date(atMs);
  const day = date.getUTCDate();
  const month = MONTHS[date.getUTCMonth()]!;
  const year = date.getUTCFullYear();
  return year === new Date(now).getUTCFullYear() ? `${day} ${month}` : `${day} ${month} ${year}`;
}

function pastLabel(atMs: number, now: number): string {
  const diff = now - atMs;
  if (diff >= 0 && diff < 60_000) return "just now";
  if (diff >= 60_000 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} m ago`;
  if (diff >= 3_600_000 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff >= 86_400_000 && diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  return shortDate(atMs, now);
}

function futureLabel(atMs: number, now: number): string {
  const diff = atMs - now;
  if (diff > 0 && diff < 60_000) return "in <1 m";
  if (diff >= 60_000 && diff < 3_600_000) return `in ${Math.ceil(diff / 60_000)} m`;
  if (diff >= 3_600_000 && diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)} h`;
  return shortDate(atMs, now);
}

function untilTimeTag(untilMs: number, now: number): string {
  const diff = untilMs - now;
  if (diff > 0 && diff < 86_400_000) return timeTag(untilMs, futureLabel(untilMs, now));
  const clock = new Date(untilMs).toISOString().slice(11, 16);
  return timeTag(untilMs, `${shortDate(untilMs, now)}, ${clock} UTC`);
}

const futureTimeTag = (atMs: number, now: number) => timeTag(atMs, futureLabel(atMs, now));

function timeTag(atMs: number, label: string): string {
  const iso = new Date(atMs).toISOString().replace(".000Z", "Z");
  const utc = `${new Date(atMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `<time datetime="${iso}" title="${utc}">${text(label)}</time>`;
}
