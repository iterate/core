import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  identityHashOf,
  identityKeyIdOf,
  IdentityRecord,
  identityRecordText,
  type IdentityState,
  nextIdentity,
  signIdentityRecord,
} from "../mind-identity.ts";
import { base64url, fromBase64url } from "../signed.ts";
import {
  identityMadeFor,
  type IdentityIo,
  keyFileOf,
  mlDsaRequired,
  newIdentity,
  postIdentity,
  shownIdentity,
  signingKeyOf,
  writeWhole,
} from "./identity.ts";

const hostname = "iterate.ada-labs.com";
const url = `https://${hostname}/.well-known/iterate`;
const stackUrl = `https://${hostname}/keys/stack.json`;

test("a new identity is one root key and the genesis that it signed: the id is the genesis's hash, and the mind's own check accepts it", async () => {
  const dir = newDir();
  const { mindId, keyFile } = await newIdentity([hostname], dir);
  expect(keyFile).toBe(join(dir, `${mindId}.key.json`));
  const { mind, records } = fileOf(join(dir, `${mindId}.json`));
  expect(mind).toBe(mindId);
  expect(records).toHaveLength(1);
  expect(await identityHashOf(records[0].record)).toBe(mindId);

  const record = IdentityRecord.parse(JSON.parse(records[0].record));
  expect(record).toMatchObject({
    prev: null,
    threshold: 1,
    workingKeys: [],
    hostnames: [hostname],
  });
  expect(record.rootKeys).toMatchObject([{ signs: "raw", algorithm: "ML-DSA-65" }]);
  expect(fromBase64url(record.nonce || "")).toHaveLength(16);

  const accepted = await nextIdentity(unborn(mindId), records[0]);
  expect(accepted).toMatchObject({ state: { head: mindId, position: 1 } });
  // two minds at one hostname are two minds: each has its own key and nonce
  expect(await newIdentity([hostname], dir)).not.toMatchObject({ mindId });
});

test("the two files are private and whole: mode 600 in a folder of mode 700, and no temporary file stays", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  expect(readdirSync(dir).toSorted()).toEqual([`${mindId}.json`, `${mindId}.key.json`]);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
});

test("a write makes the folders it needs, writes every byte, and removes its temporary file when the rename fails", () => {
  const root = mkdtempSync(join(tmpdir(), "iterate-identity-"));
  const folder = join(root, "a", "b");
  // more than one write of the kernel's usual size
  const value = { text: "x".repeat(3 << 20) };
  writeWhole(join(folder, "file.json"), value);
  expect(fileOf(join(folder, "file.json"))).toEqual(value);
  expect(statSync(folder).mode & 0o777).toBe(0o700);
  expect(statSync(join(folder, "file.json")).mode & 0o777).toBe(0o600);

  // a folder where the file goes: the rename cannot replace it
  mkdirSync(join(folder, "blocked.json", "inside"), { recursive: true });
  expect(() => writeWhole(join(folder, "blocked.json"), { some: "value" })).toThrow();
  expect(readdirSync(folder).toSorted()).toEqual(["blocked.json", "file.json"]);
});

test("the key file holds the seed of the key that the genesis names: a key imported from it signs a record that the check accepts", async () => {
  const dir = newDir();
  const { mindId, keyFile } = await newIdentity([hostname], dir);
  const key = fileOf(keyFile);
  expect(key).toMatchObject({ version: 1, mind: mindId, algorithm: "ML-DSA-65" });
  expect(fromBase64url(key.seed)).toHaveLength(32);
  const [genesis] = fileOf(join(dir, `${mindId}.json`)).records;
  expect(IdentityRecord.parse(JSON.parse(genesis.record)).rootKeys[0]?.publicKey).toBe(
    key.publicKey,
  );

  const again = await signIdentityRecord(
    genesis.record,
    await signingKeyOf(dir, mindId),
    await identityKeyIdOf(key.publicKey),
  );
  // an ML-DSA signature is made with fresh randomness: another signature, and as valid
  expect(again).not.toMatchObject({ sig: genesis.signatures[0].sig });
  expect(
    await nextIdentity(unborn(mindId), { record: genesis.record, signatures: [again] }),
  ).toMatchObject({ state: { head: mindId } });
  // the records file holds no part of the key
  expect(readFileSync(join(dir, `${mindId}.json`), "utf8")).not.toContain(key.seed);
});

test("a key file that cannot be read as a key gives one fixed sentence with its path, and never its text", async () => {
  const dir = newDir();
  const { mindId, keyFile } = await newIdentity([hostname], dir);
  const key = fileOf(keyFile);
  const fixed = `The identity key file ${keyFile} cannot be read as an identity key.`;
  // a cut file, whose parser's words would quote the text near the fault, and so the seed
  writeFileSync(keyFile, readFileSync(keyFile, "utf8").slice(0, -20));
  const cut = await signingKeyOf(dir, mindId).catch((error: Error) => error);
  expect(cut).toMatchObject({ message: fixed });
  expect(String(cut)).not.toContain(key.seed.slice(0, 8));
  // a seed of the wrong length, which the runtime does not import
  writeFileSync(keyFile, JSON.stringify({ ...key, seed: "AAAA" }));
  await expect(signingKeyOf(dir, mindId)).rejects.toThrow(fixed);
  // no file at all
  rmSync(keyFile);
  await expect(signingKeyOf(dir, mindId)).rejects.toThrow(fixed);
});

test("the post reads the mind's log, posts the genesis that it lacks, lists the stack's key in a second record, and reads the log again; every later run posts the last record again, which the mind knows", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  const mind = mindAt(mindId);
  const { io, said } = ioFor(dir, mind.fetcher);

  expect(await postIdentity({ controlPlaneHostname: hostname, mindId }, io)).toEqual({
    mindId,
    taken: 2,
    here: 2,
    published: 2,
    emptyBefore: true,
  });
  expect(mind).toMatchObject({
    asked: [`GET ${url}`, `POST ${url}`, `GET ${stackUrl}`, `POST ${url}`, `GET ${url}`],
    answered: ["accepted", "accepted"],
  });
  // the second record is the genesis's content with the stack's key as its working key, signed
  // by the root key on this computer, and saved beside the genesis
  const [genesis, second] = fileOf(join(dir, `${mindId}.json`)).records;
  expect(IdentityRecord.parse(JSON.parse(second.record))).toEqual({
    ...IdentityRecord.parse(JSON.parse(genesis.record)),
    nonce: undefined,
    prev: mindId,
    workingKeys: [stackEntry(mind.stackKey()!)],
  });
  expect(mind.current()?.workingKeys).toEqual([stackEntry(mind.stackKey()!)]);
  // The log has both records now. The post goes out all the same: that request is what makes
  // the stack deliver what it still owes the mind's own log. `iterate identity post` knows no
  // id: it is the one that the mind publishes. The stack's key is listed: nothing more is signed.
  expect(await postIdentity({ controlPlaneHostname: hostname }, io)).toEqual({
    mindId,
    taken: 0,
    here: 2,
    published: 2,
    emptyBefore: false,
  });
  expect(mind).toMatchObject({ answered: ["accepted", "accepted", "known"] });
  expect(mind.asked.slice(5)).toEqual([
    `GET ${url}`,
    `POST ${url}`,
    `GET ${stackUrl}`,
    `GET ${url}`,
  ]);
  expect(mind.position()).toBe(2);
  expect(said).toEqual([]);
});

test("a stack that shows another key (a new database) gets a record that names it in place of the stack's old key, and every other working key stays", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  const mind = mindAt(mindId);
  const { io } = ioFor(dir, mind.fetcher);
  await postIdentity({ controlPlaneHostname: hostname, mindId }, io);
  const first = mind.stackKey()!;

  // the owner lists two keys of their own: another key for statements, and a key of another
  // purpose. The record is signed by the root key and posted with the others.
  const file = join(dir, `${mindId}.json`);
  const { records } = fileOf(file);
  const last = IdentityRecord.parse(JSON.parse(records.at(-1).record));
  const others = [
    { ...stackEntry(await newStackKey()), label: "laptop" },
    { ...stackEntry(await newStackKey()), purpose: "devices" },
  ];
  const record = identityRecordText({
    ...last,
    prev: await identityHashOf(records.at(-1).record),
    workingKeys: [...last.workingKeys, ...others],
  });
  const rootKey = IdentityRecord.parse(JSON.parse(records[0].record)).rootKeys[0]!.publicKey;
  const signature = await signIdentityRecord(
    record,
    await signingKeyOf(dir, mindId),
    await identityKeyIdOf(rootKey),
  );
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      mind: mindId,
      records: [...records, { record, signatures: [signature] }],
    }),
  );
  // the stack's key is listed with them: nothing more is signed
  expect(await postIdentity({ controlPlaneHostname: hostname, mindId }, io)).toMatchObject({
    taken: 1,
    here: 3,
  });

  mind.newKey();
  expect(await postIdentity({ controlPlaneHostname: hostname, mindId }, io)).toMatchObject({
    taken: 1,
    here: 4,
    published: 4,
  });
  expect(mind.stackKey()).not.toBe(first);
  expect(mind.current()?.workingKeys).toEqual([...others, stackEntry(mind.stackKey()!)]);
  expect(mind.position()).toBe(4);
});

test("with the records and no root key on this computer, nothing is signed and the stack's key is not asked for", async () => {
  const dir = newDir();
  const { mindId, keyFile } = await newIdentity([hostname], dir);
  rmSync(keyFile);
  const mind = mindAt(mindId);
  expect(
    await postIdentity({ controlPlaneHostname: hostname, mindId }, ioFor(dir, mind.fetcher).io),
  ).toMatchObject({ taken: 1, here: 1, published: 1 });
  expect(mind).toMatchObject({ asked: [`GET ${url}`, `POST ${url}`, `GET ${url}`] });
});

test("a stack key that is no ML-DSA-65 key under its own id, or another mind's, is not signed", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  const mind = mindAt(mindId);
  const answered = (document: Record<string, unknown>) =>
    ioFor(dir, async (request) =>
      new URL(request.url).pathname === "/keys/stack.json"
        ? Response.json(document)
        : mind.fetcher(request),
    ).io;
  const key = await newStackKey();
  const good = {
    mind: hostname,
    key: await identityKeyIdOf(key),
    publicKey: key,
    algorithm: "ML-DSA-65",
  };
  for (const [document, error] of [
    [{ ...good, key: "x".repeat(43) }, "shows a key that is no ML-DSA-65 key under its own id"],
    [{ ...good, publicKey: key.slice(0, 100) }, "shows a key that is no ML-DSA-65 key"],
    [{ ...good, algorithm: "P-256" }, "answered 200 with no ML-DSA-65 key of the stack"],
    [{ ...good, mind: "another.example.com" }, "answered 200 with no ML-DSA-65 key of the stack"],
  ] as const)
    await expect(
      postIdentity({ controlPlaneHostname: hostname, mindId }, answered(document)),
    ).rejects.toThrow(`${stackUrl} ${error}`);
  expect(fileOf(join(dir, `${mindId}.json`)).records).toHaveLength(1);
  expect(mind.position()).toBe(1);
});

test("the stack's key is read to a bound, and asked again after a fault, as the log is", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  const mind = mindAt(mindId);
  let tries = 0;
  const { io, said } = ioFor(dir, async (request) => {
    if (new URL(request.url).pathname !== "/keys/stack.json") return mind.fetcher(request);
    if (tries++ === 0) return new Response("x".repeat(64 * 1024));
    return mind.fetcher(request);
  });
  expect(await postIdentity({ controlPlaneHostname: hostname, mindId }, io)).toMatchObject({
    taken: 2,
  });
  expect(said).toEqual([
    "The mind's identity log did not answer (its answer was cut off, too large or too slow): again in 1 s",
  ]);
});

test("a 200 counts only as a receipt for the record that was sent: one that names another mind or another record is refused", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  for (const receipt of [
    { answer: "accepted" },
    { answer: "accepted", mind: "ab".repeat(32), hash: mindId },
    { answer: "known", mind: mindId, hash: "ab".repeat(32) },
  ]) {
    const mind = mindAt(mindId, { receipt });
    await expect(
      postIdentity({ controlPlaneHostname: hostname, mindId }, ioFor(dir, mind.fetcher).io),
    ).rejects.toThrow(`${url} answered 200 with no receipt for the record that was sent`);
  }
});

test("a 5xx answer is asked again after a growing wait that the person sees, and the post then succeeds", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  const mind = mindAt(mindId, { postsRefused: 3 });
  const { io, said, waited } = ioFor(dir, mind.fetcher);

  expect(await postIdentity({ controlPlaneHostname: hostname, mindId }, io)).toMatchObject({
    taken: 2,
  });
  expect(waited).toEqual([1_000, 2_000, 4_000]);
  expect(said).toEqual([
    "The mind's identity log did not answer (503): again in 1 s",
    "The mind's identity log did not answer (503): again in 2 s",
    "The mind's identity log did not answer (503): again in 4 s",
  ]);
  expect(mind.position()).toBe(2);
});

test("a fault of the network, and a body that breaks off, are asked again the same way, at the read of the log too", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  const mind = mindAt(mindId, { unreachable: 1, brokenBodies: 1 });
  const { io, said, waited } = ioFor(dir, mind.fetcher);

  expect(await postIdentity({ controlPlaneHostname: hostname, mindId }, io)).toMatchObject({
    taken: 2,
  });
  expect(mind.asked.slice(0, 4)).toEqual([`GET ${url}`, `GET ${url}`, `GET ${url}`, `POST ${url}`]);
  expect(waited).toEqual([1_000, 2_000]);
  expect(said).toEqual([
    "The mind's identity log did not answer (fetch failed): again in 1 s",
    "The mind's identity log did not answer (its answer was cut off, too large or too slow): again in 2 s",
  ]);
});

test("an answer is read to a bound and no further: an endless body is cancelled, and is no answer", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  let cancelled = 0;
  let sent = 0;
  const endless = ioFor(dir, async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        sent += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel: () => {
        cancelled++;
      },
    });
    return new Response(body, { status: 200 });
  });
  await expect(
    postIdentity({ controlPlaneHostname: hostname, mindId }, endless.io),
  ).rejects.toThrow(`${url} did not answer: its answer was cut off, too large or too slow`);
  // six tries, each read to the bound of a page and a record (768 KiB) and a few chunks more
  expect(cancelled).toBe(6);
  expect(sent).toBeLessThanOrEqual(6 * (768 + 4 * 64) * 1024);
  expect(endless).toMatchObject({ waited: [1_000, 2_000, 4_000, 8_000, 16_000] });
});

test("the waits are bounded: after five of them the post fails with what the mind last said, and the same post works later", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  const mind = mindAt(mindId, { postsRefused: 6 });
  const { io, waited } = ioFor(dir, mind.fetcher);

  await expect(postIdentity({ controlPlaneHostname: hostname, mindId }, io)).rejects.toThrow(
    `${url} did not take the record (503 undelivered): Not now.`,
  );
  expect(waited).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  expect(mind.asked.filter((request) => request.startsWith("POST "))).toHaveLength(6);
  expect(await postIdentity({ controlPlaneHostname: hostname, mindId }, io)).toMatchObject({
    taken: 2,
  });

  // a network that stays down ends the same way, with the network's own word
  const down = ioFor(dir, mindAt(mindId, { unreachable: 6 }).fetcher);
  await expect(postIdentity({ controlPlaneHostname: hostname, mindId }, down.io)).rejects.toThrow(
    `${url} did not answer: fetch failed`,
  );
  expect(down).toMatchObject({ waited: [1_000, 2_000, 4_000, 8_000, 16_000] });
});

test("a 4xx is the mind's last word, and so is an answer that is no log: each fails at once, with no wait", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);

  // a mind whose config names another id refuses this genesis
  const other = mindAt("ab".repeat(32));
  const refused = ioFor(dir, async (request: Request) => {
    const answer = await other.fetcher(request);
    if (request.method === "POST") return answer;
    return Response.json({ ...(await answer.json()), mind: mindId });
  });
  await expect(
    postIdentity({ controlPlaneHostname: hostname, mindId }, refused.io),
  ).rejects.toThrow(/did not take the record \(400 wrong-genesis\): The genesis does not hash/);
  expect(refused).toMatchObject({ waited: [], said: [] });
  expect(other).toMatchObject({ asked: [`GET ${url}`, `POST ${url}`] });

  await expect(
    postIdentity({ controlPlaneHostname: hostname, mindId }, ioFor(dir, other.fetcher).io),
  ).rejects.toThrow(`${url} is the log of the mind ${"ab".repeat(32)}, and this mind is ${mindId}`);

  const page = ioFor(dir, async () => new Response("<html>a page</html>", { status: 200 }));
  await expect(postIdentity({ controlPlaneHostname: hostname, mindId }, page.io)).rejects.toThrow(
    `${url} answered 200 with no identity log`,
  );
  expect(page).toMatchObject({ waited: [] });
});

test("a host's words reach the terminal as one plain line of at most 200 characters", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  const escape = String.fromCharCode(0x1b);
  const reversal = String.fromCharCode(0x202e);
  const loud = ioFor(dir, async (request: Request) => {
    if (request.method === "GET")
      return Response.json({ version: 1, mind: mindId, head: null, records: [] });
    return Response.json(
      {
        answer: "refused",
        reason: `x${escape}[2J`,
        message: `${escape}[1A\rDone.${reversal}${"y".repeat(300)}`,
      },
      { status: 400 },
    );
  });
  const error = await postIdentity({ controlPlaneHostname: hostname, mindId }, loud.io).catch(
    (thrown: Error) => thrown.message,
  );
  expect(error).toMatch(
    /^https:\/\/\S+ did not take the record \(400 x \[2J\): {2}\[1A Done\. y+$/,
  );
  expect(String(error).split(": ").at(-1)).toHaveLength(200);
});

test("a deploy from a computer that holds no records of the mind asks nothing and says nothing", async () => {
  const dir = newDir();
  const { io, said } = ioFor(dir, async () => {
    throw new Error("the mind was asked");
  });
  expect(
    await postIdentity({ controlPlaneHostname: hostname, mindId: "cd".repeat(32) }, io),
  ).toBeUndefined();
  expect(said).toEqual([]);
  // with no id given, the mind names it, and there is still nothing here to post
  const mind = mindAt("cd".repeat(32));
  expect(
    await postIdentity({ controlPlaneHostname: hostname }, ioFor(dir, mind.fetcher).io),
  ).toBeUndefined();
  expect(mind).toMatchObject({ asked: [`GET ${url}`] });
});

test("`identity post` and `show` give a mind's records only to a hostname that they name: a host that says it is a mind it is not gets nothing", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  // another host that knows the mind's public id, and says that it is that mind
  const stranger = mindAt(mindId);
  const elsewhere = ioFor(dir, stranger.fetcher);
  await expect(
    postIdentity({ controlPlaneHostname: "iterate.evil.example" }, elsewhere.io),
  ).rejects.toThrow(
    `The records of the mind ${mindId} on this computer do not name iterate.evil.example. Nothing was sent.`,
  );
  // the log was read, and nothing was signed, asked for or sent
  expect(stranger).toMatchObject({
    asked: ["GET https://iterate.evil.example/.well-known/iterate"],
  });
  // a deploy that names the mind's id gets the same rule
  await expect(
    postIdentity({ controlPlaneHostname: "iterate.evil.example", mindId }, elsewhere.io),
  ).rejects.toThrow("do not name iterate.evil.example. Nothing was sent.");
  expect(stranger.asked).toHaveLength(2);
  expect(fileOf(join(dir, `${mindId}.json`)).records).toHaveLength(1);
  expect(await shownIdentity("iterate.evil.example", elsewhere.io)).toEqual({
    mind: mindId,
    records: "the records of this mind id on this computer do not name iterate.evil.example",
  });
  // the hostname that the genesis names gets them
  const mind = mindAt(mindId);
  expect(
    await postIdentity({ controlPlaneHostname: hostname }, ioFor(dir, mind.fetcher).io),
  ).toMatchObject({ taken: 2 });
});

test("a records file is checked whole from its genesis before anything is sent: another mind's records, or a record that does not continue the log, are refused", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  const another = await newIdentity([hostname], dir);
  const file = join(dir, `${mindId}.json`);
  const [genesis] = fileOf(file).records;
  const [otherGenesis] = fileOf(join(dir, `${another.mindId}.json`)).records;

  for (const records of [[otherGenesis], [genesis, otherGenesis]]) {
    writeFileSync(file, JSON.stringify({ version: 1, mind: mindId, records }));
    const mind = mindAt(mindId);
    await expect(
      postIdentity({ controlPlaneHostname: hostname, mindId }, ioFor(dir, mind.fetcher).io),
    ).rejects.toThrow(`${file} is no identity log of the mind ${mindId} that its own check takes`);
    expect(mind).toMatchObject({ asked: [`GET ${url}`] });
  }
});

test("a log whose last record is not on this computer gets no post: nothing here continues it", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname], dir);
  const ahead = ioFor(dir, async (request) => {
    if (request.method !== "GET") throw new Error("a record was sent");
    return Response.json({ version: 1, mind: mindId, head: "ef".repeat(32), records: [] });
  });
  expect(await postIdentity({ controlPlaneHostname: hostname, mindId }, ahead.io)).toEqual({
    mindId,
    taken: 0,
    here: 1,
    published: undefined,
    emptyBefore: false,
  });
});

test("an identity that an earlier run made for a hostname is found again: the newest of those whose key file is here", async () => {
  const dir = newDir();
  const older = await newIdentity([hostname], dir);
  const newer = await newIdentity([hostname], dir);
  const keyless = await newIdentity([hostname], dir);
  const elsewhere = await newIdentity(["iterate.other.example"], dir);
  const madeAt = (identity: { keyFile: string }, iso: string) =>
    utimesSync(identity.keyFile, new Date(iso), new Date(iso));
  madeAt(older, "2026-11-01T10:00:00Z");
  madeAt(newer, "2026-11-02T10:00:00Z");
  madeAt(elsewhere, "2026-11-03T10:00:00Z");
  // the newest, but its key file is not here: that identity cannot sign, and is not taken
  rmSync(keyless.keyFile);
  // a records file that its check refuses is passed over
  writeFileSync(join(dir, `${"ab".repeat(32)}.json`), "{");
  writeFileSync(join(dir, `${"ab".repeat(32)}.key.json`), "{}");

  expect(await identityMadeFor(hostname, dir)).toEqual({
    mindId: newer.mindId,
    keyFile: newer.keyFile,
    madeAt: new Date("2026-11-02T10:00:00Z"),
  });
  expect(await identityMadeFor("iterate.other.example", dir)).toMatchObject({
    mindId: elsewhere.mindId,
  });
  expect(await identityMadeFor("iterate.third.example", dir)).toBeUndefined();
  expect(await identityMadeFor(hostname, newDir())).toBeUndefined();
  // nothing was made or removed
  expect(readdirSync(dir)).toHaveLength(9);
  expect(existsSync(older.keyFile)).toBe(true);
});

test("with no ML-DSA-65 in the runtime, the command stops with one sentence that names Node", async () => {
  await expect(mlDsaRequired(async () => false)).rejects.toThrow(
    /^This needs Node 24\.7 or newer: this one \(.+\) has no ML-DSA-65, the algorithm of a mind's identity key\.$/,
  );
  await expect(mlDsaRequired()).resolves.toBeUndefined();
});

test("`identity show` says the mind's id, the last record's hostnames, the records here and published, and where the key is", async () => {
  const dir = newDir();
  const { mindId } = await newIdentity([hostname, "ada-labs.com"], dir);
  const mind = mindAt(mindId);
  const { io } = ioFor(dir, mind.fetcher);
  const shown = {
    mind: mindId,
    hostnames: [hostname, "ada-labs.com"],
    records: { here: 1, published: 0 },
    key: keyFileOf(dir, mindId),
  };
  expect(await shownIdentity(hostname, io)).toEqual(shown);
  await postIdentity({ controlPlaneHostname: hostname, mindId }, io);
  expect(await shownIdentity(hostname, io)).toEqual({
    ...shown,
    records: { here: 2, published: 2 },
  });
  // on a computer that holds nothing of the mind, it says so and names no key
  expect(await shownIdentity(hostname, ioFor(newDir(), mind.fetcher).io)).toEqual({
    mind: mindId,
    records: "none on this computer: another computer has its key",
  });
});

/** The working key for statements, as the command lists the stack's key. */
const stackEntry = (publicKey: string) => ({
  signs: "raw" as const,
  algorithm: "ML-DSA-65" as const,
  publicKey,
  label: "stack",
  purpose: "statements",
});
const newDir = () => join(mkdtempSync(join(tmpdir(), "iterate-identity-")), "identities");
const fileOf = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const unborn = (mindId: string): IdentityState => ({
  expected: mindId,
  head: null,
  position: 0,
  current: null,
});

/** A MIND'S INTAKE AND ITS PUBLISHED LOG, as core/auth-worker answers them, with the real check:
 *  `GET` answers the log's id and head, and `POST` takes a record that `nextIdentity` accepts,
 *  with a receipt that names the mind and the record (or `receipt` in its place), and
 *  `/keys/stack.json` shows the stack's own ML-DSA-65 key. Its first
 *  `unreachable` requests fail as a network does, its next `brokenBodies` answers break off in
 *  their body, and its first `postsRefused` posts after those get a 503. */
function mindAt(
  mindId: string,
  {
    unreachable = 0,
    brokenBodies = 0,
    postsRefused = 0,
    receipt = undefined as object | undefined,
  } = {},
) {
  let state = unborn(mindId);
  let stackKey: string | undefined;
  const asked: string[] = [];
  const answered: string[] = [];
  const fetcher: IdentityIo["fetcher"] = async (request) => {
    asked.push(`${request.method} ${request.url}`);
    if (unreachable-- > 0) throw new TypeError("fetch failed");
    if (brokenBodies-- > 0)
      return new Response(
        new ReadableStream({
          start: (controller) => {
            controller.enqueue(new TextEncoder().encode('{"version":'));
            controller.error(new Error("the connection was reset"));
          },
        }),
      );
    if (request.method === "GET" && new URL(request.url).pathname === "/keys/stack.json") {
      stackKey ||= await newStackKey();
      return Response.json({
        mind: new URL(request.url).hostname,
        key: await identityKeyIdOf(stackKey),
        publicKey: stackKey,
        algorithm: "ML-DSA-65",
        listed: !!state.current?.workingKeys.some((key) => key.publicKey === stackKey),
      });
    }
    if (request.method === "GET")
      return Response.json({ version: 1, mind: mindId, head: state.head, records: [] });
    if (postsRefused-- > 0)
      return Response.json(
        { answer: "retry", reason: "undelivered", message: "Not now." },
        { status: 503 },
      );
    const next = await nextIdentity(state, await request.json());
    if ("known" in next) {
      answered.push("known");
      return Response.json(
        receipt || { answer: "known", hash: next.known, mind: mindId, position: state.position },
      );
    }
    if ("reason" in next)
      return Response.json(
        { answer: "refused", ...next },
        { status: next.reason === "not-next" ? 409 : 400 },
      );
    if (receipt) return Response.json(receipt);
    state = next.state;
    answered.push("accepted");
    return Response.json({
      answer: "accepted",
      hash: state.head,
      mind: mindId,
      position: state.position,
    });
  };
  return {
    fetcher,
    asked,
    answered,
    position: () => state.position,
    current: () => state.current,
    /** The stack's key: `newKey` makes another, as a stack on a new database does. */
    stackKey: () => stackKey,
    newKey: () => void (stackKey = undefined),
  };
}

/** An ML-DSA-65 public key, raw, as a stack shows its own at `/keys/stack.json`. */
async function newStackKey() {
  // the casts: TypeScript's library knows neither the algorithm by name nor the raw format
  const pair = (await crypto.subtle.generateKey({ name: "ML-DSA-65" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return base64url(
    new Uint8Array(
      (await crypto.subtle.exportKey("raw-public" as "raw", pair.publicKey)) as ArrayBuffer,
    ),
  );
}

/** The command's world: the folder, the mind, and what was said and how long it waited. */
function ioFor(dir: string, fetcher: IdentityIo["fetcher"]) {
  const said: string[] = [];
  const waited: number[] = [];
  const io: IdentityIo = {
    dir,
    fetcher,
    pause: async (ms) => waited.push(ms),
    say: (line) => said.push(line),
  };
  return { io, said, waited };
}
