import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import {
  candidatesOf,
  configOf,
  erateOf,
  firstSignInPage,
  mcpInstalls,
  nameOf,
  onboardingTurnScript,
} from "./deploy.ts";

test("the stack's name comes from the owner's address, and is always a name the stack takes", () => {
  expect(nameOf("Ada.Lovelace+minds@example.org")).toBe("ada-lovelace");
  expect(nameOf("42@example.org")).toBe("mind");
  expect(nameOf("a@example.org")).toBe("mind");
  expect(nameOf(`${"x".repeat(40)}@example.org`)).toBe("x".repeat(30));
});

test("the names asked about come from the person's name and words: the -erate names first, then .com, 20 at most", () => {
  expect(erateOf("jonas")).toBe("jonaserate");
  expect(erateOf("misha")).toBe("misherate");
  const names = candidatesOf("Ada Lovelace", "engines");
  expect(names).toHaveLength(20);
  expect(names.slice(0, 8)).toEqual([
    "aderate.com",
    "lovelacerate.com",
    "aderate.dev",
    "lovelacerate.dev",
    "adalovelace.com",
    "ada-lovelace.com",
    "adal.com",
    "lovelace.com",
  ]);
  expect(names).toContain("engines.com");
  expect(names).toContain("adaengines.com");
  expect(candidatesOf("ada")).toEqual([
    "aderate.com",
    "aderate.dev",
    "adas.com",
    "heyada.com",
    "adahq.com",
    "adas.dev",
    "adas.net",
    "adas.xyz",
    "heyada.dev",
    "heyada.net",
    "heyada.xyz",
    "adahq.dev",
    "adahq.net",
    "adahq.xyz",
  ]);
});

const mind = {
  name: "ada",
  accountId: "0".repeat(32),
  owner: "ada@example.org",
  domain: "ada-labs.com",
};

test("an access that may make API tokens turns on telemetry and the mind's Cloudflare connection", () => {
  const config = configOf({ ...mind, apiTokens: true, sandboxImage: "published" });
  expect(config).toMatchObject({
    cloudflareToken: true,
    telemetry: true,
    mind: { sandboxImage: "published" },
  });
  expect(config).not.toHaveProperty("cloud");
});

test("the config has mail, the mailed code, the sandboxes and iterate Cloud's key", () => {
  const cloud = { origin: "https://cloud.example.com", publicKey: "key" };
  expect(configOf({ ...mind, cloud })).toEqual({
    name: "ada",
    accountId: "0".repeat(32),
    domain: "ada-labs.com",
    mail: true,
    mind: { sandboxImage: "managed" },
    auth: {
      login: { methods: { email: {} }, allow: [{ email: "ada@example.org" }] },
      keys: [
        {
          actor: "iterate-cloud",
          publicKey: "key",
          label: "iterate Cloud",
          paths: ["/integrations/"],
        },
      ],
    },
    cloud: { origin: "https://cloud.example.com" },
  });
});

test("the first page adds the passkey and then goes on to the CLI's sign-in, with the ticket in the fragment alone", () => {
  const authorize = new URL("https://iterate.ada-labs.com/oauth2/auth?client_id=cli&state=a%26b");
  const page = firstSignInPage("ada-labs.com", "the-ticket", authorize);
  expect(page.toString()).toBe(
    "https://iterate.ada-labs.com/keys/first?next=%2Foauth2%2Fauth%3Fclient_id%3Dcli%26state%3Da%2526b#the-ticket",
  );
  expect(page.searchParams.get("next")).toBe("/oauth2/auth?client_id=cli&state=a%26b");
  // an authorization page elsewhere is no `next` the mind would honour
  const elsewhere = firstSignInPage("ada-labs.com", "t", new URL("https://evil.example/auth"));
  expect(elsewhere.toString()).toBe("https://iterate.ada-labs.com/keys/first#t");
});

test("the onboarding turn runs in the mind: it says hi to the onboarding agent and answers how the model's request ended", async () => {
  const said: string[] = [];
  const result = { status: "succeeded", text: "Welcome" };
  const itx = {
    agents: {
      get: (path: string) => ({
        message: async (text: string) => {
          said.push(`${path}: ${text}`);
          return { offset: 7 };
        },
      }),
    },
    cd: () => ({
      readEvents: async () => ({
        events: [
          { type: "events.iterate.com/agent/llm-request-started", payload: {} },
          { type: "events.iterate.com/agent/llm-request-settled", payload: { result } },
        ],
      }),
    }),
  };
  // the script is text for the mind: here it runs as the function it spells
  const turn = runInNewContext(`(${onboardingTurnScript()})`, { setTimeout });
  expect(await turn(itx)).toEqual(result);
  expect(said).toEqual(["/agents/onboarding: hi"]);
});

test("the MCP server goes to Claude Code and Codex for the whole user, under the mind's own name", () => {
  expect(
    mcpInstalls("ada-labs.com").map(({ command, args }) => [command, ...args].join(" ")),
  ).toEqual([
    "claude mcp add --transport http --scope user ada-labs-com https://iterate.ada-labs.com/mcp",
    "codex mcp add ada-labs-com --url https://iterate.ada-labs.com/mcp",
  ]);
});
