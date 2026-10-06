import type { FormEvent, Ref } from "react";
import { Button } from "../ui/button.tsx";
import { ConsentActions, StepHeading, type ConsentOutcome } from "./consent-step.tsx";
import { ProjectFields } from "./project-fields.tsx";

/** The first view for someone with no project yet: create one. There is nothing to authorize
 *  until it exists, so the consent itself follows (authorize-step.tsx). */
export function OnboardingStep({
  headingRef,
  outcome,
  fields,
  onCreateProject,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  outcome: ConsentOutcome;
  fields: Parameters<typeof ProjectFields>[0];
  onCreateProject: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form onSubmit={onCreateProject} className="flex flex-col gap-6">
      <section className="flex max-w-md flex-col gap-3">
        <StepHeading ref={headingRef}>Create a project</StepHeading>
        <ProjectFields {...fields} />
      </section>
      <ConsentActions {...outcome}>
        <Button type="submit" size="lg" className="h-11 px-4" disabled={fields.disabled}>
          Create project
        </Button>
      </ConsentActions>
    </form>
  );
}
