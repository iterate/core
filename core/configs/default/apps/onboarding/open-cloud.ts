// open-cloud.ts — "OPEN ITERATE CLOUD": the route `GET /open-cloud` of the onboarding app, for
// members (worker.ts guards the host). It answers a 303 to this mind's own `/sign-in/open`, which
// sends the member on to iterate Cloud's page for this mind (`/mind?mind=<hostname>`), and the
// Cloud signs them in through this mind. It calls nothing at iterate.com: the mind's sign-in
// vouches for the member (core/auth-worker/src/vouch.ts `opened`).
import { ITERATE_CLOUD } from "../../cloud-deliveries.ts";

/** `mind`: this mind's control-plane hostname (`itx.whoami().mindSlug`), where its sign-in is. */
export function openCloud(mind: string | undefined): Response {
  if (!mind)
    return new Response("This mind did not say its own hostname. Try again.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  const to = `${ITERATE_CLOUD}/mind?mind=${encodeURIComponent(mind)}`;
  return new Response(null, {
    status: 303,
    headers: {
      location: `https://${mind}/sign-in/open?to=${encodeURIComponent(to)}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
