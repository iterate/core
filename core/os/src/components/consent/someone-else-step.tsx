import { useId, useState, type Ref } from "react";
import { Button } from "../ui/button.tsx";
import { Field, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { linkClass } from "../standalone-page.tsx";
import type { ConsentView } from "../../consent.ts";
import { ConsentActions, StepHeading, type ConsentOutcome } from "./consent-step.tsx";

/** A PLATFORM ADMIN'S "Sign in as someone else…" (the consent view's `impersonation`, admins only):
 *  whom, typed with the platform's people as suggestions, and who the client really is — its
 *  verified host, where the code goes, the resource and the permissions it would hold as them, and
 *  a warning for anything that is not one of this deployment's own apps. A link naming someone fills
 *  them in (`impersonation.suggested`); nothing is signed in until the admin submits. Submit is a
 *  plain POST to this very authorization URL carrying `impersonate=<user id>` in the body, which
 *  the platform checks again (consent.ts `approve`). */
export function SomeoneElseStep({
  headingRef,
  outcome,
  clientName,
  clientId,
  impersonation,
  onBack,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  outcome: ConsentOutcome;
  clientName: string;
  clientId: string;
  impersonation: NonNullable<Extract<ConsentView, { kind: "consent" }>["impersonation"]>;
  onBack: () => void;
}) {
  const formId = useId();
  const [email, setEmail] = useState(impersonation.suggested || "");
  const [submitting, setSubmitting] = useState(false);
  // the form posts the person's id, never the address typed: only someone on the list can be picked
  const chosen = impersonation.people.find((person) => person.email === email.trim().toLowerCase());
  const who = chosen?.email || "them";
  return (
    <>
      <form
        id={formId}
        method="post"
        onSubmit={() => setSubmitting(true)}
        className="flex max-w-md flex-col gap-3"
      >
        <StepHeading ref={headingRef}>Sign in as someone else</StepHeading>
        <Field>
          <FieldLabel htmlFor={`${formId}-email`}>Their email</FieldLabel>
          <Input
            id={`${formId}-email`}
            type="email"
            list={`${formId}-people`}
            autoComplete="off"
            required
            value={email}
            className="h-11 bg-muted px-3"
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <datalist id={`${formId}-people`}>
          {impersonation.people.map((person) => (
            <option key={person.id} value={person.email} />
          ))}
        </datalist>
        {chosen ? <input type="hidden" name="impersonate" value={chosen.id} /> : null}
      </form>
      <section aria-label="The client" className="flex flex-col gap-2">
        <h3>{clientName}</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Client</dt>
          <dd className="wrap-anywhere">
            {impersonation.metadataHost || `unverified client · ${clientId}`}
          </dd>
          <dt className="text-muted-foreground">Returns to</dt>
          <dd className="wrap-anywhere">{impersonation.redirectHost}</dd>
          <dt className="text-muted-foreground">Resource</dt>
          <dd>{impersonation.resource}</dd>
          <dt className="text-muted-foreground">Permissions</dt>
          <dd>
            <ul>
              {impersonation.scopes.map((scope) => (
                <li key={scope.name}>{scope.title}</li>
              ))}
            </ul>
          </dd>
        </dl>
        {impersonation.ownApp ? null : (
          <p className="text-destructive">Not an iterate app — it will act as {who} for an hour.</p>
        )}
        <p className="text-xs text-muted-foreground">
          Everything it does names you beside them, and both your accounts record it.
        </p>
      </section>
      <ConsentActions {...outcome}>
        <Button
          type="submit"
          form={formId}
          size="lg"
          className="h-auto min-h-11 max-w-full shrink px-4 py-2 text-left whitespace-normal"
          disabled={!chosen || submitting}
        >
          Sign {clientName} in as {who} for an hour
        </Button>
        <Button type="button" variant="link" className={linkClass} onClick={onBack}>
          Back
        </Button>
      </ConsentActions>
    </>
  );
}
