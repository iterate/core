import { useId } from "react";
import { cn } from "cn";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Label } from "../ui/label.tsx";
import { linkClass } from "../standalone-page.tsx";
import type { ProjectRow, ProjectSelection } from "./project-selection.ts";

/** A box for each project, one for future projects, and the New project toggle: what "Full access"
 *  (full-access.tsx) shows once it has been unticked. A client bound to one project has only its
 *  project, listed ticked, and it stays so. `fixed` projects stay ticked too: the bound client's,
 *  and a first project the screen is about to make, the one thing there is to grant. */
export function ProjectChoices({
  projects,
  projectBound,
  fixed,
  selection,
  newProject,
  disabled,
  onSelectionChange,
}: {
  projects: ProjectRow[];
  projectBound: boolean;
  fixed: boolean;
  selection: ProjectSelection;
  /** the New project toggle, where the screen offers one */
  newProject: { open: boolean; onOpenChange: (open: boolean) => void } | null;
  disabled: boolean;
  onSelectionChange: (selection: ProjectSelection) => void;
}) {
  // The label around a checkbox names it too (Base UI); these name each project "<slug> in <org>",
  // and the others by their title alone, described by the note beside it.
  const id = useId();
  const everyProject = projects.every((project) => !selection.excluded.has(project.id));
  function tick(projectId: string, checked: boolean) {
    const excluded = new Set(selection.excluded);
    if (checked) excluded.delete(projectId);
    else excluded.add(projectId);
    onSelectionChange({ ...selection, excluded, future: selection.future && checked });
  }
  return (
    <fieldset aria-label="Projects it may reach" className="flex flex-col gap-2">
      {projects.map((project) => (
        <Label key={project.id} className="items-start gap-3 leading-normal">
          <Checkbox
            className="mt-1 rounded-none border-foreground/30 data-disabled:opacity-50"
            aria-labelledby={`${id}-${project.id}-slug ${id}-${project.id}-in ${id}-${project.id}-org`}
            checked={!selection.excluded.has(project.id)}
            disabled={disabled || fixed}
            onCheckedChange={(checked) => tick(project.id, checked)}
          />
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <span id={`${id}-${project.id}-slug`} className="wrap-anywhere">
              {project.slug}
            </span>
            <span id={`${id}-${project.id}-in`} className="sr-only">
              in
            </span>
            <span
              id={`${id}-${project.id}-org`}
              className="text-xs wrap-anywhere text-muted-foreground"
            >
              {project.orgName}
            </span>
          </span>
        </Label>
      ))}
      {projectBound && !projects.length ? (
        <p className="text-muted-foreground">You do not have access to this app’s project.</p>
      ) : null}
      {projectBound ? null : (
        <>
          {/* a rule between it and the projects: the one box that is not a project */}
          <Label
            className={cn(
              "max-w-md items-start gap-3 leading-normal",
              projects.length && "mt-1 border-t pt-3",
            )}
          >
            <Checkbox
              className="mt-1 rounded-none border-foreground/30 data-disabled:opacity-50"
              aria-labelledby={`${id}-future`}
              aria-describedby={everyProject ? undefined : `${id}-future-note`}
              checked={selection.future}
              disabled={disabled || !everyProject}
              onCheckedChange={(future) => onSelectionChange({ ...selection, future })}
            />
            <span className="flex flex-wrap items-baseline gap-x-3">
              <span id={`${id}-future`}>Future projects</span>
              {everyProject ? null : (
                <span id={`${id}-future-note`} className="text-xs text-muted-foreground">
                  Only with every project above
                </span>
              )}
            </span>
          </Label>
          {newProject ? (
            <Button
              type="button"
              variant="link"
              className={cn(linkClass, "self-start")}
              aria-expanded={newProject.open}
              disabled={disabled}
              onClick={() => newProject.onOpenChange(!newProject.open)}
            >
              <span aria-hidden="true">+</span>
              New project
            </Button>
          ) : null}
        </>
      )}
    </fieldset>
  );
}
