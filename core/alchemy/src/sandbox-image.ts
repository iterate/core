// The sandboxes' full development image, built once from core/mind-worker/images/iterate-dev-image
// and published in public. `mind.sandboxImage: "published"` copies it into the mind's own registry
// (../scripts/sandbox-image.ts), because a Container a Durable Object runs starts only from
// registry.cloudflare.com. A new build moves this pin in a commit:
//   depot build --platform linux/amd64 --push --provenance=false \
//     -t ghcr.io/iterate/iterate-dev-image:<commit> core/mind-worker/images/iterate-dev-image
export const PUBLISHED_SANDBOX_IMAGE = {
  source: "ghcr.io/iterate/iterate-dev-image",
  // allow-high-entropy-next-line: the public image's content digest, a pin and no secret
  digest: "sha256:03e19e40cae1cddd093802f5cab2e0b7273395a0abebea0a111c07e23dceb419",
};

/** The repository the copy lands in, in the mind's account. Cloudflare keeps a failed preparation of
 *  an image address and answers it again, even after the image is deleted and pushed again: another
 *  repository name is another address, and the way past one. Every repository of an account reads
 *  the same layers, so a new name copies only the manifest. */
export const SANDBOX_IMAGE_REPOSITORY = "iterate-sandbox";

/** Where the copy lands. */
export const publishedSandboxImageIn = (accountId: string) =>
  `registry.cloudflare.com/${accountId}/${SANDBOX_IMAGE_REPOSITORY}@${PUBLISHED_SANDBOX_IMAGE.digest}`;
