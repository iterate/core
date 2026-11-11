import { RpcTarget } from "capnweb";
import { type ClientRpcStub, isLendOf, type IterateContextRpcTarget, lendRefusal } from "core-itx";
import { canonicalItxExpressionPrefix, type ItxExpressionInput } from "iterate/expression";
import { codedError, errorCode } from "iterate/lib";
import type { Lender } from "iterate/principal";

/** WHAT A KEY'S TOKEN REACHES (core/auth-worker/src/key-tokens.ts): the one lend a member allowed
 *  its key, and nothing of the mind. `iterate provide --key` runs against it: `whoami` proves the
 *  session and keeps it alive, `provide` lends. Every other name of `itx` is absent. */
export class LenderRoot extends RpcTarget {
  readonly #root: Pick<IterateContextRpcTarget, "provide" | "invoke">;
  readonly #lender: Lender;
  readonly #platformNames: ReadonlySet<string>;

  /** `platformNames`: the names that are the platform's at the mind's root, which no key lends. */
  constructor(
    root: Pick<IterateContextRpcTarget, "provide" | "invoke">,
    lender: Lender,
    platformNames: ReadonlySet<string>,
  ) {
    super();
    this.#root = root;
    this.#lender = lender;
    this.#platformNames = platformNames;
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
    // A key enrolled before the auth Worker refused such a name, or by a stack whose auth Worker
    // is older than its mind: the kernel refuses the lend too, and this says it of the key.
    const refused = lendRefusal(own, this.#platformNames);
    if (refused) throw codedError("FORBIDDEN", `this key lends nothing: ${refused}`);
    if (!target || typeof target === "string" || Array.isArray(target))
      throw codedError("FORBIDDEN", `this key lends its own functions as ${own}: a live stub`);
    if (Object.keys(options).some((option) => option !== "description"))
      throw codedError("FORBIDDEN", "this key's lend takes a description and no other option");
    const description =
      typeof options.description === "string" ? { description: options.description } : {};
    return this.#nameInTheTable(own).then((mine) => {
      if (!mine)
        throw codedError(
          "FORBIDDEN",
          `this key lends nothing: ${own} is a name this mind uses already, and a lent stub never takes it`,
        );
      // The cast: `target` came off the wire. The checks above left an object or a function,
      // which is what capnweb hands over for a stub, and the kernel's lend refuses anything else.
      return this.#root.provide(own, target as ClientRpcStub, description);
    });
  }

  /** WHETHER THE NAME IS THE KEY'S TO TAKE, BY THE MIND'S OWN TABLE: nothing answers at it, or the
   *  key's lend from before does. A row of the mind's own at it or above it (`itx.agents`, from an
   *  app) is not a built-in root, so only the table knows it. A table that cannot be read lends
   *  nothing. */
  async #nameInTheTable(own: string): Promise<boolean> {
    try {
      const chain = await this.#root.invoke(["itx", "builtins", "rewriteRules", ["resolve", own]]);
      const resolved: unknown = Array.isArray(chain) ? chain.at(-1) : undefined;
      return typeof resolved === "string" && isLendOf(resolved, own);
    } catch (error) {
      if (errorCode(error) === "NO_ITX_EXPRESSION_MATCH") return true;
      throw error;
    }
  }
}
