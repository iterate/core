// src/first-party-row-filter.test.ts — the filter a first-party facet's row takes when its enable
// names none: what the processor that facet constructs reduces, and the wake record. The row on a
// running root is test/vitest/os/project-row.e2e.test.ts's.
import { expect, test } from "vitest";
import { consumesEvent } from "iterate/stream/processor";
import { firstPartyRowConsumesOf } from "./first-party-row-filter.ts";
import { AccountProcessor } from "./account/processor.ts";
import { EmailProcessor } from "./email/processor.ts";
import { InstanceProcessor } from "./instance/processor.ts";
import { IntegrationRegistryProcessor } from "./integrations/registry.ts";
import { OrganizationProcessor } from "./organization/processor.ts";
import { ProjectProcessor } from "./project/processor.ts";
import { SecretProcessor } from "./secret/processor.ts";

// Each facet class's `processor` field, so the filter is pinned to what the engine in that facet
// reduces.
test.for([
  { name: "account", processor: new AccountProcessor() },
  { name: "email", processor: new EmailProcessor() },
  { name: "instance", processor: new InstanceProcessor() },
  { name: "integration", processor: new IntegrationRegistryProcessor() },
  { name: "organization", processor: new OrganizationProcessor() },
  { name: "project", processor: new ProjectProcessor(unused, unused) },
  { name: "secret", processor: new SecretProcessor() },
])(
  "a $name row enabled with no filter delivers what its processor reduces, and the wake",
  ({ name, processor }) => {
    expect(firstPartyRowConsumesOf(name)).toEqual([
      ...processor.contract.consumes,
      "events.iterate.com/itx/woken",
    ]);
  },
);

test.for([
  { name: "repo" },
  { name: "sandbox" },
  { name: "workspace" },
  { name: "agents" },
  { name: "presence" },
])("a $name row enabled with no filter stays unfiltered", ({ name }) => {
  expect(firstPartyRowConsumesOf(name)).toBeUndefined();
});

test("the root's project row pushes its facet the wake and what the project folds, never a listing copy", () => {
  const consumes = firstPartyRowConsumesOf("project");
  const types = [
    "events.iterate.com/agent/listing-updated",
    "events.iterate.com/test/said",
    "events.iterate.com/itx/woken",
    "events.iterate.com/itx/child-created",
    "events.iterate.com/repo/commit-completed",
    "events.iterate.com/project/worker-updated",
  ];
  expect(types.filter((type) => consumesEvent(consumes, { type }))).toEqual([
    "events.iterate.com/itx/woken",
    "events.iterate.com/itx/child-created",
    "events.iterate.com/repo/commit-completed",
    "events.iterate.com/project/worker-updated",
  ]);
});

/** A reach the processor never calls: these rows read its contract alone. */
function unused(): never {
  throw new Error("unused");
}
