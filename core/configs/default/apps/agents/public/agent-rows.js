// agent-rows.js — the rows the sidebar and the home page show, from the catalog's live state on
// `/agents` (iterate/agents catalog.ts). Pure functions.

/** The catalog's rows, or none if `value` is not a catalog. A field this page does not know is
 *  read as absent, never as an error: the catalog may be newer than this file. */
export function agentRowsOf(value) {
  const agents = value && typeof value === "object" ? value.agents : undefined;
  if (!agents || typeof agents !== "object") return [];
  const text = (field) => (typeof field === "string" && field ? field : null);
  return Object.entries(agents).map(([path, row]) => ({
    path,
    createdAt: text(row.createdAt) || "",
    parent: text(row.parent),
    kind: text(row.kind),
    status: ["working", "idle", "waiting", "ended"].includes(row.status) ? row.status : null,
    activity: text(row.activity),
    title: text(row.title),
    lastActivityAt: text(row.lastActivityAt),
  }));
}

/** The agents a list shows: those with no agent above them. A row that never said what it is and
 *  only holds others (`/agents/web`) is a folder: not listed, and its children count as at the top. */
export function topLevelAgents(rows) {
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const holders = new Set(rows.map((row) => row.parent));
  const isFolder = (row) => !row.kind && !row.title && holders.has(row.path);
  return rows.filter((row) => {
    if (isFolder(row)) return false;
    const parent = row.parent && byPath.get(row.parent);
    return !parent || isFolder(parent);
  });
}

/** What a list calls an agent: its title, or else the last segment of its path. */
export function agentTitle(row) {
  return row.title || row.path.split("/").filter(Boolean).at(-1) || row.path;
}

/** The agents, most recently active first; the path breaks a tie. */
export function byRecentActivity(rows) {
  const at = (row) => row.lastActivityAt || row.createdAt;
  return rows.toSorted(
    (left, right) => at(right).localeCompare(at(left)) || left.path.localeCompare(right.path),
  );
}

/** A browser-created agent lives at `/agents/web/<moment>`. An agent is its path. */
export function newWebAgentPath(date) {
  return newAgentPath("web", date);
}

/** Another kind's new agent: `/agents/<kind>/<moment>`. */
export function newAgentPath(folder, date) {
  const slug = date
    .toISOString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `/agents/${folder}/${slug}`;
}
