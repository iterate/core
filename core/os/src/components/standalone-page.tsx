import type { ReactNode } from "react";
import { cn } from "cn";

/** The frame of the issuer's pages (`/`, sign-in, consent), so they read as one family and as
 *  www.iterate.com does: one centred column, its content left-aligned. */
export function StandalonePage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <main className={cn("mx-auto my-14 flex max-w-210 flex-col gap-6 px-5 pb-12", className)}>
      {children}
    </main>
  );
}

/** A text link in the homepage's blue: on an anchor, or over a `variant="link"` button's own
 *  classes, for an action that reads as a link. */
export const linkClass = "h-auto p-0 text-link underline underline-offset-2";

/** A refusal or failure shown where the person acted. */
export function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <p role="alert" data-type="error" className="text-destructive">
      {children}
    </p>
  );
}
