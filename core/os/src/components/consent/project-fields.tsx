import { useId } from "react";
import { cn } from "cn";
import type { IngressRouting } from "iterate/project-ingress";
import { Button } from "../ui/button.tsx";
import { Field, FieldDescription, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "../ui/native-select.tsx";
import type { OrganizationRecord } from "../../control-plane/catalog.ts";
import { focusOnMount } from "../focus-on-mount.ts";
import { linkClass } from "../standalone-page.tsx";
import { typedSlug } from "./project-slug.ts";

/** A project about to be created on the consent page: its slug as typed (or, on the first
 *  project, following the organization's name until edited) and its organization — one of the
 *  person's (`orgId`), or a new one named here (`orgId` empty). */
export interface ProjectDraft {
  /** the slug has a box of its own: the New project form is open, or a first project's "Change
   *  project name" was asked for (or its name was refused) */
  open: boolean;
  slug: string;
  followsName: boolean;
  orgId: string;
  organizationName: string;
}

/** The organization (a select of the person's, or a new one's name) and the project's slug, with
 *  where this deployment will serve it. Until the draft is `open` the slug has no box: the line
 *  says where the project will live, and "Change project name" opens the box. */
export function ProjectFields({
  draft,
  slug,
  orgs,
  ingressRouting,
  platformOrigin,
  disabled,
  onDraftChange,
}: {
  draft: ProjectDraft;
  slug: string;
  orgs: OrganizationRecord[];
  ingressRouting: IngressRouting;
  platformOrigin: string;
  disabled: boolean;
  onDraftChange: (draft: ProjectDraft) => void;
}) {
  const organizationId = useId();
  const organizationNameId = useId();
  const slugId = useId();
  const shownSlug = slug || "my-project";
  const hostedAt = !ingressRouting
    ? null
    : ingressRouting.type === "subdomains"
      ? `${shownSlug}.${ingressRouting.hostname}`
      : `${platformOrigin}/projects/${shownSlug}/`;
  return (
    <div className="flex flex-col gap-4">
      {orgs.length ? (
        <Field>
          <FieldLabel htmlFor={organizationId}>Organization</FieldLabel>
          <NativeSelect
            id={organizationId}
            className="w-full *:data-[slot=native-select]:h-11 *:data-[slot=native-select]:bg-muted *:data-[slot=native-select]:pl-3"
            value={draft.orgId}
            disabled={disabled}
            onChange={(event) => onDraftChange({ ...draft, orgId: event.target.value })}
          >
            {orgs.map((org) => (
              <NativeSelectOption key={org.id} value={org.id}>
                {org.name}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value="">New organization…</NativeSelectOption>
          </NativeSelect>
        </Field>
      ) : null}
      {draft.orgId ? null : (
        <Field>
          <FieldLabel htmlFor={organizationNameId}>Organization name</FieldLabel>
          <Input
            id={organizationNameId}
            value={draft.organizationName}
            placeholder="Acme"
            autoComplete="organization"
            required
            disabled={disabled}
            className="h-11 bg-muted px-3"
            onChange={(event) => onDraftChange({ ...draft, organizationName: event.target.value })}
          />
        </Field>
      )}
      {draft.open ? (
        <Field>
          <FieldLabel htmlFor={slugId}>Project slug</FieldLabel>
          <Input
            id={slugId}
            value={slug}
            placeholder="my-project"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
            // the box has just been asked for
            ref={focusOnMount}
            disabled={disabled}
            className="h-11 bg-muted px-3"
            onChange={(event) =>
              onDraftChange({ ...draft, slug: typedSlug(event.target.value), followsName: false })
            }
          />
          {hostedAt ? (
            <FieldDescription className="text-xs wrap-anywhere">
              Your project will be hosted at {hostedAt}
            </FieldDescription>
          ) : null}
        </Field>
      ) : (
        <p className="text-xs wrap-anywhere text-muted-foreground">
          {hostedAt
            ? `Your project will be hosted at ${hostedAt}.`
            : `Your project will be called ${shownSlug}.`}{" "}
          <Button
            type="button"
            variant="link"
            className={cn(linkClass, "text-xs")}
            disabled={disabled}
            onClick={() => onDraftChange({ ...draft, open: true })}
          >
            Change project name
          </Button>
        </p>
      )}
    </div>
  );
}
