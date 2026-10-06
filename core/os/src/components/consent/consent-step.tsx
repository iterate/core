import type { ReactNode, Ref } from "react";
import { focusOnMount } from "../focus-on-mount.ts";
import { linkClass } from "../standalone-page.tsx";

/** What every view of the consent page ends with, beside its own action: what went wrong (if
 *  anything), what the platform is busy with (if anything), and where Cancel goes — the client's
 *  own refusal URL, so the app learns the person declined. */
export interface ConsentOutcome {
  error: string | null;
  status: string | null;
  denyLocation: string;
}

/** A view's heading. It takes focus when the person moves between views, so the change is read. */
export function StepHeading({
  ref,
  children,
}: {
  ref: Ref<HTMLHeadingElement>;
  children: ReactNode;
}) {
  return (
    <h2 ref={ref} tabIndex={-1} className="outline-none">
      {children}
    </h2>
  );
}

/** The foot of a view: its error and status, then its action (`children`) beside Cancel. */
export function ConsentActions({
  error,
  status,
  denyLocation,
  children,
}: ConsentOutcome & { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p
          role="alert"
          data-type="error"
          tabIndex={-1}
          ref={focusOnMount}
          className="text-destructive outline-none"
        >
          {error}
        </p>
      ) : null}
      {status ? (
        <p role="status" className="text-muted-foreground">
          {status}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {children}
        <a href={denyLocation} className={linkClass}>
          Cancel
        </a>
      </div>
    </div>
  );
}
