import { GATE_LOCKED, GATE_UNLOCKED } from "iterate/acts";
import { expect, test } from "vitest";
import { actRules } from "./acts-page.ts";

test.for([
  {
    locked: false,
    state: "<strong>These rules are open.</strong>",
    opener: '<button type="button" data-opens="lock-dialog">Lock these rules</button>',
    title: "Lock the rules for mail and calls?",
    signs: `<button type="button" data-lock="${GATE_LOCKED}">Lock with passkey</button>`,
    means: "can no longer add, change or remove these rules",
  },
  {
    locked: true,
    state: "<strong>These rules are locked.</strong>",
    opener:
      '<button type="button" class="outline" data-opens="lock-dialog">Unlock these rules</button>',
    title: "Unlock the rules for mail and calls?",
    signs: `<button type="button" data-lock="${GATE_UNLOCKED}">Unlock with passkey</button>`,
    means: "can then add, change and remove these rules with no signature",
  },
])(
  "rules locked: $locked. A real button beside the state opens a dialog that says what the press means, and the dialog's own button signs",
  ({ locked, state, opener, title, signs, means }) => {
    const html = actRules({ rules: [], proposed: [], held: [], locked });
    // the state and its button are the first thing under the part's heading
    expect(html.indexOf(state)).toBeGreaterThan(-1);
    expect(html.indexOf(state)).toBeLessThan(html.indexOf("A mail, or a call of a verb"));
    // a button, not a button that is drawn as a link
    expect(html).toContain(`${opener}</div>`);
    const dialog = /<dialog id="lock-dialog"[^>]*>([\s\S]*?)<\/dialog>/.exec(html)?.[1] || "";
    expect(dialog).toContain(`>${title}</h2>`);
    expect(dialog).toContain(means);
    // Cancel is first, so it has the focus when the dialog opens, and the signing button is last
    expect(dialog).toContain(
      `<button type="button" class="outline" data-close>Cancel</button> ${signs}</p>`,
    );
    // one button on the page signs for the lock, and it is inside the dialog
    expect(html.match(/data-lock=/g)).toHaveLength(1);
    expect(html.replace(/<dialog[\s\S]*?<\/dialog>/, "")).not.toContain("data-lock");
  },
);
