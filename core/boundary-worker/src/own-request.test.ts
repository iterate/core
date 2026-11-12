import { expect, test } from "vitest";
import { OWN_REQUEST_ADDRESS, ownRequestHeaders } from "./own-request.ts";

test("the mind's own request to its host carries no session, and one fixed address in place of any it named", () => {
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
    // the one address of the mind's own requests: the auth Worker counts them as one client
    "cf-connecting-ip": OWN_REQUEST_ADDRESS,
  });
});

test("every request of the mind's own carries the same address, also one that named none", () => {
  const addresses = [
    new Headers(),
    new Headers({ "cf-connecting-ip": "203.0.113.7" }),
    new Headers({ "CF-Connecting-IP": "198.51.100.9", "x-forwarded-for": "198.51.100.9" }),
  ].map((headers) => ownRequestHeaders(headers).get("cf-connecting-ip"));
  expect(addresses).toEqual(["192.0.0.8", "192.0.0.8", "192.0.0.8"]);
});
