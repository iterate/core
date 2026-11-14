// What a sandbox's start runs (`imageOrDisk`): the image it names, a disk, or the mind's default.
import { expect, test } from "vitest";
import { imageOrDisk } from "./durable-object.ts";

const PREPARED = "registry.cloudflare.com/account/prepared@sha256:digest";

test("a start with no image and no disk runs the image the mind names, else the stack's own", async () => {
  const named = mindNaming(PREPARED);
  const none = mindNaming(null);
  expect({
    named: await imageOrDisk({}, named.image),
    none: await imageOrDisk({}, none.image),
  }).toEqual({ named: { image: PREPARED }, none: { image: "iterate-dev-image" } });
});

test("an image the start names and a disk it restores win over the mind's image, which is not read then", async () => {
  const mind = mindNaming(PREPARED);
  expect({
    image: await imageOrDisk({ image: "cloudflare/debian-trixie", snapshotId: "disk" }, mind.image),
    disk: await imageOrDisk({ snapshotId: "disk" }, mind.image),
    reads: mind.reads,
  }).toEqual({
    image: { image: "cloudflare/debian-trixie" },
    disk: { containerSnapshot: { id: "disk" } },
    reads: 0,
  });
});

/** The mind's default image as the facet reads it, and how many times it was read. */
function mindNaming(image: string | null) {
  const mind = {
    reads: 0,
    image: async () => {
      mind.reads += 1;
      return image;
    },
  };
  return mind;
}
