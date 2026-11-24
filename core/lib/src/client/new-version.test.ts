import { expect, test } from "vitest";
import { STARTED_OVER_TYPES, versionEndedBy } from "./new-version.ts";

test.each(STARTED_OVER_TYPES)("%s ends the version that its payload names", (type) => {
  expect(versionEndedBy({ type, payload: { version: 3 } })).toBe(3);
});

test("no other event ends a version", () => {
  expect(
    versionEndedBy({ type: "events.iterate.com/itx/created", payload: { version: 3 } }),
  ).toBeUndefined();
});
