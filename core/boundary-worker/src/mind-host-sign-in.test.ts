// WHEN INGRESS SIGNS A PERSON IN on a mind hostname (./mind-host-sign-in.ts), from the app's 401:
// a page load by someone signed out, and RFC 9470's step-up, where the app takes none of the ways
// the session began by. The ways ride the challenge's `acr_values`, and a sign-in that would bring
// the same session back is never started.
import { expect, test } from "vitest";
import { type MindHostCaller, mindHostSignInAnswerOf } from "./mind-host-sign-in.ts";

const CLOUDFLARE_ONLY = 'Bearer realm="iterate", scope="identity", acr_values="cloudflare"';
const STEP_UP =
  'Bearer realm="iterate", scope="identity", error="insufficient_user_authentication", acr_values="cloudflare"';

test.for<{
  name: string;
  challenge: string;
  caller: MindHostCaller;
  method?: string;
  navigation?: false;
  answer: unknown;
}>([
  {
    name: "signed out, at an app that names Cloudflare",
    challenge: CLOUDFLARE_ONLY,
    caller: "anonymous",
    answer: { methods: ["cloudflare"] },
  },
  {
    name: "a person who signed in with a mailed code",
    challenge: STEP_UP,
    caller: "non-member",
    method: "email",
    answer: { methods: ["cloudflare"] },
  },
  {
    name: "a member, whose passkey this app does not take",
    challenge: STEP_UP,
    caller: "member",
    method: "passkey",
    answer: { methods: ["cloudflare"] },
  },
  {
    name: "a session from before sessions said how they began",
    challenge: CLOUDFLARE_ONLY,
    caller: "non-member",
    answer: { methods: ["cloudflare"] },
  },
  {
    name: "a session the app takes, refused for another reason",
    challenge: STEP_UP,
    caller: "non-member",
    method: "cloudflare",
    answer: null,
  },
  {
    name: "Cloudflare's session at an app that names no way",
    challenge: 'Bearer realm="iterate", scope="identity", error="insufficient_user_authentication"',
    caller: "non-member",
    method: "cloudflare",
    answer: { methods: [] },
  },
  {
    name: "a mind's own session at an app that names no way",
    challenge: 'Bearer realm="iterate", scope="identity", error="insufficient_user_authentication"',
    caller: "non-member",
    method: "email",
    answer: null,
  },
  {
    name: "a fetch by a person the app does not take",
    challenge: STEP_UP,
    caller: "non-member",
    method: "email",
    navigation: false,
    answer: null,
  },
  {
    name: "signed out, at an app that names no way",
    challenge: 'Bearer realm="iterate", scope="identity"',
    caller: "anonymous",
    answer: { methods: [] },
  },
  {
    name: "someone who is no member, at a members' page",
    challenge: 'Bearer realm="iterate"',
    caller: "non-member",
    method: "email",
    answer: "not-a-member",
  },
])("$name", ({ challenge, caller, method, navigation, answer }) => {
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
  expect(mindHostSignInAnswerOf({ answer: unauthorized, request, caller, method })).toEqual(answer);
});
