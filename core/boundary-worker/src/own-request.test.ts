import { expect, test } from "vitest";
import { ownRequestHeaders } from "./own-request.ts";

test("the mind's own request to its host carries no session and no word about its caller's address", () => {
  const kept = ownRequestHeaders(
    new Headers({
      accept: "application/json",
      authorization: "Bearer the-app's-own",
      "content-type": "application/x-www-form-urlencoded",
      cookie: "__Host-iterate-session=someone's",
      // the address the auth Worker counts its limits by: only the edge may say it
      "CF-Connecting-IP": "203.0.113.7",
      "cf-ipcountry": "GB",
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "203.0.113.7",
      "true-client-ip": "203.0.113.7",
      forwarded: "for=203.0.113.7",
      "x-custom": "stays",
    }),
  );
  expect(Object.fromEntries(kept)).toEqual({
    accept: "application/json",
    authorization: "Bearer the-app's-own",
    "content-type": "application/x-www-form-urlencoded",
    "x-custom": "stays",
  });
});
