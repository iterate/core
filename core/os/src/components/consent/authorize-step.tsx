import { useState, type FormEvent, type Ref } from "react";
import type { ConsentScope } from "iterate/oauth-scopes";
import { Button } from "../ui/button.tsx";
import { ConsentActions, StepHeading, type ConsentOutcome } from "./consent-step.tsx";
import { PermissionChoices } from "./permission-choices.tsx";
import { ProjectChoices } from "./project-choices.tsx";
import { grantedProjects, type ProjectRow, type ProjectSelection } from "./project-selection.ts";
import { ProjectFields } from "./project-fields.tsx";

/** The consent itself, on one screen: which projects the client may reach (and a project made on
 *  the spot when none fits), which of the permissions it asked for to grant, and Authorize — a
 *  plain POST to this very authorization URL carrying the choices as `project` and `scope` fields.
 *  Everything Authorize grants is on the screen when it is clicked. */
export function AuthorizeStep({
  headingRef,
  outcome,
  projects,
  projectBound,
  selection,
  scopes,
  declined,
  fields,
  onSelectionChange,
  onDeclinedChange,
  onCreateProject,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  outcome: ConsentOutcome;
  projects: ProjectRow[];
  projectBound: boolean;
  selection: ProjectSelection;
  scopes: ConsentScope[];
  declined: ReadonlySet<string>;
  fields: Parameters<typeof ProjectFields>[0];
  onSelectionChange: (selection: ProjectSelection) => void;
  onDeclinedChange: (declined: ReadonlySet<string>) => void;
  onCreateProject: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { draft, disabled, onDraftChange } = fields;
  const [authorizing, setAuthorizing] = useState(false);
  const granted = {
    projects: grantedProjects(projects, selection),
    scopes: scopes.filter((scope) => scope.required || !declined.has(scope.name)),
  };
  return (
    <>
      <section className="flex flex-col gap-3">
        <StepHeading ref={headingRef}>Projects</StepHeading>
        <ProjectChoices
          projects={projects}
          projectBound={projectBound}
          fixed={projectBound}
          selection={selection}
          newProject={
            projectBound
              ? null
              : { open: draft.open, onOpenChange: (open) => onDraftChange({ ...draft, open }) }
          }
          disabled={disabled}
          onSelectionChange={onSelectionChange}
        />
        {draft.open ? (
          // Its own form, beside Authorize's and not inside it: Enter in a field creates the
          // project, and Authorize never creates an unfinished draft.
          <form
            aria-label="New project"
            onSubmit={onCreateProject}
            className="flex max-w-md flex-col gap-4 border p-4"
          >
            <h3>New project</h3>
            <ProjectFields {...fields} />
            <Button
              type="submit"
              variant="outline"
              size="lg"
              className="h-11 self-start px-4"
              disabled={disabled}
            >
              Create project
            </Button>
          </form>
        ) : null}
      </section>
      <section className="flex flex-col gap-3">
        <h2>Permissions</h2>
        <PermissionChoices
          scopes={scopes}
          declined={declined}
          disabled={disabled}
          onDeclinedChange={onDeclinedChange}
        />
      </section>
      <form method="post" onSubmit={() => setAuthorizing(true)}>
        {granted.projects.map((project) => (
          <input key={project} type="hidden" name="project" value={project} />
        ))}
        {granted.scopes.map((scope) => (
          <input key={scope.name} type="hidden" name="scope" value={scope.name} />
        ))}
        <ConsentActions {...outcome}>
          <Button
            type="submit"
            size="lg"
            className="h-11 px-4"
            disabled={disabled || authorizing || !granted.projects.length}
          >
            Authorize
          </Button>
        </ConsentActions>
      </form>
    </>
  );
}
