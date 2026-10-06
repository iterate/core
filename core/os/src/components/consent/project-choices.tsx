import { useId } from "react";
import { cn } from "cn";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Label } from "../ui/label.tsx";
import { linkClass } from "../standalone-page.tsx";
import type { ProjectRow, ProjectSelection } from "./project-selection.ts";

/** "Full access", ticked to begin with, and under it, once it has been unticked, a box for each
 *  project, one for future projects, and the New project toggle. Unticking "Full access" unticks
 *  every box, ticking it ticks every box, and ticking them all one by one ticks it. A client bound
 *  to one project has none of this: its project is listed ticked, and stays so. */
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
      {projectBound ? null : (
        <Label className="items-start gap-3 leading-normal">
          <Checkbox
            className="mt-1 rounded-none border-foreground/30 data-disabled:opacity-50"
            aria-labelledby={`${id}-full`}
            aria-describedby={`${id}-full-note`}
            checked={selection.future && everyProject}
            disabled={disabled}
            onCheckedChange={(full) =>
              onSelectionChange({
                future: full,
                excluded: new Set(full ? [] : projects.map((project) => project.id)),
                listed: true,
              })
            }
          />
          <span className="flex flex-wrap items-baseline gap-x-3">
            <span id={`${id}-full`}>Full access</span>
            <span id={`${id}-full-note`} className="text-xs text-muted-foreground">
              All projects, now and future
            </span>
          </span>
        </Label>
      )}
      {projectBound || selection.listed ? (
        <div className={cn("flex flex-col gap-2", !projectBound && "pl-7")}>
          {projects.map((project) => (
            <Label key={project.id} className="items-start gap-3 leading-normal">
              <Checkbox
                className="mt-1 rounded-none border-foreground/30 data-disabled:opacity-50"
                aria-labelledby={`${id}-${project.id}-slug ${id}-${project.id}-in ${id}-${project.id}-org`}
                checked={!selection.excluded.has(project.id)}
                disabled={disabled || projectBound}
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
              {/* a rule above it: the one box that is not a project */}
              <Label className="mt-1 max-w-md items-start gap-3 border-t pt-3 leading-normal">
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
            </>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}
