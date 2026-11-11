import { codedError } from "iterate/lib";
import { PLATFORM_HOSTNAME_LABEL } from "iterate/mind-api";
import { ROUTING_SLUG } from "iterate/mind-ingress";

export const URL_ROOT_DESCRIPTION =
  "this mind's public URL over HTTP — the apex or a routing key's host, at a path: `url({ routingSlug?, path? })`";

export function urlRoot(domain: string) {
  return async (target: { routingSlug?: string; path?: string } = {}) => {
    const { routingSlug, path = "/" } = target;
    if (
      (routingSlug &&
        (!ROUTING_SLUG.test(routingSlug) || routingSlug === PLATFORM_HOSTNAME_LABEL)) ||
      !/^\/(?!\/)/.test(path)
    )
      throw codedError(
        "INVALID_INPUT",
        `itx.url: ${JSON.stringify(target)} is not an address in this mind (a routing key is [a-z][a-z0-9-]*, not "${PLATFORM_HOSTNAME_LABEL}"; a path starts with "/")`,
      );
    return new URL(path, `https://${routingSlug ? `${routingSlug}.` : ""}${domain}`).href;
  };
}
