// What leaves a destroyed stack's zone (dmarc-record.ts), against a pretend Cloudflare.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Call } from "./cloudflare-call.ts";
import { domainFor, removeDmarcRecord } from "./dmarc-record.ts";

const ACCOUNT = "a".repeat(32);
const WRITTEN = '"v=DMARC1; p=reject;"';

void test("after a destroy, the record that Email Sending wrote goes, and no other record of the zone", async () => {
  const cloudflare = pretendCloudflare({ records: { "_dmarc.one.example": [WRITTEN] } });
  const { failed, lines } = await removeDmarcRecord({
    accountId: ACCOUNT,
    name: "one",
    domain: "one.example",
    call: cloudflare.call,
  });
  assert.equal(failed, false);
  assert.deepEqual(lines, ["Removed: the TXT record _dmarc.one.example"]);
  assert.deepEqual(cloudflare.writes, ["DELETE /client/v4/zones/zone-1/dns_records/record-0"]);
  // a second run finds nothing and says nothing
  assert.deepEqual(
    await removeDmarcRecord({
      accountId: ACCOUNT,
      name: "one",
      domain: "one.example",
      call: cloudflare.call,
    }),
    { failed: false, lines: [] },
  );
});

void test("a DMARC record with a person's own content stays", async () => {
  const cloudflare = pretendCloudflare({
    records: { "_dmarc.one.example": ['"v=DMARC1; p=none; rua=mailto:dmarc@one.example"'] },
  });
  const { failed, lines } = await removeDmarcRecord({
    accountId: ACCOUNT,
    name: "one",
    domain: "one.example",
    call: cloudflare.call,
  });
  assert.equal(failed, false);
  assert.deepEqual(lines, [
    "Left: a TXT record _dmarc.one.example that Email Sending did not write",
  ]);
  assert.deepEqual(cloudflare.writes, []);
});

void test("a stack that is still deployed keeps its record", async () => {
  const cloudflare = pretendCloudflare({
    records: { "_dmarc.one.example": [WRITTEN] },
    workers: ["iterate-one-auth"],
  });
  const { failed, lines } = await removeDmarcRecord({
    accountId: ACCOUNT,
    name: "one",
    domain: "one.example",
    call: cloudflare.call,
  });
  assert.equal(failed, false);
  assert.match(lines[0]!, /still deployed \(the Worker iterate-one-auth is there\)/);
  assert.deepEqual(cloudflare.writes, []);
});

void test("an answer that Cloudflare refuses fails the step, with a line that says what may be left", async () => {
  for (const refuse of ["zone", "records", "delete"]) {
    const cloudflare = pretendCloudflare({ records: { "_dmarc.one.example": [WRITTEN] }, refuse });
    const { failed, lines } = await removeDmarcRecord({
      accountId: ACCOUNT,
      name: "one",
      domain: "one.example",
      call: cloudflare.call,
    });
    assert.equal(failed, true, refuse);
    assert.match(lines.join(" "), /answered 403/, refuse);
    assert.doesNotMatch(lines.join(" "), /^Removed/, refuse);
  }
});

void test("a domain that is no zone of the account has no record to remove", async () => {
  const cloudflare = pretendCloudflare({ records: {}, zone: "other.example" });
  const { failed, lines } = await removeDmarcRecord({
    accountId: ACCOUNT,
    name: "one",
    domain: "one.example",
    call: cloudflare.call,
  });
  assert.equal(failed, false);
  assert.deepEqual(lines, ["The account has no zone one.example: no DNS record"]);
});

void test("a stack with no config file: the domain that destroy read first is used, and the cleared state is never read", async () => {
  // as after a destroy of a stack whose config was in its state
  const cleared = async (): Promise<string> => {
    throw new Error("No stored config for the stack one");
  };
  assert.equal(
    await domainFor(["node", "script", "--domain", "one.example", "--stage", "one"], cleared),
    "one.example",
  );
  await assert.rejects(
    domainFor(["node", "script", "--stage", "one"], cleared),
    /No stored config/,
  );
  // by hand, with a config file, the config's domain is used
  assert.equal(
    await domainFor(["node", "script", "--stage", "one"], async () => "file.example"),
    "file.example",
  );
});

void test("`pnpm run destroy` reads the domain before Alchemy's destroy and gives it to the step after", () => {
  // The cast: this package's own package.json, which has the script.
  const { scripts } = JSON.parse(
    readFileSync(`${import.meta.dirname}/../package.json`, "utf8"),
  ) as { scripts: { destroy: string } };
  const read = scripts.destroy.indexOf("remove-dmarc-record.ts --print-domain");
  const destroyed = scripts.destroy.indexOf("cli.js destroy");
  const removed = scripts.destroy.indexOf('remove-dmarc-record.ts --domain "$domain"');
  assert.ok(read >= 0 && read < destroyed && destroyed < removed, scripts.destroy);
  // a domain that cannot be read stops the run before anything is destroyed
  assert.match(scripts.destroy, /--print-domain "\$@"\) \|\| return 1; /);
});

/** An account as Cloudflare answers for it: its Workers, and one zone (`one.example` unless
 *  `zone` names another) with its TXT records by name. `refuse` names the call that Cloudflare
 *  refuses: "zone" (its lookup), "records" (their listing), "delete". */
function pretendCloudflare(held: {
  records: Record<string, string[]>;
  workers?: string[];
  zone?: string;
  refuse?: string;
}) {
  const records = Object.entries(held.records).flatMap(([name, contents]) =>
    contents.map((content, at) => ({ id: `record-${at}`, name, content })),
  );
  const writes: string[] = [];
  const answer = (status: number, body: unknown = null) => ({ status, body });
  const call: Call = async (method, url) => {
    const { pathname, searchParams } = new URL(url);
    if (method !== "GET") writes.push(`${method} ${pathname}`);
    const parts = pathname.split("/").filter(Boolean).slice(2);
    if (parts[0] === "accounts")
      return (held.workers || []).includes(parts[4]!) ? answer(200, {}) : answer(404);
    if (parts.length === 1) {
      if (held.refuse === "zone") return answer(403);
      const mine = searchParams.get("name") === (held.zone || "one.example");
      return answer(200, { result: mine ? [{ id: "zone-1" }] : [] });
    }
    if (method === "GET") {
      if (held.refuse === "records") return answer(403);
      return answer(200, {
        result: records.filter((record) => record.name === searchParams.get("name")),
      });
    }
    if (held.refuse === "delete") return answer(403);
    records.splice(
      records.findIndex((record) => record.id === parts[3]),
      1,
    );
    return answer(200, { result: { id: parts[3] } });
  };
  return { call, writes };
}
