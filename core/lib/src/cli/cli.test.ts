import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { z } from "zod";
import { packageVersionOf } from "./cli.ts";

test("iterate --version and -v print the package version and exit 0", () => {
  const pkg = z
    .object({ version: z.string().min(1) })
    .parse(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")));
  expect(packageVersionOf()).toBe(pkg.version);

  const bin = fileURLToPath(new URL("../../bin/iterate.js", import.meta.url));
  for (const flag of ["--version", "-v", "-V"]) {
    const result = spawnSync(process.execPath, [bin, flag], { encoding: "utf8" });
    expect({ flag, status: result.status, stdout: result.stdout.trim() }).toEqual({
      flag,
      status: 0,
      stdout: pkg.version,
    });
  }
});
