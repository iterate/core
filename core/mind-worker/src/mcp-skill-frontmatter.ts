// mcp-skill-frontmatter.ts — THE YAML OF A `SKILL.md`'s FRONTMATTER, AS JSON (./mcp-skills.ts
// serves it).
//
// WHAT IT READS is the part of YAML that the Agent Skills specification's fields need:
//
//   name: a-plain-value            description: "quoted" or 'quoted'
//   description: >-                (also `>`, `|`, `|-`: a block of indented lines)
//     Two lines that are
//     one sentence.
//   metadata:                      (a map of plain or quoted values, one level)
//     author: acme
//   allowed-tools:                 (a list of plain or quoted values)
//     - Read
//
// WHAT IT REFUSES, WITH THE LINE: everything else, and every plain value that some YAML parser
// reads as something other than a string (`true`, `1.0`, `2026-01-01`, `no`). A client compares
// the frontmatter it parses from `SKILL.md` with the one this server lists, so a value read
// differently here would make the client drop the skill. A refused skill is not served, and
// `skills/list` says why: quote the value, and it is served.
//
// ./mcp-skills.test.ts has its samples.

type Value = string | string[] | Record<string, string>;
type Read<T> = { value: T } | { why: string };

// A plain value that a YAML 1.1 or 1.2 parser may read as null, a boolean, a number or a date.
const NOT_A_STRING =
  /^(~|null|true|false|yes|no|on|off|y|n|[-+]?(\.\d+|\d[\d_,]*(\.[\d_]*)?(e[-+]?\d+)?)|0x[\da-f_]+|0o?[0-7_]+|0b[01_]+|[-+]?\.(inf|nan)|[-+]?\d+(:\d+)+(\.\d*)?|\d{4}-\d\d?-\d\d?.*)$/i;

/** One value on one line: double-quoted, single-quoted, or plain. */
function scalar(text: string): Read<string> {
  if (text.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(text))
      return { why: "a double-quoted value must end the line" };
    try {
      // a JSON string means the same in YAML; YAML's other escapes are refused
      const value: unknown = JSON.parse(text);
      if (typeof value === "string") return { value };
    } catch {
      // refused below
    }
    return { why: 'a double-quoted value may use the escapes \\" \\\\ \\n \\t \\uXXXX alone' };
  }
  if (text.startsWith("'"))
    return /^'(?:[^']|'')*'$/.test(text)
      ? { value: text.slice(1, -1).replaceAll("''", "'") }
      : { why: "a single-quoted value must end the line" };
  if (/^[[\]{}&*!|>%@`#,?:-]/.test(text) || /: |:$| #|\t/.test(text))
    return { why: "quote this value: it has a character that YAML reads as syntax" };
  if (NOT_A_STRING.test(text))
    return { why: "quote this value: YAML reads it as a number, a date, a boolean or null" };
  return { value: text };
}

/** The lines under `key: |` or `key: >`, with `-` when the last line break is left off. */
function block(lines: string[], header: string): Read<string> {
  if (lines.length === 0) return { value: "" };
  if (lines[0] === "") return { why: "a block must not begin with an empty line" };
  const indent = /^ */.exec(lines[0])?.[0].length || 0;
  if (indent === 0) return { why: "the lines of a block must be indented, in spaces" };
  const content: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") content.push("");
    else if (line.startsWith(" ".repeat(indent)) && !/^[ \t]/.test(line.slice(indent)))
      content.push(line.slice(indent));
    else return { why: "every line of a block must have the same indentation, in spaces" };
  }
  let text = content[0];
  if (header.startsWith("|")) text = content.join("\n");
  else {
    // folded: a line break is a space, and an empty line is a line break
    let empty = 0;
    for (const line of content.slice(1)) {
      if (line === "") empty += 1;
      else {
        text += (empty ? "\n".repeat(empty) : " ") + line;
        empty = 0;
      }
    }
  }
  return { value: header.endsWith("-") ? text : `${text}\n` };
}

/** The frontmatter's YAML as a JSON object, or why this reader refuses it. */
export function readFrontmatter(yaml: string): Read<Record<string, Value>> {
  const lines = yaml.split(/\r?\n/);
  const frontmatter: Record<string, Value> = {};
  const isComment = (line: string) => /^[ \t]*#/.test(line);
  let at = 0;
  while (at < lines.length) {
    const refuse = (why: string, line = at) => ({ why: `frontmatter line ${line + 1}: ${why}` });
    if (lines[at].trim() === "" || isComment(lines[at])) {
      at += 1;
      continue;
    }
    const field = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(lines[at]);
    if (!field) return refuse("expected `key: value`, with no indentation");
    const key = field[1];
    const rest = (field[2] || "").trimEnd();
    if (Object.hasOwn(frontmatter, key)) return refuse(`the key ${key} is there twice`);
    // an assignment to this key would set the object's prototype, not a field
    if (key === "__proto__") return refuse("the key __proto__ is not read");
    // the lines that belong to this key: indented, empty, or the items of a list
    const first = at + 1;
    let end = first;
    while (end < lines.length && /^([ \t]|- |-$|$)/.test(lines[end])) end += 1;
    while (end > first && lines[end - 1].trim() === "") end -= 1;
    const under = lines.slice(first, end);

    if (/^[|>]-?$/.test(rest)) {
      const read = block(under, rest);
      if ("why" in read) return refuse(read.why, first);
      frontmatter[key] = read.value;
    } else if (rest) {
      if (under.some((line) => line.trim() !== "" && !isComment(line)))
        return refuse("a value on several lines: write it as a block, `>-`", first);
      const read = scalar(rest);
      if ("why" in read) return refuse(read.why);
      frontmatter[key] = read.value;
    } else {
      const own = under
        .map((line, index) => ({ line, at: first + index }))
        .filter(({ line }) => line.trim() !== "" && !isComment(line));
      if (own.length === 0) return refuse(`the key ${key} has no value`);
      const indent = /^ */.exec(own[0].line)?.[0] || "";
      const isList = own[0].line.slice(indent.length).startsWith("-");
      const list: string[] = [];
      const map: Record<string, string> = {};
      for (const { line, at: lineAt } of own) {
        if (!line.startsWith(indent) || /^[ \t]/.test(line.slice(indent.length)))
          return refuse("the lines under a key must have the same indentation, in spaces", lineAt);
        const item = /^- +(.+)$/.exec(line.slice(indent.length));
        const entry = /^([A-Za-z0-9_./-]+):[ \t]+(.+)$/.exec(line.slice(indent.length));
        const text = isList ? item?.[1] : indent && entry?.[2];
        if (!text)
          return refuse(
            isList ? "expected `- value`" : "expected an indented `key: value`, one level deep",
            lineAt,
          );
        const read = scalar(text.trimEnd());
        if ("why" in read) return refuse(read.why, lineAt);
        if (entry?.[1] === "__proto__") return refuse("the key __proto__ is not read", lineAt);
        if (isList) list.push(read.value);
        else if (entry && Object.hasOwn(map, entry[1]))
          return refuse(`the key ${entry[1]} is there twice`, lineAt);
        else if (entry) map[entry[1]] = read.value;
      }
      frontmatter[key] = isList ? list : map;
    }
    at = end;
  }
  return { value: frontmatter };
}
