import { createFileRoute, Link } from "@tanstack/react-router";
import { cn } from "cn";
import { buttonVariants } from "../components/ui/button.tsx";
import { linkClass, StandalonePage } from "../components/standalone-page.tsx";
import { getLandingState } from "../issuer.functions.ts";
import { loginSearchOf } from "../login-search.ts";

export const Route = createFileRoute("/")({
  loader: () => getLandingState(),
  head: () => ({ meta: [{ title: "iterate platform" }] }),
  component: LandingPage,
});

function LandingPage() {
  const { issuer, dash } = Route.useLoaderData();
  return (
    <StandalonePage>
      <h1>iterate platform</h1>
      <p>
        <strong>{new URL(issuer).host}</strong> is deliberately headless: the API (<code>/api</code>
        ), the OAuth issuer and the MCP server. Its only pages are{" "}
        <Link to="/login" search={loginSearchOf({})} className={linkClass}>
          sign-in
        </Link>{" "}
        and consent.
      </p>
      {dash ? (
        <div className="flex flex-col items-start gap-3">
          <p>Your projects, organizations and sessions are in the dash.</p>
          <a
            className={cn(buttonVariants({ size: "lg" }), "h-11 px-4")}
            href={`${dash}/.auth/connect?${new URLSearchParams({ issuer })}`}
          >
            {new URL(dash).host}
          </a>
        </div>
      ) : null}
      <p className="text-muted-foreground">
        Setting this up with an agent? Point it at{" "}
        <a href="/setup-prompt.md" className={linkClass}>
          /setup-prompt.md
        </a>
        .
      </p>
    </StandalonePage>
  );
}
