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
 *  only holds others (`/agents/web`) is a folder: not listed, and its children count as at the
 *  top. A person's folders are folders with nothing in them too (`isPeopleFolder`). */
export function topLevelAgents(rows) {
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const holders = new Set(rows.map((row) => row.parent));
  const isFolder = (row) =>
    !row.kind && !row.title && (holders.has(row.path) || isPeopleFolder(row.path));
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

// ── whose an agent is ──
// An agent that a person starts here lives in that person's folder,
// `/agents/people/<person>/<folder>/<moment>`. These are the rules of iterate's UI kit
// (packages/ui/src/lib/agent-summary.ts in https://github.com/iterate/core), which says why each
// is as it is, and what the folder's name cannot tell (two people with one local part).

/** The folder under `/agents` that holds each person's folder. */
const PEOPLE = "people";

/** A person's folder name, from the address they sign in with, or nothing for no address. */
export function personOf(email) {
  const local = typeof email === "string" ? email.split("@")[0] : "";
  return (
    local
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || undefined
  );
}

/** The person whose folder holds the agent at `path`, or nothing for an agent in no one's. */
export function personAt(path) {
  const [, agents, people, person, ...rest] = path.split("/");
  return agents === "agents" && people === PEOPLE && rest.length > 0 ? person : undefined;
}

/** Whether `path` is the people's level, a person's folder, or a person's folder for one kind. */
function isPeopleFolder(path) {
  const [, agents, people, ...rest] = path.split("/");
  return agents === "agents" && people === PEOPLE && rest.length <= 2;
}

/** A new agent's path at this moment: in `person`'s folder under `folder`, or with no person
 *  `/agents/<folder>/<moment>`. An agent is its path. */
export function newAgentPath(folder, date, person) {
  const slug = date
    .toISOString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return person ? `/agents/${PEOPLE}/${person}/${folder}/${slug}` : `/agents/${folder}/${slug}`;
}

/** `rows` in their order, with `person`'s own first: a list in which a person finds their agents
 *  before the others'. With no person, the rows as they are. */
export function mineFirst(rows, person) {
  if (!person) return rows;
  const mine = (row) => personAt(row.path) === person;
  return [...rows.filter(mine), ...rows.filter((row) => !mine(row))];
}
