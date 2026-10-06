import { useRef, useState, useTransition, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { useHydrated, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { StandalonePage } from "../standalone-page.tsx";
import type { ConsentView } from "../../consent.ts";
import { projectSlug } from "../../control-plane/catalog.ts";
import { createProjectForConsent } from "../../issuer.functions.ts";
import { switchAccountHref } from "../../login-search.ts";
import { AuthorizeStep } from "./authorize-step.tsx";
import { ClientHeading } from "./client-heading.tsx";
import { OnboardingStep } from "./onboarding-step.tsx";
import type { ProjectSelection } from "./project-selection.ts";
import type { ProjectDraft } from "./project-fields.tsx";
import { SignedInAccount } from "./signed-in-account.tsx";
import { SomeoneElseStep } from "./someone-else-step.tsx";

/** The consent page for a request the platform accepted: one screen with the projects the client
 *  may reach, the permissions it asked for and Authorize (authorize-step.tsx). Two views stand in
 *  for it: a first project for someone with none, and, for a platform admin, "Sign in as someone
 *  else…", which a link naming someone opens on. Choices live here, so a refreshed description
 *  (after a project is created) and a trip to another view never drop one. */
export function ConsentCard({
  view,
  authorization,
  platformOrigin,
}: {
  view: Extract<ConsentView, { kind: "consent" }>;
  authorization: string;
  platformOrigin: string;
}) {
  const router = useRouter();
  const createProject = useServerFn(createProjectForConsent);
  const hydrated = useHydrated();
  const [pending, startTransition] = useTransition();
  // a link that named someone (`impersonation.suggested`) opens on signing in as them
  const [someoneElse, setSomeoneElse] = useState(Boolean(view.impersonation?.suggested));
  // consent starts on full access; a client bound to one project has only that project to grant
  const [selection, setSelection] = useState<ProjectSelection>({
    future: !view.projectBound,
    excluded: new Set(),
    listed: false,
  });
  const [declined, setDeclined] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState<ProjectDraft>({
    open: false,
    slug: "",
    followsName: true,
    orgId: view.orgs[0]?.id ?? "",
    organizationName: view.orgs.length ? "" : view.suggestedOrganizationName,
  });
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Controls do nothing until React owns them; disabled, a test (or a quick hand) waits for that.
  const disabled = !hydrated || pending;
  const orgNames = new Map(view.orgs.map((org) => [org.id, org.name]));
  const projects = view.projects.map((project) => ({
    id: project.id,
    slug: project.slug,
    orgName: orgNames.get(project.orgId) ?? project.orgId,
  }));
  const onboarding = !view.projectBound && !view.projects.length;
  const organizationName = draft.orgId ? (orgNames.get(draft.orgId) ?? "") : draft.organizationName;
  const slug = onboarding && draft.followsName ? projectSlug(organizationName) : draft.slug;
  const switchAccount = switchAccountHref(`/oauth2/auth${authorization}`);

  /** Change view and move focus to its heading, so the change is announced. */
  function showSomeoneElse(shown: boolean) {
    flushSync(() => {
      setSomeoneElse(shown);
      setError(null);
    });
    headingRef.current?.focus();
  }

  /** Create the drafted project (and its new organization, when one is named), then refresh the
   *  description. The first project goes straight on to the consent. */
  function submitDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // cleared first, so a refusal (even the same one again) is a new alert that takes focus
    const invalid = draftError(slug, draft);
    setError(invalid);
    if (invalid) return;
    const first = onboarding;
    startTransition(async () => {
      try {
        const result = await createProject({
          data: {
            authorization,
            slug,
            organization: draft.orgId ? { id: draft.orgId } : { name: draft.organizationName },
          },
        });
        // An ended session is redirected to sign-in: useServerFn has already navigated there and
        // resolves with nothing, so this page has nothing left to update.
        if (!result) return;
        // `sync`: "Creating project…" stays up until the description shows the new project, rather
        // than ending on the old one (docs/frontend-development.md#act-mutations).
        await router.invalidate({ sync: true });
        // An organization made for a refused project stays chosen for the retry.
        const orgId = result.orgId || draft.orgId;
        if (result.error) {
          setDraft((current) => ({ ...current, orgId }));
          setError(result.error);
          return;
        }
        // Rendered at once: after a first project the refreshed description has replaced the
        // first-project view with the consent, whose heading takes focus.
        flushSync(() =>
          setDraft({ open: false, slug: "", followsName: true, orgId, organizationName: "" }),
        );
        if (first) headingRef.current?.focus();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    });
  }

  const fields = {
    draft,
    slug,
    orgs: view.orgs,
    ingressRouting: view.ingressRouting,
    platformOrigin,
    disabled,
    onDraftChange: setDraft,
  };

  const outcome = {
    error,
    // Creating a project takes the platform a few seconds; say so while the controls wait.
    status: pending ? "Creating project…" : null,
    denyLocation: view.denyLocation,
  };

  return (
    <StandalonePage>
      <ClientHeading clientName={view.clientName} clientDomain={view.clientDomain} />
      <SignedInAccount
        email={view.email}
        switchAccount={switchAccount}
        onSignInAsSomeoneElse={
          view.impersonation && !someoneElse ? () => showSomeoneElse(true) : undefined
        }
      />
      {someoneElse && view.impersonation ? (
        <SomeoneElseStep
          headingRef={headingRef}
          outcome={outcome}
          clientName={view.clientName}
          clientId={view.clientId}
          impersonation={view.impersonation}
          onBack={() => showSomeoneElse(false)}
        />
      ) : onboarding ? (
        <OnboardingStep
          headingRef={headingRef}
          outcome={outcome}
          fields={fields}
          onCreateProject={submitDraft}
        />
      ) : (
        <AuthorizeStep
          headingRef={headingRef}
          outcome={outcome}
          projects={projects}
          projectBound={view.projectBound}
          selection={selection}
          scopes={view.scopes}
          declined={declined}
          fields={fields}
          onSelectionChange={setSelection}
          onDeclinedChange={setDeclined}
          onCreateProject={submitDraft}
        />
      )}
    </StandalonePage>
  );
}

/** Why the drafted project cannot be created yet, or null when it can. */
function draftError(slug: string, draft: ProjectDraft) {
  if (!slug.trim()) return "Enter a project name.";
  if (!draft.orgId && !draft.organizationName.trim()) return "Enter an organization name.";
  return null;
}
