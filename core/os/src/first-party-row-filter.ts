// src/first-party-row-filter.ts — WHAT A FIRST-PARTY FACET'S ROW DELIVERS when its enable names no
// filter (context/built-ins.ts `processors.enable`): the events the facet's processor reduces, from
// its contract, never a copy of them. Its engine drops every other event (iterate/stream/processor
// `reducesEvent`), yet each push of one costs the context a call and holds its direct append. A
// module of its own: the core reduce imports first-party-facets.ts, and node scripts import the core
// reduce (iterate-config.ts), so the contracts stay off that path.
import { EmailContract } from "iterate/email";
import { IntegrationRegistryContract } from "iterate/integrations";
import { AccountContract } from "./account/contract.ts";
import type { FIRST_PARTY_FACET_CLASSES } from "./first-party-facets.ts";
import { InstanceContract } from "./instance/contract.ts";
import { OrganizationContract } from "./organization/contract.ts";
import { ProjectContract } from "./project/contract.ts";
import { SecretContract } from "./secret/contract.ts";

/** The contract of the processor each first-party facet hosts. A first-party name without an entry
 *  fails to typecheck. `null` keeps the row unfiltered: the entity processors
 *  (project/entity-lifecycle.ts) run a failed teardown again only at their next at-head pass, and
 *  the sandbox's re-arms a failed idle interval the same way, so a filter would hold that retry
 *  until an event they consume or the context's next wake. */
const FIRST_PARTY_ROW_CONTRACTS = new Map(
  Object.entries({
    account: AccountContract,
    email: EmailContract,
    instance: InstanceContract,
    integration: IntegrationRegistryContract,
    organization: OrganizationContract,
    project: ProjectContract,
    repo: null,
    sandbox: null,
    secret: SecretContract,
    workspace: null,
  } satisfies Record<
    keyof typeof FIRST_PARTY_FACET_CLASSES,
    { consumes: readonly string[] } | null
  >),
);

/** The filter of a first-party facet's row enabled with none: what its processor reduces, and the
 *  context's wake record. The wake is pushed so that each incarnation runs the processor's at-head
 *  pass, which starts again what the last incarnation left owed (project/processor.ts: a
 *  publication the platform gave up on for now, a deletion that failed). Undefined for any other
 *  name, and for a row kept unfiltered. */
export function firstPartyRowConsumesOf(name: string): string[] | undefined {
  const contract = FIRST_PARTY_ROW_CONTRACTS.get(name);
  return contract ? [...contract.consumes, "events.iterate.com/itx/woken"] : undefined;
}
