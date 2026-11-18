import { codedError } from "iterate/lib";
import { Hostname, isControlPlaneHostname, type MindConfig, zoneOf } from "iterate/mind-config";

export const URL_ROOT_DESCRIPTION =
  "a public URL of this mind's own code over HTTP, `https://<hostname><path>`: `url({ hostname?, path? })`, `hostname` a hostname of the mind's zones (the first zone when absent) and never its control-plane hostname: where that hostname is the first zone itself, name a `hostname`";

/** `itx.url`: how the mind's code learns its zones and spells a link to a page of its own. A
 *  hostname outside the mind's zones is refused, and so is the control-plane hostname, which the
 *  boundary answers and the mind's code does not. */
export function urlRoot(config: Pick<MindConfig, "controlPlaneHostname" | "zones">) {
  return async (target: { hostname?: string; path?: string } = {}) => {
    const { path = "/" } = target;
    // With no hostname the answer is the apex of the first zone. Where the control plane is at
    // that apex, the mind's own code answers no page there, so its caller names the hostname.
    if (!target.hostname && isControlPlaneHostname(config, config.zones[0]!))
      throw codedError(
        "INVALID_INPUT",
        `itx.url: name a hostname, as in url({ hostname: "app.${config.zones[0]}" }). With none, the URL is at the apex of the first zone, and ${config.controlPlaneHostname} is the mind's control plane, where the mind's own code answers nothing`,
      );
    // A DNS name, lowercased, before anything is asked of it: a text with a slash or an `@` in it
    // would pass a check of its last letters and name another origin once it is in a URL.
    const hostname = Hostname.safeParse(target.hostname || config.zones[0]).data;
    if (!hostname || !zoneOf(config, hostname) || isControlPlaneHostname(config, hostname))
      throw codedError(
        "INVALID_INPUT",
        `itx.url: ${JSON.stringify(target.hostname)} is not a hostname of this mind's own code (its zones are ${config.zones.join(", ")}; ${config.controlPlaneHostname} is the platform's)`,
      );
    // one leading slash: `//host` would read as an authority
    if (!/^\/(?!\/)/.test(path))
      throw codedError(
        "INVALID_INPUT",
        `itx.url: the path ${JSON.stringify(path)} does not start with a single "/"`,
      );
    const url = new URL(path, `https://${hostname}`);
    // what leaves here is on the hostname that was asked for, whatever the path held
    if (url.origin !== `https://${hostname}`)
      throw codedError(
        "INVALID_INPUT",
        `itx.url: the path ${JSON.stringify(path)} leaves ${hostname}`,
      );
    return url.href;
  };
}
