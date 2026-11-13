import { expect, test } from "vitest";
import type { Env } from "./env.ts";
import { authResponse } from "./http.ts";

const env = {
  DOMAIN: "example.com",
  AUTH_SETTINGS: JSON.stringify({
    login: { methods: { email: {} }, allow: [{ email: "owner@example.net" }] },
    keys: [],
  }),
} as unknown as Env;

test("the platform's host has no start page: `/` leads a signed-out visitor to the Dash", async () => {
  for (const method of ["GET", "HEAD"]) {
    const answer = await authResponse(
      new Request("https://iterate.example.com/", { method }),
      env,
      {} as ExecutionContext,
    );
    expect(answer).toMatchObject({ status: 302 });
    expect(Object.fromEntries(answer.headers)).toMatchObject({
      location: "https://dash.example.com/",
      "cache-control": "no-store",
    });
  }
});
