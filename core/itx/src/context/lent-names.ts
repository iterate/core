// lent-names.ts — A LENT NAME NEVER TAKES A NAME OF THE PLATFORM'S. A lend is a rule of the
// context's table that points at a live stub, and a rule is read before a built-in root. So a stub
// lent as `itx.secrets` would get every call of `itx.secrets.set(…)` made after it, with the clear
// value, and one lent as `itx.config.x` would stand in for the mind's own code. The one who lends
// is outside the mind: a bridge with a key of its own, or a process a member started.
import {
  canonicalItxExpressionPrefix,
  type ItxExpressionInput,
  itxExpressionStepName,
  normalizedItxExpression,
  parseItxExpressionPrefix,
} from "iterate/expression";

/** Whether a resolved call is the stub lent as `match` and nothing past it:
 *  `itx.builtins.rpcStubs.get(match)`, which is how the table names a lent stub. A call that goes
 *  on from that stub (`….get(match).inner`) came through another rule, and is not this lend. */
export function isLendOf(resolved: ItxExpressionInput, match: ItxExpressionInput): boolean {
  const [scope, builtins, stubs, get, ...further] = normalizedItxExpression(resolved);
  return (
    further.length === 0 &&
    scope === "itx" &&
    builtins === "builtins" &&
    stubs === "rpcStubs" &&
    Array.isArray(get) &&
    get[0] === "get" &&
    get[1] === canonicalItxExpressionPrefix(match)
  );
}

/** Why a live stub is not lent at `match`, or null when it may be. `roots` are the names that are
 *  the platform's at the mind's root (`implicitRootsAt("/")`): the kernel's and the host's. */
export function lendRefusal(match: ItxExpressionInput, roots: ReadonlySet<string>): string | null {
  const steps = parseItxExpressionPrefix(match);
  const name = itxExpressionStepName(steps[1]);
  if (steps[0] !== "itx" || !name) return "a lend names what it lends, as itx.<name>";
  // `builtins` is how the table itself names a root, and `config` is the mind's own code
  if (name === "builtins" || name === "config" || roots.has(name))
    return `itx.${name} is the platform's own name, and a lent stub never takes it: lend under a name of your own`;
  return null;
}
