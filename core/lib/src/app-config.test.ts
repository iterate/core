// app-config.test.ts — the mechanism every Worker's config goes through: the object and its vars
// composed under the config's prefix, a key the schema does not name warned about in both
// spellings and dropped, and a malformed field refused. Each schema's own fields are its app's table (core/os/src/worker.test.ts,
// scripts/lib/start-app.test.ts).
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { configVarNameOf, httpOrigin, optionalOrigin, parseAppConfigVars } from "./app-config.ts";

/** A schema with each shape the walk meets: a prefaulted block, an optional one, a record, an array
 *  of objects. */
const Schema = z.object({
  urls: z.object({ os: httpOrigin, dash: optionalOrigin }).prefault({ os: "" }),
  routing: z.object({ type: z.string() }).optional(),
  labels: z.record(z.string(), z.string()).default({}),
  routes: z.array(z.object({ pattern: z.string() })).optional(),
});

const IGNORED = "not in the schema, ignored — remove it, or add it to the schema";

test.for<{
  name: string;
  /** the config's name; `ITERATE` when unset */
  prefix?: string;
  env: Record<string, string>;
  becomes?: unknown;
  throws?: RegExp;
  /** every warning printed, in order: one per key the schema does not name */
  warns?: string[];
}>([
  {
    name: "the object and a var compose, and a record's keys are its own",
    env: {
      ITERATE: JSON.stringify({ urls: { os: "https://os.test" }, labels: { anything: "kept" } }),
      ITERATE__URLS__DASH: "https://dash.test",
    },
    becomes: {
      urls: { os: "https://os.test", dash: "https://dash.test" },
      labels: { anything: "kept" },
    },
  },
  {
    name: "a key inside the object the schema does not name",
    env: {
      ITERATE: JSON.stringify({ urls: { os: "https://os.test", mcp: "https://mcp.test" } }),
    },
    becomes: { urls: { os: "https://os.test", dash: "" }, labels: {} },
    warns: [`ITERATE urls.mcp (ITERATE__URLS__MCP): ${IGNORED}`],
  },
  {
    name: "a var no field answers to, named where it leaves the schema",
    env: { ITERATE__URLS__OS: "https://os.test", ITERATE__URL__DASH: "https://dash.test" },
    becomes: { urls: { os: "https://os.test", dash: "" }, labels: {} },
    warns: [`ITERATE url (ITERATE__URL): ${IGNORED}`],
  },
  {
    name: "a stray key inside an optional block a var sets whole",
    env: { ITERATE__URLS__OS: "https://os.test", ITERATE__ROUTING: '{"type":"paths","x":1}' },
    becomes: { urls: { os: "https://os.test", dash: "" }, routing: { type: "paths" }, labels: {} },
    warns: [`ITERATE routing.x (ITERATE__ROUTING__X): ${IGNORED}`],
  },
  {
    name: "a malformed field, even beside a key the schema does not name",
    env: { ITERATE__URLS__OS: "os.test", ITERATE__URLS__MCP: "https://mcp.test" },
    throws: /^ITERATE urls\.os \(ITERATE__URLS__OS\): expected an HTTP\(S\) origin/,
    warns: [`ITERATE urls.mcp (ITERATE__URLS__MCP): ${IGNORED}`],
  },
  {
    name: "a field lands on the object its parent var sets, whatever order the environment lists them in",
    env: {
      ITERATE__URLS__OS: "https://os.test",
      ITERATE__ROUTING__TYPE: "subdomains",
      ITERATE__ROUTING: '{"type":"paths"}',
    },
    becomes: {
      urls: { os: "https://os.test", dash: "" },
      routing: { type: "subdomains" },
      labels: {},
    },
  },
  {
    name: "a stray key inside an array's element",
    env: {
      ITERATE__URLS__OS: "https://os.test",
      ITERATE__ROUTES: '[{"pattern":"a/*","zone":"z"}]',
    },
    becomes: {
      urls: { os: "https://os.test", dash: "" },
      routes: [{ pattern: "a/*" }],
      labels: {},
    },
    warns: [`ITERATE routes.0.zone (ITERATE__ROUTES__0__ZONE): ${IGNORED}`],
  },
  {
    name: "a binding that shares the name's first word is not the config's",
    env: {
      ITERATE__URLS__OS: "https://os.test",
      ITERATE_CONTEXT: "a binding",
    },
    becomes: { urls: { os: "https://os.test", dash: "" }, labels: {} },
  },
  {
    name: "another config's name reads only its own variables",
    prefix: "ITERATE_APP",
    env: {
      ITERATE_APP: JSON.stringify({ urls: { os: "https://os.test" } }),
      ITERATE_APP__URLS__DASH: "https://dash.test",
      ITERATE__LABELS: '{"other":"config"}',
    },
    becomes: { urls: { os: "https://os.test", dash: "https://dash.test" }, labels: {} },
  },
  {
    name: "an app's ITERATE_APP never reads the platform's ITERATE or ITERATE__*",
    prefix: "ITERATE_APP",
    env: {
      ITERATE: JSON.stringify({ urls: { os: "https://platform.test" } }),
      ITERATE__URLS__DASH: "https://platform-dash.test",
      ITERATE_APP__URLS__OS: "https://os.test",
    },
    becomes: { urls: { os: "https://os.test", dash: "" }, labels: {} },
  },
  {
    name: "the platform's ITERATE never reads an app's ITERATE_APP or ITERATE_APP__*",
    env: {
      ITERATE__URLS__OS: "https://os.test",
      ITERATE_APP: JSON.stringify({ urls: { dash: "https://app-dash.test" } }),
      ITERATE_APP__URLS__DASH: "https://app-dash.test",
    },
    becomes: { urls: { os: "https://os.test", dash: "" }, labels: {} },
  },
])("parseAppConfigVars: $name", ({ prefix = "ITERATE", env, becomes, throws, warns = [] }) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  if (throws) expect(() => parseAppConfigVars(env, Schema, { prefix })).toThrow(throws);
  // exact: a key the schema does not name is never kept
  else expect(parseAppConfigVars(env, Schema, { prefix })).toEqual(becomes);
  expect(warn.mock).toMatchObject({ calls: warns.map((message) => [message]) });
});

test("configVarNameOf: a field's var is its path, `__` before each part, each part in SNAKE_CASE", () => {
  expect(
    configVarNameOf(["integrations", "github", "oauthClientSecret"], { prefix: "ITERATE" }),
  ).toBe("ITERATE__INTEGRATIONS__GITHUB__OAUTH_CLIENT_SECRET");
  expect(configVarNameOf(["adminBearer"], { prefix: "ITERATE" })).toBe("ITERATE__ADMIN_BEARER");
});
