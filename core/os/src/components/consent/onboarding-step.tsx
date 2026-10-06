import type { FormEvent, Ref } from "react";
import type { ConsentScope } from "iterate/oauth-scopes";
import { Button } from "../ui/button.tsx";
import { ConsentActions, StepHeading, type ConsentOutcome } from "./consent-step.tsx";
import { PermissionChoices } from "./permission-choices.tsx";
import { ProjectChoices } from "./project-choices.tsx";
import { ProjectFields } from "./project-fields.tsx";
import type { ProjectSelection } from "./project-selection.ts";

/** The consent for someone with no project yet: the same screen (authorize-step.tsx) with the
 *  project it is about to make in place of a list. One button makes the organization and the
 *  project and then grants access (consent-card.tsx `createAndAuthorize`), so the form's `project`
 *  field is `*` for full access, or the new project's id once there is one (`createdProjectId`). */
export function OnboardingStep({
  headingRef,
  outcome,
  fields,
  organizationName,
  selection,
  scopes,
  declined,
  createdProjectId,
  onSelectionChange,
  onDeclinedChange,
  onCreateAndAuthorize,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  outcome: ConsentOutcome;
  fields: Parameters<typeof ProjectFields>[0];
  organizationName: string;
  selection: ProjectSelection;
  scopes: ConsentScope[];
  declined: ReadonlySet<string>;
  createdProjectId: string | null;
  onSelectionChange: (selection: ProjectSelection) => void;
  onDeclinedChange: (declined: ReadonlySet<string>) => void;
  onCreateAndAuthorize: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const granted = {
    projects: selection.future ? ["*"] : createdProjectId ? [createdProjectId] : [],
    scopes: scopes.filter((scope) => scope.required || !declined.has(scope.name)),
  };
  return (
    <form method="post" onSubmit={onCreateAndAuthorize} className="flex flex-col gap-6">
      <section className="flex max-w-md flex-col gap-3">
        <StepHeading ref={headingRef}>Create a project</StepHeading>
        <ProjectFields {...fields} />
      </section>
      <section className="flex flex-col gap-3">
        <h2>Projects</h2>
        <ProjectChoices
          projects={[
            { id: "first-project", slug: fields.slug || "my-project", orgName: organizationName },
          ]}
          projectBound={false}
          fixed
          selection={selection}
          newProject={null}
          disabled={fields.disabled}
          onSelectionChange={onSelectionChange}
        />
      </section>
      <section className="flex flex-col gap-3">
        <h2>Permissions</h2>
        <PermissionChoices
          scopes={scopes}
          declined={declined}
          disabled={fields.disabled}
          onDeclinedChange={onDeclinedChange}
        />
      </section>
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
          className="h-auto min-h-11 max-w-full shrink px-4 py-2 text-left whitespace-normal"
          disabled={fields.disabled}
        >
          Create project and authorize
        </Button>
      </ConsentActions>
    </form>
  );
}
