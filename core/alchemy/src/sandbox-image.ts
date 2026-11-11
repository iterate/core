// The sandboxes' full development image, built once from core/mind-worker/images/iterate-dev-image
// and published in public. `mind.sandboxImage: "published"` copies it into the mind's own registry
// (../scripts/sandbox-image.ts), because a Container a Durable Object runs starts only from
// registry.cloudflare.com. A new build moves this pin in a commit:
//   depot build --platform linux/amd64 --push --provenance=false \
//     -t ghcr.io/iterate/iterate-dev-image:<commit> core/mind-worker/images/iterate-dev-image
export const PUBLISHED_SANDBOX_IMAGE = {
  source: "ghcr.io/iterate/iterate-dev-image",
  // allow-high-entropy-next-line: the public image's content digest, a pin and no secret
  digest: "sha256:df1de82cbcaa70bda17b7a456134075175a77054798bde102848c35b161e6104",
};

/** Where the copy lands: the repository is the image's name in the mind's account. */
export const publishedSandboxImageIn = (accountId: string) =>
  `registry.cloudflare.com/${accountId}/iterate-dev-image@${PUBLISHED_SANDBOX_IMAGE.digest}`;
