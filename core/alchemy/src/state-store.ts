// state-store.ts — WHAT A DESTROY LEAVES OF A STACK'S STATE STORE, and how it is removed when the
// stack is gone for good (scripts/remove-state-store.ts).
//
// A destroy leaves the state store on purpose: a fork's stack keeps its state in the same store,
// and a stack that is deployed again reads its keys from it. So three things stay in the account
// after the last destroy: the Worker `iterate-<name>-state`, and two secrets in the account's
// Secrets Store, by which Alchemy reaches that Worker. A Worker deleted by hand leaves the two
// secrets, and a Secrets Store holds a limited number.
import { resourceNamesOf } from "./config.ts";
import { accountUrl, type Call, stillDeployed } from "./cloudflare-call.ts";

/** The two secrets of a state store, as Alchemy names them. The Cloud's erase removes the same
 *  (internal-packages/installer/container/takeover.mjs `namesOf`): `core/` is published alone, so
 *  this is a second copy of the rule. */
export function stateSecretNamesOf(name: string): string[] {
  const store = resourceNamesOf(name).state.replace(/[^A-Za-z0-9_]/g, "_");
  return [`AlchemyStateStoreToken_${store}`, `AlchemyStateStoreEncryptionKey_${store}`];
}

/** Removes the state store of a stack that is destroyed: its Worker, then its two secrets. It
 *  stops, and removes nothing, while a Worker of the stack is still deployed: the state store is
 *  then the only record of what a destroy must remove. Answers a line for each thing. */
export async function removeStateStore(input: { accountId: string; name: string; call: Call }) {
  const { accountId, name, call } = input;
  const names = resourceNamesOf(name);
  const account = accountUrl(accountId);
  const lines: string[] = [];
  const live = await stillDeployed(input);
  if (live.worker)
    return {
      failed: true,
      lines: [
        `Stopped: the Worker ${live.worker} is still deployed. Destroy the stack first (pnpm run destroy --stage ${name}): its state store is the record of what a destroy removes.`,
      ],
    };
  if (live.unread)
    return { failed: true, lines: [`Stopped: ${live.unread}. Nothing was removed.`] };
  let failed = false;
  // Cloudflare answers a delete with 200, or 202 for a secret of the Secrets Store
  const said = (what: string, status: number) => {
    if (status >= 200 && status < 300) lines.push(`Removed: ${what}`);
    else {
      failed = true;
      lines.push(`NOT removed: ${what} (Cloudflare answered ${status})`);
    }
  };
  const worker = await call("DELETE", `${account}/workers/scripts/${names.state}?force=true`);
  if (worker.status === 404) lines.push(`The Worker ${names.state} is not there.`);
  else said(`the Worker ${names.state}, with the stack's state`, worker.status);

  const wanted = stateSecretNamesOf(name);
  const stores = await call("GET", `${account}/secrets_store/stores`);
  // The cast: Cloudflare's documented answer; a list that is not there reads as empty.
  const storeIds = ((stores.body as { result?: { id: string }[] } | null)?.result ?? []).map(
    (store) => store.id,
  );
  if (stores.status !== 200) {
    failed = true;
    lines.push(
      `NOT removed: the state store's two secrets (Cloudflare answered ${stores.status} to GET the Secrets Stores)`,
    );
  }
  let found = 0;
  for (const store of storeIds)
    // a store's secrets, a hundred at a time: twenty pages at most
    for (let page = 1; page <= 20; page += 1) {
      const listed = await call(
        "GET",
        `${account}/secrets_store/stores/${store}/secrets?per_page=100&page=${page}`,
      );
      // The cast: as for the stores above.
      const secrets =
        (listed.body as { result?: { id: string; name: string }[] } | null)?.result ?? [];
      for (const secret of secrets.filter((candidate) => wanted.includes(candidate.name))) {
        found += 1;
        const gone = await call(
          "DELETE",
          `${account}/secrets_store/stores/${store}/secrets/${secret.id}`,
        );
        said(`the secret ${secret.name} in the Secrets Store`, gone.status);
      }
      if (secrets.length < 100) break;
    }
  if (stores.status === 200 && found === 0)
    lines.push(`The Secrets Store holds no secret of ${names.state}.`);
  return { failed, lines };
}
