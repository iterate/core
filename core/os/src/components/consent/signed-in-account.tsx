import { useHydrated } from "@tanstack/react-router";
import { Button } from "../ui/button.tsx";
import { linkClass } from "../standalone-page.tsx";

/** Who is approving, and Switch account, which signs out and comes back to this request through
 *  sign-in. A platform admin also gets "Sign in as someone else…" (`onSignInAsSomeoneElse`,
 *  consent-card.tsx). */
export function SignedInAccount({
  email,
  switchAccount,
  onSignInAsSomeoneElse,
}: {
  email: string;
  switchAccount: string;
  onSignInAsSomeoneElse?: () => void;
}) {
  // the link does nothing until React owns it; disabled, a test (or a quick hand) waits for that
  const hydrated = useHydrated();
  return (
    <section aria-label="Signed-in account" className="flex flex-wrap items-baseline gap-x-4">
      <p>
        Signed in as <strong className="wrap-anywhere">{email}</strong>.
      </p>
      <form method="post" action={switchAccount}>
        <Button type="submit" variant="link" className={linkClass}>
          Switch account
        </Button>
      </form>
      {onSignInAsSomeoneElse ? (
        <Button
          type="button"
          variant="link"
          className={linkClass}
          disabled={!hydrated}
          onClick={onSignInAsSomeoneElse}
        >
          Sign in as someone else…
        </Button>
      ) : null}
    </section>
  );
}
