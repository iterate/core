// Which image a start runs, as Cloudflare takes it.
import { codedError } from "iterate/lib";
import { CLOUDFLARE_MANAGED_IMAGE } from "./contract.ts";

/** The one registry Cloudflare starts a Durable Object's Container from, the account's own. */
const CLOUDFLARE_REGISTRY = "registry.cloudflare.com/";

const listed = (names: string[]) => names.map((name) => JSON.stringify(name)).join(", ");

/** The image for a start that names `name`, among the stack's named images (`ctx.container.images`).
 *  A name is the Cloudflare-managed image, a named image of the stack, or an image of the account's
 *  registry; any other fails here, with the stack's own names: Cloudflare's answer to it is only
 *  "internal error". With no name: the stack's named image when it has exactly one, and the
 *  Cloudflare-managed image when it has none. With several, no one of them is the default, so the
 *  start fails and asks for a name: taking the Cloudflare-managed image there would leave the
 *  stack's images without a word. */
export function imageToStart(named: Record<string, string>, name?: string): string {
  const names = Object.keys(named);
  if (!name) {
    if (names.length > 1)
      throw codedError(
        "INVALID_INPUT",
        `this stack has ${names.length} named images (${listed(names)}), and the start names none. Name one in start({ image }), or name the mind's own with events.iterate.com/mind/sandbox-image-configured on /.`,
      );
    return names.length === 1 ? named[names[0]!]! : CLOUDFLARE_MANAGED_IMAGE;
  }
  if (name === CLOUDFLARE_MANAGED_IMAGE || name.startsWith(CLOUDFLARE_REGISTRY)) return name;
  if (Object.hasOwn(named, name)) return named[name]!;
  throw codedError(
    "INVALID_INPUT",
    `start({ image: ${JSON.stringify(name)} }): no such image. A start takes "${CLOUDFLARE_MANAGED_IMAGE}" (the Cloudflare-managed image), a named image of the stack (${names.length > 0 ? listed(names) : "this stack has none"}), or a digest-pinned image of the account's own registry (${CLOUDFLARE_REGISTRY}<account>/<repository>@sha256:<digest>). Cloudflare does not pull from another registry: push the image to the account's registry first.`,
  );
}
