import { expect, test } from "vitest";
import { loginFlowFor, unexpectedUser, type LoginFlow } from "./flow.ts";

test.for<{
  name: string;
  device?: boolean;
  env: Record<string, string>;
  platform: string;
  flow: LoginFlow;
}>([
  { name: "a Mac desktop", env: {}, platform: "darwin", flow: "browser" },
  {
    name: "a Linux desktop",
    env: { WAYLAND_DISPLAY: "wayland-1" },
    platform: "linux",
    flow: "browser",
  },
  { name: "Linux with no display server", env: {}, platform: "linux", flow: "device" },
  {
    name: "a shell over SSH, even with a forwarded display",
    env: { SSH_CONNECTION: "203.0.113.7 50000 192.0.2.1 22", DISPLAY: "localhost:10.0" },
    platform: "linux",
    flow: "device",
  },
  { name: "a coding agent on a Mac", env: { AGENT: "1" }, platform: "darwin", flow: "device" },
  {
    name: "ITERATE_LOGIN_FLOW=browser over SSH",
    env: { ITERATE_LOGIN_FLOW: "browser", SSH_CONNECTION: "203.0.113.7 50000 192.0.2.1 22" },
    platform: "linux",
    flow: "browser",
  },
  {
    name: "--device over ITERATE_LOGIN_FLOW",
    device: true,
    env: { ITERATE_LOGIN_FLOW: "browser" },
    platform: "darwin",
    flow: "device",
  },
  {
    name: "--device false on a headless Linux",
    device: false,
    env: {},
    platform: "linux",
    flow: "browser",
  },
])("$name signs in with the $flow flow", ({ device, env, platform, flow }) => {
  expect(loginFlowFor({ device, env, platform })).toBe(flow);
});

test.for<{ name: string; signedInAs?: string; expected?: string; refusal: string | null }>([
  { name: "no expectation", signedInAs: "a@example.com", refusal: null },
  {
    name: "the expected person, typed in another case",
    signedInAs: "a@example.com",
    expected: " A@Example.com ",
    refusal: null,
  },
  {
    name: "someone else",
    signedInAs: "b@example.com",
    expected: "a@example.com",
    refusal: "This sign-in is b@example.com, not a@example.com. It was ended and not saved.",
  },
  {
    name: "an account with no email",
    expected: "a@example.com",
    refusal:
      "This sign-in is an account with no email, not a@example.com. It was ended and not saved.",
  },
])("the expected user: $name", ({ signedInAs, expected, refusal }) => {
  expect(unexpectedUser(signedInAs, expected)).toBe(refusal);
});
