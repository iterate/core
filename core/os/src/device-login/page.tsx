import { useId } from "react";
import { Button } from "../components/ui/button.tsx";
import { Field, FieldLabel } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import { focusOnMount } from "../components/focus-on-mount.ts";
import { ErrorMessage, linkClass, StandalonePage } from "../components/standalone-page.tsx";
import type { DevicePageView } from "./page.server.ts";

/** The device login's page (page.server.ts): the code form, the device to check before the consent
 *  page, or how the person answered. Every action is a plain form, so the page works before it
 *  hydrates. */
export function DeviceLoginPage({ view }: { view: DevicePageView }) {
  if (view.kind === "outcome") return <Outcome outcome={view.outcome} />;
  if (view.kind === "enter") return <EnterCode typed={view.typed} error={view.error} />;
  const place = [view.requestedFrom.city, view.requestedFrom.country].filter(Boolean).join(", ");
  return (
    <StandalonePage>
      <h1>Sign in a device?</h1>
      <p role="alert" className="font-medium">
        Only continue if you started this on your own computer or agent. If someone sent you this
        code or link, they are trying to get into your account: decline it.
      </p>
      <div>
        <p className="font-mono text-3xl tracking-widest">{view.userCode}</p>
        <p className="text-muted-foreground">Check that your device shows this code.</p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Account</dt>
        <dd className="wrap-anywhere">{view.email}</dd>
        <dt className="text-muted-foreground">Device</dt>
        <dd className="wrap-anywhere">
          {view.clientName} <span className="text-muted-foreground">(the name it gave itself)</span>
        </dd>
        <dt className="text-muted-foreground">Asked from</dt>
        <dd>{place || "an unknown place"}</dd>
        <dt className="text-muted-foreground">Asked</dt>
        <dd>{agoOf(view.askedSecondsAgo)}</dd>
      </dl>
      <p>Next you choose which projects the device can read and change.</p>
      <form method="post" className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <input type="hidden" name="user_code" value={view.userCode} />
        <Button type="submit" name="action" value="confirm" size="lg" className="h-11 px-4">
          Continue
        </Button>
        <Button type="submit" name="action" value="decline" variant="link" className={linkClass}>
          Decline
        </Button>
      </form>
    </StandalonePage>
  );
}

function EnterCode({ typed, error }: { typed?: string; error?: string }) {
  const id = useId();
  return (
    <StandalonePage>
      <header>
        <h1>Sign in a device</h1>
        <p className="text-muted-foreground">Enter the code your device shows.</p>
      </header>
      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
      <form method="get" className="flex max-w-md flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={id}>Code</FieldLabel>
          <Input
            id={id}
            name="user_code"
            defaultValue={typed}
            placeholder="WDJB-MJHT"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            ref={focusOnMount}
            className="h-11 bg-muted px-3 font-mono tracking-widest uppercase"
          />
        </Field>
        <Button type="submit" size="lg" className="h-11 self-start px-4">
          Continue
        </Button>
      </form>
    </StandalonePage>
  );
}

const OUTCOMES = {
  approved: {
    title: "Device signed in",
    body: "Go back to your device. It finishes signing in within a few seconds.",
  },
  declined: { title: "Sign-in declined", body: "Nothing was granted. The device gets no access." },
  failed: {
    title: "This sign-in did not finish",
    body: "Nothing was granted. Start the sign-in on your device again.",
  },
};

function Outcome({ outcome }: { outcome: keyof typeof OUTCOMES }) {
  return (
    <StandalonePage>
      <h1>{OUTCOMES[outcome].title}</h1>
      <p>{OUTCOMES[outcome].body}</p>
    </StandalonePage>
  );
}

function agoOf(seconds: number) {
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
}
