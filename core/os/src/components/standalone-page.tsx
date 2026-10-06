import type { ReactNode } from "react";
import { cn } from "cn";

/** The frame of the issuer's pages (`/`, sign-in, consent), so they read as one family and as
 *  www.iterate.com does: one centred column, its content left-aligned. The space above and below
 *  is padding: a margin would collapse through `body` and push its `min-h-svh` down the page, so a
 *  page shorter than the window would scroll. */
export function StandalonePage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <main className={cn("mx-auto flex max-w-210 flex-col gap-6 px-5 pt-14 pb-26", className)}>
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
