// iterate-apps.ts — A DEPLOYMENT'S OWN APPS, as another deployment reads them. The issuer serves
// `/.well-known/iterate-apps.json`: the client ids of its first-party apps (its Dash, `urls.dash`,
// and `urls.apps`), each `<origin>/.auth/client.json`, the client document iterate/app-server
// serves. A deployment that signs people in through it (iterate-sign-in.ts) approves those clients
// for such a person without its consent page (consent.ts `#approveIssuersOwnApp`): the issuer's
// word on which apps are its own, as it is on who the person is.
import { z } from "zod";
import type { IterateConfig } from "./iterate-config.ts";

export const ITERATE_APPS_PATH = "/.well-known/iterate-apps.json";

const IterateApps = z.object({ clients: z.array(z.string()) });

/** The document this deployment serves: its own apps' client ids. */
export function iterateAppsOf(config: Pick<IterateConfig, "urls">): z.infer<typeof IterateApps> {
  const origins = [config.urls.dash, ...config.urls.apps].filter(Boolean);
  return { clients: [...new Set(origins)].map((origin) => `${origin}/.auth/client.json`) };
}

/** How long an isolate keeps an issuer's list: a change at the issuer is seen within it. */
const KEPT_MS = 5 * 60_000;
const kept = new Map<string, { clients: string[]; until: number }>();

/** `issuer`'s own apps' client ids, read from its document and kept `KEPT_MS`. An issuer that does
 *  not answer has none for now: its apps get the consent page, and the next read asks again. */
export async function issuersOwnApps(issuer: string): Promise<string[]> {
  const known = kept.get(issuer);
  if (known && known.until > Date.now()) return known.clients;
  try {
    const response = await fetch(`${issuer}${ITERATE_APPS_PATH}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`${issuer}${ITERATE_APPS_PATH} answered ${response.status}`);
    const { clients } = IterateApps.parse(await response.json());
    kept.set(issuer, { clients, until: Date.now() + KEPT_MS });
    return clients;
  } catch (error) {
    console.warn({ event: "iterate-apps.unread", issuer, message: String(error) });
    return [];
  }
}
