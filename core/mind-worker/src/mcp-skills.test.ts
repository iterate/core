// mcp-skills.test.ts — the skills catalog of an MCP server (./mcp-skills.ts) and the reader of a
// SKILL.md's frontmatter (./mcp-skill-frontmatter.ts).
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { readFrontmatter } from "./mcp-skill-frontmatter.ts";
import { skillCatalog } from "./mcp-skills.ts";

test("each folder with a SKILL.md is a skill, with the digest and size of every file under it", async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const files = {
    "README.md": "in no skill",
    "refunds/SKILL.md": skillMd("refunds"),
    "refunds/assets/a b.png": png,
    "refunds/references/policy.md": "# Policy",
  };
  const { skills, resources, contents, leftOut } = await skillCatalog(files);
  expect(leftOut).toEqual([]);
  expect(skills).toEqual([
    {
      uri: "skill://refunds/SKILL.md",
      frontmatter: { name: "refunds", description: "What refunds does." },
      resources: [
        { uri: "skill://refunds/SKILL.md", digest: sha256(files["refunds/SKILL.md"]), size: 65 },
        { uri: "skill://refunds/assets/a%20b.png", digest: sha256(png), size: 4 },
        { uri: "skill://refunds/references/policy.md", digest: sha256("# Policy"), size: 8 },
      ],
    },
  ]);
  // a file in no skill's folder is no resource; a SKILL.md is listed under its skill's name
  expect(resources.map((resource) => [resource.uri, resource.name, resource.mimeType])).toEqual([
    ["skill://refunds/SKILL.md", "refunds", "text/markdown"],
    ["skill://refunds/assets/a%20b.png", "a b.png", "image/png"],
    ["skill://refunds/references/policy.md", "policy.md", "text/markdown"],
  ]);
  expect(contents.get("skill://refunds/assets/a%20b.png")).toEqual({
    uri: "skill://refunds/assets/a%20b.png",
    mimeType: "image/png",
    blob: "iVBORw==",
  });
  expect(contents.has("skill://README.md")).toBe(false);
});

test("a SKILL.md that is no valid skill is left out, with the reason", async () => {
  const many: Record<string, string> = { "many/SKILL.md": skillMd("many") };
  for (let index = 0; index < 512; index++) many[`many/files/${index}.txt`] = "";
  const { skills, resources, leftOut } = await skillCatalog({
    "SKILL.md": skillMd("root"),
    "bare/SKILL.md": "# no frontmatter",
    "other/SKILL.md": skillMd("another-name"),
    "Upper/SKILL.md": skillMd("Upper"),
    "blank/SKILL.md": "---\nname: blank\ndescription: '  '\n---\n",
    "typed/SKILL.md": "---\nname: typed\ndescription: true\n---\n",
    ...many,
  });
  expect(skills).toEqual([]);
  expect(resources).toEqual([]);
  expect(Object.fromEntries(leftOut.map(({ path, why }) => [path, why]))).toEqual({
    "SKILL.md": expect.stringContaining("a skill is a folder"),
    "bare/SKILL.md": "SKILL.md does not begin with YAML frontmatter",
    "other/SKILL.md": 'the name "another-name" is not the folder\'s name, "other"',
    "Upper/SKILL.md": expect.stringContaining("the frontmatter needs a name"),
    "blank/SKILL.md": expect.stringContaining("description"),
    "typed/SKILL.md": expect.stringContaining("line 2: quote this value"),
    "many/SKILL.md": expect.stringMatching(/^513 files/),
  });
});

test("a description is served as the author wrote it: a block keeps its last line break", async () => {
  const { skills } = await skillCatalog({
    "block/SKILL.md": "---\nname: block\ndescription: |\n  Kept as written.\n---\n",
  });
  expect(skills[0]?.frontmatter).toEqual({ name: "block", description: "Kept as written.\n" });
});

test("the frontmatter reader: the YAML that a skill's fields need, and a refusal with the line for the rest", () => {
  expect(
    readFrontmatter(
      '# a comment\nname: "quoted \\"name\\""\n\ndescription: >-\n  Two lines that are\n  one sentence.\n\n  A second paragraph.\nlicense: \'it\'\'s MIT\'\nmetadata:\n  author: acme\n  version: "1.0"\nallowed-tools:\n  - Read\n  - "Bash(git:*)"',
    ),
  ).toEqual({
    value: {
      name: 'quoted "name"',
      description: "Two lines that are one sentence.\nA second paragraph.",
      license: "it's MIT",
      metadata: { author: "acme", version: "1.0" },
      "allowed-tools": ["Read", "Bash(git:*)"],
    },
  });
  for (const [yaml, why] of [
    ["name: 123\ndescription: d", /line 1: quote this value/],
    ["name: x\ndescription: 2026-01-01", /line 2: quote this value/],
    ["name: x\nmetadata:\n  version: 1.0", /line 3: quote this value/],
    ["name: x\nname: y", /line 2: the key name is there twice/],
    ["__proto__: x", /__proto__ is not read/],
    ["name: [a, b]", /line 1: quote this value/],
    ["  name: x", /line 1: expected `key: value`/],
  ] as const)
    expect(readFrontmatter(yaml)).toEqual({ why: expect.stringMatching(why) });
});

const skillMd = (name: string, description = `What ${name} does.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const sha256 = (content: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;
