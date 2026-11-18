// identity-delivery.ts — THE BOUNDARY DELIVERS THE MIND'S IDENTITY FACTS TO `/`. The auth Worker
// accepts a signed record of the mind's identity into its own rows (core/auth-worker
// src/identity.ts), which are the authority. The mind's root context holds each accepted record
// and each refusal as an event: a copy that decides nothing. The auth Worker cannot reach the
// mind, so the boundary carries each fact over: it asks the auth Worker for the facts that are
// not delivered, appends their events on `/` as the platform, and only then tells the auth
// Worker which are stored. A fact goes as a value of an RPC call, never in a header: its size
// is a record's, and a header that is not read would look like no fact.
//
// DELIVERY IS BEST EFFORT, AND IN ORDER. Nothing waits for it: the answer to a record that was
// posted is the auth Worker's own, and it goes out at once, while the delivery runs after it. A
// fact that could not be appended stays owed in the auth Worker's rows, and the next record that
// anyone posts delivers it, as the same event under the same key.
import type { AuthService, MindTarget } from "iterate/workers";

/** How often one request asks for more: each answer holds a few facts. What is left is
 *  delivered at the next request to the intake. */
const ROUNDS = 8;

/** Delivers the identity facts that are not delivered, and says whether none is left owed. Each
 *  fact is one append, marked once it resolved. THE FACTS OF ONE MIND ID KEEP THEIR ORDER: `/`
 *  folds a record only after the one before it, so after an append of a mind id's fact failed,
 *  no later fact of that id is appended in this delivery. The facts of other mind ids, and the
 *  refusals, go on. Never throws: what failed is one line of the log. */
export async function identityFactsDelivered(
  auth: Pick<AuthService, "identityFactsToDeliver" | "identityFactsDelivered">,
  append: (events: Parameters<MindTarget["append"]>[1]) => Promise<unknown>,
): Promise<boolean> {
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const facts = await auth.identityFactsToDeliver();
      if (facts.length === 0) return true;
      const stored: string[] = [];
      const failed: { id: string; error: string }[] = [];
      const mindsToLeave = new Set<string>();
      for (const fact of facts) {
        if (fact.mind && mindsToLeave.has(fact.mind)) continue;
        try {
          await append([fact.event]);
          stored.push(fact.id);
        } catch (error) {
          failed.push({ id: fact.id, error: String(error).slice(0, 200) });
          if (fact.mind) mindsToLeave.add(fact.mind);
        }
      }
      if (stored.length > 0) await auth.identityFactsDelivered(stored);
      if (failed.length > 0) {
        console.warn({
          event: "boundary.identity-facts-owed",
          message:
            "identity facts could not be appended on / and stay owed: the next record posted to the intake delivers them",
          failed,
        });
        return false;
      }
    }
    return (await auth.identityFactsToDeliver()).length === 0;
  } catch (error) {
    console.warn({
      event: "boundary.identity-facts-owed",
      message:
        "the delivery of identity facts to / stopped and what is left stays owed: the next record posted to the intake delivers it",
      error: String(error).slice(0, 200),
    });
    return false;
  }
}

/** THE ANSWER TO A RECORD THAT WAS POSTED TO THE INTAKE: the auth Worker's own answer, as it
 *  is, at once. The answer says what the auth Worker's rows say. Whether the mind's own log
 *  holds the record yet changes nothing of it: nothing decides by that log, so the answer does
 *  not wait for it. The delivery runs after the answer, under `waitUntil` (the request's
 *  `ctx.waitUntil`), and is bounded by `ROUNDS`. */
export function identityIntakeAnswer(
  answer: Response,
  auth: Pick<AuthService, "identityFactsToDeliver" | "identityFactsDelivered">,
  append: (events: Parameters<MindTarget["append"]>[1]) => Promise<unknown>,
  waitUntil: (work: Promise<unknown>) => void,
): Response {
  waitUntil(identityFactsDelivered(auth, append));
  return answer;
}
