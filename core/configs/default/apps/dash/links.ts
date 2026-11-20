// links.ts — CANONICAL DASH URLS for a mind: one pure formatter shared by config code, Slack and
// mail writers, and `itx.config.dashLink(input)` for agents. Keeps the same encoding rules as
// `@iterate-com/ui`'s `dashPaths` (`dash-paths.ts`), pinned by `dash-routes.fixture.json`.
import { z } from "zod";

/** Page ids allowed as the first path segment (host-reserved paths and dotted names are rejected). */
const PAGE_SEGMENT = /^(?!(?:itx|connect|api|keys|brands)$)[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Hostname of a mind's zone (`example.com`), never a scheme, path or credentials. */
const APEX_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/** Trailing `.` `,` `:` encoded so Slack and mail linkifiers do not drop them from the link. */
const TRAILING_PUNCTUATION: Record<string, string> = { ".": "%2E", ",": "%2C", ":": "%3A" };

/** A path that a URL's pathname can carry and read back cleanly (non-root, no empty/`.`/`..` segments). */
const sayable = (path: string) =>
  path.length > 1 &&
  path.startsWith("/") &&
  path
    .slice(1)
    .split("/")
    .every((segment) => segment && segment !== "." && segment !== "..");

/** A single path segment that round-trips without splitting or dot-segment resolution. */
const sayableSegment = (segment: string) =>
  Boolean(segment) && !segment.includes("/") && segment !== "." && segment !== "..";

/** A relative multi-segment path (a repo file or page remainder) that round-trips. */
const sayableRelative = (path: string) => !path.startsWith("/") && sayable(`/${path}`);

/** Context path encoded for a URL pathname, keeping path-safe sub-delimiters readable. */
const urlPathOf = (path: string) =>
  path
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/%(?:40|3A|24|26|2B|2C|3B|3D)/g, decodeURIComponent);

/** Query string for `contextPath`, keeping `/ @ : ,` raw and spaces as `%20`. */
function contextPathQuery(contextPath: string): string {
  const ordered = new URLSearchParams();
  ordered.set("contextPath", contextPath);
  return ordered
    .toString()
    .replaceAll("+", "%20")
    .replace(/%(?:2F|40|3A|2C)/g, decodeURIComponent);
}

/** Finalizes a Dash path and optional query string, encoding trailing `.` `,` `:`. */
function finish(origin: string, pathname: string, query = ""): string {
  const href = query ? `${pathname}?${query}` : pathname;
  return `${origin}${href.replace(/[.,:]$/, (char) => TRAILING_PUNCTUATION[char]!)}`;
}

/** Shared context-path formatter for `/agents` and `/contexts`: sayable non-root paths go in the
 *  pathname; root `/` and unsayable paths stay in `?contextPath=`. */
function contextRoute(origin: string, page: "agents" | "contexts", contextPath: string): string {
  if (sayable(contextPath)) return finish(origin, `/${page}${urlPathOf(contextPath)}`);
  return finish(origin, `/${page}`, contextPathQuery(contextPath));
}

function assertApex(apex: string): string {
  if (!APEX_HOST.test(apex) || apex.includes(".."))
    throw new Error(`dashLinks: invalid apex hostname "${apex}"`);
  return `https://dash.${apex}`;
}

function assertContextPath(path: string, label: string): string {
  if (!path.startsWith("/"))
    throw new Error(`dashLinks: ${label} must start with "/" (got "${path}")`);
  return path;
}

function assertPageId(id: string): string {
  if (!PAGE_SEGMENT.test(id)) throw new Error(`dashLinks: "${id}" is not a valid Dash page id`);
  return id;
}

function assertRelative(path: string, label: string): string {
  if (!sayableRelative(path)) throw new Error(`dashLinks: invalid ${label} "${path}"`);
  return path;
}

const ContextPath = z
  .string()
  .min(1)
  .max(1000)
  .refine((path) => path.startsWith("/"), 'contextPath must start with "/"');

const PageId = z
  .string()
  .refine((id) => PAGE_SEGMENT.test(id), "page must be a valid non-reserved Dash page id");

const RepoName = z
  .string()
  .min(1)
  .max(200)
  .refine(sayableSegment, "repo must be a plain repo name");

const RelativePath = z
  .string()
  .min(1)
  .max(1000)
  .refine(sayableRelative, "path must be a relative path with no empty, . or .. segments");

/** Structured destination for `dashLink` and `itx.config.dashLink(input)`. */
export const DashLinkInput = z.discriminatedUnion("view", [
  z.object({ view: z.literal("home") }),
  z.object({ view: z.literal("agent"), contextPath: ContextPath }),
  z.object({ view: z.literal("context"), contextPath: ContextPath }),
  z.object({
    view: z.literal("repos"),
    repo: RepoName.optional(),
    file: RelativePath.optional(),
  }),
  z.object({
    view: z.literal("page"),
    page: PageId,
    rest: RelativePath.optional(),
  }),
  z.object({ view: z.literal("agents") }),
  z.object({ view: z.literal("contexts") }),
  z.object({ view: z.literal("secrets"), rest: RelativePath.optional() }),
  z.object({ view: z.literal("integrations"), rest: RelativePath.optional() }),
  z.object({ view: z.literal("analytics"), rest: RelativePath.optional() }),
]);

export type DashLinkInput = z.infer<typeof DashLinkInput>;

/** Pure URL builder for a mind's Dash (`https://dash.<apex>`). */
export function dashLinks(apex: string) {
  const origin = assertApex(apex);
  const page = (id: string, rest?: string) => {
    assertPageId(id);
    const tail = rest ? urlPathOf(`/${assertRelative(rest, "page remainder")}`) : "";
    return finish(origin, `/${id}${tail}`);
  };
  return {
    origin,
    home: () => `${origin}/`,
    page,
    agent: (contextPath: string) =>
      contextRoute(origin, "agents", assertContextPath(contextPath, "agent path")),
    context: (contextPath: string) =>
      contextRoute(origin, "contexts", assertContextPath(contextPath, "context path")),
    repos: (repo?: string, file?: string) => {
      if (!repo && !file) return `${origin}/repos`;
      const target = repo || "config";
      if (!sayableSegment(target)) throw new Error(`dashLinks: invalid repo "${target}"`);
      const fileTail = file ? urlPathOf(`/${assertRelative(file, "repo file")}`) : "";
      return finish(origin, `/repos${urlPathOf(`/${target}`)}${fileTail}`);
    },
    agents: () => `${origin}/agents`,
    contexts: () => page("contexts"),
    secrets: (rest?: string) => page("secrets", rest),
    integrations: (rest?: string) => page("integrations", rest),
    analytics: (rest?: string) => page("analytics", rest),
  };
}

/** Validates a structured destination and returns its canonical URL on `https://dash.<apex>`. */
export function dashLink(apex: string, input: DashLinkInput): string {
  const parsed = DashLinkInput.parse(input);
  const links = dashLinks(apex);
  switch (parsed.view) {
    case "home":
      return links.home();
    case "agent":
      return links.agent(parsed.contextPath);
    case "context":
      return links.context(parsed.contextPath);
    case "repos":
      return links.repos(parsed.repo, parsed.file);
    case "page":
      return links.page(parsed.page, parsed.rest);
    case "agents":
      return links.agents();
    case "contexts":
      return links.contexts();
    case "secrets":
      return links.secrets(parsed.rest);
    case "integrations":
      return links.integrations(parsed.rest);
    case "analytics":
      return links.analytics(parsed.rest);
  }
}
