import { expect, test, vi } from "vitest";
import { brokered } from "./cloud-client.ts";

const CLOUD = "https://cloud.example.com";

test("a brokered request carries its statement in a header that Workers Logs redact by its name", async () => {
  const sent: Request[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    return new Response("ok");
  });
  await brokered(
    async () => ({ statement: "{}", signature: "s" }),
    CLOUD,
    "github",
    "t",
  )(new Request(`${CLOUD}/clients/github/token`));

  const carried = [...sent[0]!.headers.keys()].filter((name) => name.includes("statement"));
  // Workers Logs write "REDACTED" for a name with one of these; any other header is kept whole
  expect(carried).toEqual(["iterate-auth-statement"]);
  expect(carried[0]).toMatch(/auth|key|secret|token|jwt/);
});
