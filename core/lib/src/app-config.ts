// app-config.ts — THE PREFIXED CONFIG MECHANISM: how every Worker of ours reads what differs between
// deployments of the same code. ONE JSON object under a prefix of the Worker's own — the
// platform's `ITERATE` (the iterate config, core/os/src/iterate-config.ts), the apps' `ITERATE_APP`
// — checked against the Worker's own zod schema; loud on anything malformed, naming the field. A
// value left out takes its schema's default.
//
// Any key can also be set ALONE as a var: the name, then the path, `__` before every segment and
// each segment in SNAKE_CASE: `ITERATE__URLS__OS`, `ITERATE__LOGIN__PASSWORD`,
// `ITERATE_APP__URLS__OS`. The parser merges it on top of the object, so a deployment's vars and its
// secrets compose, and a laptop's gitignored `.dev.vars` names one local origin without restating
// the rest. A blank var is unset. A key the schema does not name, in the object or as a var, is
// warned about loudly and dropped, never silently kept. A var under the prefix with ONE underscore
// (`ITERATE_CONTEXT`, a binding, or the apps' `ITERATE_APP`) is not the config's.
//
// The schemas: the platform's in core/os/src/iterate-config.ts, the apps on top's in
// packages/shared/src/start-app-config.ts.

import { z } from "zod";

/** Which config: the object's variable, and the prefix of every one-field variable
 *  (`<prefix>__<PATH>`). */
export type ConfigPrefix = { prefix: string };

/** Parse `schema` out of `env` (a worker env, or any record — only `<prefix>` and the
 *  `<prefix>__*` keys are read; a blank one is unset). Pure. A malformed field throws naming
 *  itself in both spellings (`fieldNameOf`); a key the schema does not name is warned about, named
 *  the same way, and dropped. Unknown keys are tolerated because parallel branches add keys; a key
 *  one branch adds must not fail another's deploy — owner decision 2026-09-26. */
export function parseAppConfigVars<Schema extends z.ZodTypeAny>(
  env: object,
  schema: Schema,
  config: ConfigPrefix,
): z.output<Schema> {
  return parseAppConfig(appConfigInputOf(env, config), schema, config);
}

/** The config's object as `env` gives it, before the schema: `<prefix>` with every `<prefix>__*`
 *  override merged on top, the deeper path last. Pure. What a deployment's config file starts from
 *  (core/os/iterate.config.ts), and what `parseAppConfigVars` parses. */
export function appConfigInputOf(env: object, { prefix }: ConfigPrefix): Record<string, unknown> {
  const configEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!(key === prefix || key.startsWith(`${prefix}__`))) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    configEnv[key] = value;
  }
  return deepMerge(objectOf(configEnv[prefix], prefix), overridesOf(configEnv, prefix));
}

/** Parse `schema` out of the config's object, `raw` (`appConfigInputOf`'s, or a config file's).
 *  Pure. Fails and warns as `parseAppConfigVars` does. */
export function parseAppConfig<Schema extends z.ZodTypeAny>(
  raw: unknown,
  schema: Schema,
  { prefix }: ConfigPrefix,
): z.output<Schema> {
  try {
    warnUnknownKeys(raw, schema, [], prefix);
    return schema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0]!;
      throw new Error(`${fieldNameOf(issue.path, { prefix })}: ${issue.message}`);
    }
    throw error;
  }
}

/** Where a field came from, for a message: its path in the object and its var spelling —
 *  `ITERATE urls.os (ITERATE__URLS__OS)`. */
export function fieldNameOf(path: readonly PropertyKey[], { prefix }: ConfigPrefix): string {
  return `${prefix} ${path.map(String).join(".")} (${configVarNameOf(path, { prefix })})`;
}

/** An HTTP(S) origin with no path or query — `new URL(v).origin === v`. */
export const httpOrigin = z
  .string()
  .trim()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" || url.protocol === "http:");
  }, "expected an HTTP(S) origin without a path");

/** An origin a deployment may leave out (blank ⇒ the field's documented default). */
export const optionalOrigin = z.union([z.literal(""), httpOrigin]).default("");

/** A DNS name: lowercase labels, no scheme, no trailing dot, no wildcard — the wildcard is implied. */
export const dnsName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/, "expected a DNS name");

/** The override var a schema path answers to — `["urls", "os"]` → `ITERATE__URLS__OS` — the inverse
 *  of `overridesOf`, so a message names both spellings a human might have used. */
export function configVarNameOf(path: readonly PropertyKey[], { prefix }: ConfigPrefix): string {
  return [
    prefix,
    ...path.map((segment) =>
      String(segment)
        .replace(/([A-Z])/g, "_$1")
        .toUpperCase(),
    ),
  ].join("__");
}

/** Warn, loudly, once per key, about a key the schema does not name — in the object or a
 *  `<prefix>__*` override, checked once on the merged config; the schema's parse then drops it. */
function warnUnknownKeys(raw: unknown, schema: z.ZodTypeAny, path: string[], prefix: string): void {
  for (const unknownPath of unknownKeysOf(raw, schema, path))
    console.warn(
      `${fieldNameOf(unknownPath, { prefix })}: not in the schema, ignored — remove it, or add it to the schema`,
    );
}

/** The paths in `raw` that `schema` does not name: what a parse drops. Walks the plain objects and
 *  each element of an array; a record accepts any key. */
export function unknownKeysOf(raw: unknown, schema: z.ZodTypeAny, path: string[] = []): string[][] {
  // unwrap() and shape hand back loosely typed schemas; the walk checks each with instanceof
  let current = schema;
  while (
    current instanceof z.ZodDefault ||
    current instanceof z.ZodPrefault ||
    current instanceof z.ZodOptional
  )
    current = current.unwrap() as z.ZodTypeAny;
  if (current instanceof z.ZodArray && Array.isArray(raw)) {
    const element = current.element as z.ZodTypeAny;
    return raw.flatMap((item, index) => unknownKeysOf(item, element, [...path, String(index)]));
  }
  const object = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!object.success || !(current instanceof z.ZodObject)) return [];
  const shape = current.shape;
  return Object.entries(object.data).flatMap(([key, value]) => {
    const child = shape[key] as z.ZodTypeAny | undefined;
    return child ? unknownKeysOf(value, child, [...path, key]) : [[...path, key]];
  });
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The object itself (`<prefix>`); blank ⇒ `{}`. */
function objectOf(value: string | undefined, prefix: string): PlainObject {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${prefix} must be valid JSON`, { cause: error });
  }
  if (!isPlainObject(parsed)) throw new Error(`${prefix} must be a JSON object`);
  return parsed;
}

/** The `<prefix>__*` overrides as one nested object: `__` separates path segments and each
 *  segment's SNAKE_CASE becomes camelCase (`ITERATE__LOGIN__EMAIL_CODE__FROM` → `login.emailCode.from`).
 *  A value that reads as JSON (`true`, `false`, `null`, an object, an array, a quoted string) is
 *  parsed; anything else is the string itself. The shallower path goes first, so a field
 *  (`ITERATE__CUSTOM_HOSTNAMES__CLOUDFLARE_API_TOKEN`) lands on the object its parent sets
 *  (`ITERATE__CUSTOM_HOSTNAMES`) whatever order the environment lists them in. */
function overridesOf(configEnv: Record<string, string>, prefix: string): PlainObject {
  const overrides: PlainObject = {};
  const depth = (key: string) => key.split("__").length;
  const entries = Object.entries(configEnv).sort(([a], [b]) => depth(a) - depth(b));
  for (const [key, value] of entries) {
    if (!key.startsWith(`${prefix}__`)) continue;
    const path = key
      .slice(`${prefix}__`.length)
      .split("__")
      .map((segment) =>
        segment
          .toLowerCase()
          .split("_")
          .filter(Boolean)
          .map((word, index) => (index === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
          .join(""),
      )
      .filter(Boolean);
    const last = path.pop();
    if (!last) continue;
    let target = overrides;
    for (const segment of path) {
      const existing = target[segment];
      const next: PlainObject = isPlainObject(existing) ? existing : {};
      target[segment] = next;
      target = next;
    }
    target[last] = overrideValueOf(value);
  }
  return overrides;
}

function overrideValueOf(value: string): unknown {
  const trimmed = value.trim();
  const looksLikeJson =
    ["true", "false", "null"].includes(trimmed) ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'));
  if (!looksLikeJson) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** `overrides` over `base`, plain objects merged key by key; anything else replaced whole, and an
 *  undefined override leaves the base's value. */
export function deepMerge(base: PlainObject, overrides: PlainObject): PlainObject {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return merged;
}
