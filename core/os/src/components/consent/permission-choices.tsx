import { useId } from "react";
import type { ConsentScope } from "iterate/oauth-scopes";
import { Checkbox } from "../ui/checkbox.tsx";
import { Label } from "../ui/label.tsx";

/** The permissions the request asked for; a required one stays ticked. */
export function PermissionChoices({
  scopes,
  declined,
  disabled,
  onDeclinedChange,
}: {
  scopes: ConsentScope[];
  declined: ReadonlySet<string>;
  disabled: boolean;
  onDeclinedChange: (declined: ReadonlySet<string>) => void;
}) {
  // Named by the title and described by the note: the label around the checkbox would name it
  // with both (Base UI).
  const id = useId();
  function tick(name: string, checked: boolean) {
    const next = new Set(declined);
    if (checked) next.delete(name);
    else next.add(name);
    onDeclinedChange(next);
  }
  return (
    <fieldset aria-label="Permissions it is granted" className="flex flex-col gap-2">
      {scopes.map((scope) => (
        <Label key={scope.name} className="items-start gap-3 leading-normal">
          <Checkbox
            className="mt-1 rounded-none border-foreground/30 data-disabled:opacity-50"
            aria-labelledby={`${id}-${scope.name}-title`}
            aria-describedby={`${id}-${scope.name}-note`}
            checked={scope.required || !declined.has(scope.name)}
            disabled={disabled || scope.required}
            onCheckedChange={(checked) => tick(scope.name, checked)}
          />
          <span className="flex flex-col">
            <span id={`${id}-${scope.name}-title`}>{scope.title}</span>
            <span id={`${id}-${scope.name}-note`} className="text-xs text-muted-foreground">
              {scope.note}
            </span>
          </span>
        </Label>
      ))}
    </fieldset>
  );
}
