import assert from "node:assert/strict";
import { test } from "node:test";
import { localEntranceRequest } from "./local-entrance.ts";

void test("a POST to the local port with a header that names a secret: the header goes, as at the boundary; a stamp and the statement go too; the rest and the body arrive whole", async () => {
  const sent = localEntranceRequest(
    new Request("http://localhost:8787/", {
      method: "POST",
      headers: {
        // a placeholder in a header's parameter (a browser's fetch may send its own content-type)
        "content-type": 'text/plain; x=getSecret("/secrets/openai")',
        cookie: 'app=1; x=getSecret("/secrets/openai")',
        "x-itx-principal": '{"actor":"forged"}',
        "iterate-auth-statement": "forged",
        accept: "*/*",
      },
      body: "the whole body",
    }),
    new URL("https://mind.example/"),
  );
  assert.deepEqual(Object.fromEntries(sent.headers), { accept: "*/*", cookie: "app=1" });
  assert.equal(sent.url, "https://mind.example/");
  assert.equal(await sent.text(), "the whole body");
});
