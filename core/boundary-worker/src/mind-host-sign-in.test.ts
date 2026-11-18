// WHEN THE BOUNDARY SIGNS A PERSON IN on a mind hostname (./mind-host-sign-in.ts), from the app's
// 401: a page load by someone signed out. A sign-in that would bring the same session back is
// never started.
import { expect, test } from "vitest";
import { type MindHostCaller, mindHostSignInAnswerOf } from "./mind-host-sign-in.ts";

const MEMBERS = 'Bearer realm="iterate"';
const ANYONE_SIGNED_IN = 'Bearer realm="iterate", scope="identity"';

test.for<{
  name: string;
  challenge: string;
  caller: MindHostCaller;
  navigation?: false;
  answer: unknown;
}>([
  {
    name: "signed out, at a members' page",
    challenge: MEMBERS,
    caller: "anonymous",
    answer: "sign-in",
  },
  {
    name: "signed out, at a page for anyone signed in",
    challenge: ANYONE_SIGNED_IN,
    caller: "anonymous",
    answer: "sign-in",
  },
  {
    name: "someone who is no member, at a members' page",
    challenge: MEMBERS,
    caller: "non-member",
    answer: "not-a-member",
  },
  {
    name: "a signed-in person whom a page for anyone signed in refuses for another reason",
    challenge: ANYONE_SIGNED_IN,
    caller: "non-member",
    answer: null,
  },
  { name: "a member whom the app refuses", challenge: MEMBERS, caller: "member", answer: null },
  {
    name: "a fetch by someone signed out",
    challenge: MEMBERS,
    caller: "anonymous",
    navigation: false,
    answer: null,
  },
  {
    name: "a challenge that is not the platform's",
    challenge: 'Bearer realm="another"',
    caller: "anonymous",
    answer: null,
  },
])("$name", ({ challenge, caller, navigation, answer }) => {
  const request = new Request("https://app.example.com/", {
    headers:
      navigation === false
        ? { accept: "application/json" }
        : { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  const unauthorized = new Response(null, {
    status: 401,
    headers: { "www-authenticate": challenge },
  });
  expect(mindHostSignInAnswerOf({ answer: unauthorized, request, caller })).toEqual(answer);
});

test("a fetch by someone who is no member gets a 403, never a 401 that would start OAuth again", () => {
  const answer = mindHostSignInAnswerOf({
    answer: new Response(null, { status: 401, headers: { "www-authenticate": MEMBERS } }),
    request: new Request("https://app.example.com/", { headers: { accept: "application/json" } }),
    caller: "non-member",
  });
  expect(answer).toMatchObject({ status: 403 });
});
