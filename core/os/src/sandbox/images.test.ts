import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { imageNames, imageReferences } from "../../scripts/images.ts";
import { SANDBOX_IMAGE } from "./contract.ts";

const images = path.join(import.meta.dirname, "../../images");

test("an image is core/os/images/<name>/Dockerfile, its name ends in -image, and the sandbox's default is one", () => {
  const names = readdirSync(images, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  expect(names).toContain(SANDBOX_IMAGE);
  for (const name of names) {
    expect(name).toMatch(/^[a-z][a-z0-9-]*-image$/);
    expect(readFileSync(path.join(images, name, "Dockerfile"), "utf8")).toMatch(/^FROM /m);
  }
});

test("a deploy reads each image's pin and builds nothing: a reference per pinned image, a warning for the others", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  expect(imageReferences("acct", { [SANDBOX_IMAGE]: digest })).toEqual({
    found: { [SANDBOX_IMAGE]: `registry.cloudflare.com/acct/${SANDBOX_IMAGE}@${digest}` },
    unpinned: imageNames().filter((name) => name !== SANDBOX_IMAGE),
  });
  expect(imageReferences("acct", {})).toMatchObject({ found: {}, unpinned: imageNames() });
});
