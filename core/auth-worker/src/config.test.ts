import { inspect } from "node:util";
import { expect, test } from "vitest";
import { atMindsZone, authConfigOf, isOwner, tokenAudiencesOf } from "./config.ts";
import { configVars } from "./test-support.ts";

test("the config is the shared one and the Worker's own signing key", () => {
  const config = authConfigOf(configVars());
  expect(config).toMatchObject({
    controlPlaneHostname: "iterate.example.com",
    zones: ["example.com"],
    ownerEmails: ["owner@example.net"],
    topology: "full-cloudflare",
  });
  expect(config.signingKey.exposeSecret()).toBe("a signing key for a test, never a real one");
});

test("a config with no signing key is refused, and the refusal names the variable", () => {
  const { ITERATE } = configVars();
  expect(() => authConfigOf({ ITERATE })).toThrow("ITERATE__SIGNING_KEY");
});

test("the config names the team and the application of Cloudflare Access, and one without them is refused", () => {
  const vars = configVars();
  expect(authConfigOf(vars)).toMatchObject({
    cloudflareAccessTeamDomain: "team.cloudflareaccess.com",
    cloudflareAccessAudienceTag: "the-audience-tag-of-the-owners-application",
  });
  const { cloudflareAccessTeamDomain: _, ...withoutTeam } = JSON.parse(vars.ITERATE);
  expect(() => authConfigOf({ ...vars, ITERATE: JSON.stringify(withoutTeam) })).toThrow(
    "ITERATE__CLOUDFLARE_ACCESS_TEAM_DOMAIN",
  );
  const { cloudflareAccessAudienceTag: __, ...withoutTag } = JSON.parse(vars.ITERATE);
  expect(() => authConfigOf({ ...vars, ITERATE: JSON.stringify(withoutTag) })).toThrow(
    "ITERATE__CLOUDFLARE_ACCESS_AUDIENCE_TAG",
  );
});

test("a dump of the config prints REDACTED where the signing key is", () => {
  const config = authConfigOf(configVars());
  for (const dump of [JSON.stringify(config), inspect(config), `${config.signingKey}`]) {
    expect(dump).not.toContain("a signing key for a test");
    expect(dump).toMatch(/redacted/i);
  }
});

test.for([
  ["at a zone", "owner@example.com"],
  ["under a zone", "owner@mail.example.com"],
  ["at the second zone", "owner@second.example"],
])("an owner's address %s of the mind is refused: the mind receives its mail", ([, email]) => {
  const vars = configVars({ zones: ["example.com", "second.example"], ownerEmails: [email!] });
  expect(() => authConfigOf(vars)).toThrow(/ITERATE__OWNER_EMAILS.*is at a zone of the mind/);
});

test("an address is the mind's own at any of its zones, and nowhere else", () => {
  const config = { zones: ["example.com", "second.example"] };
  expect(
    [
      "agent@example.com",
      "Agent@Sub.Second.Example ",
      // another domain that only ends with the same letters
      "jo@notexample.com",
      "jo@example.net",
    ].map((email) => atMindsZone(config, email)),
  ).toEqual([true, true, false, false]);
});

test("an owner is an address the config names, and no other", () => {
  const config = { ownerEmails: ["owner@example.net"] };
  expect([
    isOwner(config, "owner@example.net"),
    isOwner(config, " Owner@Example.net"),
    isOwner(config, "owner+tag@example.net"),
    isOwner(config, "other@example.net"),
  ]).toEqual([true, true, false, false]);
});

test("the token audiences are the API and the MCP server, and the external mind's address when it runs outside the stack", () => {
  const controlPlaneHostname = "iterate.example.com";
  expect(tokenAudiencesOf({ controlPlaneHostname, topology: "full-cloudflare" })).toEqual([
    "https://iterate.example.com/api",
    "https://iterate.example.com/mcp",
  ]);
  expect(
    tokenAudiencesOf({
      controlPlaneHostname,
      topology: "external-mind-connects-into-cloudflare-boundary",
    }),
  ).toEqual([
    "https://iterate.example.com/api",
    "https://iterate.example.com/mcp",
    "https://iterate.example.com/api/provide-connect",
  ]);
});

test("an owner is also an address at the exact domain of an owner email pattern", () => {
  const config = { ownerEmails: ["owner@example.net"], ownerEmailPatterns: ["*@company.example"] };
  expect([
    isOwner(config, "owner@example.net"),
    isOwner(config, " Bo@Company.example"),
    isOwner(config, "bo@sub.company.example"),
    isOwner(config, "bo@company.example.evil.example"),
    isOwner(config, "bo@example.net"),
  ]).toEqual([true, true, false, false, false]);
});

test.for([
  ["at a zone", "*@example.com"],
  ["under a zone", "*@mail.example.com"],
  ["at the second zone", "*@second.example"],
])(
  "an owner email pattern %s of the mind is refused: the mind receives its mail",
  ([, pattern]) => {
    const vars = configVars({
      zones: ["example.com", "second.example"],
      ownerEmailPatterns: [pattern!],
    });
    expect(() => authConfigOf(vars)).toThrow(
      /ITERATE__OWNER_EMAIL_PATTERNS.*names a zone of the mind/,
    );
  },
);

test("a config whose owner email pattern is no pattern is refused, and one with a pattern elsewhere is taken", () => {
  expect(() => authConfigOf(configVars({ ownerEmailPatterns: ["*@*"] }))).toThrow(
    "ownerEmailPatterns",
  );
  expect(authConfigOf(configVars({ ownerEmailPatterns: ["*@company.example"] }))).toMatchObject({
    ownerEmailPatterns: ["*@company.example"],
  });
  expect(authConfigOf(configVars())).not.toHaveProperty("ownerEmailPatterns");
});
