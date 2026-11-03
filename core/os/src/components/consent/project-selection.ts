/** A project the person reaches, with its organization's name for the list. */
export interface ProjectRow {
  id: string;
  slug: string;
  orgName: string;
}

/** Which projects the client may reach. "Full access" (full-access.tsx) is these boxes ticked,
 *  each project and "Future projects", with every permission. A grant holds every project or a
 *  list of them (consent.ts `approve`), so future projects come only with every project there is
 *  today: `future` is never true while a project is unticked. */
export interface ProjectSelection {
  /** "Future projects" */
  future: boolean;
  /** the projects unticked; a project created on the page starts ticked */
  excluded: ReadonlySet<string>;
  /** the boxes under "Full access" show: unticking it shows them, a request for `admin` starts with
   *  them shown (consent-card.tsx), and nothing hides them after */
  listed: boolean;
}

/** The `project` fields a selection posts: `*` for full access, else each project ticked. */
export function grantedProjects(projects: ProjectRow[], selection: ProjectSelection) {
  const ticked = projects.filter((project) => !selection.excluded.has(project.id));
  if (selection.future && ticked.length === projects.length) return ["*"];
  return ticked.map((project) => project.id);
}
