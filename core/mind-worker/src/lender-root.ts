import { RpcTarget } from "capnweb";
import type { ClientRpcStub, IterateContextRpcTarget } from "core-itx";
import { canonicalItxExpressionPrefix, type ItxExpressionInput } from "iterate/expression";
import { codedError } from "iterate/lib";
import type { Lender } from "iterate/principal";

/** WHAT A KEY'S TOKEN REACHES (core/auth-worker/src/key-tokens.ts): the one lend a member allowed
 *  its key, and nothing of the mind. `iterate provide --key` runs against it: `whoami` proves the
 *  session and keeps it alive, `provide` lends. Every other name of `itx` is absent. */
export class LenderRoot extends RpcTarget {
  readonly #root: Pick<IterateContextRpcTarget, "provide">;
  readonly #lender: Lender;

  constructor(root: Pick<IterateContextRpcTarget, "provide">, lender: Lender) {
    super();
    this.#root = root;
    this.#lender = lender;
  }

  whoami() {
    const { actor, provide } = this.#lender;
    return { path: "/", principal: { actor }, lends: `itx.${provide}` };
  }

  /** A live stub at the key's own name, with a description. A row would name something of the
   *  mind's as the key's own, and a fetch route would open the mind's hostname to the key. */
  provide(match: ItxExpressionInput, target: unknown, options: { description?: unknown } = {}) {
    const own = `itx.${this.#lender.provide}`;
    if (canonicalItxExpressionPrefix(match) !== canonicalItxExpressionPrefix(own))
      throw codedError("FORBIDDEN", `this key lends ${own} and nothing else`);
    if (!target || typeof target === "string" || Array.isArray(target))
      throw codedError("FORBIDDEN", `this key lends its own functions as ${own}: a live stub`);
    if (Object.keys(options).some((option) => option !== "description"))
      throw codedError("FORBIDDEN", "this key's lend takes a description and no other option");
    return this.#root.provide(
      own,
      target as ClientRpcStub,
      typeof options.description === "string" ? { description: options.description } : {},
    );
  }
}
