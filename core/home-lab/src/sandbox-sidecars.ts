// sandbox-sidecars.ts — THE SIDECARS THAT workerd LEAVES BEHIND. For each sandbox, local workerd
// starts two containers: the sandbox, and beside it `<name>-proxy` from the image
// `cloudflare/proxy-everything`, which carries the sandbox's traffic. When a sandbox ends, workerd
// removes its container and leaves the sidecar running (seen with workerd 1.20261104.1: after a
// night of smoke runs a home machine had 29 of them and no sandbox). The launcher removes them.
import { spawnSync } from "node:child_process";

/** A container as `docker ps -a` lists it. */
export type Listed = { name: string; image: string; state: string; createdAt: number };

/** A sidecar is older than this before it counts as left: workerd starts the sidecar first, and
 *  its sandbox a moment later. */
const SETTLED_MS = 60_000;

/** The sidecars to remove: workerd's own (`workerd-…-proxy`, of the proxy image), with no running
 *  container of the name before `-proxy`, and not just started. */
export function leftSidecars(listed: readonly Listed[], now: number): string[] {
  const running = new Set(
    listed.filter((container) => container.state === "running").map((container) => container.name),
  );
  return listed
    .filter(
      ({ name, image, createdAt }) =>
        name.startsWith("workerd-") &&
        name.endsWith("-proxy") &&
        image.startsWith("cloudflare/proxy-everything") &&
        !running.has(name.slice(0, -"-proxy".length)) &&
        now - createdAt > SETTLED_MS,
    )
    .map((container) => container.name);
}

/** Removes the left sidecars on this machine, and answers how many. Never throws: a Docker that
 *  does not answer leaves them for the next sweep. */
export function sweepSidecars(): number {
  const ps = spawnSync(
    "docker",
    ["ps", "--all", "--no-trunc", "--format", "{{.Names}}\t{{.Image}}\t{{.State}}\t{{.CreatedAt}}"],
    { encoding: "utf8" },
  );
  if (ps.error || ps.status !== 0) return 0;
  const listed = ps.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", image = "", state = "", created = ""] = line.split("\t");
      // Docker prints "2026-11-12 03:52:58 +0000 UTC": the zone's name is said twice
      return { name, image, state, createdAt: Date.parse(created.replace(/ [A-Z]+$/, "")) };
    });
  const left = leftSidecars(listed, Date.now());
  if (left.length === 0) return 0;
  const removed = spawnSync("docker", ["rm", "--force", ...left], { encoding: "utf8" });
  return removed.status === 0 ? left.length : 0;
}
