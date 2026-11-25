// mcp-skills.ts — THE SKILLS OF AN MCP SERVER, as the platform serves them (./mcp.ts answers the
// calls).
//
// A SKILL IS A FOLDER WITH A `SKILL.md` (https://agentskills.io/specification). The files are a
// folder that the config's code hands over (iterate/sdk `McpServerTarget.skills`): in a config,
// `import skills from "./skills/"`. So a skill is added by a commit to the config repo.
//
// THE WIRE FORMAT is MCP's Skills extension, `io.modelcontextprotocol/skills` (SEP-2640,
// https://skills.extensions.modelcontextprotocol.io/specification/beta/skills): each file is a
// resource `skill://<folder>/<file>`, and `skills/list` and `skills/get` answer one entry for
// each skill with its frontmatter and the digest and size of every file.
//
// A SKILL'S TEXT IS DATA. This code reads the frontmatter and hands the bytes over. It runs
// nothing from a skill and gives a skill no reach: a skill copied from somewhere else is as
// untrusted here as it was there, and the client that loads it decides what its text may do.
import { bytesToBase64 } from "iterate/lib";
import { z } from "zod";
import { readFrontmatter } from "./mcp-skill-frontmatter.ts";

/** A folder as the platform's loader makes it: every file under it, by path (../../files.d.ts). */
export type SkillFiles = Record<string, string | Uint8Array>;

type SkillResource = { uri: string; digest: string; size: number };

/** One entry of `skills/list`, and the answer of `skills/get`. */
export type Skill = {
  uri: string;
  frontmatter: { name: string; description: string; [key: string]: unknown };
  resources: SkillResource[];
};

/** One file as `resources/list` names it. */
type Resource = { uri: string; name: string; description?: string; mimeType: string; size: number };

/** One file as `resources/read` answers it. */
type ResourceContents =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string };

export type SkillCatalog = {
  skills: Skill[];
  resources: Resource[];
  contents: Map<string, ResourceContents>;
  /** A `SKILL.md` that is served as no skill, and why: `skills/list` tells the client. */
  leftOut: { path: string; why: string }[];
};

// The extension's limits for one skill: what every client that follows it accepts.
const MAX_SKILL_RESOURCES = 512;
const MAX_SKILL_BYTES = 16 * 1024 * 1024;

// The Agent Skills specification's rules for the two fields that a skill must have. Every other
// field passes through as the author wrote it.
const Frontmatter = z.looseObject({
  name: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  // checked and never changed: a client compares the frontmatter it parses with this one, so a
  // block's last line break stays
  description: z.string().max(1024).regex(/\S/),
});

const MIME_TYPES: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  css: "text/css",
  csv: "text/csv",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/typescript",
  py: "text/x-python",
  sh: "application/x-sh",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

const mimeTypeOf = (path: string, content: string | Uint8Array) =>
  MIME_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ||
  (typeof content === "string" ? "text/plain" : "application/octet-stream");

const uriOf = (path: string) => `skill://${path.split("/").map(encodeURIComponent).join("/")}`;

/** The YAML between the two `---` lines at the top of a `SKILL.md`, as the author wrote it. */
function frontmatterOf(skillMd: string | Uint8Array) {
  if (typeof skillMd !== "string") return { why: "SKILL.md is not text" };
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillMd);
  if (!block) return { why: "SKILL.md does not begin with YAML frontmatter" };
  const read = readFrontmatter(block[1]);
  if ("why" in read) return read;
  const parsed = Frontmatter.safeParse(read.value);
  if (!parsed.success)
    return {
      why: `the frontmatter needs a name (lowercase letters, digits and single hyphens, at most 64 characters) and a description (at most 1024 characters): ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    };
  return { frontmatter: parsed.data };
}

/** Every skill under `files`, with the resources of each. A `SKILL.md` that is no valid skill
 *  is in `leftOut` with the reason, and its files are served as no resource. A file that is in
 *  no skill's folder is not served either. */
export async function skillCatalog(files: SkillFiles): Promise<SkillCatalog> {
  const catalog: SkillCatalog = { skills: [], resources: [], contents: new Map(), leftOut: [] };
  const paths = Object.keys(files).sort();
  const encoder = new TextEncoder();
  for (const skillMdPath of paths) {
    if (skillMdPath !== "SKILL.md" && !skillMdPath.endsWith("/SKILL.md")) continue;
    const folder = skillMdPath.slice(0, -"/SKILL.md".length);
    const leaveOut = (why: string) => catalog.leftOut.push({ path: skillMdPath, why });
    if (!folder) {
      leaveOut("a skill is a folder: put SKILL.md in a folder that has the skill's name");
      continue;
    }
    const read = frontmatterOf(files[skillMdPath]);
    if ("why" in read) {
      leaveOut(read.why);
      continue;
    }
    const folderName = folder.slice(folder.lastIndexOf("/") + 1);
    if (read.frontmatter.name !== folderName) {
      leaveOut(`the name "${read.frontmatter.name}" is not the folder's name, "${folderName}"`);
      continue;
    }
    // a skill's files are everything under its folder, a skill inside it too
    const own = paths.filter((path) => path.startsWith(`${folder}/`));
    const bytesOf = new Map(
      own.map((path) => {
        const content = files[path];
        // a copy of a binary file: its bytes on a buffer of their own, which the digest takes
        return [
          path,
          typeof content === "string" ? encoder.encode(content) : new Uint8Array(content),
        ] as const;
      }),
    );
    const total = [...bytesOf.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
    if (own.length > MAX_SKILL_RESOURCES || total > MAX_SKILL_BYTES) {
      leaveOut(
        `${own.length} files of ${total} bytes: a skill has at most ${MAX_SKILL_RESOURCES} files and ${MAX_SKILL_BYTES} bytes`,
      );
      continue;
    }
    const resources: SkillResource[] = [];
    for (const path of own) {
      const content = files[path];
      const bytes = bytesOf.get(path) || new Uint8Array();
      const uri = uriOf(path);
      const mimeType = mimeTypeOf(path, content);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      resources.push({
        uri,
        digest: `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        size: bytes.byteLength,
      });
      // a file of a skill inside this one was listed with the outer skill already
      if (catalog.contents.has(uri)) continue;
      catalog.contents.set(
        uri,
        typeof content === "string"
          ? { uri, mimeType, text: content }
          : { uri, mimeType, blob: bytesToBase64(content) },
      );
      catalog.resources.push({
        uri,
        name: path.slice(path.lastIndexOf("/") + 1),
        mimeType,
        size: bytes.byteLength,
      });
    }
    catalog.skills.push({ uri: uriOf(skillMdPath), frontmatter: read.frontmatter, resources });
  }
  // a SKILL.md is listed under its skill's name and description, so a client that knows
  // resources and not the extension can still choose a skill
  for (const skill of catalog.skills) {
    const resource = catalog.resources.find((candidate) => candidate.uri === skill.uri);
    if (!resource) continue;
    resource.name = skill.frontmatter.name;
    resource.description = skill.frontmatter.description;
  }
  return catalog;
}
