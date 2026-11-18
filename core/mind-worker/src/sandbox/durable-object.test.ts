// What a sandbox's start runs (`imageOrSnapshot`): the image it names, a snapshot, or the mind's
// default. And when a start is refused (`startRefusal`): it names what to run on, and the sandbox
// runs already or another call is starting it.
import { expect, test } from "vitest";
import type { SandboxStarted } from "./contract.ts";
import { imageOrSnapshot, startRefusal } from "./durable-object.ts";

const PREPARED = "registry.cloudflare.com/account/prepared@sha256:digest";
const IMAGE = "registry.cloudflare.com/account/iterate-sandbox@sha256:digest";

test("a start with no image and no snapshot runs the image the mind names, else names none: the container starts the stack's default", async () => {
  const named = mindNaming(PREPARED);
  const none = mindNaming(null);
  expect({
    named: await imageOrSnapshot({}, named.image),
    none: await imageOrSnapshot({}, none.image),
  }).toEqual({ named: { image: PREPARED }, none: { image: undefined } });
});

test("an image the start names and a snapshot it restores win over the mind's image, which is not read then", async () => {
  const mind = mindNaming(PREPARED);
  expect({
    image: await imageOrSnapshot(
      { image: "cloudflare/debian-trixie", snapshotId: "snapshot" },
      mind.image,
    ),
    snapshot: await imageOrSnapshot({ snapshotId: "snapshot" }, mind.image),
    reads: mind.reads,
  }).toEqual({
    image: { image: "cloudflare/debian-trixie" },
    snapshot: { containerSnapshot: { id: "snapshot" } },
    reads: 0,
  });
});

test("a start that names an image, a snapshot or another sandbox fails on a sandbox that runs on something else, and the error names what it asked for", () => {
  // it started with no word (an `exec` started it), from the stack's image
  const running = { running: true, started: { from: "image", image: IMAGE } } as const;
  expect({
    image: startRefusal("/box", { image: "tools" }, { ...running, image: PREPARED }),
    snapshot: startRefusal("/box", { containerSnapshot: { id: "snapshot" } }, running),
    from: startRefusal("/box", { from: "/golden" }, running),
    // a state from before `started` was kept says nothing of what it runs on
    unknown: startRefusal("/box", { from: "/golden" }, { running: true }),
  }).toEqual({
    image: expect.stringMatching(
      /^sandbox \/box runs already, and not on what start\(\{ image \}\) names/,
    ),
    snapshot: expect.stringMatching(/not on what start\(\{ containerSnapshot \}\) names/),
    from: expect.stringMatching(/not on what start\(\{ from \}\) names.*container\.destroy\(\)/),
    unknown: expect.stringMatching(/not on what start\(\{ from \}\) names/),
  });
});

test("a start asked again after 'still starting' finds the sandbox up on what it names, and has nothing left to do", () => {
  const up = (started: SandboxStarted, image?: string) => ({
    running: true as const,
    started,
    image,
  });
  expect({
    image: startRefusal(
      "/box",
      { image: "iterate-dev-image" },
      up({ from: "image", image: IMAGE }, IMAGE),
    ),
    from: startRefusal(
      "/box",
      { from: "/golden" },
      up({ from: "snapshot", snapshotId: "golden-1", fromSandbox: "/golden" }),
    ),
    snapshot: startRefusal(
      "/box",
      { containerSnapshot: { id: "own-1" } },
      up({ from: "snapshot", snapshotId: "own-1" }),
    ),
    // the same snapshot id, but taken over from another sandbox: not this start
    otherSandbox: startRefusal(
      "/box",
      { containerSnapshot: { id: "golden-1" } },
      up({ from: "snapshot", snapshotId: "golden-1", fromSandbox: "/golden" }),
    ),
  }).toEqual({
    image: undefined,
    from: undefined,
    snapshot: undefined,
    otherSandbox: expect.stringMatching(/runs already, and not on what/),
  });
});

test("a start that names nothing to run on only makes the sandbox run: it is never refused", () => {
  expect({
    running: startRefusal("/box", {}, { running: true }),
    size: startRefusal("/box", { instance: "standard-2" }, { running: true }),
    starting: startRefusal("/box", {}, { starting: { from: "/golden" } }),
  }).toEqual({ running: undefined, size: undefined, starting: undefined });
});

test("while a start goes on, the same start asked again waits for it, and another one fails", () => {
  const starting = { starting: { from: "/golden" } };
  expect({
    same: startRefusal("/box", { from: "/golden" }, starting),
    other: startRefusal("/box", { from: "/other" }, starting),
    image: startRefusal("/box", { image: "cloudflare/debian-trixie" }, { starting: {} }),
  }).toEqual({
    same: undefined,
    other: expect.stringMatching(
      /^sandbox \/box is being started by another call: start\(\{ from \}\)/,
    ),
    image: expect.stringMatching(/is being started by another call: start\(\{ image \}\)/),
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
