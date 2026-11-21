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
import { inspect } from "node:util";
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
import type { TelemetryMode } from "./telemetry-token.ts";

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

/** A Worker that the stack does not make (`Cloudflare.Worker.lookup`, the egress gateway): Node
 *  prints it as `Cloudflare.Worker.lookup(<its name>)`. */
const lookedUp = (value: any) => isExpr(value) && (value as any).Type === "Cloudflare.Worker";

const kindOf = (value: any): string => {
  if (typeof value === "string") return "plain_text";
  // the one Effect left here is one that carries its kind (see `bindingsOf`)
  if (Effect.isEffect(value)) return (value as any)["~alchemy/Kind"];
  if (Redacted.isRedacted(value)) return "secret_text";
  if (lookedUp(value)) return inspect(value);
  if (isExpr(value)) return `output of ${sourcesOf(value).join(", ")}`;
  if (isResource(value)) return `${value.Type} ${value.LogicalId}`;
  if (value.kind === "Cloudflare.WorkerEntrypoint")
    return `${value.kind} (worker ${lookedUp(value.worker) ? inspect(value.worker) : value.worker.LogicalId}, entrypoint ${value.entrypoint})`;
  if (value.kind === "Cloudflare.DurableObject") {
    const containers = (value.containers ?? []).map(
      (container: Named<string>) => container["~alchemy/Id"],
    );
    return `${value.kind} (class ${value.className}${value.scriptName ? `, worker ${value.scriptName}` : ""}${containers.length ? `, containers ${containers.join(" ")}` : ""})`;
  }
  return value.kind;
};

/** What `declaredOf` answers: each Worker's bindings by kind, each resource's type, and each
 *  Worker's variables that are plain text. */
type Declared = {
  workers: Record<string, string[]>;
  resources: Record<string, string>;
  texts: Record<string, Record<string, string>>;
};

/** Each Worker's bindings and declared resources, as the program declares them for one config. */
const declaredOf = (config: MindConfig, options?: { telemetryMode?: TelemetryMode }) =>
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
    yield* inStack(mindStack(config, options));
    const workers: Record<string, string[]> = {};
    /** each Worker's variables that are plain text, as the text itself */
    const texts: Record<string, Record<string, string>> = {};
    for (const resource of Object.values(stack.resources).filter(
      (r) => r.Type === "Cloudflare.Worker",
    )) {
      texts[resource.LogicalId] = Object.fromEntries(
        Object.entries<any>(resource.Props.env ?? {}).filter(
          ([, value]) => typeof value === "string",
        ),
      );
      const lines: string[] = [];
      // An Effect is run, as Alchemy runs it (another Worker's entrypoint), unless it carries its
      // kind (`~alchemy/Kind`, the Worker Loader): Alchemy reads that one as it is.
      for (const [name, value] of Object.entries<any>(resource.Props.env ?? {}))
        lines.push(
          `${name}:${kindOf(Effect.isEffect(value) && !("~alchemy/Kind" in value) ? yield* inStack(value as Effect.Effect<unknown, unknown, never>) : value)}`,
        );
      workers[resource.LogicalId] = lines.sort();
    }
    const resources = Object.fromEntries(
      Object.values(stack.resources).map((r) => [r.LogicalId, r.Type as string]),
    );
    return { workers, resources, texts };
  });

void test("each Worker of the stack holds what stack-bindings.snapshot.json says", async () => {
  const listing: Record<string, Record<string, string[]>> = {};
  for (const [name, config] of Object.entries(CASES))
    listing[name] = (
      await Effect.runPromise(declaredOf(MindConfig.parse(config)) as Effect.Effect<Declared>)
    ).workers;
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

const declared = (config: object) =>
  Effect.runPromise(declaredOf(MindConfig.parse(config)) as Effect.Effect<Declared>);

// A STACK THAT NAMES NO GATEWAY IS AS IT WAS BEFORE THE GATEWAY'S FIELD EXISTED. Its config
// variables are written out here character by character: a marker or a new key there would
// change every mind. Its bindings are read from the declaration and never from the snapshot
// file, so a rewrite of the snapshot cannot hide one. This reads the declaration, not what
// Alchemy sends to Cloudflare: a plan of a stack shows that.
void test("a stack that names no egress gateway binds none, and has the same ITERATE and DEPLOY_CONFIG, byte for byte", async () => {
  const id = "a".repeat(64);
  const external = "external-mind-connects-into-cloudflare-boundary";
  for (const [name, topology, mail] of [
    [
      "full-cloudflare, mail forward",
      "full-cloudflare",
      ',"mail":{"forwardTo":"team@group.example"}',
    ],
    ["full-cloudflare, no mail forward", "full-cloudflare", ""],
    ["external mind, no mail forward", external, ""],
  ] as const) {
    const { texts, workers } = await declared(CASES[name]);
    // the two Workers that send what leaves the stack; a mind's and a telemetry Worker's `ITERATE`
    // has fields of its own after these, and the loop below reads every Worker's
    for (const worker of ["Secrets", "Boundary"])
      assert.equal(
        texts[worker]!.ITERATE,
        `{"mindId":"${id}","controlPlaneHostname":"example.com","zones":["example.com"],"ownerEmails":["owner@owner.example"],"topology":"${topology}"}`,
        `${name} / ${worker}`,
      );
    assert.equal(
      texts.Boundary!.DEPLOY_CONFIG,
      `{"mindId":"${id}","controlPlaneHostname":"example.com","ownerEmails":["owner@owner.example"],"topology":"${topology}","alchemy":{"stageName":"example-com"},"cloudflare":{"accountId":"${accountId}","zones":["example.com"]}${mail}}`,
      name,
    );
    // no binding of any Worker, and no plain-text variable, names a gateway
    for (const worker of Object.keys(workers))
      assert.deepEqual(
        [
          ...workers[worker]!.filter((line) => /egress/i.test(line)),
          ...Object.entries(texts[worker]!).filter(([key, value]) => /egress/i.test(key + value)),
        ],
        [],
        `${name} / ${worker}`,
      );
  }
});

for (const name of ["full-cloudflare, no mail forward", "external mind, no mail forward"] as const)
  void test(`${name}, and an egress gateway: the vault and the boundary get the gateway, found by its name; the boundary alone gets its Providers entrypoint; nothing else of the stack changes`, async () => {
    const gateway = "Cloudflare.Worker.lookup(owners-egress-gateway)";
    const { workers } = await declared({
      ...CASES[name],
      cloudflare: { ...base.cloudflare, egressGatewayWorker: "owners-egress-gateway" },
    });
    const without = (await declared(CASES[name])).workers;
    const added = (worker: string) =>
      workers[worker]!.filter((line) => !without[worker]!.includes(line));
    assert.deepEqual(added("Secrets"), [`EGRESS_GATEWAY:${gateway}`]);
    assert.deepEqual(added("Boundary"), [
      `EGRESS_GATEWAY:${gateway}`,
      `EGRESS_GATEWAY_PROVIDERS:Cloudflare.WorkerEntrypoint (worker ${gateway}, entrypoint EgressGatewayProviders)`,
    ]);
    // no other Worker gets a line, and every other line of every Worker is the same stack's with
    // no gateway
    for (const [worker, lines] of Object.entries(workers)) {
      if (worker !== "Secrets" && worker !== "Boundary")
        assert.deepEqual(added(worker), [], worker);
      assert.deepEqual(
        lines.filter((line) => !added(worker).includes(line)),
        without[worker],
        worker,
      );
    }
  });

void test("telemetry modes: minted keeps both AccountApiToken resources, given uses TelemetryToken, and off makes the bucket and streams but no token, catalog, sink or pipeline, while other Workers stay identical", async () => {
  const config = MindConfig.parse(CASES["full-cloudflare, no mail forward"]);
  const runMode = (telemetryMode: TelemetryMode) =>
    Effect.runPromise(declaredOf(config, { telemetryMode }) as Effect.Effect<Declared>);
  const [minted, given, off] = await Promise.all([
    runMode("minted"),
    runMode("given"),
    runMode("off"),
  ]);

  // Minted mode declares both AccountApiToken resources and their Worker bindings
  assert.deepEqual(minted.workers.Telemetry, [
    "EVENTS:Cloudflare.Pipelines.Stream Telemetry_events_stream",
    "ITERATE:plain_text",
    "ITERATE__ANALYTICS_TOKEN:output of TelemetryAnalyticsToken.value",
    "ITERATE__CATALOG_TOKEN:output of TelemetryCatalogToken.value",
    "ITERATE__OTLP_SECRET:output of TelemetryOtlpSecret.text",
    "LOGS:Cloudflare.Pipelines.Stream Telemetry_logs_stream",
    "METRICS:Cloudflare.AnalyticsEngine.Dataset",
    "SPANS:Cloudflare.Pipelines.Stream Telemetry_spans_stream",
  ]);
  assert.equal(minted.resources.TelemetryCatalogToken, "Cloudflare.ApiToken.AccountApiToken");
  assert.equal(minted.resources.TelemetryAnalyticsToken, "Cloudflare.ApiToken.AccountApiToken");
  assert.equal(minted.resources.TelemetryToken, undefined);

  // Given mode declares TelemetryToken
  assert.deepEqual(given.workers.Telemetry, [
    "EVENTS:Cloudflare.Pipelines.Stream Telemetry_events_stream",
    "ITERATE:plain_text",
    "ITERATE__ANALYTICS_TOKEN:output of TelemetryToken.value",
    "ITERATE__CATALOG_TOKEN:output of TelemetryToken.value",
    "ITERATE__OTLP_SECRET:output of TelemetryOtlpSecret.text",
    "LOGS:Cloudflare.Pipelines.Stream Telemetry_logs_stream",
    "METRICS:Cloudflare.AnalyticsEngine.Dataset",
    "SPANS:Cloudflare.Pipelines.Stream Telemetry_spans_stream",
  ]);
  assert.equal(given.resources.TelemetryToken, "Iterate.TelemetryToken");
  assert.equal(given.resources.TelemetryCatalogToken, undefined);
  assert.equal(given.resources.TelemetryAnalyticsToken, undefined);
  // the tables that a mind made itself are only an "off" stack's
  assert.equal(given.resources.TelemetryTablesOfTheMind, undefined);
  assert.equal(minted.resources.TelemetryTablesOfTheMind, undefined);

  // Off mode binds the three streams and declares the bucket, the streams and the destinations,
  // and no token, catalog, sink or pipeline: the mind can make those itself
  assert.deepEqual(off.workers.Telemetry, [
    "EVENTS:Cloudflare.Pipelines.Stream Telemetry_events_stream",
    "ITERATE:plain_text",
    "ITERATE__OTLP_SECRET:output of TelemetryOtlpSecret.text",
    "LOGS:Cloudflare.Pipelines.Stream Telemetry_logs_stream",
    "METRICS:Cloudflare.AnalyticsEngine.Dataset",
    "SPANS:Cloudflare.Pipelines.Stream Telemetry_spans_stream",
  ]);
  for (const declared of [
    "TelemetryBucket",
    "Telemetry_events_stream",
    "Telemetry_logs_stream",
    "Telemetry_spans_stream",
    "Telemetry_logs",
    "Telemetry_traces",
    "TelemetryTablesOfTheMind",
  ])
    assert.ok(off.resources[declared], `${declared} should be declared when off`);
  for (const omitted of [
    "TelemetryToken",
    "TelemetryCatalogToken",
    "TelemetryAnalyticsToken",
    "TelemetryCatalog",
    "TelemetrySinkTables",
    "Telemetry_events_sink",
    "Telemetry_events_pipeline",
    "Telemetry_logs_sink",
    "Telemetry_logs_pipeline",
    "Telemetry_spans_sink",
    "Telemetry_spans_pipeline",
  ]) {
    assert.equal(off.resources[omitted], undefined, `${omitted} should be omitted when off`);
  }

  // Every other Worker's bindings stay identical across all three telemetry modes
  for (const worker of ["Auth", "Secrets", "Mind", "Boundary"] as const) {
    assert.deepEqual(minted.workers[worker], given.workers[worker]);
    assert.deepEqual(off.workers[worker], given.workers[worker]);
  }
});
