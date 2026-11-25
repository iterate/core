import { expect, test } from "vitest";
import { listenForRedirect } from "./oauth.ts";

test("the loopback's /start leads to a long page; the sign-in's own redirect goes on to onboarding", async () => {
  await using onward = await listenForRedirect();
  const long =
    "https://iterate.ada-labs.com/sign-in/access?next=https%3A%2F%2Fiterate.ada-labs.com%2Foauth%2Fauthorize";
  const start = await fetch(onward.startAt(long), { redirect: "manual" });
  onward.sendOnward("https://onboarding.ada-labs.com/", "s1");
  const answer = await fetch(`${onward.redirectUri}?code=abc&state=s1`, { redirect: "manual" });
  expect({
    start: [start.status, start.headers.get("location")],
    status: answer.status,
    location: answer.headers.get("location"),
    code: (await onward.redirect).get("code"),
  }).toEqual({
    start: [303, long],
    status: 303,
    location: "https://onboarding.ada-labs.com/",
    code: "abc",
  });
});

test("a redirect with another state, or a refusal, gets the page and does not go on", async () => {
  for (const query of ["code=abc&state=other", "error=access_denied&state=s1"]) {
    await using loopback = await listenForRedirect();
    loopback.sendOnward("https://onboarding.ada-labs.com/", "s1");
    const answer = await fetch(`${loopback.redirectUri}?${query}`, { redirect: "manual" });
    expect({ query, status: answer.status, location: answer.headers.get("location") }).toEqual({
      query,
      status: query.startsWith("error") ? 400 : 200,
      location: null,
    });
    await loopback.redirect;
  }
});
