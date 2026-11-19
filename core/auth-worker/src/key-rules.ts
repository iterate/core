import { type MindConfig, controlPlaneOriginOf, zoneOf } from "iterate/mind-config";

/** WHERE A PAGE OF THIS WORKER MAY SEND A PERSON ON, of the `next` a link gave: an address of
 *  the control-plane hostname, or of any hostname of any zone of the mind, which is the owner's own
 *  site. The answer is the whole `https:` URL that was checked, never a part cut out of it, so the
 *  browser goes exactly where the check looked: `//host` is that host, a `blob:` URL that carries
 *  an origin is no `https:` URL, and neither becomes a path of this origin. Null for anywhere
 *  else. */
export function honouredNext(
  next: string | null,
  config: Pick<MindConfig, "controlPlaneHostname" | "zones">,
): string | null {
  if (!next || !URL.canParse(next, controlPlaneOriginOf(config))) return null;
  const url = new URL(next, controlPlaneOriginOf(config));
  const own = url.hostname === config.controlPlaneHostname || zoneOf(config, url.hostname) !== null;
  if (url.protocol !== "https:" || url.port || url.username || url.password || !own) return null;
  return url.href;
}

// The mind resolves dot segments, so `/integrations/../secrets/x` would land at `/secrets/x`
// while its text starts with `/integrations/`.
export const canonicalPath = (path: string) =>
  path.startsWith("/") &&
  (path === "/" ||
    path
      .split("/")
      .slice(1)
      .every((segment) => segment && segment !== "." && segment !== ".."));

// By whole segments, so `/smoke` never reaches `/smokey`.
export const underPaths = (path: string, paths: readonly string[] | undefined) =>
  !paths ||
  paths.some((prefix) => {
    const root = prefix.replace(/\/+$/, "");
    return path === root || path.startsWith(`${root}/`);
  });

const SERVICE_PATHS_ROOT = "/integrations/";

/** THE NAME THAT A READER IN THE MIND TRUSTS iterate Cloud BY (core/configs/default
 *  cloud-deliveries.ts), so no service gets it for the asking on `/keys/enrol`. It goes only with
 *  `cloud`, the Cloud's origin, and only to the key that this origin publishes at
 *  `<cloud>/.well-known/iterate-cloud` (./cloud-key.ts). No config of the stack names a Cloud: the
 *  link names the origin, the consent page shows it, and the member's passkey signs it. */
export const CLOUD_ACTOR = "iterate-cloud";

export type ServiceKeyRequest = {
  actor: string;
  label: string;
  publicKey: string;
  /** Where the key may add events. Empty for a key that only lends. */
  paths: string[];
  /** The one capability the key's token may lend, as `itx.<provide>` (./key-tokens.ts). */
  provide?: string;
  /** The origin of the iterate Cloud whose key this is: for `CLOUD_ACTOR` alone, and always with
   *  it. */
  cloud?: string;
};

/** `value` when it is an `https:` origin and nothing more: no path, query, user or trailing
 *  slash. Null for anything else. */
function cloudOriginOf(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value ? value : null;
}

/** A capability's name, as `iterate provide` takes it: `whatsapp`, `whatsapp.jonas`. */
const CAPABILITY_NAME = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$/;

/** NAMES THAT ARE THE PLATFORM'S AT A MIND'S ROOT, which no key lends (core/itx
 *  `context/lent-names.ts` says why, and refuses such a lend itself). This list is so that no
 *  member is asked to allow such a key. The kernel's roots, then the mind Worker's (core/itx
 *  `BUILT_IN_ROOT_DESCRIPTIONS`, core/mind-worker `roots`). */
const PLATFORM_NAMES = new Set([
  ...["builtins", "config", "whoami", "fetchRoutes", "append", "appendOffsets", "schedules"],
  ...["readEvents", "waitForEvent", "cd", "fetch", "rpcStubs", "rewriteRules", "facets", "abort"],
  ...["subscriptions", "processors", "workers", "run"],
  ...["connectToOpenApi", "connectToCapnweb", "connectToMcp", "repos", "workspaces", "sandboxes"],
  ...["files", "kv", "ai", "cfArtifacts", "r2", "secrets", "approvals", "browser", "images", "git"],
  ...["email", "integrations", "url", "webhooks", "minds", "telemetry", "platformHook"],
  // a row of the default config's agents (agents.ts), not a root: the mind's table refuses it for a
  // key
  "agents",
]);

// `actor` allows no `_`, so it is never a user's id, `user_…`.
export function serviceKeyRequestOf(
  fields: URLSearchParams | FormData,
): ServiceKeyRequest | { refused: string } {
  const field = (name: string) => String(fields.get(name) || "").trim();
  const actor = field("actor");
  const label = field("label");
  const publicKey = field("publicKey");
  const paths = field("paths")
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(Boolean);
  const provide = field("provide");
  const cloud = field("cloud");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(actor))
    return { refused: "The service's name must be lowercase letters, digits and hyphens." };
  if (actor === CLOUD_ACTOR && !cloud)
    return {
      refused: `The name ${CLOUD_ACTOR} goes only to the key that an iterate Cloud publishes at its own address, and this link names no address (cloud). Start again from the Cloud's own page.`,
    };
  if (cloud && actor !== CLOUD_ACTOR)
    return { refused: `The field cloud goes only with the name ${CLOUD_ACTOR}.` };
  if (cloud && !cloudOriginOf(cloud))
    return {
      refused:
        "The Cloud's address (cloud) must be an https address with no path, such as https://cloud.iterate.com.",
    };
  if (cloud && provide)
    return { refused: "iterate Cloud's key adds events: it lends no capability." };
  if (!label || label.length > 100) return { refused: "The service must give a short name." };
  if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) return { refused: "The service sent no public key." };
  // A key a member allows on a page reaches integrations alone: a link someone was tricked into
  // opening cannot ask for an agent's context or the mind's root.
  if (
    !paths.every(
      (prefix) =>
        prefix.startsWith(SERVICE_PATHS_ROOT) && canonicalPath(prefix.replace(/\/+$/, "")),
    )
  )
    return { refused: `The service may add events under ${SERVICE_PATHS_ROOT} alone.` };
  if (provide && (provide.length > 100 || !CAPABILITY_NAME.test(provide)))
    return {
      refused:
        "The service may lend one capability, named in letters and digits (whatsapp, whatsapp.jonas).",
    };
  const lent = provide.split(".")[0] || "";
  if (PLATFORM_NAMES.has(lent))
    return {
      refused: `The service may not lend itx.${lent}: that name is this mind's own. A service lends under a name of its own.`,
    };
  // a key that may do nothing is a mistake in the link, never a wish
  if (!paths.length && !provide)
    return {
      refused: `The service must name what it asks for: a capability to lend (provide), or where under ${SERVICE_PATHS_ROOT} it adds events (paths).`,
    };
  if (cloud) return { actor, label, publicKey, paths, cloud };
  return provide ? { actor, label, publicKey, paths, provide } : { actor, label, publicKey, paths };
}

/** WHAT A MEMBER SIGNS TO ALLOW A SERVICE'S KEY: the key and all that it may do, the label that
 *  the consent page shows, and for iterate Cloud's key the Cloud's origin. The page signs this, and
 *  the answer is taken only for the same. */
export function enrolPayloadOf(key: string, ask: ServiceKeyRequest) {
  return {
    key,
    actor: ask.actor,
    label: ask.label,
    paths: ask.paths,
    provide: ask.provide || null,
    cloud: ask.cloud,
  };
}

/** Whether a signed payload allows exactly this key with exactly this reach and label: a
 *  statement for one key, or for a smaller reach, allows no other. */
export function allowsExactly(
  payload: Record<string, unknown>,
  key: string,
  ask: ServiceKeyRequest,
) {
  const asked = enrolPayloadOf(key, ask);
  return (
    payload.key === asked.key &&
    payload.actor === asked.actor &&
    payload.label === asked.label &&
    JSON.stringify(payload.paths) === JSON.stringify(asked.paths) &&
    (payload.provide || null) === asked.provide &&
    (payload.cloud || null) === (asked.cloud || null)
  );
}

/** One piece of the consent page's statement: plain words, which are the same on every key page;
 *  a fact that this mind checked; a word that the link gave and nobody checked; or the member who
 *  signs. */
export type StatementPart = { text: string; from?: "checked" | "link" | "you" };

/** THE STATEMENT THAT A MEMBER SIGNS ON `/keys/enrol`, as sentences of parts, so that the page
 *  can show which words this mind checked and which words only the link gave. `key` is the key's
 *  id, `person` the member's email. The label and the actor are the link's: the passkey signs
 *  them (`enrolPayloadOf`), but nobody checked them. */
export function statementInParts(
  ask: ServiceKeyRequest,
  facts: { mind: string; key: string; person: string },
): StatementPart[][] {
  const checked = (text: string): StatementPart => ({ text, from: "checked" });
  const link = (text: string): StatementPart => ({ text, from: "link" });
  const mind = checked(facts.mind);
  const lent = ask.provide && checked(`itx.${ask.provide}`);
  const adds: StatementPart[] = ask.paths.length
    ? [
        {
          text:
            ask.paths.length === 1 ? "add events to the context " : "add events to the contexts ",
        },
        ...listOf(ask.paths.map(checked)),
        {
          text:
            ask.paths.length === 1 ? " and the contexts under it" : " and the contexts under them",
        },
      ]
    : [];
  const may: StatementPart[] = lent
    ? [
        { text: "lend its functions to " },
        mind,
        { text: " as " },
        lent,
        ...(adds.length ? [{ text: ", and " }, ...adds] : []),
      ]
    : [...adds, { text: ", in " }, mind];
  const sentences: StatementPart[][] = [
    [
      { text: "I, " },
      { text: facts.person, from: "you" },
      { text: ", let key " },
      checked(facts.key.slice(0, 8)),
      { text: " " },
      ...may,
      { text: ", until a member removes it." },
    ],
  ];
  if (lent)
    sentences.push(
      [
        { text: "The agents of " },
        mind,
        { text: " call them, so the key's holder sees what they send." },
      ],
      [
        { text: "If " },
        lent,
        { text: " is lent to " },
        mind,
        { text: " now, the key's holder takes it when that lend ends." },
      ],
    );
  // the Cloud's name and origin are checked: the origin published this very key under that name
  const named = ask.cloud ? checked(ask.actor) : link(ask.actor);
  if (adds.length)
    sentences.push([
      { text: "Each event that it adds shows the name " },
      named,
      { text: " and this key." },
    ]);
  if (ask.cloud)
    sentences.push([
      { text: "The key is the one that " },
      checked(ask.cloud),
      { text: " publishes as iterate Cloud's." },
    ]);
  else
    sentences.push([
      { text: "The link says that the key belongs to " },
      link(`“${ask.label}”`),
      { text: "." },
    ]);
  return sentences;
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(items: StatementPart[]): StatementPart[] {
  return items.flatMap((item, index) =>
    index === 0 ? [item] : [{ text: index === items.length - 1 ? " and " : ", " }, item],
  );
}

/** A live key that lends, as the keys table has it. */
export type LendingKey = { id: string; label: string; provide: string; added_at: number };

/** THE OTHER KEY THAT LENDS A NAME NOW, or null. The mind lets a key take its name only when no
 *  other lender lends it at that moment (core/itx `context/rpc-stubs.ts` `appendAtAttach`). Two live
 *  keys with one name would each take it whenever the other's lend ended, and a link that asks for
 *  a name in use would give it to the link's maker at the first gap in that lend. So a key gets a
 *  name only once no other key holds it. The same key asking again holds its own name. */
export function otherKeyLending(
  lending: readonly LendingKey[],
  key: string,
  provide: string | undefined,
): LendingKey | null {
  return lending.find((held) => held.provide === provide && held.id !== key) ?? null;
}

/** THE CONSENT PAGE'S FIRST WORDS, for a person who has never met a key: what its holder can do
 *  in the mind `mind`, and what it cannot. They name nobody: whose key it is, is the link's word,
 *  and the statement under them marks it so. */
export function scopePlainly(
  { paths, provide }: Pick<ServiceKeyRequest, "paths" | "provide">,
  mind: string,
) {
  const places = paths.length === 1 ? "one place" : `${paths.length} places`;
  const can = [
    provide && `offer its functions to the agents of ${mind}`,
    paths.length > 0 && `send messages to ${places} in ${mind}`,
  ]
    .filter(Boolean)
    .join(", and ");
  const cannot = provide
    ? "It cannot approve requests, and it reads nothing but what the agents send it."
    : "It cannot read anything, approve requests or reach an agent.";
  return `This lets whoever holds this key ${can}. ${cannot}`;
}

/** THE CONSENT PAGE'S FIRST WORDS FOR iterate Cloud's KEY. The Cloud's host is what the member
 *  must recognise, so it names the asker; the link's label never does. A key of the Cloud's is
 *  trusted further than any other service's: what it adds, the mind reads as the providers' own
 *  (core/configs/default cloud-deliveries.ts). */
export function cloudPlainly(cloud: string, mind: string) {
  const host = new URL(cloud).host;
  return {
    heading: `iterate Cloud at ${host} asks to add events to ${mind}`,
    can: `With this key it can add events under ${SERVICE_PATHS_ROOT}, and ${mind} reads them as GitHub's, Slack's, Google's and X's own. It can read nothing and change nothing else.`,
    recognise: `The key is the one that ${host} publishes. Sign only if ${host} is the iterate Cloud that you use.`,
  };
}

/** What the key lets its service do, in a person's words: for the consent page and `/keys`. */
export function scopeInWords({ paths, provide }: Pick<ServiceKeyRequest, "paths" | "provide">) {
  return [
    provide && `lend its functions to this mind as itx.${provide}`,
    paths.length > 0 && `add events under ${paths.join(", ")}`,
  ]
    .filter(Boolean)
    .join(", and ");
}
