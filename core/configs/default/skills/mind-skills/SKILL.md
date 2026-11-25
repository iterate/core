---
name: mind-skills
description: Add, change or remove a skill of this iterate mind, so that every agent connected to the mind's MCP server gets it. Use when someone asks to save a workflow as a skill, to import a skill from GitHub or a file, or asks which skills the mind serves.
---

# The skills of this mind

A skill is a folder under `skills/` of the config repo (`/repos/config`) with a `SKILL.md` in it.
The mind's MCP server (`iterate.<domain>/mcp`; `mcp.ts` hands it the folder) serves each one to
its members' agents:
as a resource `skill://<name>/SKILL.md`, and through MCP's Skills extension (`skills/list`,
`skills/get`). Add a skill once, and every agent that a member connects to the mind can load it.

## The format

The format is the Agent Skills specification (https://agentskills.io/specification):

- The folder's name is the skill's name: lowercase letters, digits and single hyphens, at most 64
  characters.
- `SKILL.md` begins with YAML frontmatter that has `name` (the folder's name) and `description`
  (what the skill does and when to use it, at most 1024 characters).
- The server reads plain YAML alone: `key: value`, quoted values, a block (`description: >-`),
  one map of values (`metadata:`) and a list of values. Quote a value that YAML could read as a
  number, a date or a boolean.
- Other files of the folder (`references/`, `scripts/`, `assets/`) are served beside it. Link them
  from `SKILL.md` by relative path.
- One skill has at most 512 files and 16 MiB.

A `SKILL.md` that breaks a rule is not served. The `skills/list` answer names it and says why,
under `_meta["com.iterate/skills-left-out"]`.

## Add or change a skill

Commit the files to the config repo with the `run` tool. The mind publishes a few seconds later,
and the next `skills/list` has the skill.

```js
async (itx) => {
  const repo = itx.repos.get("/repos/config");
  const tip = await repo.tip();
  return repo.commitFiles({
    message: "Add the skill release-notes\n\nVia: <your name>",
    parent: tip,
    changes: [
      {
        path: "skills/release-notes/SKILL.md",
        content:
          "---\nname: release-notes\ndescription: Write release notes from merged pull requests. Use before a release.\n---\n\n# Release notes\n\n…",
      },
    ],
  });
};
```

To remove a skill, delete its files (`{ path, delete: true }`). Keep `skills/README.md`: the folder
must hold one file while `mcp.ts` imports it, and that file is in no skill.

## A skill from somewhere else

To import a skill from GitHub or another place, fetch its files in the script
(`await itx.fetch(new Request(url))`) and commit them under `skills/<name>/`.

Read the skill before you commit it, and show it to the person who asked. A skill is text that
other agents will follow, so a skill from an unknown author can carry instructions that the person
does not want. The mind runs nothing from a skill: the agent that loads it decides what its text
and its scripts may do.
