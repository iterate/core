import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  type Envelope,
  KEY_TOKEN_STATEMENT_TYPE,
  statementOf,
  verifySignature,
} from "../signed.ts";
import { bridgeAppend, bridgeKeyOf, bridgeToken, enrolUrlOf } from "./bridge-key.ts";
import { finalStateOf, ProvideRefusal, ProvideState } from "./provide-state.ts";

const MIND = "iterate.example.com";
const timing = { waitMs: 1_000, askEveryMs: 1 };

test("the first run makes the key in a file only its owner reads, and every later run uses it", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "bridge-key-")), "keys", "whatsapp.key");
  const made = await bridgeKeyOf(file);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(await bridgeKeyOf(file)).toMatchObject({ key: made.key, publicKey: made.publicKey });
});

test("the link asks a member to allow the key for one capability, and for paths when given", async () => {
  const { publicKey } = await key();
  const link = new URL(enrolUrlOf({ address: MIND, name: "whatsapp.jonas", publicKey }));
  expect(`${link.origin}${link.pathname}`).toBe("https://iterate.example.com/keys/enrol");
  expect(Object.fromEntries(link.searchParams)).toEqual({
    actor: "bridge-whatsapp-jonas",
    label: expect.stringMatching(/^whatsapp\.jonas on /),
    publicKey,
    provide: "whatsapp.jonas",
  });
  const withPaths = enrolUrlOf({
    address: MIND,
    name: "x",
    publicKey,
    paths: ["/integrations/x/"],
  });
  expect(new URL(withPaths).searchParams.get("paths")).toBe("/integrations/x/");
});

test("the first run prints the link once and asks until a member has allowed the key", async () => {
  const bridge = await key();
  const sent = answers([refusal("invalid_client"), refusal("invalid_client"), token("whatsapp")]);
  const printed: string[] = [];
  const got = await bridgeToken({
    address: MIND,
    name: "whatsapp",
    key: bridge,
    wait: (line) => printed.push(line),
    timing,
  });
  expect(got).toBe("a-token");
  expect(printed).toEqual([expect.stringContaining("https://iterate.example.com/keys/enrol?")]);
  expect(sent.map(({ url }) => url)).toEqual(
    Array(3).fill("https://iterate.example.com/keys/token"),
  );
  // each ask is a new statement of the token type at `/`, for this mind, that ends within minutes
  const statements = sent.map(({ envelope }) => statementOf(envelope.statement));
  expect(new Set(sent.map(({ envelope }) => envelope.statement))).toHaveProperty("size", 3);
  for (const [index, statement] of statements.entries()) {
    expect(statement).toMatchObject({ mind: MIND, path: "/", type: KEY_TOKEN_STATEMENT_TYPE });
    if ("refused" in statement) throw new Error(statement.refused);
    expect(statement.expires - Date.now()).toBeLessThanOrEqual(60_000);
    expect(
      await verifySignature(sent[index]!.envelope, bridge.publicKey, { origin: "", rpId: "" }),
    ).toEqual({});
  }
});

test("a later connection does not wait: a key that was removed is refused, with the link", async () => {
  answers([refusal("invalid_client")]);
  await expect(bridgeToken({ address: MIND, name: "whatsapp", key: await key() })).rejects.toThrow(
    /not allowed on iterate.example.com: .*keys\/enrol\?/,
  );
});

test("a key allowed for another name says so", async () => {
  answers([token("herdr")]);
  await expect(bridgeToken({ address: MIND, name: "whatsapp", key: await key() })).rejects.toThrow(
    /allowed to lend itx.herdr, not itx.whatsapp/,
  );
});

test("a refusal that no consent mends ends the run", async () => {
  answers([refusal("invalid_grant")]);
  await expect(
    bridgeToken({ address: MIND, name: "whatsapp", key: await key(), wait: () => {}, timing }),
  ).rejects.toThrow(/no token: the reason the mind gave/);
});

test("--json: each refusal is a state — waiting for a member, removed, not in time, another name, and a CLI the mind does not agree with", async () => {
  const stateOf = (error: unknown) => ProvideState.parse(finalStateOf(error));
  const link = expect.stringContaining("https://iterate.example.com/keys/enrol?");
  const reported: ProvideState[] = [];
  answers([refusal("invalid_client"), token("whatsapp")]);
  const bridge = await key();
  await bridgeToken({
    address: MIND,
    name: "whatsapp",
    key: bridge,
    wait: () => {},
    report: (state) => reported.push(ProvideState.parse(state)),
    timing,
  });
  expect(reported).toEqual([
    { state: "notAllowed", why: "No member has allowed this key yet.", link, waiting: true },
  ]);

  answers([refusal("invalid_client")]);
  const removed = await bridgeToken({ address: MIND, name: "whatsapp", key: bridge }).catch(
    stateOf,
  );
  expect(removed).toEqual({
    state: "notAllowed",
    why: "the reason the mind gave.",
    link,
    waiting: false,
  });

  answers(Array.from({ length: 5 }, () => refusal("invalid_client")));
  const late = await bridgeToken({
    address: MIND,
    name: "whatsapp",
    key: bridge,
    wait: () => {},
    timing: { waitMs: 3, askEveryMs: 1 },
  }).catch(stateOf);
  expect(late).toEqual({
    state: "notAllowed",
    why: "Nobody allowed this key in time.",
    link,
    waiting: false,
  });

  answers([token("herdr")]);
  expect(
    await bridgeToken({ address: MIND, name: "whatsapp", key: bridge }).catch(stateOf),
  ).toEqual({
    state: "notAllowed",
    why: "This key was allowed to lend itx.herdr, not itx.whatsapp.",
    waiting: false,
  });

  for (const why of [
    "the statement is for another mind",
    `the statement is not ${KEY_TOKEN_STATEMENT_TYPE} at /`,
  ]) {
    answers([Response.json({ error: "invalid_grant", error_description: why }, { status: 400 })]);
    const refused = await bridgeToken({ address: MIND, name: "whatsapp", key: bridge }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ProvideRefusal);
    expect((refused as Error).message).toContain("update the CLI");
    expect(stateOf(refused)).toEqual({
      state: "incompatible",
      why: `${why}: this iterate CLI and the mind do not agree on the protocol`,
    });
  }

  // a refusal that a later try may mend is no state of its own: it stops the run, or a reconnect
  // tries again
  answers([refusal("invalid_grant")]);
  expect(
    await bridgeToken({ address: MIND, name: "whatsapp", key: bridge }).catch(stateOf),
  ).toEqual({
    state: "stopped",
    why: "The mind gave this bridge's key no token: the reason the mind gave.",
  });
});

test("the file's append posts one event as a statement the key signs, and a refusal throws", async () => {
  const bridge = await key();
  const sent = answers([
    new Response("{}"),
    Response.json({ refused: "this key adds no events" }, { status: 403 }),
  ]);
  const append = bridgeAppend(MIND, bridge);
  const event = { type: "whatsapp/message-received", payload: { text: "hello" } };
  await append("/integrations/whatsapp/jonas", event);
  expect(sent[0]).toMatchObject({ url: "https://iterate.example.com/statements" });
  expect(statementOf(sent[0]!.envelope.statement)).toMatchObject({
    mind: MIND,
    path: "/integrations/whatsapp/jonas",
    ...event,
  });
  await expect(append("/agents/x", event)).rejects.toThrow(/this key adds no events/);
});

const key = () => bridgeKeyOf(join(mkdtempSync(join(tmpdir(), "bridge-key-")), "bridge.key"));

const token = (provide: string) =>
  Response.json({ access_token: "a-token", token_type: "Bearer", expires_in: 3600, provide });

const refusal = (error: string) =>
  Response.json({ error, error_description: "the reason the mind gave" }, { status: 400 });

/** The mind's answers, in order; what the bridge sent is read back from the list it returns. */
function answers(responses: Response[]) {
  const sent: { url: string; envelope: Envelope }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    sent.push({ url, envelope: JSON.parse(init.body) as Envelope });
    const answer = responses.shift();
    if (!answer) throw new Error("the bridge asked more often than the test answers");
    return answer;
  });
  return sent;
}
