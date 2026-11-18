// Which image a start runs (`imageToStart`), among the stack's named images.
import { errorCode } from "iterate/lib";
import { expect, test } from "vitest";
import { imageToStart } from "./image.ts";

const DEV = "registry.cloudflare.com/account/iterate-sandbox@sha256:dev";
const TOOLS = "registry.cloudflare.com/account/iterate-sandbox@sha256:tools";

test("a start that names no image runs the stack's one named image, or the Cloudflare-managed image on a stack with none", () => {
  expect({
    one: started({ "iterate-dev-image": DEV }),
    none: started({}),
  }).toEqual({ one: DEV, none: "cloudflare/debian-trixie" });
});

test("on a stack with several named images, a start that names none is refused and lists them", () => {
  expect(started({ "iterate-dev-image": DEV, tools: TOOLS })).toBe(
    'INVALID_INPUT: this stack has 2 named images ("iterate-dev-image", "tools"), and the start names none',
  );
});

test("a start takes the Cloudflare-managed image, a named image of the stack, or an image of the account's registry", () => {
  const named = { "iterate-dev-image": DEV, tools: TOOLS };
  expect({
    managed: started(named, "cloudflare/debian-trixie"),
    name: started(named, "tools"),
    address: started({}, "registry.cloudflare.com/account/mine@sha256:mine"),
  }).toEqual({
    managed: "cloudflare/debian-trixie",
    name: TOOLS,
    address: "registry.cloudflare.com/account/mine@sha256:mine",
  });
});

test("any other image is refused, with the stack's own names: an image name of another stack, and an image of another registry", () => {
  expect({
    alias: started({}, "iterate-dev-image"),
    elsewhere: started({ tools: TOOLS }, "ghcr.io/iterate/iterate-dev-image@sha256:dev"),
  }).toEqual({
    alias: 'INVALID_INPUT: start({ image: "iterate-dev-image" }): no such image',
    elsewhere: 'INVALID_INPUT: start({ image: "ghcr',
  });
});

/** What a start runs, or the code and first words of its refusal. */
function started(named: Record<string, string>, name?: string) {
  try {
    return imageToStart(named, name);
  } catch (error) {
    return `${errorCode(error)}: ${(error as Error).message.split(".")[0]}`;
  }
}
