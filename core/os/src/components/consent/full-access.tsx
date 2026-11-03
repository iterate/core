import { useId, type ReactNode } from "react";
import type { ConsentScope } from "iterate/oauth-scopes";
import { Checkbox } from "../ui/checkbox.tsx";
import { Label } from "../ui/label.tsx";
import type { ProjectRow, ProjectSelection } from "./project-selection.ts";

/** "Full access", ticked to begin with: every project, now and future, and every permission the
 *  request asked for. Under it, once `selection.listed` says so, `children`: the project and
 *  permission boxes it stands for. Unticking it unticks every box that can be unticked (not a
 *  `fixed` project, not a required permission), ticking it ticks every box, and ticking them all
 *  one by one ticks it. */
export function FullAccess({
  projects,
  fixed,
  selection,
  scopes,
  declined,
  disabled,
  onSelectionChange,
  onDeclinedChange,
  children,
}: {
  projects: ProjectRow[];
  /** the projects stay ticked: a first project the screen is about to make */
  fixed: boolean;
  selection: ProjectSelection;
  scopes: ConsentScope[];
  declined: ReadonlySet<string>;
  disabled: boolean;
  onSelectionChange: (selection: ProjectSelection) => void;
  onDeclinedChange: (declined: ReadonlySet<string>) => void;
  children: ReactNode;
}) {
  // named by its title and described by the note: the label around it would name it with both
  // (Base UI)
  const id = useId();
  const optional = scopes.filter((scope) => !scope.required).map((scope) => scope.name);
  const full =
    selection.future &&
    projects.every((project) => !selection.excluded.has(project.id)) &&
    optional.every((name) => !declined.has(name));
  return (
    <div className="flex flex-col gap-3">
      <Label className="items-start gap-3 leading-normal">
        <Checkbox
          className="mt-1 rounded-none border-foreground/30 data-disabled:opacity-50"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-note`}
          checked={full}
          disabled={disabled}
          onCheckedChange={(checked) => {
            onSelectionChange({
              future: checked,
              excluded: new Set(checked || fixed ? [] : projects.map((project) => project.id)),
              listed: true,
            });
            onDeclinedChange(new Set(checked ? [] : optional));
          }}
        />
        <span className="flex flex-wrap items-baseline gap-x-3">
          <span id={`${id}-title`}>Full access</span>
          <span id={`${id}-note`} className="text-xs text-muted-foreground">
            All projects, now and future, and every permission it asked for
          </span>
        </span>
      </Label>
      {selection.listed ? <div className="flex flex-col gap-6 pl-7">{children}</div> : null}
    </div>
  );
}
