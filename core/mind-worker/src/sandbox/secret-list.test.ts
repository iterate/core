import { expect, test } from "vitest";
import { narrowedSecretList, secretListRefusal } from "./secret-list.ts";

test("a sandbox with no secret list may name any secret, as before", () => {
  expect(secretListRefusal(named('getSecret("/secrets/anthropic")'), undefined)).toBeNull();
});

test("a sandbox's list lets its own secrets through and refuses any other, by path", async () => {
  const list = ["/secrets/anthropic", "/secrets/codex-current"];
  expect(secretListRefusal(named('getSecret("/secrets/anthropic")'), list)).toBeNull();
  expect(
    secretListRefusal(named('getSecret("/secrets/codex-current", { field: "accessToken" })'), list),
  ).toBeNull();
  expect(secretListRefusal(new Request("https://example.com/"), list)).toBeNull();
  const refused = secretListRefusal(named('getSecret("/secrets/github")'), list)!;
  expect(refused).toMatchObject({ status: 403 });
  expect(await refused.text()).toContain("does not name /secrets/github");
});

test("a secret in the URL is refused like one in a header, and an empty list names none", async () => {
  const request = new Request('https://api.telegram.org/botgetSecret("/secrets/telegram")/getMe');
  expect(secretListRefusal(request, ["/secrets/anthropic"])?.status).toBe(403);
  expect(await secretListRefusal(named('getSecret("/secrets/anthropic")'), [])!.text()).toContain(
    "may name no secret",
  );
});

test("a running sandbox takes a narrower list at once and refuses a wider one", () => {
  const four = ["/secrets/openai", "/secrets/anthropic", "/secrets/claude-current"];
  expect(narrowedSecretList(undefined, four)).toEqual(four);
  expect(narrowedSecretList(four, ["/secrets/anthropic"])).toEqual(["/secrets/anthropic"]);
  expect(narrowedSecretList(four, [])).toEqual([]);
  expect(() => narrowedSecretList(["/secrets/anthropic"], four)).toThrow(
    /does not name \/secrets\/openai, \/secrets\/claude-current: stop it/,
  );
});

function named(header: string) {
  return new Request("https://api.anthropic.com/v1/messages", { headers: { "x-api-key": header } });
}
