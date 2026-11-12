// What a failed check says of its error (reason.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { reasonOf } from "./reason.ts";

void test("a failed request says why it failed, which Node keeps in the error's cause", () => {
  // the error of `fetch` to a host with no address (Node 24): the code is on the cause
  const error = new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND iterate.example.test"), {
      code: "ENOTFOUND",
    }),
  });
  assert.equal(
    reasonOf(error),
    "fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND iterate.example.test)",
  );
});

void test("a cause with no code gives its message, and a cause of a cause is said too", () => {
  const error = new Error("fetch failed", {
    cause: new Error("the socket closed", { cause: new Error("read ECONNRESET") }),
  });
  assert.equal(reasonOf(error), "fetch failed (the socket closed (read ECONNRESET))");
});

void test("an error with no cause says its message, and what is no error says itself", () => {
  assert.equal(
    reasonOf(new Error("the page never showed the change")),
    "the page never showed the change",
  );
  assert.equal(reasonOf("stopped"), "stopped");
  assert.equal(
    reasonOf(new Error("refused", { cause: "by the far end" })),
    "refused (by the far end)",
  );
});
