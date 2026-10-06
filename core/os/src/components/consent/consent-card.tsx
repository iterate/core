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
 *  may reach, the permissions it asked for and Authorize (authorize-step.tsx). For someone with no
 *  project the same screen makes one as it authorizes (onboarding-step.tsx). For a platform admin,
 *  "Sign in as someone else…" stands in for it, and a link naming someone opens on that. Choices
 *  live here, so a refreshed description (after a project is created) and a trip to another view
 *  never drop one. */
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
  // a first project, made a moment ago: the grant about to be posted names it
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
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

  /** The drafted project (and its new organization, when one is named), created. A refusal is
   *  shown, with the organization made for it kept for the retry and the slug's own box opened;
   *  null is a session that has ended: `useServerFn` has already navigated to sign-in and
   *  resolves with nothing, so the page has nothing left to do. */
  async function createDraft() {
    const result = await createProject({
      data: {
        authorization,
        slug,
        organization: draft.orgId ? { id: draft.orgId } : { name: draft.organizationName },
      },
    });
    if (!result) return null;
    if (!("error" in result)) return result;
    // `sync`: "Creating project…" stays up until the description shows the organization made,
    // rather than ending on the old one (docs/frontend-development.md#act-mutations).
    await router.invalidate({ sync: true });
    setDraft((current) => ({ ...current, open: true, orgId: result.orgId || current.orgId }));
    setError(result.error);
    return null;
  }

  /** The New project form: create the project, then list it. */
  function submitDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // cleared first, so a refusal (even the same one again) is a new alert that takes focus
    const invalid = draftError(slug, organizationName);
    setError(invalid);
    if (invalid) return;
    startTransition(async () => {
      try {
        const created = await createDraft();
        if (!created) return;
        await router.invalidate({ sync: true });
        setDraft({
          open: false,
          slug: "",
          followsName: true,
          orgId: created.orgId,
          organizationName: "",
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    });
  }

  /** A first consent's one button: create the project, then post the form, which grants it. The
   *  post is the form's own (a plain POST to this very authorization URL), sent only once the
   *  project exists. */
  function createAndAuthorize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const invalid = draftError(slug, organizationName);
    setError(invalid);
    // a name that makes no slug is fixed in the slug's own box
    if (invalid) return setDraft((current) => ({ ...current, open: true }));
    startTransition(async () => {
      try {
        const created = await createDraft();
        if (!created) return;
        // rendered at once: the form holds the new project's id before it is posted
        flushSync(() => setCreatedProjectId(created.projectId));
        form.submit();
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
          organizationName={organizationName}
          selection={selection}
          scopes={view.scopes}
          declined={declined}
          createdProjectId={createdProjectId}
          onSelectionChange={setSelection}
          onDeclinedChange={setDeclined}
          onCreateAndAuthorize={createAndAuthorize}
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
function draftError(slug: string, organizationName: string) {
  if (!organizationName.trim()) return "Enter an organization name.";
  if (!slug.trim()) return "Enter a project name.";
  return null;
}
