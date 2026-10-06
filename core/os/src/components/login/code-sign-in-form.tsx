import { useId } from "react";
import { Button } from "../ui/button.tsx";
import { Field, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { focusOnMount } from "../focus-on-mount.ts";
import { linkClass } from "../standalone-page.tsx";

/** The mailed code, and the way back to another email. */
export function CodeSignInForm({ next, codeSentTo }: { next: string; codeSentTo: string }) {
  const codeId = useId();
  return (
    <div className="flex max-w-md flex-col gap-4">
      <p>
        We sent a code to <strong className="wrap-anywhere">{codeSentTo}</strong>.
      </p>
      <form method="post" action="/login" className="flex flex-col gap-4">
        <input type="hidden" name="next" value={next} />
        <Field>
          <FieldLabel htmlFor={codeId}>Code</FieldLabel>
          <Input
            id={codeId}
            type="text"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            spellCheck={false}
            pattern="[0-9]{6}"
            maxLength={6}
            required
            ref={focusOnMount}
            className="h-11 max-w-48 bg-muted px-3 tracking-[0.3em]"
          />
        </Field>
        <Button type="submit" size="lg" className="h-11 self-start px-4">
          Continue
        </Button>
      </form>
      <form method="post" action="/login">
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="restart" value="1" />
        <Button type="submit" variant="link" className={linkClass}>
          Use a different email
        </Button>
      </form>
    </div>
  );
}
