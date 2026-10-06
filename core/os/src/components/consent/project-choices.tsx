import { useId } from "react";
import { cn } from "cn";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Label } from "../ui/label.tsx";
import { linkClass } from "../standalone-page.tsx";

/** A project the person reaches, with its organization's name for the list. */
export interface ProjectRow {
  id: string;
  slug: string;
  orgName: string;
}

/** Which projects the client may reach: every one now and later, or the ones ticked. Choosing all
 *  parks the individual ticks, so narrowing access again restores them. */
export interface ProjectSelection {
  all: boolean;
  /** the projects unticked; a project created on the page starts ticked */
  excluded: ReadonlySet<string>;
}

/** The project list with its either/or — all projects, or those ticked — and the New project
 *  toggle. A client bound to one project has neither choice: its project is listed ticked, and
 *  stays so. */
export function ProjectChoices({
  projects,
  projectBound,
  selection,
  creating,
  disabled,
  onSelectionChange,
  onCreatingChange,
}: {
  projects: ProjectRow[];
  projectBound: boolean;
  selection: ProjectSelection;
  creating: boolean;
  disabled: boolean;
  onSelectionChange: (selection: ProjectSelection) => void;
  onCreatingChange: (creating: boolean) => void;
}) {
  // The label around a checkbox names it too (Base UI); these name each project "<slug> in <org>".
  const id = useId();
  function tick(projectId: string, checked: boolean) {
    const excluded = new Set(selection.excluded);
    if (checked) excluded.delete(projectId);
    else excluded.add(projectId);
    onSelectionChange({ ...selection, excluded });
  }
  return (
    <fieldset aria-label="Projects it may reach" className="flex flex-col gap-2">
      {projectBound ? null : (
        <Label className="gap-3 leading-normal">
          <Checkbox
            className="rounded-none border-foreground/30 data-disabled:opacity-50"
            checked={selection.all}
            disabled={disabled}
            onCheckedChange={(all) => onSelectionChange({ ...selection, all })}
          />
          All my projects, now and future
        </Label>
      )}
      {projects.map((project) => (
        <Label key={project.id} className="items-start gap-3 leading-normal">
          <Checkbox
            className="mt-1 rounded-none border-foreground/30 data-disabled:opacity-50"
            aria-labelledby={`${id}-${project.id}-slug ${id}-${project.id}-in ${id}-${project.id}-org`}
            checked={selection.all || !selection.excluded.has(project.id)}
            disabled={disabled || selection.all || projectBound}
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
        <Button
          type="button"
          variant="link"
          className={cn(linkClass, "self-start")}
          aria-expanded={creating}
          disabled={disabled}
          onClick={() => onCreatingChange(!creating)}
        >
          <span aria-hidden="true">+</span>
          New project
        </Button>
      )}
    </fieldset>
  );
}
