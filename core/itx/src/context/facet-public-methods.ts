// Only the walk's first step is checked: later steps walk what that public member answered.
// The platform's own calls into a facet (delivery, revive, secrets, egress) take entries no walk reaches.
import { codedError } from "iterate/lib";
import { itxExpressionStepName, type ItxExpression } from "iterate/expression";

export function assertFacetMethodIsPublic(
  facetName: string,
  publicMethods: readonly string[],
  itxExpressionSteps: ItxExpression,
): void {
  const method = itxExpressionStepName(itxExpressionSteps[0]) ?? "";
  if (publicMethods.includes(method)) return;
  throw codedError(
    "FORBIDDEN",
    `facet "${facetName}": ${JSON.stringify(method)} is not one of its public methods (${publicMethods.join(", ") || "it lists none"}) — a facet's class lists what a caller reaches by itx expression in static publicMethods`,
  );
}

// WHAT ONE PERSON CAN ASK OF A CONTEXT THROUGH THEIR VIEW (../person-context.ts), the two numbers
// together: 120 calls of a person method a minute, each with arguments of at most 8 MiB of JSON
// (the ceiling of one event, ../stream/stream.ts `EVENT_BODY_MAX_CHARS`, which is the bound on a
// message through the view). So one person can make a context parse about 1 GiB a minute.
export const PERSON_CALLS_PER_MINUTE = 120;
export const PERSON_METHOD_MAX_CHARS = 8 * 1024 * 1024;

/** THE COUNT OF A PERSON'S CALLS, by the minute, in memory. Two places hold one each:
 *  - the context's object (./facet-host.ts), by person: every socket that a person holds to a
 *    context calls through that one object, so this count is exact, for all person methods of
 *    the context together, and is taken before a facet is started or asked anything;
 *  - a person's view (../person-context.ts), for its one socket: taken before the view reads the
 *    arguments, so a call over the count costs the Worker no JSON walk and no signature.
 *  No write and no await. An eviction forgets a count. */
export class PersonCallCount {
  #minute = 0;
  readonly #calls = new Map<string, number>();
  /** Counts one call of `actor` on the context at `path`, and refuses it over the count. */
  count(actor: string, path: string): void {
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== this.#minute) this.#calls.clear();
    this.#minute = minute;
    const calls = (this.#calls.get(actor) ?? 0) + 1;
    this.#calls.set(actor, calls);
    if (calls > PERSON_CALLS_PER_MINUTE)
      throw codedError(
        "PERSON_CALL_LIMIT",
        `more than ${PERSON_CALLS_PER_MINUTE} calls of a person's methods on ${path} in one minute: ask again in the next minute`,
      );
  }
}

/** A PERSON'S CALL (a caller with no principal that names a person: ../on-behalf-of.ts `askerOf`)
 *  reaches one method call that the class lists in `static personMethods` and in
 *  `static publicMethods`, and nothing past it: a person never reaches what a member's session
 *  could not, whatever the class lists. Never `fetch`, which every class lists as public: a
 *  Request names nobody, and the kernel would build it from the person's arguments. This is the
 *  one check of a person's call, in place of `assertFacetMethodIsPublic`, so its refusal names
 *  only what the class offers a person. A class that lists none stays out of a person's reach. */
export function assertFacetMethodIsAPersons(
  facetName: string,
  publicMethods: readonly string[],
  personMethods: readonly string[],
  itxExpressionSteps: ItxExpression,
): void {
  const offered = personMethods.filter((name) => name !== "fetch" && publicMethods.includes(name));
  const [step] = itxExpressionSteps;
  const method = itxExpressionStepName(step) ?? "";
  if (itxExpressionSteps.length === 1 && Array.isArray(step) && offered.includes(method)) return;
  throw codedError(
    "FORBIDDEN",
    `facet "${facetName}": ${JSON.stringify(method)} is not one call of a method it offers a person (${offered.join(", ") || "it lists none"}) — a facet's class lists what a person's view of its context may call in static personMethods`,
  );
}
