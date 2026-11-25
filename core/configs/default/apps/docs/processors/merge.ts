// merge.ts — MERGING a commit someone else made into the text being edited, the way git merges:
// ours and theirs both changed base. The result goes into the live text as small edits, so people
// typing elsewhere in the doc, even in the same sentence, keep their keystrokes. `diff3Merge` is
// node-diff3's (https://github.com/bhousel/node-diff3), `diffChars` is jsdiff's
// (https://github.com/kpdecker/jsdiff).
import { diffChars, diffLines } from "diff";
import * as nodeDiff3 from "node-diff3";
import { z } from "zod";

// WHERE THE PACKAGE'S FUNCTIONS ARE depends on who loaded it, so they are looked for in each place:
// - Node and a bundler give them as named exports;
// - esm.sh may serve them as a single `default`, an object of its functions;
// - esm.sh's browser build has an EMPTY `default`, and puts them on `globalThis.Diff3`.
// Looked for at the first merge, not when this module loads: a doc that needs no merge opens
// whatever the package looks like.
/** A place that holds node-diff3's functions: one of the places above. */
const Diff3 = z.object({
  diff3Merge: z.custom<typeof nodeDiff3.diff3Merge>((value) => typeof value === "function"),
});
type Diff3 = z.infer<typeof Diff3>;

/** node-diff3's functions from the first of `places` that holds them; the places are the
 *  package's named exports, its `default` and `globalThis.Diff3`, unless a test names others. */
export function diff3(
  places: unknown[] = [
    nodeDiff3,
    Reflect.get(nodeDiff3, "default"),
    Reflect.get(globalThis, "Diff3"),
  ],
): Diff3 {
  const found = places
    .map((place) => Diff3.safeParse(place))
    .find((parsed) => parsed.success)?.data;
  if (!found)
    throw new Error(
      "docs: the package node-diff3 has no diff3Merge as a named export, on its default or on globalThis.Diff3 (apps/docs/processors/merge.ts)",
    );
  return found;
}

/** ours + theirs over base, line by line. Where both changed the same lines, ours stays: a doc
 *  never shows conflict markers. `conflicts` says how many places that happened. */
export function mergeText(ours: string, base: string, theirs: string) {
  const regions = diff3().diff3Merge(ours.split("\n"), base.split("\n"), theirs.split("\n"), {
    excludeFalseConflicts: true,
  });
  return {
    text: regions.flatMap((region) => region.ok || region.conflict!.a).join("\n"),
    conflicts: regions.filter((region) => region.conflict).length,
  };
}

/** The edits that turn `from` into `to`, in order, each position in the text as the edits before
 *  it left it: what a `Y.Text` applies one by one. The texts are compared by line, and only the
 *  lines that changed by character: a character diff of two whole files costs seconds of CPU once
 *  they differ in many places (26,000 characters, 50 changed groups of lines: 1.8 s), and the
 *  processor's invocation has no seconds. */
export function textEdits(from: string, to: string) {
  const edits: ({ at: number; insert: string } | { at: number; delete: number })[] = [];
  let at = 0;
  const parts = diffLines(from, to);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const next = parts[index + 1];
    if (part.removed && next?.added) {
      // lines that were replaced: the characters that changed in them
      for (const edit of replacedTextEdits(part.value, next.value)) {
        if ("insert" in edit) {
          edits.push({ at, insert: edit.insert });
          at += edit.insert.length;
        } else if ("delete" in edit) edits.push({ at, delete: edit.delete });
        else at += edit.keep;
      }
      index++;
    } else if (part.removed) edits.push({ at, delete: part.value.length });
    else if (part.added) {
      edits.push({ at, insert: part.value });
      at += part.value.length;
    } else at += part.value.length;
  }
  return edits;
}

/** How many characters two replaced groups of lines may differ by and still be compared by
 *  character. Past it the group is replaced whole: the cost of the comparison grows with the square
 *  of this number, and at 1,000 it is under 100 ms. */
const MOST_CHANGED_CHARACTERS = 1_000;

function replacedTextEdits(
  from: string,
  to: string,
): ({ insert: string } | { delete: number } | { keep: number })[] {
  const changes = diffChars(from, to, { maxEditLength: MOST_CHANGED_CHARACTERS });
  if (!changes) return [{ delete: from.length }, { insert: to }];
  return changes.map((change) =>
    change.added
      ? { insert: change.value }
      : change.removed
        ? { delete: change.value.length }
        : { keep: change.value.length },
  );
}
