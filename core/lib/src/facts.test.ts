import { expect, test } from "vitest";
import { FACTS_HEADER, recordFacts, withFacts } from "./facts.ts";

test("a fact that records an act: the answer goes on at once, stored or not", async () => {
  const appended: unknown[] = [];
  const kept = recordFacts(answered(), async (path, events) => appended.push([path, events]));
  expect(kept.answer).toBeInstanceOf(Response);
  await kept.recorded;
  expect(appended).toEqual([["/integrations/x", [event]]]);

  const { answer, recorded } = recordFacts(answered(), lost);
  await recorded;
  expect(await answer).toMatchObject({ status: 200 });
});

test("a fact that is the act: the answer waits for the store, and is a 503 when it fails", async () => {
  let store = () => {};
  const { answer } = recordFacts(answered(true), () => new Promise<void>((done) => (store = done)));
  let gone = false;
  void Promise.resolve(answer).then(() => (gone = true));
  await new Promise((turn) => setTimeout(turn, 0));
  expect(gone).toBe(false);
  store();
  const stored = await answer;
  expect({ status: stored.status, facts: stored.headers.has(FACTS_HEADER) }).toEqual({
    status: 200,
    facts: false,
  });

  const refused = await recordFacts(answered(true), lost).answer;
  expect({ status: refused.status, facts: refused.headers.has(FACTS_HEADER) }).toEqual({
    status: 503,
    facts: false,
  });
  // the Cloud's queue reads `refused`, and tries again for anything but "seen" or "expired"
  expect(await refused.json()).toEqual({ refused: expect.stringMatching(/send the same request/) });
});

const event = { type: "x/said", payload: { text: "hello" } };

function answered(storeFirst?: true) {
  return withFacts(Response.json({ ok: true }), [
    { path: "/integrations/x", events: [event], storeFirst },
  ]);
}

function lost() {
  return Promise.reject(new Error("the log could not be reached"));
}
