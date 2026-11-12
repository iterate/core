import { GATE_LOCKED, GATE_UNLOCKED } from "iterate/acts";
import { expect, test } from "vitest";
import { actRules } from "./acts-page.ts";

test("Unlock is not where Lock was: open rules show Lock, and locked rules keep Unlock in a closed block", () => {
  const gate = { rules: [], proposed: [], held: [] };
  const open = actRules({ ...gate, locked: false });
  expect(open).toContain(`data-lock="${GATE_LOCKED}">Lock, signed</button>`);
  expect(open).not.toContain("<details");
  const locked = actRules({ ...gate, locked: true });
  // closed until a member opens it, so a second press where Lock was unlocks nothing
  expect(locked).toMatch(
    new RegExp(
      `<details><summary>Unlock these rules</summary>.*data-lock="${GATE_UNLOCKED}">Unlock, signed</button></p></details>`,
    ),
  );
  expect(locked).not.toContain("Lock, signed");
  // the page's script wires the one lock button that the page has
  expect([open, locked].map((html) => html.match(/data-lock=/g)?.length)).toEqual([1, 1]);
});
