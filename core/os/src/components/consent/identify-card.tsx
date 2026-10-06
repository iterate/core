import { useHydrated } from "@tanstack/react-router";
import { Button } from "../ui/button.tsx";
import { linkClass, StandalonePage } from "../standalone-page.tsx";
import type { ConsentView } from "../../consent.ts";

/** A client asking only who the person is (the `/oauth2/userinfo` resource): it learns their email
 *  and reaches nothing. Continue is a plain POST to this very authorization URL (consent.ts
 *  `approve`). */
export function IdentifyCard({ view }: { view: Extract<ConsentView, { kind: "identify" }> }) {
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
          className="h-auto min-h-11 max-w-full shrink px-4 py-2 text-left whitespace-normal"
          disabled={!hydrated}
        >
          Continue as {view.email}
        </Button>
        <a href={view.denyLocation} className={linkClass}>
          Cancel
        </a>
      </form>
    </StandalonePage>
  );
}
