// merge.ts — MERGING a commit someone else made into the text being edited, the way git merges:
// ours and theirs both changed base. The result goes into the live text as small edits, so people
// typing elsewhere in the doc, even in the same sentence, keep their keystrokes. `diff3Merge` is
// node-diff3's (https://github.com/bhousel/node-diff3), `diffChars` is jsdiff's
// (https://github.com/kpdecker/jsdiff).
import { diffChars } from "diff";
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
 *  it left it: what a `Y.Text` applies one by one. */
export function textEdits(from: string, to: string) {
  const edits: ({ at: number; insert: string } | { at: number; delete: number })[] = [];
  let at = 0;
  for (const part of diffChars(from, to)) {
    if (part.added) {
      edits.push({ at, insert: part.value });
      at += part.value.length;
    } else if (part.removed) edits.push({ at, delete: part.value.length });
    else at += part.value.length;
  }
  return edits;
}
