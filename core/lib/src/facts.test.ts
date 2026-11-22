import { expect, test, vi } from "vitest";
import { FACTS_HEADER, recordFacts, withFacts } from "./facts.ts";
import { codedError } from "./lib.ts";

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

test("a record whose key already names an event reached the log before: info, never an issue; the act itself is still a 503", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const issue = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { answer, recorded } = recordFacts(answered(), reachedBefore);
    await recorded;
    expect(await answer).toMatchObject({ status: 200 });
    expect(issue).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "facts.reached-before", path: "/integrations/x" }),
    );

    const refused = await recordFacts(answered(true), reachedBefore).answer;
    expect(refused).toMatchObject({ status: 503 });
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ event: "issue", failureSite: "facts.not-stored" }),
    );
  } finally {
    info.mockRestore();
    issue.mockRestore();
  }
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

function reachedBefore() {
  return Promise.reject(
    codedError(
      "IDEMPOTENCY_CONFLICT",
      'idempotency key "x/said:1" already names a different event at offset 3',
    ),
  );
}
