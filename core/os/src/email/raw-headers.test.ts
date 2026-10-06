// src/email/raw-headers.test.ts — raw-headers.ts's executable spec: which header fields a message's
// bytes carry, as `email/received` records them, and the bound on how many it keeps.
import { expect, test } from "vitest";
import { HEADERS_MAX_CHARS, rawHeadersOf } from "./raw-headers.ts";

// toEqual: the exact list is the point, its order, duplicates and raw values included.
test.for([
  {
    name: "a folded field keeps its fold, and repeated fields keep their order",
    message:
      "Received: from a\r\n\tby b; Mon, 5 Oct 2026\r\nARC-Seal: i=2; cv=pass\r\nARC-Seal: i=1; cv=none\r\nSubject:  Hi \r\n\r\nBody: not a field",
    headers: [
      { name: "Received", value: " from a\r\n\tby b; Mon, 5 Oct 2026" },
      { name: "ARC-Seal", value: " i=2; cv=pass" },
      { name: "ARC-Seal", value: " i=1; cv=none" },
      { name: "Subject", value: "  Hi " },
    ],
  },
  {
    name: "bare LF line breaks end lines and the header section too",
    message: "From: ann\n  <ann@example.com>\nTo: b@example.com\n\nBody: not a field",
    headers: [
      { name: "From", value: " ann\n  <ann@example.com>" },
      { name: "To", value: " b@example.com" },
    ],
  },
  {
    name: "encoded words and UTF-8 stay as written",
    message: "Subject: =?UTF-8?Q?Caf=C3=A9?= café\r\n\r\n",
    headers: [{ name: "Subject", value: " =?UTF-8?Q?Caf=C3=A9?= café" }],
  },
  {
    name: "a name keeps its case and drops the space before its colon; a line with no colon is a name",
    message: "X-Odd-Case : v\r\nnot a field\r\n\r\n",
    headers: [
      { name: "X-Odd-Case", value: " v" },
      { name: "not a field", value: "" },
    ],
  },
  {
    name: "a message with no body is all header section",
    message: "Subject: Hi\r\nTo: b@example.com\r\n",
    headers: [
      { name: "Subject", value: " Hi" },
      { name: "To", value: " b@example.com" },
    ],
  },
  {
    name: "a message that starts with an empty line has no fields",
    message: "\r\nSubject: in the body",
    headers: [],
  },
])("$name", ({ message, headers }) =>
  expect(rawHeadersOf(new TextEncoder().encode(message))).toEqual({
    headers,
    headersTruncated: false,
  }),
);

test("fields past HEADERS_MAX_CHARS of JSON are left out whole, from the bottom", () => {
  // 1,035 characters of JSON each and a comma: 253 fit in 256 KiB
  const fields = Array.from({ length: 300 }, (_, index) => ({
    name: `X-Filler-${String(index).padStart(3, "0")}`,
    value: ` ${"x".repeat(1000)}`,
  }));
  const message = `${fields.map(({ name, value }) => `${name}:${value}`).join("\r\n")}\r\n\r\nHi`;
  const { headers, headersTruncated } = rawHeadersOf(new TextEncoder().encode(message));
  expect({ headers, headersTruncated }).toEqual({
    headers: fields.slice(0, 253),
    headersTruncated: true,
  });
  expect(JSON.stringify(headers).length).toBeLessThanOrEqual(HEADERS_MAX_CHARS);
});
