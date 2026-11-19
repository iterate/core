// What each Worker of a stack holds, from the stack's own declaration (./stack.ts), against the
// checked-in ./stack-bindings.snapshot.json. A pull request that adds, removes or renames a
// binding changes that file, so the change shows in its diff. The program runs with no provider,
// no credential and no state: Alchemy records each resource's props as it is declared, and the
// one call to Cloudflare (the zone's lookup) gets a local answer. Each binding is its name and its
// kind, and for a resource, a service or a class what it names: never a value.
//
// If a change is meant, rewrite the file: UPDATE_STACK_BINDINGS=1 pnpm --filter core-alchemy test
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import type { Named } from "alchemy/Named";
import { isResource } from "alchemy/Resource";
import { isExpr } from "alchemy/Output";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import { MindConfig } from "./config.ts";
import { mindStack } from "./stack.ts";

const SNAPSHOT = new URL("stack-bindings.snapshot.json", import.meta.url);
const accountId = "aaaaabbbbbccccc111112222233333aa";
const base = {
  mindId: "a".repeat(64),
  controlPlaneHostname: "example.com",
  ownerEmails: ["owner@owner.example"],
  alchemy: { stageName: "example-com" },
  cloudflare: { accountId, zones: ["example.com"] },
};
const CASES = {
  "full-cloudflare, mail forward": {
    ...base,
    topology: "full-cloudflare",
    mail: { forwardTo: "team@group.example" },
  },
  "full-cloudflare, no mail forward": { ...base, topology: "full-cloudflare" },
  "external mind, no mail forward": {
    ...base,
    topology: "external-mind-connects-into-cloudflare-boundary",
  },
};

/** Cloudflare's answer to the zone's lookup (`listZones`), given here: the program asks nothing else. */
const zoneLookup = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ id: "zone-1", name: "example.com", account: { id: accountId } }],
      }),
    ),
  ),
);

/** Where an Output comes from: the resources and attributes it reads, not what it holds. */
const sourcesOf = (expr: any): string[] =>
  expr.kind === "ResourceExpr"
    ? [expr.src.LogicalId]
    : expr.kind === "PropExpr"
      ? sourcesOf(expr.expr).map((source) => `${source}.${String(expr.identifier)}`)
      : expr.kind === "AllExpr"
        ? expr.outs.flatMap(sourcesOf)
        : sourcesOf(expr.expr);

const kindOf = (value: any): string => {
  if (typeof value === "string") return "plain_text";
  // the one Effect left here is one that carries its kind (see `bindingsOf`)
  if (Effect.isEffect(value)) return (value as any)["~alchemy/Kind"];
  if (Redacted.isRedacted(value)) return "secret_text";
  if (isExpr(value)) return `output of ${sourcesOf(value).join(", ")}`;
  if (isResource(value)) return `${value.Type} ${value.LogicalId}`;
  if (value.kind === "Cloudflare.WorkerEntrypoint")
    return `${value.kind} (worker ${value.worker.LogicalId}, entrypoint ${value.entrypoint})`;
  if (value.kind === "Cloudflare.DurableObject") {
    const containers = (value.containers ?? []).map(
      (container: Named<string>) => container["~alchemy/Id"],
    );
    return `${value.kind} (class ${value.className}${value.scriptName ? `, worker ${value.scriptName}` : ""}${containers.length ? `, containers ${containers.join(" ")}` : ""})`;
  }
  return value.kind;
};

/** Each Worker's bindings, as the program declares them for one config. */
const bindingsOf = (config: MindConfig) =>
  Effect.gen(function* () {
    const stack = {
      name: "mind",
      stage: config.alchemy.stageName,
      resources: {} as Record<string, any>,
      bindings: {},
      actions: {},
    };
    const inStack = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(StackContext, stack),
        Effect.provideService(HttpClient.HttpClient, zoneLookup),
        Effect.provide(fromApiToken({ apiToken: Redacted.make("none") })),
      );
    yield* inStack(mindStack(config));
    const workers: Record<string, string[]> = {};
    for (const resource of Object.values(stack.resources).filter(
      (r) => r.Type === "Cloudflare.Worker",
    )) {
      const lines: string[] = [];
      // An Effect is run, as Alchemy runs it (another Worker's entrypoint), unless it carries its
      // kind (`~alchemy/Kind`, the Worker Loader): Alchemy reads that one as it is.
      for (const [name, value] of Object.entries<any>(resource.Props.env ?? {}))
        lines.push(
          `${name}:${kindOf(Effect.isEffect(value) && !("~alchemy/Kind" in value) ? yield* inStack(value as Effect.Effect<unknown, unknown, never>) : value)}`,
        );
      workers[resource.LogicalId] = lines.sort();
    }
    return workers;
  });

void test("each Worker of the stack holds what stack-bindings.snapshot.json says", async () => {
  const listing: Record<string, Record<string, string[]>> = {};
  for (const [name, config] of Object.entries(CASES))
    listing[name] = await Effect.runPromise(
      bindingsOf(MindConfig.parse(config)) as Effect.Effect<Record<string, string[]>>,
    );
  if (process.env.UPDATE_STACK_BINDINGS)
    writeFileSync(SNAPSHOT, `${JSON.stringify(listing, null, 2)}\n`);
  const snapshot: typeof listing = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const changes: string[] = [];
  for (const name of new Set([...Object.keys(snapshot), ...Object.keys(listing)]))
    for (const worker of new Set([
      ...Object.keys(snapshot[name] ?? {}),
      ...Object.keys(listing[name] ?? {}),
    ])) {
      const before = snapshot[name]?.[worker] ?? [];
      const after = listing[name]?.[worker] ?? [];
      const went = before.filter((line) => !after.includes(line)).map((line) => `  - ${line}`);
      const came = after.filter((line) => !before.includes(line)).map((line) => `  + ${line}`);
      if (went.length || came.length) changes.push(`${name} / ${worker}:`, ...went, ...came);
    }
  if (changes.length)
    assert.fail(
      `The stack's bindings differ from the snapshot:\n${changes.join("\n")}\nIf this change is meant, update the snapshot: UPDATE_STACK_BINDINGS=1 pnpm --filter core-alchemy test`,
    );
});
