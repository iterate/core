import { expect, test, vi } from "vitest";
import { identityHashOf, type IdentityRecord, type SignedRecord } from "./mind-identity.ts";
import {
  deadlineIn,
  identitiesAfterAccepted,
  identitiesAfterRefused,
  identityOfMind,
  identityStateOf,
  publishedMindOf,
  reservedPathOf,
  textWithin,
} from "./mind-identity-log.ts";
import { newIdentityLog } from "./test-support/identity-log.ts";

test("an accepted genesis opens the log of its mind id, and the record after it is folded into that log: the head, the position and the whole identity", async () => {
  const log = await newIdentityLog();
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  const born = identitiesAfterAccepted({}, await acceptedOf(log.mind, log.genesis));
  // `toEqual`: one log, with exactly these fields, and the record as its text spells it
  expect(born).toEqual({
    [log.mind]: {
      head: log.mind,
      position: 1,
      current: JSON.parse(log.genesis.record),
      refused: null,
    },
  });
  expect(identitiesAfterAccepted(born!, await acceptedOf(log.mind, second))).toEqual({
    [log.mind]: {
      head: await identityHashOf(second.record),
      position: 2,
      current: JSON.parse(second.record),
      refused: null,
    },
  });
});

test("the logs of two mind ids stand side by side, and a record of either is folded whichever came last: a mind that has an id again that it had before", async () => {
  const [first, other] = [await newIdentityLog(), await newIdentityLog()];
  const second = await first.next(first.genesis, { alsoKnownAs: ["did:example:ada"] });
  // the first id's genesis, then the other id's genesis, then a further record of the first
  let identities = {};
  for (const [log, signed] of [
    [first, first.genesis],
    [other, other.genesis],
    [first, second],
  ] as const)
    identities = identitiesAfterAccepted(identities, await acceptedOf(log.mind, signed))!;
  expect(identities).toEqual({
    [first.mind]: {
      head: await identityHashOf(second.record),
      position: 2,
      current: JSON.parse(second.record),
      refused: null,
    },
    [other.mind]: {
      head: other.mind,
      position: 1,
      current: JSON.parse(other.genesis.record),
      refused: null,
    },
  });
  // the one reader of "this mind's identity": the log under a mind id, or null
  expect(identityOfMind(identities, first.mind)).toMatchObject({ position: 2 });
  expect(identityOfMind(identities, other.mind)).toMatchObject({ position: 1 });
  expect(identityOfMind(identities, "c".repeat(64))).toBeNull();
  // a name of every object is no mind id
  expect(identityOfMind(identities, "constructor")).toBeNull();
});

test("an accepted record that does not continue the log of its mind id is passed over", async () => {
  const log = await newIdentityLog();
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  const third = await log.next(second, { alsoKnownAs: [] });
  const other = await newIdentityLog();
  const born = identitiesAfterAccepted({}, await acceptedOf(log.mind, log.genesis))!;
  const passedOver = [
    // a later record before the genesis
    identitiesAfterAccepted({}, await acceptedOf(log.mind, second)),
    // the third record while the head is the genesis
    identitiesAfterAccepted(born, await acceptedOf(log.mind, third)),
    // the genesis again: an event that the log holds already, appended once more
    identitiesAfterAccepted(born, await acceptedOf(log.mind, log.genesis)),
    // another mind's genesis under this mind's id, before this log and after its genesis
    identitiesAfterAccepted({}, await acceptedOf(log.mind, other.genesis)),
    identitiesAfterAccepted(born, await acceptedOf(log.mind, other.genesis)),
    // this mind's genesis, and its second record, in an event that names another mind
    identitiesAfterAccepted({}, await acceptedOf(other.mind, log.genesis)),
    identitiesAfterAccepted(born, await acceptedOf(other.mind, second)),
    // a later record under its own hash as the mind id: only a genesis opens a log
    identitiesAfterAccepted({}, await acceptedOf(await identityHashOf(second.record), second)),
    // a text that is no record
    identitiesAfterAccepted({}, { ...(await acceptedOf(log.mind, log.genesis)), record: "{}" }),
  ];
  expect(passedOver).toEqual(passedOver.map(() => undefined));
});

test("a refused record sets the latest refusal of its mind id's log, and leaves every head", async () => {
  const [log, other] = [await newIdentityLog(), await newIdentityLog()];
  let identities = identitiesAfterAccepted({}, await acceptedOf(log.mind, log.genesis))!;
  identities = identitiesAfterAccepted(identities, await acceptedOf(other.mind, other.genesis))!;
  const refusal = { mind: log.mind, reason: "not-next", message: "a sentence" };
  expect(identitiesAfterRefused(identities, refusal, 7)).toEqual({
    [log.mind]: { ...identities[log.mind], refused: { offset: 7, reason: "not-next" } },
    [other.mind]: identities[other.mind],
  });
  // a mind id with no log has no root key that could have signed the record
  expect(
    identitiesAfterRefused(identities, { ...refusal, mind: "b".repeat(64) }, 8),
  ).toBeUndefined();
});

test("a mind id's reduced log is narrowed to one of the check's two forms, or to none", async () => {
  const log = await newIdentityLog();
  // the cast: the genesis text is a record's
  const current = JSON.parse(log.genesis.record) as IdentityRecord;
  // before the genesis: a log with no head
  expect(identityStateOf({}, log.mind)).toEqual({
    expected: log.mind,
    head: null,
    position: 0,
    current: null,
  });
  const born = { head: log.mind, position: 1, current, refused: null };
  expect(identityStateOf({ [log.mind]: born }, log.mind)).toEqual({
    expected: log.mind,
    head: log.mind,
    position: 1,
    current,
  });
  // Every state that the check refuses is none here either: the genesis as the head at
  // another position than 1, and a head that is not the genesis at position 1.
  const second = JSON.parse((await log.next(log.genesis)).record) as IdentityRecord;
  const later = { head: "b".repeat(64), position: 2, current: second, refused: null };
  expect(identityStateOf({ [log.mind]: { ...born, position: 2 } }, log.mind)).toBeNull();
  expect(identityStateOf({ [log.mind]: { ...later, position: 1 } }, log.mind)).toBeNull();
  expect(identityStateOf({ [log.mind]: { ...later, current } }, log.mind)).toBeNull();
  expect(identityStateOf({ [log.mind]: later }, log.mind)).toMatchObject({ position: 2 });
  // and a text that is no mind id has no log to check a record against
  expect(identityStateOf({}, "iterate.example.com")).toBeNull();
});

test("a mind's log is read at its hostname, every record is checked, and the answer is kept a minute", async () => {
  const hostname = "iterate.peer-one.example";
  const log = await newIdentityLog([hostname]);
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  const { asked, fetcher } = hostOf(log.mind, [log.genesis, second]);
  const published = {
    expected: log.mind,
    head: await identityHashOf(second.record),
    position: 2,
    current: JSON.parse(second.record),
  };
  expect(await publishedMindOf(hostname, fetcher)).toEqual(published);
  expect(await publishedMindOf(hostname, fetcher)).toEqual(published);
  expect(asked).toEqual([`https://${hostname}/.well-known/iterate manual`]);
});

test("a log in pages is read to its head, each page after the last record read", async () => {
  const hostname = "iterate.peer-two.example";
  const log = await newIdentityLog([hostname]);
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  const third = await log.next(second, { alsoKnownAs: [] });
  const { asked, fetcher } = hostOf(log.mind, [log.genesis, second, third], 1);
  expect(await publishedMindOf(hostname, fetcher)).toMatchObject({
    head: await identityHashOf(third.record),
    position: 3,
  });
  expect(asked).toEqual([
    `https://${hostname}/.well-known/iterate manual`,
    `https://${hostname}/.well-known/iterate?after=${log.mind} manual`,
    `https://${hostname}/.well-known/iterate?after=${await identityHashOf(second.record)} manual`,
  ]);
});

test("a reader that holds a record already asks for the records after it, and takes only a log that continues it", async () => {
  const hostname = "iterate.peer-three.example";
  const log = await newIdentityLog([hostname]);
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  const held = {
    expected: log.mind,
    head: log.mind,
    position: 1,
    // the cast: the genesis text is a record's
    current: JSON.parse(log.genesis.record) as IdentityRecord,
  };
  const { asked, fetcher } = hostOf(log.mind, [log.genesis, second]);
  expect(await publishedMindOf(hostname, fetcher, held)).toMatchObject({
    head: await identityHashOf(second.record),
    position: 2,
  });
  expect(asked).toEqual([`https://${hostname}/.well-known/iterate?after=${log.mind} manual`]);
  // another mind at the same hostname: its log is not the one that the reader holds
  const other = await newIdentityLog([hostname]);
  const moved = hostOf(other.mind, [other.genesis]);
  const elsewhere = { ...held, head: await identityHashOf(second.record), position: 2 };
  expect(
    await publishedMindOf(hostname, moved.fetcher, {
      ...elsewhere,
      // the cast: the second record's text is a record's
      current: JSON.parse(second.record) as IdentityRecord,
    }),
  ).toEqual({
    why: `https://${hostname}/.well-known/iterate?after=${elsewhere.head} is the log of another mind`,
  });
});

test.for([
  {
    name: "a log whose last record does not list the hostname that was asked",
    hostname: "iterate.peer-four.example",
    listed: ["iterate.elsewhere.example"],
    spoil: (answer: Response) => answer,
    why: "the log at https://iterate.peer-four.example/.well-known/iterate does not list iterate.peer-four.example",
  },
  {
    name: "a redirect",
    hostname: "iterate.peer-five.example",
    listed: ["iterate.peer-five.example"],
    spoil: () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    why: "https://iterate.peer-five.example/.well-known/iterate answered 302 with no identity log",
  },
  {
    name: "a document that names another mind id than its genesis has",
    hostname: "iterate.peer-six.example",
    listed: ["iterate.peer-six.example"],
    spoil: async (answer: Response) =>
      Response.json({ ...(await answer.json<object>()), mind: "d".repeat(64) }),
    why: "https://iterate.peer-six.example/.well-known/iterate has a record that does not continue its log: wrong-genesis",
  },
  {
    name: "a record whose signature is of another record",
    hostname: "iterate.peer-seven.example",
    listed: ["iterate.peer-seven.example"],
    spoil: async (answer: Response) => {
      const log = await answer.json<{ records: SignedRecord[] }>();
      const [genesis, second] = log.records;
      return Response.json({
        ...log,
        records: [genesis, { ...second, signatures: genesis!.signatures }],
      });
    },
    why: "https://iterate.peer-seven.example/.well-known/iterate has a record that does not continue its log: bad-signature",
  },
  {
    name: "a log with no record",
    hostname: "iterate.peer-eight.example",
    listed: ["iterate.peer-eight.example"],
    spoil: async (answer: Response) =>
      Response.json({ ...(await answer.json<object>()), head: null, records: [] }),
    why: "https://iterate.peer-eight.example/.well-known/iterate has no record yet",
  },
  {
    name: "a page larger than a page may be",
    hostname: "iterate.peer-nine.example",
    listed: ["iterate.peer-nine.example"],
    spoil: () => new Response("x".repeat(800 * 1024)),
    why: "https://iterate.peer-nine.example/.well-known/iterate answered 200 with no identity log",
  },
])("no identity is read from $name", async ({ hostname, listed, spoil, why }) => {
  const log = await newIdentityLog(listed);
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  const { fetcher } = hostOf(log.mind, [log.genesis, second]);
  expect(await publishedMindOf(hostname, async (request) => spoil(await fetcher(request)))).toEqual(
    { why },
  );
});

test.for([
  "169.254.169.254",
  "iterate.example.com:8080",
  "iterate.example.com/admin?",
  "internal.example/latest#",
  "user:secret@iterate.example.com",
  "ITERATE.EXAMPLE.COM",
  "[::1]",
  "localhost",
  "iterate.example.com.",
  "",
])("%j is no hostname to read a mind at: nothing is asked", async (hostname) => {
  const fetcher = vi.fn(async () => new Response("{}"));
  expect(await publishedMindOf(hostname, fetcher)).toEqual({
    why: "a mind is read at a lowercase DNS hostname, and nothing more",
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test("a state to read on from that is no state of a log is refused before anything is asked", async () => {
  const log = await newIdentityLog(["iterate.peer-ten.example"]);
  // the cast: the genesis text is a record's
  const current = JSON.parse(log.genesis.record) as IdentityRecord;
  const fetcher = vi.fn(async () => new Response("{}"));
  for (const from of [
    // the cast: a caller in JavaScript can hand over anything
    { expected: log.mind, head: "x/../../admin?", position: 1, current } as never,
    { expected: log.mind, head: log.mind, position: 4, current },
    { expected: log.mind, head: null, position: 0, current: null } as never,
  ])
    expect(await publishedMindOf("iterate.peer-ten.example", fetcher, from)).toEqual({
      why: "the state to read on from is no state of a log with a record",
    });
  expect(fetcher).not.toHaveBeenCalled();
});

test("a reader that stands at the head of the log it reads on from gets that state from an empty page", async () => {
  const hostname = "iterate.peer-eleven.example";
  const log = await newIdentityLog([hostname]);
  // the cast: the genesis text is a record's
  const current = JSON.parse(log.genesis.record) as IdentityRecord;
  const held = { expected: log.mind, head: log.mind, position: 1, current };
  const { asked, fetcher } = hostOf(log.mind, [log.genesis]);
  expect(await publishedMindOf(hostname, fetcher, held)).toEqual(held);
  expect(asked).toEqual([`https://${hostname}/.well-known/iterate?after=${log.mind} manual`]);
});

test("a page that repeats the record that the reader has, or that is empty before the head it names, ends the read at once", async () => {
  const log = await newIdentityLog([
    "iterate.peer-twelve.example",
    "iterate.peer-thirteen.example",
  ]);
  const head = "f".repeat(64);
  const repeats = vi.fn(async () =>
    Response.json({ version: 1, mind: log.mind, head, records: [log.genesis] }),
  );
  expect(await publishedMindOf("iterate.peer-twelve.example", repeats)).toEqual({
    why: `https://iterate.peer-twelve.example/.well-known/iterate?after=${log.mind} repeats a record that the reader has`,
  });
  expect(repeats).toHaveBeenCalledTimes(2);
  const empties = vi.fn(async (request: Request) =>
    Response.json({
      version: 1,
      mind: log.mind,
      head,
      records: request.url.includes("after=") ? [] : [log.genesis],
    }),
  );
  expect(await publishedMindOf("iterate.peer-thirteen.example", empties)).toEqual({
    why: `https://iterate.peer-thirteen.example/.well-known/iterate?after=${log.mind} ends before the head that it names`,
  });
  expect(empties).toHaveBeenCalledTimes(2);
});

test("a log of more pages than a reader asks for is not read", async () => {
  const hostname = "iterate.peer-fourteen.example";
  const log = await newIdentityLog([hostname]);
  const records = [log.genesis];
  for (let position = 2; position <= 66; position++)
    records.push(await log.next(records.at(-1)!, { alsoKnownAs: [`did:example:${position}`] }));
  const { asked, fetcher } = hostOf(log.mind, records, 1);
  expect(await publishedMindOf(hostname, fetcher)).toEqual({
    why: `https://${hostname}/.well-known/iterate has more than 64 pages`,
  });
  expect(asked).toHaveLength(64);
});

test("the whole read ends at five seconds: a host that answers slowly is asked nothing more, and its body is cancelled", async () => {
  vi.useFakeTimers();
  try {
    const log = await newIdentityLog([
      "iterate.peer-fifteen.example",
      "iterate.peer-sixteen.example",
    ]);
    const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
    const host = hostOf(log.mind, [log.genesis, second], 1);
    // each page takes three seconds: the second page cannot come before the deadline
    let asked = 0;
    const slow = async (request: Request) => {
      asked += 1;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return host.fetcher(request);
    };
    const read = publishedMindOf("iterate.peer-fifteen.example", slow);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await read).toEqual({
      why: "https://iterate.peer-fifteen.example/.well-known/iterate was not read in five seconds",
    });
    // nothing is asked after the deadline, however long the host is given
    const askedAtTheDeadline = asked;
    expect(askedAtTheDeadline).toBeLessThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toBe(askedAtTheDeadline);
    // a body that never ends is cancelled at the deadline
    let cancelled = false;
    const endless = async () =>
      new Response(
        new ReadableStream({
          pull: (controller) => controller.enqueue(new TextEncoder().encode(" ")),
          cancel: () => void (cancelled = true),
        }),
      );
    const drip = async () => {
      const answer = await endless();
      const reader = answer.body!.getReader();
      // one byte a second
      return new Response(
        new ReadableStream({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            controller.enqueue((await reader.read()).value);
          },
          cancel: () => reader.cancel(),
        }),
      );
    };
    const dripped = publishedMindOf("iterate.peer-sixteen.example", drip);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await dripped).toEqual({
      why: "https://iterate.peer-sixteen.example/.well-known/iterate was not read in five seconds",
    });
    expect(cancelled).toBe(true);
    // no timer of a finished read is left
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  } finally {
    vi.useRealTimers();
  }
});

test("a read that ends before its deadline leaves no timer behind", async () => {
  vi.useFakeTimers();
  try {
    const hostname = "iterate.peer-seventeen.example";
    const log = await newIdentityLog([hostname]);
    await publishedMindOf(hostname, hostOf(log.mind, [log.genesis]).fetcher);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("an answer is kept for one hostname, expected id and head; a failure of the reader's own way out is not kept; a kept state cannot be changed", async () => {
  const hostname = "iterate.peer-eighteen.example";
  const log = await newIdentityLog([hostname]);
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  const host = hostOf(log.mind, [log.genesis, second]);
  let down = true;
  const fetcher = async (request: Request) => {
    if (down) throw new Error("the way out is closed for a deploy");
    return host.fetcher(request);
  };
  expect(await publishedMindOf(hostname, fetcher)).toEqual({
    why: `https://${hostname}/.well-known/iterate: Error: the way out is closed for a deploy`,
  });
  // the next call asks again, and its answer is kept
  down = false;
  const read = await publishedMindOf(hostname, fetcher);
  expect(read).toMatchObject({ expected: log.mind, position: 2 });
  expect(await publishedMindOf(hostname, fetcher)).toBe(read);
  expect(host.asked).toHaveLength(1);
  expect(() => {
    // the cast: the type says `hostnames` can be written, and the kept answer is frozen
    (read as { current: IdentityRecord }).current.hostnames.push("evil.example");
  }).toThrow(TypeError);
  // Another starting state is another answer: the same head under another expected id is not
  // answered from what was kept for this one.
  // the cast: the genesis text is a record's
  const current = JSON.parse(log.genesis.record) as IdentityRecord;
  const held = { expected: log.mind, head: log.mind, position: 1, current };
  expect(await publishedMindOf(hostname, fetcher, held)).toMatchObject({ position: 2 });
  expect(host.asked).toHaveLength(2);
  const other = await newIdentityLog([hostname]);
  // the cast: the genesis text is a record's
  const otherCurrent = JSON.parse(other.genesis.record) as IdentityRecord;
  expect(
    await publishedMindOf(hostname, fetcher, {
      expected: other.mind,
      head: other.mind,
      position: 1,
      current: otherCurrent,
    }),
  ).toEqual({
    why: `https://${hostname}/.well-known/iterate?after=${other.mind} is the log of another mind`,
  });
  expect(host.asked).toHaveLength(3);
  // The same head under another expected id is another question too: what was kept for the
  // one is no answer for the other.
  const head = await identityHashOf(second.record);
  // the cast: the second record's text is a record's
  const atHead = { head, position: 2, current: JSON.parse(second.record) as IdentityRecord };
  expect(await publishedMindOf(hostname, fetcher, { expected: log.mind, ...atHead })).toEqual({
    expected: log.mind,
    ...atHead,
  });
  expect(await publishedMindOf(hostname, fetcher, { expected: other.mind, ...atHead })).toEqual({
    why: `https://${hostname}/.well-known/iterate?after=${head} is the log of another mind`,
  });
  expect(host.asked).toHaveLength(5);
});

test("a body is read to its limit and to its deadline and no further, and a body that its sender cut off is no body", async () => {
  const never = new Promise<undefined>(() => {});
  const body = (size: number) => new Response("x".repeat(size));
  expect(await textWithin(body(10), 10, never)).toBe("xxxxxxxxxx");
  expect(await textWithin(body(11), 10, never)).toBeNull();
  expect(await textWithin(new Response(null), 10, never)).toBe("");
  // a length that the sender states is believed before anything is read
  const stated = new Response("x", { headers: { "content-length": "11" } });
  expect(await textWithin(stated, 10, never)).toBeNull();
  // a sender that went away in the middle of its body
  const cut = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        controller.error(new Error("the connection was reset"));
      },
    }),
  );
  expect(await textWithin(cut, 10, never)).toBeNull();
  // a sender that stops sending: the read ends at the deadline, and the stream is cancelled
  let cancelled = false;
  const stalled = new Response(
    new ReadableStream({
      start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
      cancel: () => void (cancelled = true),
    }),
  );
  const deadline = deadlineIn(20);
  expect(await textWithin(stalled, 10, deadline.expiry)).toBeNull();
  expect(deadline.passed()).toBe(true);
  expect(cancelled).toBe(true);
});

test.for([
  ["/.well-known/iterate", { path: "/.well-known/iterate", exact: true }],
  ["/keys/stack.json", { path: "/keys/stack.json", exact: true }],
  ["/.well-known/iterate/", { path: "/.well-known/iterate", exact: false }],
  ["/.well-known/Iterate", { path: "/.well-known/iterate", exact: false }],
  ["/.well-known/%69terate", { path: "/.well-known/iterate", exact: false }],
  ["//.well-known//iterate", { path: "/.well-known/iterate", exact: false }],
  ["/%2Ewell-known%2Fiterate", { path: "/.well-known/iterate", exact: false }],
  ["/keys/%73tack.json", { path: "/keys/stack.json", exact: false }],
  ["/keys/stack.json/", { path: "/keys/stack.json", exact: false }],
  ["/KEYS/STACK.JSON", { path: "/keys/stack.json", exact: false }],
  ["/.well-known/iterate-app", null],
  ["/.well-known/iterate/more", null],
  ["/keys/stack.json.txt", null],
  ["/keys", null],
  ["/%", null],
  ["/", null],
] as const)("the path %s is reserved as %j", ([pathname, reserved]) => {
  expect(reservedPathOf(pathname)).toEqual(reserved);
});

/** The accepted event's payload for a signed record of the mind `mind`. The reduce reads no
 *  signer, so none is named. */
async function acceptedOf(mind: string, signed: SignedRecord) {
  return {
    mind,
    hash: await identityHashOf(signed.record),
    record: signed.record,
    signatures: signed.signatures,
    signedBy: [],
  };
}

/** A host that serves `records` as a mind's log, `perPage` records a page, and keeps what it
 *  was asked. */
function hostOf(mind: string, records: SignedRecord[], perPage = records.length) {
  const asked: string[] = [];
  const hashes = Promise.all(records.map(({ record }) => identityHashOf(record)));
  const fetcher = async (request: Request) => {
    asked.push(`${request.url} ${request.redirect}`);
    const after = new URL(request.url).searchParams.get("after");
    const from = after ? (await hashes).indexOf(after) + 1 : 0;
    return Response.json({
      version: 1,
      mind,
      head: (await hashes).at(-1) ?? null,
      records: records.slice(from, from + perPage),
    });
  };
  return { asked, fetcher };
}
