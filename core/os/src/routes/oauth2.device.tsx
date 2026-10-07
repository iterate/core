import { createFileRoute } from "@tanstack/react-router";
import { DeviceLoginPage } from "../device-login/page.tsx";
import { DevicePageSearch } from "../device-login/protocol.ts";
import { devicePageFormResponse } from "../device-login/page.server.ts";
import { getDeviceLoginPage } from "../issuer.functions.ts";
import { issuerRequestContext } from "../issuer-request-context.server.ts";

// The device login's page (device-login/). As on the consent page, the description may redirect to
// sign-in, so it runs in `beforeLoad` (routes/oauth2.auth.tsx says why).
export const Route = createFileRoute("/oauth2/device")({
  validateSearch: DevicePageSearch,
  beforeLoad: async ({ search }) => ({ device: await getDeviceLoginPage({ data: search }) }),
  loader: ({ context }) => context.device,
  head: () => ({ meta: [{ title: "Sign in a device — iterate" }] }),
  server: {
    handlers: {
      POST: ({ request }) => devicePageFormResponse(request, issuerRequestContext().env),
    },
  },
  component: function DevicePage() {
    return <DeviceLoginPage view={Route.useLoaderData()} />;
  },
});
