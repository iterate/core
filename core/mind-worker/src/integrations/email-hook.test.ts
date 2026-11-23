// The mind's part of one delivery's `email` hook (email-hook.ts), with a config, an email log and a
// boundary's forward that say what they did.
import { codedError, errorCode } from "iterate/lib";
import type { EmailHookArgs } from "iterate/email";
import type { ItxExpression } from "iterate/expression";
import { expect, test, vi } from "vitest";
import { MIND_SNAPSHOT_READ, runEmailHook } from "./email-hook.ts";

const RAW = "/email/abc/hello@mind.example.eml";

test("the config's forward reaches the boundary's capability, and the SENT mark is written after Cloudflare accepted it", async () => {
  const mind = fakeMind(async ({ forward }) => {
    await forward("team@elsewhere.example");
  });
  await runEmailHook(mind.deps, mind.args);
  expect(mind).toMatchObject({
    did: [
      "check team@elsewhere.example",
      "forwarded to team@elsewhere.example",
      "mark team@elsewhere.example",
    ],
    appended: [],
  });
  expect([...mind.marked]).toEqual([`email/sent:${RAW}:team@elsewhere.example`]);
});

test("the config's save reaches the boundary's capability", async () => {
  const mind = fakeMind(async ({ save }) => {
    await save();
  });
  await expect(runEmailHook(mind.deps, mind.args)).resolves.toBe("returned");
  expect(mind).toMatchObject({ did: ["saved"], appended: [] });
});

test("the mind answers how the hook ended: returned without a save, threw, or missing; the boundary records the mail for the last two", async () => {
  const returned = fakeMind(async () => {});
  await expect(runEmailHook(returned.deps, returned.args)).resolves.toBe("returned");
  expect(returned).toMatchObject({ did: [], appended: [] });
  const threw = fakeMind(async () => {
    throw new Error("the config broke");
  });
  await expect(runEmailHook(threw.deps, threw.args)).resolves.toBe("threw");
  const missing = fakeMind("missing");
  await expect(runEmailHook(missing.deps, missing.args)).resolves.toBe("missing");
});

test("a save kept past the config's function is EXPIRED, and the boundary is not asked", async () => {
  let kept: EmailHookArgs["save"] | undefined;
  const mind = fakeMind(async ({ save }) => {
    kept = save;
  });
  await runEmailHook(mind.deps, mind.args);
  expect(await kept!().catch(errorCode)).toBe("EXPIRED");
  expect(mind).toMatchObject({ did: [], appended: [] });
});

test("from a boundary that hands no save, which recorded the mail itself, the config's save answers", async () => {
  const mind = fakeMind(async ({ save }) => {
    await save();
    mind.did.push("the config went on");
  });
  const { save: _save, ...older } = mind.args;
  await runEmailHook(mind.deps, older);
  expect(mind).toMatchObject({ did: ["the config went on"], appended: [] });
});

test("a mind that dies after its check and before Cloudflare is asked leaves no mark: the next delivery forwards", async () => {
  const mind = fakeMind(async ({ forward }) => {
    await forward("team@elsewhere.example");
  });
  // the email log's answer never reaches the first run: it died there
  mind.dies = true;
  void runEmailHook(mind.deps, mind.args);
  await vi.waitFor(() => expect(mind.did).toHaveLength(1));
  mind.dies = false;
  await runEmailHook(mind.deps, mind.args);
  expect(mind).toMatchObject({
    did: [
      "check team@elsewhere.example",
      "check team@elsewhere.example",
      "forwarded to team@elsewhere.example",
      "mark team@elsewhere.example",
    ],
    appended: [],
  });
});

test("ACCEPTED: a mind that dies after Cloudflare accepted and before its mark lands leaves no mark, and the next delivery sends a second copy", async () => {
  const mind = fakeMind(async ({ forward }) => {
    await forward("team@elsewhere.example");
  });
  mind.diesAtMark = true;
  void runEmailHook(mind.deps, mind.args);
  await vi.waitFor(() => expect(mind.did).toContain("forwarded to team@elsewhere.example"));
  mind.diesAtMark = false;
  await runEmailHook(mind.deps, mind.args);
  expect(mind.did.filter((line) => line.startsWith("forwarded"))).toEqual([
    "forwarded to team@elsewhere.example",
    "forwarded to team@elsewhere.example",
  ]);
});

test("a forward that the config called before it threw, and whose check answers after, while the threw fact's append never answers, is EXPIRED and never reaches the boundary", async () => {
  let late: Promise<unknown> | undefined;
  let answerCheck!: () => void;
  const mind = fakeMind(async ({ forward }) => {
    late = forward("team@elsewhere.example").catch((error: unknown) => errorCode(error));
    throw new Error("the config fails");
  });
  mind.checkWaits = new Promise<void>((resolve) => (answerCheck = resolve));
  mind.appendHangs = true;
  void runEmailHook(mind.deps, mind.args);
  await vi.waitFor(() => expect(mind).toMatchObject({ did: ["check team@elsewhere.example"] }));
  // the config has thrown, and the mind awaits its threw fact: then the check answers
  await new Promise((resolve) => setTimeout(resolve, 5));
  answerCheck();
  expect(await late).toBe("EXPIRED");
  expect(mind).toMatchObject({ did: ["check team@elsewhere.example"] });
});

test("a forward that Cloudflare accepted and whose fact never landed is not sent again by a second delivery: its mark holds", async () => {
  // the boundary's email/forwarded did not reach the log (`recorded` stays empty)
  const mind = fakeMind(async ({ forward }) => {
    await forward("team@elsewhere.example");
  });
  await runEmailHook(mind.deps, mind.args);
  await runEmailHook(mind.deps, mind.args);
  expect(mind.did.filter((line) => line.startsWith("forwarded"))).toEqual([
    "forwarded to team@elsewhere.example",
  ]);
  expect(mind.appended).toMatchObject([
    { payload: { why: "threw", error: expect.stringMatching(/^FORWARDED_BEFORE: /) } },
  ]);
});

test("an early fact under the forward's key is no SENT mark: the boundary wrote answered false before Cloudflare answered, Cloudflare rejected, and a redelivery's forward reaches the boundary", async () => {
  // the first delivery: the boundary gave up waiting and wrote its early fact; then Cloudflare
  // rejected the forward, so the mind wrote no mark
  const first = fakeMind(
    async ({ forward }) => {
      await forward("team@elsewhere.example").catch(() => {});
    },
    { forward: codedError("REFUSED", "the destination refused") },
  );
  first.recorded.add(`email/forwarded:${RAW}:team@elsewhere.example`);
  await runEmailHook(first.deps, first.args);
  // the redelivery, on the same email log
  const again = fakeMind(async ({ forward }) => {
    await forward("team@elsewhere.example");
  });
  again.recorded = first.recorded;
  again.marked = first.marked;
  await runEmailHook(again.deps, again.args);
  expect(again).toMatchObject({
    did: [
      "check team@elsewhere.example",
      "forwarded to team@elsewhere.example",
      "mark team@elsewhere.example",
    ],
    appended: [],
  });
});

test("a forward that a SENT mark names already, from an earlier delivery, is refused with FORWARDED_BEFORE and never reaches the boundary", async () => {
  const mind = fakeMind(async ({ forward }) => {
    await forward("Team@Elsewhere.Example ");
  });
  mind.marked.add(`email/sent:${RAW}:team@elsewhere.example`);
  await runEmailHook(mind.deps, mind.args);
  expect(mind).toMatchObject({
    did: ["check team@elsewhere.example"],
    appended: [
      {
        type: "events.iterate.com/email/hook-failed",
        idempotencyKey: `email/hook-failed:threw:${RAW}`,
        payload: {
          why: "threw",
          raw: RAW,
          error: expect.stringMatching(/^FORWARDED_BEFORE: not forwarded: this mail went to/),
        },
      },
    ],
  });
});

test("a hook that catches the refusal goes on, and nothing is recorded", async () => {
  const mind = fakeMind(async ({ forward }) => {
    await forward("a@elsewhere.example").catch(() => {});
    await forward("b@elsewhere.example");
  });
  mind.marked.add(`email/sent:${RAW}:a@elsewhere.example`);
  await runEmailHook(mind.deps, mind.args);
  expect(mind).toMatchObject({
    did: [
      "check a@elsewhere.example",
      "check b@elsewhere.example",
      "forwarded to b@elsewhere.example",
      "mark b@elsewhere.example",
    ],
    appended: [],
  });
});

test("the boundary's refusal is the hook's to catch; uncaught, it is one threw fact with its code, and no mark", async () => {
  const mind = fakeMind(
    async ({ forward }) => {
      await forward("team@elsewhere.example");
    },
    { forward: codedError("REFUSED", "destination address not verified") },
  );
  await runEmailHook(mind.deps, mind.args);
  expect(mind).toMatchObject({
    did: ["check team@elsewhere.example"],
    appended: [{ payload: { why: "threw", error: "REFUSED: destination address not verified" } }],
  });
});

test.each([
  [
    "a capability kept past the call (a disposed stub)",
    new Error("RPC stub used after being disposed."),
  ],
  [
    "a capability called after the boundary's connection dropped",
    Object.assign(new Error("Network connection lost."), { retryable: true }),
  ],
])(
  "%s throws EXPIRED to the config, with the runtime's words, and no mark",
  async (_case, gone) => {
    const caught: unknown[] = [];
    const mind = fakeMind(
      async ({ forward }) => {
        await forward("team@elsewhere.example").catch((error: unknown) => caught.push(error));
      },
      { forward: gone },
    );
    await runEmailHook(mind.deps, mind.args);
    expect(caught).toMatchObject([
      {
        code: "EXPIRED",
        message: `the mail's delivery has ended, and its save and forward with it (${gone.message})`,
      },
    ]);
    expect(mind).toMatchObject({
      did: ["check team@elsewhere.example"],
      appended: [],
    });
  },
);

test("an EXPIRED that the config does not catch is its threw fact, not a mind the boundary could not reach", async () => {
  const mind = fakeMind(
    async ({ forward }) => {
      await forward("team@elsewhere.example");
    },
    { forward: Object.assign(new Error("Network connection lost."), { retryable: true }) },
  );
  await runEmailHook(mind.deps, mind.args);
  expect(mind.appended).toMatchObject([
    { payload: { why: "threw", error: expect.stringMatching(/^EXPIRED: the mail's delivery/) } },
  ]);
});

test("a config with no email method gets one missing fact for its commit, under one key for every mail", async () => {
  const mind = fakeMind("missing");
  await runEmailHook(mind.deps, mind.args);
  await runEmailHook(mind.deps, mind.args);
  // the email log lands an event once for each key: the second append is the first's
  const missing = {
    type: "events.iterate.com/email/hook-failed",
    idempotencyKey: "email/hook-failed:missing:c0ffee",
    payload: { why: "missing", commitOid: "c0ffee" },
  };
  expect(mind).toMatchObject({ appended: [missing, missing] });
  // the next commit, still with no email, is one fact more
  mind.commit = "deadbeef";
  await runEmailHook(mind.deps, mind.args);
  expect(mind.appended.at(-1)).toMatchObject({
    idempotencyKey: "email/hook-failed:missing:deadbeef",
  });
});

test("the platform's read of the published commit calls the mind facet's snapshot, and so gets its state", async () => {
  // The root walks the read as Workers RPC would (core-itx dispatch.ts, iterate/sdk
  // call-with-cause.ts): a string step reads a member, an array step calls it. A bare "snapshot"
  // step answers the method itself, which has no `state`.
  const mind = fakeMind("missing");
  await runEmailHook(mind.deps, mind.args);
  expect(mind).toMatchObject({
    read: [MIND_SNAPSHOT_READ],
    appended: [
      { idempotencyKey: "email/hook-failed:missing:c0ffee", payload: { commitOid: "c0ffee" } },
    ],
  });
});

test("a commit that cannot be read is still one missing fact for every mail, keyed as unknown, and the hook does not throw", async () => {
  const mind = fakeMind("missing");
  mind.snapshotFails = new Error("the root was unreachable");
  await runEmailHook(mind.deps, mind.args);
  await runEmailHook(mind.deps, mind.args);
  const missing = {
    type: "events.iterate.com/email/hook-failed",
    idempotencyKey: "email/hook-failed:missing:unknown-commit",
    payload: {
      why: "missing",
      error: "the published commit could not be read: Error: the root was unreachable",
    },
  };
  expect(mind).toMatchObject({ appended: [missing, missing] });
  // before the first publication the snapshot names no commit: the same one key
  mind.commit = null;
  await runEmailHook(mind.deps, mind.args);
  expect(mind.appended.at(-1)).toMatchObject({
    idempotencyKey: "email/hook-failed:missing:unknown-commit",
  });
});

test("a second delivery that throws again with other words is recorded already: the idempotency conflict is no failure", async () => {
  const mind = fakeMind(async () => {
    throw new Error("the hook failed");
  });
  mind.conflict = true;
  await expect(runEmailHook(mind.deps, mind.args)).resolves.toBe("threw");
});

test("a platform failure on the way is not the hook's: it throws, and the boundary records the mind as unreachable", async () => {
  const mind = fakeMind(async () => {
    throw codedError("UNAVAILABLE", "the root was reset", {
      kind: "deploy-reset",
      retryAfterMs: 1000,
    });
  });
  await expect(runEmailHook(mind.deps, mind.args)).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });
  expect(mind).toMatchObject({ appended: [] });
});

/** A mind whose config runs `hook` (or has no email: "missing"), whose email log holds the keys in
 *  `recorded`, and whose boundary's forward fails with `fails.forward`. */
function fakeMind(
  hook: ((args: EmailHookArgs) => Promise<void>) | "missing",
  fails: { forward?: Error } = {},
) {
  const did: string[] = [];
  const appended: { type: string; idempotencyKey?: string; payload?: unknown }[] = [];
  const mind = {
    did,
    appended,
    recorded: new Set<string>(),
    /** The email log's `send:<key>` rows: the SENT marks. */
    marked: new Set<string>(),
    /** The email log's next check answers this run never: the run died after the log did its part. */
    dies: false,
    /** The mark is never written, and this run never goes on: it died after Cloudflare accepted. */
    diesAtMark: false,
    /** The email log's check answers when this settles. */
    checkWaits: undefined as Promise<void> | undefined,
    /** The email log takes no append, and never answers one. */
    appendHangs: false,
    commit: "c0ffee" as string | null,
    snapshotFails: undefined as Error | undefined,
    read: [] as ItxExpression[],
    conflict: false,
    args: {
      mail: { raw: { path: RAW, contentType: "message/rfc822", size: 1 }, subject: "hi" } as never,
      save: async () => {
        did.push("saved");
      },
      forward: async (to: string) => {
        if (fails.forward) throw fails.forward;
        did.push(`forwarded to ${to}`);
      },
    } satisfies EmailHookArgs,
    deps: {
      deliverEmail: async (args: EmailHookArgs) => {
        if (hook === "missing") return "missing";
        await hook(args);
        return "done";
      },
      // As core-itx: `sentBefore` reads a fact or a `send:` row; `reserveSend` (the mark) puts a
      // row where neither is.
      emailLog: {
        sentBefore: async (key: string) => {
          did.push(`check ${key.split(":").at(-1)}`);
          if (mind.dies) return new Promise<boolean>(() => {});
          await mind.checkWaits;
          return mind.recorded.has(key) || mind.marked.has(key);
        },
        markSent: async (key: string) => {
          if (mind.diesAtMark) return new Promise(() => {});
          did.push(`mark ${key.split(":").at(-1)}`);
          if (!mind.recorded.has(key)) mind.marked.add(key);
        },
        reserveSend: async (key: string) => {
          did.push(`check ${key.split(":").at(-1)}`);
          const reserved = !mind.recorded.has(key) && !mind.marked.has(key);
          if (reserved) mind.marked.add(key);
          if (mind.dies) return new Promise(() => {});
          return { reserved };
        },
        releaseSend: async (key: string) => {
          did.push("release");
          mind.marked.delete(key);
        },
      },
      readRoot: async (expression: ItxExpression) => {
        mind.read.push(expression);
        if (mind.snapshotFails) throw mind.snapshotFails;
        return walk(rootBuiltIns(mind), expression.slice(2));
      },
      append: async (events: (typeof appended)[number][]) => {
        if (mind.appendHangs) return new Promise<void>(() => {});
        if (mind.conflict) throw codedError("IDEMPOTENCY_CONFLICT", "another event has this key");
        appended.push(...events);
      },
    },
  };
  return mind;
}

/** The root's `itx.builtins`, with the first-party `mind` facet: its `snapshot` answers
 *  `{ offset, state }` (iterate/stream/processor `snapshot`). */
function rootBuiltIns(mind: { commit: string | null }) {
  const facet = {
    async snapshot() {
      return { offset: 7, state: { publishedCommit: mind.commit, unpublishedCommits: [] } };
    },
  };
  return { facets: { get: (name: string) => (name === "mind" ? facet : undefined) } };
}

/** A walk as Workers RPC makes it: a string step reads a member, an array step calls it. */
async function walk(start: unknown, steps: ItxExpression) {
  let value = start;
  for (const step of steps) {
    const target = value as Record<string, unknown>;
    if (typeof step === "string") value = await target[step];
    else {
      const [method, ...args] = step;
      value = await (target[method] as (...a: unknown[]) => unknown).apply(target, args);
    }
  }
  return value;
}
