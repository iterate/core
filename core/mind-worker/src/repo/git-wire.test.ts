import { expect, test } from "vitest";
import { encodeCommit, manifestOf, type RawGitObject } from "./git-wire.ts";

const PLATFORM = { name: "iterate", email: "iterate@example.com" };

test("a commit's author and committer are one line each: a name or address that would start another is refused", () => {
  const commit = (author: { name: string; email: string }) =>
    new TextDecoder().decode(
      encodeCommit({
        author: { ...author, date: new Date(0) },
        committer: PLATFORM,
        message: "a change",
        parents: [],
        tree: "a".repeat(40),
      }),
    );
  expect(commit({ name: "Ada", email: "ada@example.net" })).toBe(
    `tree ${"a".repeat(40)}\nauthor Ada <ada@example.net> 0 +0000\ncommitter iterate <iterate@example.com> 0 +0000\n\na change`,
  );
  // a line break ends the header early, and the real committer's line falls into the message
  for (const author of [
    { name: "Ada", email: "ada@example.net\n\ncommitter someone <else@example.net> 0 +0000" },
    { name: "Ada\ncommitter someone <else@example.net> 0 +0000", email: "ada@example.net" },
    { name: "Ada", email: "ada@example.net> 0 +0000\rx <y" },
    { name: "Ada <ada@example.org>", email: "ada@example.net" },
    { name: "Ada\0", email: "ada@example.net" },
  ])
    expect(() => commit(author)).toThrow("one line");
});

test("a tree that names one subtree many times over is refused, not expanded without end", () => {
  // 20 levels, each naming the level below twice: 2^20 files from 20 small objects
  const objects = new Map<string, RawGitObject>();
  const oidOf = (level: number) => level.toString(16).padStart(40, "0");
  const tree = (entries: [mode: string, name: string, oid: string][]) =>
    Uint8Array.from(
      entries.flatMap(([mode, name, oid]) => [
        ...new TextEncoder().encode(`${mode} ${name}\0`),
        ...oid.match(/../g)!.map((byte) => Number.parseInt(byte, 16)),
      ]),
    );
  objects.set(oidOf(0), {
    oid: oidOf(0),
    type: "tree",
    payload: tree([["100644", "file", "f".repeat(40)]]),
  });
  for (let level = 1; level <= 20; level += 1)
    objects.set(oidOf(level), {
      oid: oidOf(level),
      type: "tree",
      payload: tree([
        ["40000", "a", oidOf(level - 1)],
        ["40000", "b", oidOf(level - 1)],
      ]),
    });
  expect(() => manifestOf([{ mode: "40000", name: "root", oid: oidOf(20) }], objects)).toThrow(
    "more than 200000 files",
  );
  // an ordinary tree is read as before
  expect([...manifestOf([{ mode: "40000", name: "root", oid: oidOf(2) }], objects).keys()]).toEqual(
    ["root/a/a/file", "root/a/b/file", "root/b/a/file", "root/b/b/file"],
  );
});
