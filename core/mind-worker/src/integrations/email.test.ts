import type { ItxHostRootContext, ReachableContext } from "core-itx";
import type { GateAnswer } from "iterate/acts";
import type { Door } from "iterate/workers";
import { expect, test } from "vitest";
import { emailRoot } from "./email.ts";

test("a held mail keeps no reservation while it waits, so a retry of its delivery is not refused", async () => {
  const mind = mindWith([held, { sent: true, messageId: "<m1@example.com>" }]);
  const recorded = await mind.send();
  expect(mind).toMatchObject({
    asked: [
      { wait: false, reserved: ["delivery-1"] },
      // the wait for a member's answer: the reservation is given up before it
      { wait: true, reserved: [] },
    ],
  });
  expect(recorded).toMatchObject({ type: "events.iterate.com/email/sent" });
});

test("a mail no rule holds is reserved while it goes, and a held mail nobody approves leaves no reservation", async () => {
  const free = mindWith([{ sent: true, messageId: "<m2@example.com>" }]);
  await free.send();
  expect(free).toMatchObject({ asked: [{ wait: false, reserved: ["delivery-1"] }] });

  const waiting: GateAnswer = { state: "waiting", digest: "d".repeat(64), facts: [] };
  const unanswered = mindWith([held, { sent: false, error: "it waits", gate: waiting }]);
  await expect(unanswered.send()).rejects.toThrow("waits for a member's approval");
  expect(unanswered.reservations()).toEqual([]);
});

type Outcome = Awaited<ReturnType<Door["sendEmail"]>>;

const held: Outcome = {
  sent: false,
  error: "it waits",
  gate: { state: "held", digest: "d".repeat(64), facts: [] },
};

/** A mind whose boundary answers `outcomes` in turn. `asked` keeps, for each call of the boundary,
 *  whether it waits and which reservations stand at that moment. */
function mindWith(outcomes: Outcome[]) {
  const reservations = new Set<string>();
  const asked: { wait: boolean; reserved: string[] }[] = [];
  const emailContext = {
    reserveSend: async (key: string) => {
      if (reservations.has(key)) return { reserved: false };
      reservations.add(key);
      return { reserved: true };
    },
    releaseSend: async (key: string) => void reservations.delete(key),
    invoke: async (expression: unknown[]) => {
      const [verb, event] = [expression.at(-1)].flat();
      return verb === "append" ? [{ ...Object(event), offset: 1 }] : undefined;
    },
  };
  const context = {
    path: "/agents/one",
    caller: () => ({
      principal: null,
      cause: { chain: "/agents/one#1", depth: 1, at: 0, writeKey: "delivery" },
    }),
    context: () => emailContext,
  };
  const egress = {
    sendEmail: async (_message: unknown, options?: { wait?: boolean }) => {
      asked.push({
        wait: Boolean(options?.wait),
        reserved: [...reservations].map((key) => key.replace(/:email\.send:.*/, "-1")),
      });
      return outcomes.shift()!;
    },
  };
  const root = emailRoot(
    // A test's stand-in: `emailRoot` reads only `path`, `caller` and `context` of the root, and
    // `reserveSend`, `releaseSend` and `invoke` of a context.
    context as unknown as ItxHostRootContext & { context: () => ReachableContext },
    {
      // no attachment is named, so no file is read
      files: {} as R2Bucket,
      egress: () => egress,
      name: "mind",
      domain: "example.com",
    },
  );
  return {
    asked,
    reservations: () => [...reservations],
    send: () => root.send({ to: "jo@example.org", subject: "Hello", text: "A mail." }),
  };
}
