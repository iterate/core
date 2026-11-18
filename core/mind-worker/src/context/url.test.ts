import { expect, test } from "vitest";
import { urlRoot } from "./url.ts";

const url = urlRoot({
  controlPlaneHostname: "iterate.example.org",
  zones: ["example.org", "example.com"],
});

test("a URL of the mind's own code is on a hostname of its zones, the first zone's apex when none is named", async () => {
  expect(await url()).toBe("https://example.org/");
  expect(await url({ path: "/a?b=1" })).toBe("https://example.org/a?b=1");
  expect(await url({ hostname: "blog.example.com", path: "/post" })).toBe(
    "https://blog.example.com/post",
  );
  // a hostname is one name, whatever its case
  expect(await url({ hostname: "Blog.Example.COM" })).toBe("https://blog.example.com/");
});

test("where the control plane is at the first zone's apex, a URL with no hostname is refused with words that say to name one, and a named hostname is answered", async () => {
  const atApex = urlRoot({
    controlPlaneHostname: "example.org",
    zones: ["example.org", "example.com"],
  });
  await expect(atApex()).rejects.toMatchObject({
    code: "INVALID_INPUT",
    message: expect.stringContaining('name a hostname, as in url({ hostname: "app.example.org" })'),
  });
  await expect(atApex({ path: "/a" })).rejects.toThrow("name a hostname");
  expect(await atApex({ hostname: "app.example.org", path: "/a" })).toBe(
    "https://app.example.org/a",
  );
  expect(await atApex({ hostname: "example.com" })).toBe("https://example.com/");
});

test.for([
  // it ends in a zone's letters, and as a URL it is another origin
  "outside.test/path.example.org",
  "outside.test#.example.org",
  "user@outside.test:443/.example.org",
  "outside.test\\.example.org",
  "example.org:8443",
  "example.org.",
  "outside.test",
  "notexample.org",
  // the control-plane hostname is the platform's, in any case
  "iterate.example.org",
  "ITERATE.example.org",
])("the hostname %j is refused", async (hostname) => {
  await expect(url({ hostname })).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test.for(["//outside.test/x", "relative", "\\\\outside.test/x", "/\\outside.test/x"])(
  "the path %j never leaves the hostname",
  async (path) => {
    const made = await url({ hostname: "blog.example.com", path }).catch((error: unknown) => error);
    if (typeof made === "string")
      expect(new URL(made)).toMatchObject({ origin: "https://blog.example.com" });
    else expect(made).toMatchObject({ code: "INVALID_INPUT" });
  },
);
