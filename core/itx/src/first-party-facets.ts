// The only path from a facet name to `ctx.exports`: no FacetSpec names a class of the Worker, and
// a reserved name refuses a spec, so loaded code never reaches the host's classes.
import { codedError } from "iterate/lib";
import { itxHost } from "./host.ts";

function firstPartyFacet(name: string) {
  const facets = itxHost().firstPartyFacets;
  return Object.hasOwn(facets, name) ? facets[name] : undefined;
}

export function firstPartyFacetClassOf(name: string): string | undefined {
  return firstPartyFacet(name)?.className;
}

/** Every first-party facet name the host declares. */
export function firstPartyFacetNames(): string[] {
  return Object.keys(itxHost().firstPartyFacets);
}

/** Its class's own `publicMethods`, as the host declares them. */
export function firstPartyFacetPublicMethodsOf(name: string): readonly string[] {
  return firstPartyFacet(name)?.publicMethods ?? [];
}

// The wake record is in the filter so each incarnation runs the processor's at-head pass, which
// restarts what the last incarnation left owed. Undefined for a row kept unfiltered.
export function firstPartyRowConsumesOf(name: string): string[] | undefined {
  const consumes = firstPartyFacet(name)?.consumes;
  return consumes ? [...consumes, "events.iterate.com/itx/woken"] : undefined;
}

// FORBIDDEN, because a hosting row's delivery halts on it at once.
export function assertFacetPlacement(name: string, path: string): void {
  const placement = firstPartyFacet(name)?.placement;
  if (!placement || placement.mayBeHostedOn(path)) return;
  throw codedError(
    "FORBIDDEN",
    `facet "${name}" is first-party and is hosted only on ${placement.where} — never on ${path}`,
  );
}
