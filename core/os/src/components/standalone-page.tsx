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
 *  classes, for an action that reads as a link. A disabled one is grey, with the cursor
 *  `disabledButtonClass` gives. */
export const linkClass =
  "h-auto p-0 text-link underline underline-offset-2 disabled:pointer-events-auto disabled:cursor-not-allowed disabled:text-muted-foreground";

/** A disabled button that looks it, over a filled variant's (`default`, `outline`) own classes: the
 *  muted fill and text of tokens.css under the vendored Button's `disabled:opacity-50`, and a
 *  not-allowed cursor. The cursor needs the pointer events the Button's `disabled:pointer-events-none`
 *  turns off; a disabled <button> fires no click either way. */
export const disabledButtonClass =
  "disabled:pointer-events-auto disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";

/** A refusal or failure shown where the person acted. */
export function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <p role="alert" data-type="error" className="text-destructive">
      {children}
    </p>
  );
}
