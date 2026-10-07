// callback-page.test.ts — the page a provider's callback shows the person (callback-page.ts). Which
// answer each callback gives is test/vitest/os-workers' (integrations.test.ts, x-integration.test.ts).

import { expect, test } from "vitest";
import { callbackPage } from "./callback-page.ts";

test.for([
  {
    name: "a refusal is marked as an error, so a browser spec's failure report quotes it",
    status: 400,
    text: "Connecting x failed: The x account '12345' is connected to another project.",
    message: `<p role="alert" data-type="error">Connecting x failed: The x account '12345' is connected to another project.</p>`,
  },
  {
    name: "a success is the same page, not marked",
    status: 200,
    text: "Done: GitHub is connected. You can close this tab.",
    message:
      '<main class="issuer-card"><img class="issuer-mark" src="/iterate-logo.svg" alt="" width="56" height="56"><p>Done: GitHub is connected. You can close this tab.</p></main>',
  },
  {
    name: "markup in the text stays text: a provider's `error` parameter cannot add any",
    status: 400,
    text: `GitHub declined: <img src=x onerror="alert(1)">&`,
    message: `<p role="alert" data-type="error">GitHub declined: &#60;img src=x onerror=&#34;alert(1)&#34;&#62;&#38;</p>`,
  },
])("$name", async ({ status, text, message }) => {
  const page = callbackPage(status, text);
  expect({
    status: page.status,
    contentType: page.headers.get("content-type"),
    body: await page.text(),
  }).toMatchObject({
    status,
    contentType: "text/html; charset=utf-8",
    body: expect.stringContaining(message),
  });
});
