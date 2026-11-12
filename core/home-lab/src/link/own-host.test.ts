import assert from "node:assert/strict";
import { test } from "node:test";
import { isOwnHost } from "./own-host.ts";

void test("the port answers this machine's own names, and no name that a web page could point at it", () => {
  for (const own of ["localhost", "agents.localhost", "iterate.localhost", "127.0.0.1", "[::1]"])
    assert.equal(isOwnHost(own), true, own);
  // DNS rebinding: a page's own name, resolved to this machine, arrives as the Host
  for (const other of [
    "evil.example",
    "localhost.evil.example",
    "127.0.0.1.nip.io",
    "192.168.0.10",
  ])
    assert.equal(isOwnHost(other), false, other);
});
