// What leaves the account when a destroyed stack's state store is removed (state-store.ts),
// against a pretend Cloudflare.
import assert from "node:assert/strict";
import { test } from "node:test";
import { removeStateStore, stateSecretNamesOf } from "./state-store.ts";
import type { Call } from "./cloudflare-call.ts";

const ACCOUNT = "a".repeat(32);

void test("a state store's two secrets are named as Alchemy names them", () => {
  assert.deepEqual(stateSecretNamesOf("blifto-com"), [
    "AlchemyStateStoreToken_iterate_blifto_com_state",
    "AlchemyStateStoreEncryptionKey_iterate_blifto_com_state",
  ]);
});

void test("the state Worker and its two secrets go, and no other stack's secret", async () => {
  const cloudflare = pretendCloudflare({
    workers: ["iterate-one-state", "iterate-two-state", "iterate-two-boundary"],
    secrets: [...stateSecretNamesOf("one"), ...stateSecretNamesOf("two"), "AlchemyStateStoreToken"],
  });

  const { failed, lines } = await removeStateStore({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
  });

  assert.equal(failed, false);
  assert.deepEqual(lines, [
    "Removed: the Worker iterate-one-state, with the stack's state",
    "Removed: the secret AlchemyStateStoreToken_iterate_one_state in the Secrets Store",
    "Removed: the secret AlchemyStateStoreEncryptionKey_iterate_one_state in the Secrets Store",
  ]);
  assert.deepEqual(cloudflare.workers, ["iterate-two-state", "iterate-two-boundary"]);
  assert.deepEqual(cloudflare.secrets, [...stateSecretNamesOf("two"), "AlchemyStateStoreToken"]);
});

void test("a stack that is still deployed keeps its state store: nothing is removed", async () => {
  const cloudflare = pretendCloudflare({
    workers: ["iterate-one-state", "iterate-one-auth"],
    secrets: stateSecretNamesOf("one"),
  });

  const { failed, lines } = await removeStateStore({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
  });

  assert.equal(failed, true);
  assert.match(lines[0]!, /^Stopped: the Worker iterate-one-auth is still deployed\./);
  assert.deepEqual(cloudflare.workers, ["iterate-one-state", "iterate-one-auth"]);
  assert.deepEqual(cloudflare.secrets, stateSecretNamesOf("one"));
});

void test("a state Worker deleted by hand: its two secrets still go, and a second run finds nothing", async () => {
  const cloudflare = pretendCloudflare({ workers: [], secrets: stateSecretNamesOf("one") });
  const first = await removeStateStore({ accountId: ACCOUNT, name: "one", call: cloudflare.call });
  assert.equal(first.failed, false);
  assert.equal(first.lines[0], "The Worker iterate-one-state is not there.");
  assert.deepEqual(cloudflare.secrets, []);
  assert.deepEqual(
    (await removeStateStore({ accountId: ACCOUNT, name: "one", call: cloudflare.call })).lines,
    [
      "The Worker iterate-one-state is not there.",
      "The Secrets Store holds no secret of iterate-one-state.",
    ],
  );
});

/** An account's Workers and the secrets of its one Secrets Store, by name. */
function pretendCloudflare(held: { workers: string[]; secrets: string[] }) {
  const state = structuredClone(held);
  const call: Call = async (method, url) => {
    const { pathname } = new URL(url);
    // /client/v4/accounts/<account>/…
    const parts = pathname.split("/").filter(Boolean).slice(4);
    if (parts[0] === "workers") {
      const worker = parts[2]!;
      if (!state.workers.includes(worker)) return { status: 404, body: null };
      if (method === "DELETE") state.workers.splice(state.workers.indexOf(worker), 1);
      return { status: 200, body: { success: true } };
    }
    // secrets_store/stores[/<store>/secrets[/<id>]]
    if (parts.length === 2) return { status: 200, body: { result: [{ id: "store" }] } };
    if (method === "GET")
      return { status: 200, body: { result: state.secrets.map((name) => ({ id: name, name })) } };
    state.secrets.splice(state.secrets.indexOf(parts[4]!), 1);
    // as the real Secrets Store answers a delete
    return { status: 202, body: { success: true } };
  };
  return {
    call,
    get workers() {
      return state.workers;
    },
    get secrets() {
      return state.secrets;
    },
  };
}
