// iterate's image for sandboxes, built once from core/mind-worker/images/iterate-dev-image and
// published in public. A Container that a Durable Object starts takes a named image only from the
// Cloudflare managed registry of its own account (registry.cloudflare.com), so a stack that names
// this image has it pushed there by the deploy (../scripts/sandbox-image.ts). A new build moves
// this pin in a commit:
//   depot build --platform linux/amd64 --push --provenance=false \
//     -t ghcr.io/iterate/iterate-dev-image:<commit> core/mind-worker/images/iterate-dev-image
const PUBLISHED_SANDBOX_IMAGE = {
  source: "ghcr.io/iterate/iterate-dev-image",
  // allow-high-entropy-next-line: the public image's content digest, a pin and no secret
  digest: "sha256:03e19e40cae1cddd093802f5cab2e0b7273395a0abebea0a111c07e23dceb419",
};

/** The name of iterate's image in a stack's `mind.images`, and so its key in
 *  `ctx.container.images`. */
export const ITERATE_DEV_IMAGE = "iterate-dev-image";

/** iterate's image as a stack's `mind.images` names it, by one of its two sources: built from its
 *  Dockerfile with the local Docker, or the public build at its pin. A config in TypeScript says
 *  `images: { [ITERATE_DEV_IMAGE]: iterateDevImage.image }`; `node scripts/iterate-dev-image.ts`
 *  prints the same entry for a config in JSON. */
export const iterateDevImage = {
  dockerfile: { dockerfile: "../mind-worker/images/iterate-dev-image/Dockerfile" },
  image: { image: `${PUBLISHED_SANDBOX_IMAGE.source}@${PUBLISHED_SANDBOX_IMAGE.digest}` },
};

export const CLOUDFLARE_REGISTRY = "registry.cloudflare.com";

/** The repository of the account's registry that the deploy pushes to. Cloudflare keeps a failed
 *  preparation of an image address and answers it again, even after the image is deleted and pushed
 *  again: another repository name is another address, and the way past one. Every repository of
 *  an account reads the same layers, so a new name pushes only the manifest. */
export const SANDBOX_IMAGE_REPOSITORY = "iterate-sandbox";

/** `<registry>/<repository>@sha256:<digest>`: the one form of image reference that Cloudflare
 *  starts a Container from. */
export const DIGEST_PINNED_IMAGE =
  /^([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?)\/([a-z0-9._/-]+)@(sha256:[0-9a-f]{64})$/;

/** The registry, repository and digest of a digest-pinned image reference. */
export function partsOfImage(image: string) {
  const [, host, repository, digest] = DIGEST_PINNED_IMAGE.exec(image) || [];
  if (!host || !repository || !digest)
    throw new Error(
      `${image} is not a digest-pinned image: <registry>/<repository>@sha256:<digest>`,
    );
  return { host, repository, digest };
}

/** The digest a stack's images have for iterate's public image and the digest of this checkout's
 *  pin, when the two differ; undefined when the stack is at the pin, builds the image itself or
 *  names another image. */
export function digestsOffPin(images: Record<string, { image: string } | { dockerfile: string }>) {
  const named = images[ITERATE_DEV_IMAGE];
  if (!named || !("image" in named)) return undefined;
  const [has, pin] = [partsOfImage(named.image), partsOfImage(iterateDevImage.image.image)];
  const same = has.host === pin.host && has.repository === pin.repository;
  return same && has.digest !== pin.digest ? { has: has.digest, pin: pin.digest } : undefined;
}

/** The address a named image starts from. An image of the Cloudflare managed registry stays as it
 *  is; one of another registry is where the deploy pushes it, in the account's own registry. */
export function imageInAccount(accountId: string, image: string) {
  const { host, digest } = partsOfImage(image);
  return host === CLOUDFLARE_REGISTRY
    ? image
    : `${CLOUDFLARE_REGISTRY}/${accountId}/${SANDBOX_IMAGE_REPOSITORY}@${digest}`;
}
