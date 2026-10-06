import { linkClass, StandalonePage } from "../standalone-page.tsx";

/** A request the authorization server refused outright, with no client to send the person back
 *  to: the reason, and the way back to iterate. */
export function InvalidRequest({ description }: { description: string }) {
  return (
    <StandalonePage>
      <h1>Invalid authorization request</h1>
      <div>
        <p>The app’s request could not be accepted: {description}.</p>
        <p className="text-muted-foreground">
          Nothing was granted. Go back to the app and try again.
        </p>
      </div>
      <p>
        <a href="/" className={linkClass}>
          Back to iterate
        </a>
      </p>
    </StandalonePage>
  );
}
