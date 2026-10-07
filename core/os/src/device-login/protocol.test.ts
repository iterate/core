import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { normalizeUserCode, userCodeOf } from "./protocol.ts";

test.for([
  { name: "a code as the device shows it", typed: "WDJB-MJHT", code: "WDJB-MJHT" },
  { name: "lower case without the dash", typed: "wdjbmjht", code: "WDJB-MJHT" },
  { name: "spaces around and between", typed: " wdjb mjht ", code: "WDJB-MJHT" },
  { name: "a vowel, which no code holds", typed: "WDJB-MJHA", code: null },
  { name: "a digit, which no code holds", typed: "WDJB-MJH7", code: null },
  { name: "one letter short", typed: "WDJB-MJH", code: null },
  { name: "one letter long", typed: "WDJB-MJHTX", code: null },
])("a typed code: $name", ({ typed, code }) => {
  expect(normalizeUserCode(typed)).toBe(code);
});

test("a device code's user code is eight letters of its SHA-256, as the page reads them back", () => {
  const hashes = Array.from({ length: 500 }, () =>
    createHash("sha256")
      .update(crypto.getRandomValues(new Uint8Array(32)))
      .digest("hex"),
  );
  const codes = hashes.map(userCodeOf);
  expect(codes.filter((code) => !code || normalizeUserCode(code) !== code)).toEqual([]);
  // the same device code, the same user code: the poll finds the row the page confirmed
  expect(hashes.map(userCodeOf)).toEqual(codes);
  // bytes at or past 240 are no letter: a hash of them alone has none
  expect(userCodeOf("f".repeat(64))).toBeNull();
});
