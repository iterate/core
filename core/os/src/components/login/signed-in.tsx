import { cn } from "cn";
import { Button, buttonVariants } from "../ui/button.tsx";
import { linkClass } from "../standalone-page.tsx";

/** A browser already signed in: who, where to go on, and the way to become someone else. */
export function SignedIn({
  email,
  next,
  dash,
  switchAccount,
}: {
  email: string;
  next: string;
  dash: string | null;
  switchAccount: string;
}) {
  const onward =
    next === "/login"
      ? dash && { href: dash, label: "Go to the dash" }
      : { href: next, label: "Continue" };
  return (
    <div className="flex flex-col gap-4">
      <p>
        Signed in as <strong className="wrap-anywhere">{email}</strong>.
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {onward ? (
          <a className={cn(buttonVariants({ size: "lg" }), "h-11 px-4")} href={onward.href}>
            {onward.label}
          </a>
        ) : null}
        <form method="post" action={switchAccount}>
          <Button type="submit" variant="link" className={linkClass}>
            Switch account
          </Button>
        </form>
      </div>
    </div>
  );
}
