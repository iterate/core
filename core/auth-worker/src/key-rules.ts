export function honouredNext(
  next: string | null,
  issuer: string,
  trustedClients: readonly string[] = [],
): string | null {
  if (!next) return null;
  let url: URL;
  try {
    url = new URL(next, issuer);
  } catch {
    return null;
  }
  // resolved first, so `//evil.example` and `/\evil.example` are judged by where they really go
  if (url.origin === issuer) return `${url.pathname}${url.search}${url.hash}`;
  // A hostname of the mind (its domain, or a label under it) is the owner's own site: the Dash,
  // the Docs app. The issuer is `iterate.<domain>`.
  const domain = new URL(issuer).hostname.split(".").slice(1).join(".");
  if (url.protocol === "https:" && (url.hostname === domain || url.hostname.endsWith(`.${domain}`)))
    return url.href;
  return trustedClients.includes(url.origin) ? url.href : null;
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

/** The stack's name for its iterate Cloud. A reader trusts a signer by this name
 *  (core/configs/default/worker.ts), so no key gets it for the asking. */
export const CLOUD_ACTOR = "iterate-cloud";

/** A service names itself on `/keys/enrol`. The Cloud's name goes only to the key that the stack's
 *  own Cloud publishes (`<cloud.origin>/.well-known/iterate-cloud`), or to a key the stack's
 *  config names (`auth.keys`). `cloud` is null when the config names no Cloud, and its `publicKey`
 *  when that Cloud gave none. Answers why `publicKey` may not have the name, or null. */
export function cloudNameRefusal(
  publicKey: string,
  cloud: { origin: string; publicKey: string | null } | null,
): string | null {
  if (!cloud)
    return `The name ${CLOUD_ACTOR} is for this mind's iterate Cloud alone, and its config names none (cloud.origin).`;
  if (!cloud.publicKey)
    return `The name ${CLOUD_ACTOR} is for this mind's iterate Cloud alone, and ${cloud.origin} gave no key to compare. Try again.`;
  return publicKey === cloud.publicKey
    ? null
    : `The name ${CLOUD_ACTOR} is for this mind's iterate Cloud alone, and this is not the key of ${cloud.origin}.`;
}

export type ServiceKeyRequest = {
  actor: string;
  label: string;
  publicKey: string;
  /** Where the key may add events. Empty for a key that only lends. */
  paths: string[];
  /** The one capability the key's token may lend, as `itx.<provide>` (./key-tokens.ts). */
  provide?: string;
};

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
  ...["files", "kv", "ai", "cfArtifacts", "r2", "secrets", "approvals", "browser", "images"],
  ...["email", "integrations", "url", "webhooks", "telemetry", "platformHook"],
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
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(actor))
    return { refused: "The service's name must be lowercase letters, digits and hyphens." };
  if (!label || label.length > 100) return { refused: "The service must give a short name." };
  if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) return { refused: "The service sent no public key." };
  // A key a member allows on a page reaches integrations alone: a link someone was tricked into
  // opening cannot ask for an agent's context or the mind's root. A wider key is the config's.
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
  return provide ? { actor, label, publicKey, paths, provide } : { actor, label, publicKey, paths };
}

/** WHAT A MEMBER SIGNS TO ALLOW A SERVICE'S KEY: the key and all that it may do, and the label
 *  that the consent page shows. The page signs this, and the answer is taken only for the same. */
export function enrolPayloadOf(key: string, ask: ServiceKeyRequest) {
  return {
    key,
    actor: ask.actor,
    label: ask.label,
    paths: ask.paths,
    provide: ask.provide || null,
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
    (payload.provide || null) === asked.provide
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
  facts: { domain: string; key: string; person: string },
): StatementPart[][] {
  const checked = (text: string): StatementPart => ({ text, from: "checked" });
  const link = (text: string): StatementPart => ({ text, from: "link" });
  const domain = checked(facts.domain);
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
        domain,
        { text: " as " },
        lent,
        ...(adds.length ? [{ text: ", and " }, ...adds] : []),
      ]
    : [...adds, { text: ", in " }, domain];
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
        domain,
        { text: " call them, so the key's holder sees what they send." },
      ],
      [
        { text: "If " },
        lent,
        { text: " is lent to " },
        domain,
        { text: " now, the key's holder takes it when that lend ends." },
      ],
    );
  if (adds.length)
    sentences.push([
      { text: "Each event that it adds shows the name " },
      link(ask.actor),
      { text: " and this key." },
    ]);
  // serviceKeyAsked (./keys-pages.ts) has compared the key with the one the stack's Cloud publishes
  if (ask.actor === CLOUD_ACTOR)
    sentences.push([domain, { text: " checked that this is the key of its iterate Cloud." }]);
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
 *  in `domain`, and what it cannot. They name nobody: whose key it is, is the link's word, and
 *  the statement under them marks it so. */
export function scopePlainly(
  { paths, provide }: Pick<ServiceKeyRequest, "paths" | "provide">,
  domain: string,
) {
  const places = paths.length === 1 ? "one place" : `${paths.length} places`;
  const can = [
    provide && `offer its functions to the agents of ${domain}`,
    paths.length > 0 && `send messages to ${places} in ${domain}`,
  ]
    .filter(Boolean)
    .join(", and ");
  const cannot = provide
    ? "It cannot approve requests, and it reads nothing but what the agents send it."
    : "It cannot read anything, approve requests or reach an agent.";
  return `This lets whoever holds this key ${can}. ${cannot}`;
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
