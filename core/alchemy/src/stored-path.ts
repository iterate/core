import { relative } from "node:path";

/** A folder as a resource's props keep it in the deploy's state: from the working directory, never
 *  absolute. Every deployer runs from `core/alchemy`, so each keeps the same string. An absolute
 *  path differs between machines, and a plan after a change of deployer then shows an update. */
export const storedPathOf = (absolute: string, from = process.cwd()) => relative(from, absolute);
