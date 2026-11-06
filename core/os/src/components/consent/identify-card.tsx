import { useHydrated } from "@tanstack/react-router";
import { cn } from "cn";
import { Button } from "../ui/button.tsx";
import { disabledButtonClass, linkClass, StandalonePage } from "../standalone-page.tsx";
import type { ConsentView } from "../../consent.ts";
import { switchAccountHref } from "../../login-search.ts";

/** A client asking only who the person is (the `/oauth2/userinfo` resource): it learns their email
 *  and reaches nothing. Continue is a plain POST to this very authorization URL (consent.ts
 *  `approve`). Switch account signs out and comes back to this request through sign-in, as the
 *  consent card's does (signed-in-account.tsx): the same form, posted elsewhere. */
export function IdentifyCard({
  view,
  authorization,
}: {
  view: Extract<ConsentView, { kind: "identify" }>;
  /** the request's raw query, `?…` (routes/oauth2.auth.tsx) */
  authorization: string;
}) {
  const hydrated = useHydrated();
  return (
    <StandalonePage>
      <h1 className="wrap-anywhere">Confirm it's you to {view.clientDomain || view.clientName}</h1>
      <div>
        <p>
          {view.clientName} learns that you are{" "}
          <strong className="wrap-anywhere">{view.email}</strong>.
        </p>
        <p className="text-muted-foreground">
          Nothing else: it gets no access to your projects or your account.
        </p>
      </div>
      <form method="post" className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button
          type="submit"
          size="lg"
          className={cn(
            "h-auto min-h-11 max-w-full shrink px-4 py-2 text-left whitespace-normal",
            disabledButtonClass,
          )}
          disabled={!hydrated}
        >
          Continue as {view.email}
        </Button>
        <Button
          type="submit"
          variant="link"
          className={linkClass}
          formAction={switchAccountHref(`/oauth2/auth${authorization}`)}
        >
          Switch account
        </Button>
        <a href={view.denyLocation} className={linkClass}>
          Cancel
        </a>
      </form>
    </StandalonePage>
  );
}
