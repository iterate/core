import { Fragment } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { environmentFaviconHref, type DeploymentEnvironment } from "iterate/lib";
import { FieldSeparator } from "../components/ui/field.tsx";
import { IterateLogo } from "../components/iterate-logo.tsx";
import { ErrorMessage, StandaloneCard, StandalonePage } from "../components/standalone-page.tsx";
import { CodeSignInForm } from "../components/login/code-sign-in-form.tsx";
import { EmailSignInForm } from "../components/login/email-sign-in-form.tsx";
import { RecommendedSignIn, SignInProviders } from "../components/login/sign-in-providers.tsx";
import { SignedIn } from "../components/login/signed-in.tsx";
import { getLoginState } from "../issuer.functions.ts";
import { issuerRequestContext } from "../issuer-request-context.server.ts";
import { loginSearchOf } from "../login-search.ts";
import { loginFormResponse } from "../login.server.ts";

export const Route = createFileRoute("/login")({
  validateSearch: loginSearchOf,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const state = await getLoginState({ data: deps });
    // Cloudflare Access is the only way in: straight there, unless a sign-in just came back refused
    if (state.straightTo) throw redirect({ href: state.straightTo });
    return state;
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: `Sign in to ${loaderData ? deploymentNameOf(loaderData.environment) : "iterate"}` },
    ],
  }),
  server: {
    handlers: {
      POST: ({ request }) => loginFormResponse(request, issuerRequestContext().env),
    },
  },
  component: LoginPage,
});

function LoginPage() {
  const state = Route.useLoaderData();
  const title = state.signedInAs
    ? "You’re signed in"
    : state.codeSentTo
      ? "Check your inbox"
      : `Sign in to ${deploymentNameOf(state.environment)}`;
  return (
    <StandalonePage className="max-w-100">
      <StandaloneCard>
        <header className="flex items-center gap-3">
          <DeploymentIcon environment={state.environment} />
          <div className="flex min-w-0 flex-col">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {state.environment.kind === "preview" ? (
              <p className="font-mono text-xs text-muted-foreground">
                {state.environment.deployment}
              </p>
            ) : null}
          </div>
        </header>
        {state.error ? <ErrorMessage>{state.error}</ErrorMessage> : null}
        {state.signedInAs ? (
          <SignedIn
            email={state.signedInAs}
            next={state.next}
            dash={state.dash}
            switchAccount={state.switchAccount}
          />
        ) : (
          <SignInOptions state={state} />
        )}
      </StandaloneCard>
    </StandalonePage>
  );
}

/** What the page calls this deployment: production is iterate; a preview and local dev say which,
 *  since someone signing in to a preview does it with their os.iterate.com account, and the page
 *  should not read as that. */
function deploymentNameOf(environment: DeploymentEnvironment) {
  if (environment.kind === "preview") return `PR ${environment.pr}’s preview`;
  if (environment.kind === "dev") return "local dev";
  return "iterate";
}

/** The deployment's mark: production's logo, else the same purple PR-number or teal dev square the
 *  tab shows (`/favicon.svg`, issuer-pages.ts). */
function DeploymentIcon({ environment }: { environment: DeploymentEnvironment }) {
  if (environment.kind === "production") return <IterateLogo alt="" className="size-8" />;
  return (
    <img
      src={environmentFaviconHref(environment, "/iterate-logo.svg")}
      alt=""
      width={32}
      height={32}
      className="size-8 shrink-0 rounded-lg"
    />
  );
}

/** Every sign-in this deployment offers, as the config lists them (sign-in-methods.ts): the email
 *  form (or, once a code is sent, its entry) and the links, in order — or, when the link suggested
 *  one of them (`provider_hint`), that one alone and the way back to the rest. */
function SignInOptions({ state }: { state: Awaited<ReturnType<typeof getLoginState>> }) {
  const links = state.methods.flatMap((method) => (method.kind === "link" ? [method] : []));
  const recommended = state.codeSentTo
    ? undefined
    : links.find((provider) => provider.key === state.providerHint);
  if (recommended) return <RecommendedSignIn provider={recommended} everyWay={state.everyWay} />;
  if (!state.methods.length)
    return <p className="text-sm">Sign-in is not configured for this deployment.</p>;
  // consecutive links share one list; a separator between the form and the links
  const groups: Array<(typeof state.methods)[number] | typeof links> = [];
  for (const method of state.methods) {
    const last = groups.at(-1);
    if (method.kind === "link" && Array.isArray(last)) last.push(method);
    else groups.push(method.kind === "link" ? [method] : method);
  }
  return (
    <>
      {groups.map((group, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <FieldSeparator className="text-xs *:data-[slot=field-separator-content]:bg-card">
              or continue with
            </FieldSeparator>
          ) : null}
          {Array.isArray(group) ? (
            <SignInProviders providers={group} />
          ) : group.kind === "email" && state.codeSentTo ? (
            <CodeSignInForm next={state.next} codeSentTo={state.codeSentTo} />
          ) : group.kind === "email" ? (
            <EmailSignInForm
              next={state.next}
              email={state.email}
              passwordEnabled={group.password}
              codeEnabled={group.code}
              passwordSelected={state.passwordSelected}
            />
          ) : null}
        </Fragment>
      ))}
    </>
  );
}
